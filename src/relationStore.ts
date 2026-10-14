import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { emptyRules, ruleKey, type RelationRules, type TargetRule } from './relations';

export const relationFile = 'extensions/json_reading/relations.json';
export function isRelationFile(file: string) {
    return file.replace(/\\/g, '/').toLowerCase().endsWith('/' + relationFile);
}
interface SharedRules { version: 1; files: Record<string, RelationRules> }
const same = isDeepStrictEqual;

/** 项目相对路径让不同成员的磁盘路径不影响规则复用。 */
export class RelationStore {
    readonly file: string;
    constructor(readonly root: string) { this.file = path.join(root, relationFile); }
    private key(file: string) {
        const relative = path.relative(this.root, file).replace(/\\/g, '/');
        if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative) || isRelationFile(file)) {
            throw new Error('源 JSON 必须位于项目中，且不能是关联匹配表自身。');
        }
        return relative;
    }
    private async load(): Promise<SharedRules> {
        let text: string;
        try { text = await fs.readFile(this.file, 'utf8'); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return { version: 1, files: {} }; }
            throw error;
        }
        try {
            const value = JSON.parse(text.replace(/^\uFEFF/, ''));
            if (value?.version !== 1 || !value.files || typeof value.files !== 'object' || Array.isArray(value.files)) { throw new Error('结构或版本不正确'); }
            for (const [file, rules] of Object.entries(value.files)) {
                if (file.startsWith('/') || /^[A-Za-z]:/.test(file) || file.split(/[\\/]/).includes('..')) { throw new Error('源文件必须使用项目相对路径'); }
                normalizeRules(rules as RelationRules);
            }
            return value as SharedRules;
        } catch (error) { throw new Error(`匹配表 ${this.file} 无法读取，请先修复 JSON 格式或 Git 冲突；不会覆盖原文件。${String(error)}`); }
    }
    async read(file: string): Promise<RelationRules | undefined> {
        const rules = (await this.load()).files[this.key(file)];
        return rules ? normalizeRules(rules) : undefined;
    }
    /** 先锁定、重新读盘，再按差异合并，最后原子替换，避免丢失其他文件或窗口的更新。 */
    async write(file: string, rules?: RelationRules, base: RelationRules = emptyRules()) {
        const key = this.key(file);
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        const lockFile = this.file + '.lock';
        let lock: fs.FileHandle | undefined;
        for (let attempt = 0; attempt < 100; attempt++) {
            try { lock = await fs.open(lockFile, 'wx'); break; }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; }
                await new Promise(resolve => setTimeout(resolve, 20));
            }
        }
        if (!lock) { throw new Error(`匹配表正被其他窗口写入，请稍后重试；若编辑器曾异常退出，请检查 ${lockFile}。`); }
        const temp = this.file + '.' + randomUUID() + '.tmp';
        try {
            const all = await this.load();
            if (!rules) { delete all.files[key]; }
            else {
                const next = normalizeRules(rules), before = normalizeRules(base);
                const current = all.files[key] ? normalizeRules(all.files[key]) : emptyRules();
                for (const [field, rule] of Object.entries(next.fields)) {
                    const old = before.fields[field];
                    const merged = current.fields[field] ?? { scanned: false, targets: {} };
                    merged.scanned ||= rule.scanned;
                    for (const [target, candidate] of Object.entries(rule.targets)) {
                        if (same(candidate, old?.targets[target])) { continue; }
                        const disk = merged.targets[target];
                        if (disk && !same(disk, old?.targets[target]) && !same(disk, candidate)) {
                            if (candidate.decision === 'pending') { continue; }
                            throw new Error('该关联已被其他窗口或成员修改，请重新读取匹配表后再操作。');
                        }
                        merged.targets[target] = candidate;
                    }
                    current.fields[field] = merged;
                }
                all.files[key] = current;
            }
            const content = JSON.stringify(sorted(all), null, 2) + '\n';
            const existing = await fs.readFile(this.file, 'utf8').catch(error => {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return ''; }
                throw error;
            });
            if (content !== existing) {
                await fs.writeFile(temp, content, 'utf8');
                await fs.rename(temp, this.file);
            }
        } finally {
            await fs.rm(temp, { force: true });
            await lock.close();
            await fs.rm(lockFile, { force: true });
        }
    }
}

function sorted(value: unknown): unknown {
    if (Array.isArray(value)) { return value.map(sorted); }
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, item]) => [key, sorted(item)]));
    }
    return value;
}

export function normalizeRules(rules: RelationRules): RelationRules {
    if (!rules?.fields || typeof rules.fields !== 'object' || Array.isArray(rules.fields)) { throw new Error('匹配表缺少 fields'); }
    const result = emptyRules();
    for (const [field, rule] of Object.entries(rules.fields)) {
        const column = JSON.parse(field);
        if (!Array.isArray(column) || column.length !== 2 || !Number.isInteger(column[0]) || column[0] < 1 || typeof column[1] !== 'string' ||
            typeof rule?.scanned !== 'boolean' || !rule.targets || typeof rule.targets !== 'object' || Array.isArray(rule.targets)) { throw new Error('字段规则格式不正确'); }
        const targets: Record<string, TargetRule> = {};
        for (const candidate of Object.values(rule.targets)) {
            const target = candidate?.target;
            if (!target || typeof target.file !== 'string' || typeof target.sheet !== 'string' || !Array.isArray(target.names) || target.names.some(name => typeof name !== 'string') ||
                !['pending', 'accepted', 'rejected'].includes(candidate.decision)) { throw new Error('关联目标格式不正确'); }
            if (target.keyField !== undefined && (typeof target.keyField !== 'string' || !target.keyField.trim())) { throw new Error('目标键字段格式不正确'); }
            const { when, extract } = candidate;
            if (when !== undefined && (!when || typeof when.field !== 'string' || !when.field.trim() || !Array.isArray(when.values) || !when.values.length ||
                when.values.some(value => typeof value !== 'string' && (typeof value !== 'number' || !Number.isFinite(value))))) { throw new Error('关联条件格式不正确'); }
            if (extract !== undefined) {
                if (!extract || (extract.separator === undefined && extract.arrayIndex === undefined)) { throw new Error('关联值提取格式不正确'); }
                const split = extract.separator !== undefined;
                if ((split && (typeof extract.separator !== 'string' || !extract.separator || !Number.isSafeInteger(extract.index) || extract.index! < 0)) ||
                    (!split && (extract.index !== undefined || extract.listSeparator !== undefined)) ||
                    (extract.listSeparator !== undefined && (typeof extract.listSeparator !== 'string' || !extract.listSeparator)) ||
                    (extract.arrayIndex !== undefined && (!Number.isSafeInteger(extract.arrayIndex) || extract.arrayIndex < 0))) { throw new Error('关联值提取格式不正确'); }
            }
            const file = target.file.replace(/\\/g, '/');
            if (!file || file.startsWith('/') || /^[A-Za-z]:/.test(file) || file.split('/').includes('..')) { throw new Error('工作簿必须使用策划目录相对路径'); }
            const normalized: TargetRule = { target: { file, sheet: target.sheet, names: target.names }, decision: candidate.decision };
            const keyField = target.keyField?.trim();
            if (keyField && keyField.toLowerCase() !== 'id') { normalized.target.keyField = keyField; }
            if (when) { normalized.when = { field: when.field, values: [...when.values] }; }
            if (extract) {
                normalized.extract = {
                    ...(extract.separator !== undefined ? { separator: extract.separator, index: extract.index } : {}),
                    ...(extract.listSeparator ? { listSeparator: extract.listSeparator } : {}),
                    ...(extract.arrayIndex !== undefined ? { arrayIndex: extract.arrayIndex } : {})
                };
            }
            targets[ruleKey(normalized.target, normalized.when, normalized.extract)] = normalized;
        }
        result.fields[field] = { scanned: rule.scanned, targets };
    }
    return result;
}
