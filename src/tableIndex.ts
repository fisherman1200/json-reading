import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { readSheetNames, readSheetRows } from './workbookReader';

export interface TableSettings {
    directory: string;
    registry: string;
    fieldRow: number;
    descriptionRow: number;
    detailRow: number;
    overrides: Record<string, string>;
}
export interface FieldDescription { description: string; detail: string }
export interface TableSource { file: string; sheet: string }
export interface TableResult {
    state: 'ready' | 'missing' | 'ambiguous' | 'error';
    message?: string;
    source?: TableSource;
    fields?: Map<string, FieldDescription>;
    candidates?: TableSource[];
}

/** @ / ^ 仅表示导出端；用于匹配时移除前缀及文件扩展名。 */
export function configName(name: string): string {
    return path.basename(name.trim()).replace(/^[@^]/, '').replace(/\.(jsonc?|csv)$/i, '').toLowerCase();
}

/** 递归扫描源码目录，不进入 Git 元数据、依赖目录或符号链接。 */
async function workbookFiles(directory: string): Promise<string[]> {
    const result: string[] = [];
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (entry.name.startsWith('~$') || ['.git', 'node_modules'].includes(entry.name)) { continue; }
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) { result.push(...await workbookFiles(file)); }
        else if (entry.isFile() && /\.xlsm$/i.test(entry.name)) { result.push(file); }
    }
    return result.sort();
}

/** 一个配置对应一个索引实例；所有并发查询共用初始化，文件变化后由上层整体替换实例。 */
export class TableIndex {
    private index?: Promise<{ registry: Map<string, Set<string>>; sheets: Map<string, string[]> }>;
    private headers = new Map<string, Promise<Map<string, FieldDescription>>>();

    constructor(readonly settings: TableSettings, private log: (message: string) => void = () => {}) {}

    /** 关联搜索覆盖全部页签，注册名仅用于标识；未注册但有 ID 列的页签也可匹配。 */
    async sources(): Promise<(TableSource & { names: string[] })[]> {
        this.index ??= this.build();
        const { registry, sheets } = await this.index;
        return [...sheets].flatMap(([sheet, files]) => files.map(file => ({
            file, sheet, names: [...registry].filter(([, names]) => names.has(sheet)).map(([name]) => name)
        })));
    }

    private async build() {
        const files = await workbookFiles(this.settings.directory);
        const registries = this.settings.registry
            ? [path.resolve(this.settings.directory, this.settings.registry)]
            : files.filter(file => path.basename(file) === '注册表.xlsm');
        if (registries.length !== 1) {
            throw new Error(registries.length ? '存在多个注册表，请设置注册表相对路径。' : '未找到注册表.xlsm。');
        }
        const registryFile = registries[0];
        const registry = new Map<string, Set<string>>();
        for (const sheet of await readSheetNames(registryFile)) {
            const rows = await readSheetRows(registryFile, sheet.name, Number.MAX_SAFE_INTEGER);
            for (const [row, cells] of rows) {
                if (row === 1) { continue; }
                const sheetName = cells.get('A')?.trim();
                const exported = cells.get('B')?.trim();
                if (!sheetName || !exported) { continue; }
                const key = configName(exported);
                const names = registry.get(key) ?? new Set<string>();
                names.add(sheetName);
                registry.set(key, names);
            }
        }
        const sheets = new Map<string, string[]>();
        let failed = 0;
        for (const file of files) {
            if (file === registryFile) { continue; }
            try {
                for (const sheet of await readSheetNames(file)) {
                    const owners = sheets.get(sheet.name) ?? [];
                    owners.push(file);
                    sheets.set(sheet.name, owners);
                }
            } catch (error) { failed++; this.log(`无法索引 ${file}：${String(error)}`); }
        }
        this.log(`索引完成：${files.length} 个工作簿，${registry.size} 个注册项，${failed} 个文件读取失败。`);
        // 索引不完整时不能把尚未发现的重名页签误判为唯一匹配。
        if (failed) { throw new Error(`${failed} 个工作簿无法读取，请查看“JSON Reading”输出并刷新索引。`); }
        return { registry, sheets };
    }

    private async readFields(source: TableSource) {
        const { fieldRow, descriptionRow, detailRow } = this.settings;
        const rows = await readSheetRows(source.file, source.sheet, Math.max(fieldRow, descriptionRow, detailRow));
        const fields = new Map<string, FieldDescription>();
        for (const [column, raw] of rows.get(fieldRow) ?? []) {
            const field = raw.trim();
            if (!field) { continue; }
            if (fields.has(field)) { throw new Error(`页签 ${source.sheet} 存在重复字段：${field}`); }
            fields.set(field, {
                description: rows.get(descriptionRow)?.get(column)?.trim() ?? '',
                detail: rows.get(detailRow)?.get(column)?.trim() ?? ''
            });
        }
        if (!fields.size) { throw new Error(`页签 ${source.sheet} 第 ${fieldRow} 行没有字段名。`); }
        return fields;
    }

    async lookup(jsonFile: string): Promise<TableResult> {
        try {
            this.index ??= this.build();
            const { registry, sheets } = await this.index;
            const key = configName(jsonFile);
            // JSON 导出文件固定追加 Data：只去掉末尾一个后缀，再查询注册表。
            // 注册表名称和工作簿选择键保持原样，中间的 Data 不受影响。
            const registryKey = key.replace(/data$/, '');
            const names = registry.get(registryKey);
            if (!names) {
                return { state: 'missing', message: `注册表中没有此 JSON 的对应记录：${path.basename(jsonFile)}（查找名称：${registryKey}）。` };
            }
            let candidates: TableSource[] = [...names].flatMap(sheet => (sheets.get(sheet) ?? []).map(file => ({ file, sheet })));
            const override = Object.entries(this.settings.overrides).find(([name]) => configName(name) === key)?.[1];
            if (override) {
                const selected = path.resolve(this.settings.directory, override);
                candidates = candidates.filter(source => source.file === selected);
            }
            if (!candidates.length) { return { state: 'missing', message: `找不到注册页签：${[...names].join('、')}${override ? '（请检查工作簿选择）' : ''}` }; }
            if (candidates.length > 1) {
                return { state: 'ambiguous', message: '存在同名页签，请运行“JSON Reading: 选择当前 JSON 的策划工作簿”。', candidates };
            }
            const source = candidates[0];
            const cacheKey = JSON.stringify(source);
            let fields = this.headers.get(cacheKey);
            if (!fields) { fields = this.readFields(source); this.headers.set(cacheKey, fields); }
            return { state: 'ready', source, fields: await fields };
        } catch (error) {
            this.log(String(error));
            return { state: 'error', message: `策划表读取失败：${error instanceof Error ? error.message : String(error)}` };
        }
    }
}
