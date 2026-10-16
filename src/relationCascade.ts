import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse, type ParseError } from 'jsonc-parser';
import { configName, type FieldDescription } from './tableIndex';
import { fieldKey, readTranslations, referenceValues, targetKey, valuesForRule,
    type RelationCell, type RelationIndex, type RelationRow, type RelationRules, type RelationTarget } from './relations';

export interface CascadeField {
    name: string; value: string; description?: string; detail?: string;
    children?: CascadeMatch[]; translations?: { key: string; text?: string; error?: string }[]; message?: string;
}
export interface CascadeRow { id: string; row: number; fields: CascadeField[]; message?: string }
export interface CascadeMatch { target: RelationTarget; id: string; rows: CascadeRow[]; message?: string }
export interface CascadeOptions {
    index: RelationIndex; root: string; sourceFile: string; rules: Record<string, RelationRules>; i18nFile?: string;
}
interface JsonTable { file: string; header: string[]; rows: unknown[][]; rules?: RelationRules }
interface Budget { remaining: number }
const maxDepth = 32, maxRecords = 300;
const message = (previous: string | undefined, next: string) => previous ? `${previous}；${next}` : next;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const identity = (file: string) => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
const scalar = (value: unknown) => typeof value === 'string' || typeof value === 'number' ? String(value).trim() : undefined;

/** 仅验证可证明的导出形式，不用 XLSM 文本反推数组结构或分隔规则。 */
function alignedValue(excel: string, json: unknown): boolean {
    const text = excel.trim();
    if (!text) { return json === '' || json === null || json === 0 || (Array.isArray(json) && json.length === 0); }
    if (typeof json === 'number') { return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text) && Number.isFinite(Number(text)) && Number(text) === json; }
    if (typeof json === 'boolean') { return text.toLowerCase() === String(json); }
    if (typeof json === 'string') { return text === json.trim(); }
    if (!Array.isArray(json)) { return false; }
    try { if (isDeepStrictEqual(JSON.parse(text), json)) { return true; } }
    catch { /* 非 JSON 数组文本只允许下方明确的扁平逗号格式。 */ }
    if (!json.length || json.some(value => !['string', 'number', 'boolean'].includes(typeof value) || String(value).includes(','))) { return false; }
    const parts = text.split(',');
    return parts.length === json.length && parts.every((value, index) => alignedValue(value, json[index]));
}

export class CascadeCancelledError extends Error {
    constructor() { super('关联视图已失效，停止继续展开。'); }
}

/** 只沿已有规则递归；JSON 提供类型/数组语义，XLSM 提供当前记录与字段说明。 */
export class RelationCascade {
    readonly dependencies = new Set<string>();
    private readonly directory: string;
    private readonly root: string;
    private readonly ruleFiles = new Map<string, string[]>();
    private readonly rulesByFile = new Map<string, RelationRules>();
    private directoryFiles?: Promise<string[]>;
    private readonly json = new Map<string, Promise<JsonTable>>();
    private readonly translations = new Map<string, Promise<Map<string, string>>>();

    constructor(private readonly options: CascadeOptions) {
        this.root = path.resolve(options.root);
        this.directory = path.dirname(path.resolve(options.sourceFile));
        for (const [relative, rules] of Object.entries(options.rules)) {
            const file = path.resolve(this.root, relative.replace(/\\/g, '/'));
            const fromRoot = path.relative(this.root, file);
            if (fromRoot === '..' || fromRoot.startsWith('..' + path.sep) || path.isAbsolute(fromRoot)) { throw new Error('关联匹配表包含项目目录之外的 JSON 路径。'); }
            this.rulesByFile.set(identity(file), rules);
            if (!/\.jsonc?$/i.test(file)) { continue; }
            const name = configName(file).replace(/data$/, '');
            const files = this.ruleFiles.get(name) ?? [];
            files.push(file); this.ruleFiles.set(name, files);
        }
    }

    private check(valid: () => boolean) { if (!valid()) { throw new CascadeCancelledError(); } }

    async expand(target: RelationTarget, rows: RelationRow[], valid: () => boolean = () => true): Promise<CascadeRow[]> {
        this.check(valid);
        return this.expandRows(target, rows, 1, new Set(), { remaining: maxRecords }, valid);
    }

    private async readJson(file: string): Promise<JsonTable> {
        const key = identity(file);
        let loaded = this.json.get(key);
        if (!loaded) {
            loaded = (async () => {
                const text = (await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '');
                const errors: ParseError[] = [];
                const jsonc = /\.jsonc$/i.test(file);
                const value: unknown = parse(text, errors, { allowTrailingComma: jsonc, disallowComments: !jsonc });
                if (errors.length || !Array.isArray(value) || !Array.isArray(value[0]) || !value[0].length ||
                    value[0].some(field => typeof field !== 'string') || value.slice(1).some(row => !Array.isArray(row))) {
                    throw new Error(`${path.basename(file)} 不是有效的首行字段名表格 JSON。`);
                }
                return { file, header: value[0], rows: value.slice(1), rules: this.rulesByFile.get(key) };
            })();
            this.json.set(key, loaded);
        }
        return loaded;
    }

    private async targetJson(target: RelationTarget, valid: () => boolean): Promise<JsonTable | undefined> {
        this.check(valid);
        const names = new Set(target.names.map(configName));
        if (!names.size) { return; }
        const candidates = new Map<string, string>();
        for (const name of names) {
            for (const file of this.ruleFiles.get(name) ?? []) {
                candidates.set(identity(file), file); this.dependencies.add(file);
            }
        }
        this.directoryFiles ??= fs.readdir(this.directory, { withFileTypes: true }).then(entries => entries
            .filter(entry => entry.isFile() && /\.jsonc?$/i.test(entry.name)).map(entry => path.join(this.directory, entry.name)));
        const files = await this.directoryFiles;
        this.check(valid);
        for (const file of files) {
            if (!names.has(configName(file).replace(/data$/, ''))) { continue; }
            candidates.set(identity(file), file); this.dependencies.add(file);
        }
        const local = [...candidates.values()].filter(file => identity(path.dirname(file)) === identity(this.directory));
        const choices = local.length ? local : [...candidates.values()];
        if (!choices.length) { return; }
        if (choices.length > 1) { throw new Error(`目标 JSON 存在多个同名候选，未猜测关联: ${choices.map(file => path.relative(this.root, file)).join('、')}`); }
        this.check(valid);
        const result = await this.readJson(choices[0]);
        this.check(valid);
        return result;
    }

    /** 非 ID 键可能命中多行，先用首列 ID 对齐；仍不唯一时只能用共同标量缩小范围。 */
    private jsonRow(table: JsonTable, target: RelationTarget, row: RelationRow): unknown[] {
        const columns = table.header.flatMap((field, index) => field.toLowerCase() === (target.keyField ?? 'ID').toLowerCase() ? [index] : []);
        if (columns.length !== 1) { throw new Error(`目标 JSON 键字段 ${target.keyField ?? 'ID'} 不存在或不唯一。`); }
        let candidates = table.rows.filter(values => scalar(values[columns[0]]) === row.id);
        if (!candidates.length) { throw new Error(`目标 JSON 中未找到 ${target.keyField ?? 'ID'} = ${row.id}，未继续递归。`); }
        const cells = new Map(row.values.map(([field, value]) => [field.trim(), value.trim()]));
        const primary = cells.get(table.header[0]);
        if (primary !== undefined && (candidates.length > 1 || columns[0] !== 0)) {
            const identified = candidates.filter(values => scalar(values[0]) === primary);
            if (!identified.length) { throw new Error('目标 JSON 与工作簿的首列 ID 无法对齐，未继续递归。'); }
            candidates = identified;
        }
        for (let column = 0; candidates.length > 1 && column < table.header.length; column++) {
            const excel = cells.get(table.header[column]);
            if (excel === undefined) { continue; }
            const matched = candidates.filter(values => scalar(values[column]) === excel);
            if (matched.length) { candidates = matched; }
        }
        const distinct = new Map(candidates.map(values => [JSON.stringify(values), values]));
        if (distinct.size !== 1) { throw new Error('目标 JSON 有多条相同键且无法唯一对齐的记录，未猜测数组或条件。'); }
        return [...distinct.values()][0];
    }

    private async translate(raw: unknown, table: JsonTable | undefined, valid: () => boolean): Promise<CascadeField['translations']> {
        const keys = referenceValues(raw).filter(value => value.startsWith('i18n_'));
        if (!keys.length) { return; }
        const configured = this.options.i18nFile?.trim();
        const file = configured ? path.resolve(this.directory, configured) : path.join(path.dirname(table?.file ?? this.options.sourceFile), 'i18zhConfigData.json');
        this.dependencies.add(file);
        this.check(valid);
        let loaded = this.translations.get(identity(file));
        if (!loaded) { loaded = readTranslations(file); this.translations.set(identity(file), loaded); }
        try {
            const translations = await loaded;
            this.check(valid);
            return keys.map(key => translations.has(key) ? { key, text: translations.get(key)! } : { key, error: '未找到对应 KeyID' });
        } catch (error) {
            this.check(valid);
            return keys.map(key => ({ key, error: `中文表读取失败: ${errorText(error)}` }));
        }
    }

    private async expandRows(target: RelationTarget, rows: RelationRow[], depth: number, ancestors: Set<string>, budget: Budget, valid: () => boolean): Promise<CascadeRow[]> {
        this.check(valid);
        let metadata: Map<string, FieldDescription> | undefined, table: JsonTable | undefined, issue: string | undefined;
        try { metadata = await this.options.index.metadata(target); }
        catch (error) { issue = `字段说明读取失败: ${errorText(error)}`; }
        this.check(valid);
        try { table = await this.targetJson(target, valid); }
        catch (error) { this.check(valid); issue = message(issue, `递归关联读取失败: ${errorText(error)}`); }
        const expanded: CascadeRow[] = [];
        for (const row of rows) {
            this.check(valid);
            if (budget.remaining <= 0) {
                // 根记录已由当前视图加载；预算只阻止继续查询，不能让后续根记录凭空消失。
                const fields = depth === 1 ? row.values.map(([name, value]) => ({ name, value, ...metadata?.get(name.trim()) })) : [];
                expanded.push({ id: row.id, row: row.row, fields, message: message(issue, `已达到 ${maxRecords} 条关联记录上限，后续记录未展开。`) });
                if (depth === 1) { continue; }
                break;
            }
            budget.remaining--;
            const fields: CascadeField[] = row.values.map(([name, value]) => ({ name, value, ...metadata?.get(name.trim()) }));
            const result: CascadeRow = { id: row.id, row: row.row, fields, ...(issue ? { message: issue } : {}) };
            expanded.push(result);
            const key = JSON.stringify([targetKey(target), row.id, row.row]);
            if (ancestors.has(key)) { result.message = message(result.message, '检测到循环关联，此处停止展开。'); continue; }
            const nextAncestors = new Set(ancestors); nextAncestors.add(key);
            let values: unknown[] | undefined;
            if (table) {
                try { values = this.jsonRow(table, target, row); }
                catch (error) { result.message = message(result.message, errorText(error)); }
            }
            const context = values && table ? Object.fromEntries(table.header.map((field, column) => [field, values![column]])) : undefined;
            for (const [displayColumn, field] of fields.entries()) {
                this.check(valid);
                const columns = table?.header.flatMap((name, column) => name === field.name.trim() ? [column] : []) ?? [];
                const column = columns.length === 1 ? columns[0] : -1;
                if (column === 0 || (!table && displayColumn === 0)) { continue; }
                const raw = values && column >= 0 ? values[column] : field.value;
                // 中文 key 直接来自当前显示的 XLSM，避免未重新导出的 JSON 翻译出旧内容。
                field.translations = await this.translate(field.value, table, valid);
                if (!table || !context || !values) { continue; }
                if (columns.length > 1) { field.message = '目标 JSON 存在同名字段，未猜测其列号。'; continue; }
                if (column < 1) { continue; }
                const rules = table.rules?.fields[fieldKey(column, table.header[column])];
                if (!rules) { continue; }
                const cell: RelationCell = { field: table.header[column], column, raw, values: referenceValues(raw), row: context, start: 0, end: 0 };
                const targets = new Map<string, { target: RelationTarget; ids: Set<string> }>();
                const warn = (text: string) => { if (!field.message?.includes(text)) { field.message = message(field.message, text); } };
                for (const candidate of Object.values(rules.targets)) {
                    if (candidate.decision === 'rejected') { continue; }
                    if (candidate.when && table.header.filter(name => name === candidate.when!.field).length !== 1) {
                        warn(`条件字段 ${candidate.when.field} 不存在或不唯一，已跳过此规则。`); continue;
                    }
                    if (candidate.when) {
                        const condition = candidate.when, cells = row.values.filter(([name]) => name.trim() === condition.field);
                        if (cells.length !== 1 || !alignedValue(cells[0][1], context[condition.field])) {
                            warn(`条件字段 ${condition.field} 的 XLSM 与 JSON 值不一致或无法确定，已跳过此规则；请重新导出 JSON 后刷新。`); continue;
                        }
                        if (!referenceValues(context[condition.field]).some(value => condition.values.some(expected => String(expected) === value))) { continue; }
                    }
                    if (row.values.filter(([name]) => name.trim() === field.name.trim()).length !== 1 || !alignedValue(field.value, raw)) {
                        warn('当前字段的 XLSM 与 JSON 值不一致或无法确定，已跳过关联；请重新导出 JSON 后刷新。'); continue;
                    }
                    const ids = valuesForRule(cell, candidate).filter(id => !id.startsWith('i18n_'));
                    if (!ids.length) { continue; }
                    const key = targetKey(candidate.target), group = targets.get(key) ?? { target: candidate.target, ids: new Set<string>() };
                    ids.forEach(id => group.ids.add(id)); targets.set(key, group);
                }
                for (const group of targets.values()) {
                    this.check(valid);
                    field.children ??= [];
                    if (budget.remaining <= 0) { field.message = message(field.message, `已达到 ${maxRecords} 条关联记录上限，后续关联未展开。`); break; }
                    if (depth >= maxDepth) { field.children.push({ target: group.target, id: [...group.ids][0], rows: [], message: `已达到 ${maxDepth} 层关联深度上限，未继续展开该目标。` }); budget.remaining--; continue; }
                    const ids = [...group.ids].slice(0, budget.remaining);
                    if (ids.length < group.ids.size) { field.message = message(field.message, `记录预算不足，另 ${group.ids.size - ids.length} 个关联键未展开。`); }
                    let records: Map<string, RelationRow[]>;
                    try { records = await this.options.index.recordsMany(group.target, ids); }
                    catch (error) {
                        this.check(valid);
                        field.children.push(...ids.map(id => ({ target: group.target, id, rows: [], message: `关联记录读取失败: ${errorText(error)}` })));
                        budget.remaining -= ids.length;
                        continue;
                    }
                    this.check(valid);
                    for (const id of ids) {
                        const rows = records.get(id) ?? [];
                        const match: CascadeMatch = { target: group.target, id, rows: [] };
                        field.children.push(match);
                        if (!rows.length) { match.message = `目标表中未找到 ${group.target.keyField ?? 'ID'} = ${id}。`; budget.remaining--; continue; }
                        if (budget.remaining <= 0) { match.message = `已达到 ${maxRecords} 条关联记录上限，未继续展开。`; break; }
                        match.rows = await this.expandRows(group.target, rows, depth + 1, nextAncestors, budget, valid);
                    }
                }
            }
        }
        return expanded;
    }
}
