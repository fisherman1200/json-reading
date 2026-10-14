import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getNodeValue, parseTree, type ParseError } from 'jsonc-parser';
import { TableIndex, type TableSettings } from './tableIndex';
import { readSheetRows } from './workbookReader';

export interface RelationCell { field: string; column: number; values: string[]; raw: unknown; row: Record<string, unknown>; start: number; end: number }
export interface RelationDocument { cells: RelationCell[]; values: Map<string, Set<string>>; primaryRanges: { start: number; end: number }[] }
export interface RelationTarget { file: string; sheet: string; names: string[]; keyField?: string }
export interface RelationCondition { field: string; values: (string | number)[] }
export interface RelationExtraction { separator?: string; index?: number; listSeparator?: string; arrayIndex?: number }
export interface TargetRule {
    target: RelationTarget; decision: 'pending' | 'accepted' | 'rejected';
    when?: RelationCondition; extract?: RelationExtraction;
}
export interface FieldRule { scanned: boolean; targets: Record<string, TargetRule> }
export interface RelationRules { fields: Record<string, FieldRule> }
export interface RelationRow { id: string; row: number; values: [string, string][] }
export interface TargetData { target: RelationTarget; rows: Map<string, RelationRow[]> }

export const targetKey = (target: RelationTarget) => JSON.stringify([
    target.file.replace(/\\/g, '/'), target.sheet,
    ...target.keyField && target.keyField.toLowerCase() !== 'id' ? [target.keyField.toLowerCase()] : []
]);
/** 同一目标的不同类型条件/拆分方式分别保存；无条件旧规则的键保持兼容。 */
export function ruleKey(target: RelationTarget, when?: RelationCondition, extract?: RelationExtraction): string {
    if (!when && !extract) { return targetKey(target); }
    const condition = when ? { field: when.field, values: [...new Set(when.values.map(String))].sort() } : null;
    const extraction = extract ? {
        ...(extract.separator !== undefined ? { separator: extract.separator, index: extract.index } : {}),
        ...(extract.listSeparator ? { listSeparator: extract.listSeparator } : {}),
        ...(extract.arrayIndex !== undefined ? { arrayIndex: extract.arrayIndex } : {})
    } : null;
    return JSON.stringify([targetKey(target), condition, extraction]);
}
export const fieldKey = (column: number, field: string) => JSON.stringify([column, field]);
export const emptyRules = (): RelationRules => ({ fields: {} });

/** 以列号和字段名共同定位，保留该列所有数据行，避免同名列互相污染。 */
export function selectRelationField(document: RelationDocument, key: string): RelationDocument {
    const values = document.values.get(key);
    const cells = document.cells.filter(cell => fieldKey(cell.column, cell.field) === key);
    if (!values || !cells.length) { throw new Error('当前字段不存在或为首列 ID，请重新选择数据字段。'); }
    return { cells, values: new Map([[key, values]]), primaryRanges: [] };
}

/** 一组按钮可以对应多个条件规则；先完整校验，再一次修改，禁止部分成功。 */
export function decideRelationRules(previous: RelationRules, field: string, keys: string[], decision: 'accepted' | 'rejected'): RelationRules {
    if (!keys.length || keys.some(key => !previous.fields[field]?.targets[key])) { throw new Error('该候选已失效，请重新打开提示。'); }
    const next = structuredClone(previous);
    for (const key of new Set(keys)) { next.fields[field].targets[key].decision = decision; }
    return next;
}

/** 值仅按标量/数组展开，组合字符串不猜测数量等数字；i18n 可从组合字符串中提取。 */
export function referenceValues(value: unknown): string[] {
    if (Array.isArray(value)) { return [...new Set(value.flatMap(referenceValues))]; }
    if (typeof value === 'number') { return [String(value)]; }
    if (typeof value !== 'string' || !value.trim()) { return []; }
    const keys = value.match(/\bi18n_[A-Za-z0-9_]+\b/g);
    return [...new Set(keys?.length ? keys : [value.trim()])];
}

/** 条件读取当前记录的其他字段；嵌套数组内的每个组合值分别提取指定项。 */
export function valuesForRule(cell: RelationCell, rule: TargetRule): string[] {
    if (rule.when && !referenceValues(cell.row[rule.when.field]).some(value => rule.when!.values.some(expected => String(expected) === value))) { return []; }
    const extract = rule.extract;
    if (!extract) { return cell.values; }
    const selected = extract.arrayIndex === undefined ? cell.raw : Array.isArray(cell.raw) ? cell.raw[extract.arrayIndex] : undefined;
    if (extract.separator === undefined) { return referenceValues(selected); }
    const values = (raw: unknown): string[] => {
        if (Array.isArray(raw)) { return raw.flatMap(values); }
        if (typeof raw !== 'string' && typeof raw !== 'number') { return []; }
        const entries = extract.listSeparator ? String(raw).split(extract.listSeparator) : [String(raw)];
        return entries.flatMap(entry => referenceValues(entry.split(extract.separator!)[extract.index!]));
    };
    return [...new Set(values(selected))];
}

/** 打开文件只加载已有且适用的规则目标，不依据碰巧相同的数字扩大查询。 */
export function targetsForDocument(rules: RelationRules, document: RelationDocument): RelationTarget[] {
    const targets = new Map<string, RelationTarget>();
    for (const cell of document.cells) {
        for (const candidate of Object.values(rules.fields[fieldKey(cell.column, cell.field)]?.targets ?? {})) {
            if (candidate.decision !== 'rejected' && valuesForRule(cell, candidate).some(value => !value.startsWith('i18n_'))) {
                targets.set(targetKey(candidate.target), candidate.target);
            }
        }
    }
    return [...targets.values()];
}

/** 首列始终跳过。保留每个单元格源码范围，紧凑 JSON、数组和同名字段按列区分。 */
export function parseRelations(text: string, jsonc = false): RelationDocument {
    const errors: ParseError[] = [];
    const root = parseTree(text, errors, { allowTrailingComma: jsonc, disallowComments: !jsonc });
    const result: RelationDocument = { cells: [], values: new Map(), primaryRanges: [] };
    const [header, ...rows] = root?.children ?? [];
    if (errors.length || root?.type !== 'array' || header?.type !== 'array' || !header.children?.length || header.children.some(v => v.type !== 'string')) { return result; }
    for (const row of rows) {
        if (row.type !== 'array') { continue; }
        const primary = row.children?.[0];
        if (primary) { result.primaryRanges.push({ start: primary.offset, end: primary.offset + primary.length }); }
        const rowValues = Object.fromEntries(header.children.map((field, column) => [String(field.value), row.children?.[column] ? getNodeValue(row.children[column]) : undefined]));
        for (let column = 1; column < Math.min(row.children?.length ?? 0, header.children.length); column++) {
            const node = row.children![column];
            const field = String(header.children[column].value);
            const raw: unknown = getNodeValue(node);
            const values = referenceValues(raw);
            result.cells.push({ field, column, values, raw, row: rowValues, start: node.offset, end: node.offset + node.length });
            const key = fieldKey(column, field);
            const all = result.values.get(key) ?? new Set<string>();
            values.forEach(value => all.add(value));
            result.values.set(key, all);
        }
    }
    return result;
}

export function addCandidates(previous: RelationRules, document: RelationDocument, data: TargetData[], rescan = false): RelationRules {
    const next: RelationRules = structuredClone(previous);
    if (!rescan) { return next; }
    for (const [field, values] of document.values) {
        const rule = next.fields[field] ?? { scanned: false, targets: {} };
        if (rule.scanned && !rescan) { continue; }
        for (const table of data) {
            const key = targetKey(table.target);
            // 手动扫描也不为已配置条件规则的目标再补一个无条件候选。
            if (Object.values(rule.targets).some(candidate => targetKey(candidate.target) === key)) { continue; }
            if ([...values].some(value => !value.startsWith('i18n_') && table.rows.has(value))) {
                rule.targets[key] = { target: table.target, decision: 'pending' };
            }
        }
        rule.scanned = true;
        next.fields[field] = rule;
    }
    return next;
}

/** XLSM 主键索引按页签共享；缓存命中后不重读整本表。 */
export class RelationIndex {
    private readonly index: TableIndex;
    private all?: Promise<TargetData[]>;
    private readonly tables = new Map<string, Promise<TargetData>>();
    constructor(private readonly settings: TableSettings) { this.index = new TableIndex(settings); }

    read(target: RelationTarget): Promise<TargetData> {
        const key = targetKey(target);
        let result = this.tables.get(key);
        if (!result) {
            result = this.readTarget(target);
            this.tables.set(key, result);
            void result.catch(() => this.tables.delete(key));
        }
        return result;
    }

    private async readTarget(target: RelationTarget): Promise<TargetData> {
        const file = path.resolve(this.settings.directory, target.file);
        const relative = path.relative(this.settings.directory, file);
        if (relative.startsWith('..') || path.isAbsolute(relative)) { throw new Error('关联表路径超出策划目录。'); }
        const rows = await readSheetRows(file, target.sheet, Number.MAX_SAFE_INTEGER);
        const fields = rows.get(this.settings.fieldRow);
        const keyField = (target.keyField ?? 'ID').toLowerCase();
        const idColumn = [...fields ?? []].find(([, field]) => field.trim().toLowerCase() === keyField)?.[0];
        const result: TargetData = { target, rows: new Map() };
        if (!idColumn && target.keyField) { throw new Error(`关联表 ${target.file} / ${target.sheet} 缺少键字段 ${target.keyField}。`); }
        if (!idColumn) { return result; }
        for (const [row, cells] of rows) {
            if (row <= this.settings.fieldRow) { continue; }
            const id = cells.get(idColumn)?.trim();
            if (!id) { continue; }
            // 全扫描只保留名称/说明摘要；完整记录在点击时读取，避免常驻复制数十万行全部列。
            const record: RelationRow = { id, row, values: [...fields!].filter(([, field]) => /name|desc|名称|说明/i.test(field)).slice(0, 3).map(([column, field]) => [field, cells.get(column) ?? '']) };
            const matches = result.rows.get(id) ?? [];
            matches.push(record);
            result.rows.set(id, matches);
        }
        return result;
    }

    async records(target: RelationTarget, id: string): Promise<RelationRow[]> {
        const cached = await this.read(target);
        const matches = cached.rows.get(id) ?? [];
        if (!matches.length) { return []; }
        const rows = await readSheetRows(path.resolve(this.settings.directory, target.file), target.sheet, Math.max(...matches.map(row => row.row)));
        const fields = rows.get(this.settings.fieldRow) ?? new Map<string, string>();
        return matches.map(record => ({ id, row: record.row,
            values: [...fields].filter(([, field]) => field.trim()).map(([column, field]) => [field, rows.get(record.row)?.get(column) ?? ''])
        }));
    }

    scan(): Promise<TargetData[]> {
        this.all ??= (async () => {
            const result: TargetData[] = [];
            for (const source of await this.index.sources()) {
                // 逐页签读取，避免同时展开数百张表造成内存/句柄峰值。
                result.push(await this.read({ ...source, file: path.relative(this.settings.directory, source.file) }));
            }
            return result;
        })();
        return this.all;
    }
}

export function parseTranslations(text: string): Map<string, string> {
    const value: unknown = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (!Array.isArray(value) || !Array.isArray(value[0])) { throw new Error('中文表应为首行字段名的二维数组。'); }
    const keys = value[0].map(v => String(v).toLowerCase());
    const key = keys.indexOf('keyid'), desc = keys.indexOf('desc');
    if (key < 0 || desc < 0) { throw new Error('中文表缺少 KeyID / Desc 列。'); }
    const result = new Map<string, string>();
    for (const row of value.slice(1)) {
        if (Array.isArray(row) && typeof row[key] === 'string') { result.set(row[key], String(row[desc] ?? '')); }
    }
    return result;
}

export async function readTranslations(file: string) { return parseTranslations(await fs.readFile(file, 'utf8')); }
