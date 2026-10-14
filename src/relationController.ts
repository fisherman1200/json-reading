import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { TableDescriptions } from './tableDescriptions';
import { addCandidates, emptyRules, parseRelations, readTranslations, RelationIndex, targetKey, targetsForDocument, fieldKey, selectRelationField, decideRelationRules,
    type RelationCell, type RelationDocument, type RelationRules, type TargetData } from './relations';
import { configName } from './tableIndex';
import { RelationStore, isRelationFile, normalizeRules } from './relationStore';
import { resolveRelationDocument } from './relationDocument';

export const relationCommands = {
    decide: 'json-reading.decideRelation', rescan: 'json-reading.rescanRelations',
    clear: 'json-reading.clearRelations', details: 'json-reading.relationDetails'
};
export interface RelationState {
    parsed: RelationDocument; rules: RelationRules; data: TargetData[];
    translations: Map<string, string>; loading: boolean; tableDirectory: string; error?: string; translationError?: string;
}
export interface RelationView { uri: string; cells: RelationCell[]; state: RelationState }
class RelationActionCancelled extends Error {}

/** 每个项目共用一个匹配文件，内部按源 JSON 相对路径隔离。 */
export class RelationController implements vscode.Disposable {
    private readonly changed = new vscode.EventEmitter<string>();
    readonly onDidChange = this.changed.event;
    private readonly subscriptions: vscode.Disposable[] = [];
    private readonly states = new Map<string, { version: number; state: RelationState }>();
    private readonly parsedDocuments = new Map<string, { version: number; parsed: RelationDocument }>();
    private readonly epochs = new Map<string, number>();
    private index?: RelationIndex;
    private disposed = false;
    private writes: Promise<void> = Promise.resolve();
    private actions: Promise<void> = Promise.resolve();
    private readonly stores = new Map<string, RelationStore>();
    private readonly storeContents = new Map<string, string>();
    private readonly storeTimers = new Map<string, ReturnType<typeof setTimeout>>();

    constructor(private readonly context: vscode.ExtensionContext, private readonly tables: TableDescriptions) {
        const invalidate = () => {
            this.index = undefined;
            for (const uri of this.states.keys()) { this.bump(uri); }
            this.states.clear();
            this.changed.fire('');
        };
        const guarded = (action: (...args: unknown[]) => Promise<string | void>, title?: string | ((...args: unknown[]) => string)) => async (...args: unknown[]) => {
            try {
                if (!vscode.workspace.isTrusted) { throw new Error('请先信任当前工作区。'); }
                // 连续点击多个候选也按顺序保存，避免后一次覆盖前一次确认。
                const operation = this.actions.catch(() => {}).then(() => title
                    ? vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: typeof title === 'string' ? title : title(...args) }, () => action(...args))
                    : action(...args));
                this.actions = operation.then(() => {}, () => {});
                const message = await operation;
                if (message) { void vscode.window.showInformationMessage(message); }
            } catch (error) {
                const message = `关联查询：${error instanceof Error ? error.message : String(error)}`;
                if (error instanceof RelationActionCancelled) { void vscode.window.showWarningMessage(message); }
                else { void vscode.window.showErrorMessage(message); }
            }
        };
        this.subscriptions.push(
            tables.onDidInvalidate(invalidate),
            vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('json-reading.relations')) { invalidate(); } }),
            vscode.workspace.onDidChangeTextDocument(e => {
                if (/i18zhConfigData\.json$/i.test(e.document.uri.fsPath)) { invalidate(); }
            }),
            vscode.workspace.onDidCloseTextDocument(doc => {
                this.bump(doc.uri.toString()); this.states.delete(doc.uri.toString()); this.parsedDocuments.delete(doc.uri.toString());
            }),
            vscode.commands.registerCommand(relationCommands.decide, guarded((...args) => this.decide(...args), (...args) => args[3] === 'accepted' ? '正在确认关联…' : '正在排除关联…')),
            vscode.commands.registerCommand(relationCommands.rescan, guarded((value, field) => this.rescan(value, field), '正在全搜索当前字段关联…')),
            vscode.commands.registerCommand(relationCommands.clear, guarded(value => this.clear(value), '正在清空当前 JSON 的匹配表…')),
            vscode.commands.registerCommand(relationCommands.details, guarded((...args) => this.details(...args)))
        );
        const watcher = vscode.workspace.createFileSystemWatcher('**/i18zhConfigData.json');
        this.subscriptions.push(watcher, watcher.onDidChange(invalidate), watcher.onDidCreate(invalidate), watcher.onDidDelete(invalidate));
    }

    private bump(uri: string) { const next = (this.epochs.get(uri) ?? 0) + 1; this.epochs.set(uri, next); return next; }
    private ensureCurrent(valid: () => boolean) {
        if (!valid()) { throw new RelationActionCancelled('文档或索引已变化，本次操作已结束，请重新查看后再操作。'); }
    }
    private legacyKey(uri: string) {
        return `relations.v1.${createHash('sha256').update(process.platform === 'win32' ? uri.toLowerCase() : uri).digest('hex')}`;
    }
    private async storeFor(document: vscode.TextDocument): Promise<RelationStore> {
        let root = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
        // 调试时打开项目外的 JSON，也优先找其自身 Git 根目录，不能写到扩展源码项目。
        if (!root) {
            let directory = path.dirname(document.uri.fsPath);
            while (true) {
                if (await fs.stat(path.join(directory, '.git')).then(() => true, () => false)) { root = directory; break; }
                const parent = path.dirname(directory);
                if (parent === directory) { break; }
                directory = parent;
            }
        }
        if (!root) { throw new Error('请打开此 JSON 所属的项目文件夹，以确定共享匹配表的位置。'); }
        let store = this.stores.get(root);
        if (!store) {
            store = new RelationStore(root);
            this.stores.set(root, store);
            const file = store.file;
            const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, 'extensions/json_reading/relations.json'));
            const changed = () => {
                clearTimeout(this.storeTimers.get(file));
                this.storeTimers.set(file, setTimeout(() => {
                    this.storeTimers.delete(file);
                    void fs.readFile(file, 'utf8').catch(() => '').then(content => {
                        if (this.disposed || this.storeContents.get(file) === content) { return; }
                        this.storeContents.set(file, content);
                        for (const uri of this.states.keys()) { this.bump(uri); }
                        this.states.clear();
                        this.changed.fire('');
                    });
                }, 200));
            };
            this.subscriptions.push(watcher, watcher.onDidCreate(changed), watcher.onDidChange(changed), watcher.onDidDelete(changed));
        }
        return store;
    }
    private async stored(document: vscode.TextDocument): Promise<RelationRules> {
        const store = await this.storeFor(document);
        const rules = await store.read(document.uri.fsPath);
        this.storeContents.set(store.file, await fs.readFile(store.file, 'utf8').catch(() => ''));
        if (rules) { return rules; }
        const legacy = this.context.workspaceState.get<{ directory: string; rules: RelationRules }>(this.legacyKey(document.uri.toString()));
        return legacy?.directory === this.tables.directory ? normalizeRules(legacy.rules) : emptyRules();
    }
    private parsed(document: vscode.TextDocument): RelationDocument {
        const uri = document.uri.toString();
        let cached = this.parsedDocuments.get(uri);
        if (cached?.version !== document.version) {
            cached = { version: document.version, parsed: parseRelations(document.getText(), document.languageId === 'jsonc') };
            this.parsedDocuments.set(uri, cached);
        }
        return cached.parsed;
    }
    private save(uri: string, rules: RelationRules | undefined, valid: () => boolean): Promise<void> {
        const next = rules ? structuredClone(rules) : undefined;
        const base = structuredClone(this.states.get(uri)?.state.rules ?? emptyRules());
        const operation = this.writes.catch(() => {}).then(async () => {
            this.ensureCurrent(valid);
            const document = this.document(uri), store = await this.storeFor(document);
            const dirty = vscode.workspace.textDocuments.find(doc => doc.uri.fsPath === store.file && doc.isDirty);
            if (dirty) { throw new Error('共享匹配表有未保存修改，请先保存后再操作。'); }
            this.ensureCurrent(valid);
            const exists = await store.read(document.uri.fsPath);
            this.ensureCurrent(valid);
            await store.write(document.uri.fsPath, next, exists ? base : emptyRules());
            this.storeContents.set(store.file, await fs.readFile(store.file, 'utf8'));
            await this.context.workspaceState.update(this.legacyKey(uri), undefined);
            this.ensureCurrent(valid);
            if (valid() && next) {
                const state = this.states.get(uri)?.state;
                if (state) { state.rules = await store.read(document.uri.fsPath) ?? emptyRules(); }
            }
        });
        this.writes = operation;
        return operation;
    }

    get(document: vscode.TextDocument): RelationState | undefined {
        if (this.disposed || !vscode.workspace.isTrusted || document.uri.scheme !== 'file' || isRelationFile(document.uri.fsPath) || !['json', 'jsonc'].includes(document.languageId)) { return; }
        const uri = document.uri.toString();
        const existing = this.states.get(uri);
        if (existing?.version === document.version) { return existing.state; }
        if (this.tables.isUpdating) { return; }
        const parsed = this.parsed(document);
        if (!parsed.cells.length) { return; }
        const state: RelationState = { parsed, rules: emptyRules(), data: [], translations: new Map(), loading: true, tableDirectory: this.tables.directory };
        this.states.set(uri, { version: document.version, state });
        void this.load(document, state);
        return state;
    }

    view(document: vscode.TextDocument, line: number): RelationView | undefined {
        if (isRelationFile(document.uri.fsPath)) { return; }
        const start = document.offsetAt(new vscode.Position(line, 0));
        const end = document.offsetAt(document.lineAt(line).range.end);
        const cells = this.parsed(document).cells.filter(cell => cell.start <= end && cell.end > start);
        // 只查看首列 ID 时不触发任何关联 I/O。
        if (!cells.length) { return; }
        const state = this.get(document);
        return state ? { uri: document.uri.toString(), cells, state } : undefined;
    }

    private async load(document: vscode.TextDocument, state: RelationState, scanField?: string) {
        const uri = document.uri.toString(), epoch = this.bump(uri);
        const version = document.version;
        const valid = () => !this.disposed && !document.isClosed && this.epochs.get(uri) === epoch && document.version === version;
        const rescan = scanField !== undefined;
        try {
            state.translationError = undefined;
            state.rules = await this.stored(document);
            this.ensureCurrent(valid);
            const hasI18n = [...state.parsed.values.values()].some(values => [...values].some(value => value.startsWith('i18n_')));
            if (hasI18n) {
                const configured = vscode.workspace.getConfiguration('json-reading.relations', document).get<string>('i18nFile', '').trim();
                const file = configured ? path.resolve(path.dirname(document.uri.fsPath), configured)
                    : path.join(path.dirname(document.uri.fsPath), 'i18zhConfigData.json');
                try { state.translations = await readTranslations(file); }
                catch (error) { state.translationError = `中文表读取失败：${error instanceof Error ? error.message : String(error)}`; }
                if (valid()) { this.changed.fire(uri); }
            }
            this.ensureCurrent(valid);
            // 全表 ID 碰撞只保留为用户主动操作，缺少匹配表也不自动触发。
            const selected = scanField === undefined ? undefined : selectRelationField(state.parsed, scanField);
            const needsScan = selected && [...selected.values.values()].some(values => [...values].some(value => !value.startsWith('i18n_')));
            if (!this.tables.directory && needsScan) { throw new Error('请先选择策划表目录，再进行全表关联搜索。'); }
            let rules = state.rules;
            if (needsScan) {
                this.index ??= new RelationIndex(this.tables.tableSettings);
                const own = configName(document.uri.fsPath).replace(/data$/, '');
                const all = (await this.index.scan()).filter(table => !table.target.names.includes(own));
                this.ensureCurrent(valid);
                rules = addCandidates(rules, selected!, all, true);
            } else if (selected) { rules = addCandidates(rules, selected, [], true); }
            const targets = targetsForDocument(rules, state.parsed);
            if (targets.length) {
                if (!this.tables.directory) { throw new Error('请先选择策划表目录，再读取已配置的关联。'); }
                this.index ??= new RelationIndex(this.tables.tableSettings);
                const loaded = await Promise.allSettled(targets.map(target => this.index!.read(target)));
                state.data = loaded.flatMap(item => item.status === 'fulfilled' ? [item.value] : []);
                const failed = loaded.flatMap(item => item.status === 'rejected' ? [item.reason instanceof Error ? item.reason.message : String(item.reason)] : []);
                if (failed.length) {
                    state.error = `部分关联表读取失败：${[...new Set(failed)].join('；')}`;
                    if (rescan) { throw new Error(state.error); }
                }
            }
            this.ensureCurrent(valid);
            if (rescan) { await this.save(uri, rules, valid); }
            this.ensureCurrent(valid);
        } catch (error) {
            if (valid()) { state.error = `关联搜索失败：${error instanceof Error ? error.message : String(error)}（未将失败记为空结果）`; }
            if (rescan) { throw error; }
        } finally {
            if (valid()) { state.loading = false; this.changed.fire(uri); }
        }
    }

    private document(value: unknown): vscode.TextDocument {
        return resolveRelationDocument(value, vscode.workspace.textDocuments, vscode.window.activeTextEditor?.document);
    }

    private readyState(document: vscode.TextDocument): RelationState {
        if (this.disposed) { throw new Error('扩展已关闭，请重新加载窗口。'); }
        if (this.tables.isUpdating) { throw new Error('策划表正在更新，请完成后重试。'); }
        const state = this.get(document);
        if (!state) { throw new Error('当前文件没有可操作的数据字段；首列 ID 不参与关联查询。'); }
        if (state.loading) { throw new Error('关联数据正在读取，请完成后重试。'); }
        return state;
    }

    private async scanField(document: vscode.TextDocument, parsed: RelationDocument, requested: unknown): Promise<string> {
        if (requested !== undefined) {
            if (typeof requested !== 'string') { throw new Error('字段参数无效，请重新打开悬浮提示。'); }
            selectRelationField(parsed, requested);
            return requested;
        }
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document !== document) { throw new Error('请在对应 JSON 的数据字段上放置光标后再全搜索。'); }
        const position = editor.selection.active, offset = document.offsetAt(position);
        if (parsed.primaryRanges.some(range => range.start <= offset && offset < range.end)) { throw new Error('首列 ID 不参与关联搜索，请选择其他数据字段。'); }
        let cells = parsed.cells.filter(cell => cell.start <= offset && offset < cell.end);
        if (!cells.length) {
            const line = document.lineAt(position.line), start = document.offsetAt(line.range.start), end = document.offsetAt(line.range.end);
            cells = parsed.cells.filter(cell => cell.start <= end && cell.end > start);
        }
        const choices = [...new Map(cells.map(cell => [fieldKey(cell.column, cell.field), { label: cell.field, description: `第 ${cell.column + 1} 列`, key: fieldKey(cell.column, cell.field) }])).values()];
        if (!choices.length) { throw new Error('当前光标不在可搜索的数据字段上，首列 ID 不参与关联搜索。'); }
        if (choices.length === 1) { return choices[0].key; }
        const selected = await vscode.window.showQuickPick(choices, { title: '选择要全搜索的字段', placeHolder: '仅搜索选中字段在此 JSON 中的所有记录' });
        if (!selected) { throw new RelationActionCancelled('已取消字段全搜索。'); }
        return selected.key;
    }

    private async decide(...args: unknown[]) {
        const [uri, field, key, decision] = args;
        const document = this.document(uri);
        const state = this.readyState(document);
        const keys = typeof key === 'string' ? [key] : key;
        if (typeof field !== 'string' || !Array.isArray(keys) || !keys.length || keys.some(item => typeof item !== 'string') || (decision !== 'accepted' && decision !== 'rejected')) { throw new Error('关联操作参数无效，请重新打开悬浮提示。'); }
        selectRelationField(state.parsed, field);
        const next = decideRelationRules(state.rules, field, keys, decision);
        const id = document.uri.toString(), epoch = this.bump(id), version = document.version;
        const valid = () => !this.disposed && !document.isClosed && this.epochs.get(id) === epoch && document.version === version;
        await this.save(id, next, valid);
        this.ensureCurrent(valid);
        this.changed.fire(id);
        return `${decision === 'accepted' ? '已确认' : '已排除'}字段「${JSON.parse(field)[1]}」的关联。`;
    }

    private async rescan(value: unknown, requested: unknown) {
        const document = this.document(value), state = this.readyState(document), version = document.version;
        const field = await this.scanField(document, state.parsed, requested);
        if (document.isClosed || document.version !== version || this.states.get(document.uri.toString())?.state !== state) { throw new RelationActionCancelled('文档已变化，请重新选择字段后再搜索。'); }
        const before = Object.keys(state.rules.fields[field]?.targets ?? {}).length;
        this.index = new RelationIndex(this.tables.tableSettings);
        state.loading = true; state.error = undefined;
        this.changed.fire(document.uri.toString());
        await this.load(document, state, field);
        this.ensureCurrent(() => !this.disposed && !document.isClosed && document.version === version && this.states.get(document.uri.toString())?.state === state);
        const added = Math.max(0, Object.keys(state.rules.fields[field]?.targets ?? {}).length - before);
        return `字段「${JSON.parse(field)[1]}」全搜索完成，新增 ${added} 个候选。`;
    }

    private async clear(value: unknown) {
        const document = this.document(value), uri = document.uri.toString(), epoch = this.bump(uri), version = document.version;
        if (this.disposed) { throw new Error('扩展已关闭，请重新加载窗口。'); }
        if (this.tables.isUpdating) { throw new Error('策划表正在更新，请完成后重试。'); }
        const valid = () => !this.disposed && !document.isClosed && this.epochs.get(uri) === epoch && document.version === version;
        await this.save(uri, undefined, valid);
        this.ensureCurrent(valid);
        this.states.delete(uri);
        this.changed.fire(uri);
        return `已清空 ${path.basename(document.uri.fsPath)} 的关联匹配表，其他 JSON 保持不变。`;
    }

    private async details(...args: unknown[]) {
        const [uri, key, id] = args;
        const document = this.document(uri), state = this.get(document);
        const table = state?.data.find(item => targetKey(item.target) === key);
        const rows = typeof id === 'string' ? table?.rows.get(id) : undefined;
        if (!table || !rows) { throw new Error('关联数据已失效，请重新查询。'); }
        const records = await this.index!.records(table.target, String(id));
        const content = JSON.stringify({ source: table.target, records }, null, 2);
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'json', content }), { preview: true });
    }

    dispose() {
        this.disposed = true;
        this.storeTimers.forEach(timer => clearTimeout(timer));
        this.subscriptions.forEach(item => item.dispose());
        this.states.clear(); this.parsedDocuments.clear(); this.changed.dispose();
    }
}
