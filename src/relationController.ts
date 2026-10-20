import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parse, type ParseError } from 'jsonc-parser';
import type { TableDescriptions } from './tableDescriptions';
import { addCandidates, addManualRelation, emptyRules, parseRelations, readTranslations, RelationIndex, targetKey, ruleKey, targetsForDocument, fieldKey, selectRelationField, decideRelationRules, valuesForRule, relationCellsInRange,
    type RelationCell, type RelationDocument, type RelationRules, type TargetData, type RelationTarget, type RelationRow } from './relations';
import { configName } from './tableIndex';
import { RelationStore, isRelationFile, normalizeRules } from './relationStore';
import { resolveRelationDocument } from './relationDocument';
import { RelationCascade, type CascadeRow } from './relationCascade';
import { RelationExpansionState, cascadeRootKey, cascadeBranchKeys } from './relationExpansion';

export const relationCommands = {
    decide: 'json-reading.decideRelation', rescan: 'json-reading.rescanRelations',
    clear: 'json-reading.clearRelations', details: 'json-reading.relationDetails',
    toggle: 'json-reading.toggleRelationExpansion', add: 'json-reading.addRelation'
};
export interface RelationState {
    parsed: RelationDocument; rules: RelationRules; data: TargetData[];
    translations: Map<string, string>; loading: boolean; tableDirectory: string; error?: string; translationError?: string;
}
export interface RelationResult {
    field: string; column: number; target: RelationTarget; id: string; rows: RelationRow[]; loading: boolean; error?: string;
    expandedRows?: CascadeRow[];
}
export interface RelationView {
    uri: string; cells: RelationCell[]; state: RelationState; results?: RelationResult[];
    expansion?: { version: number; line: number; expanded: ReadonlySet<string>; collapsed?: ReadonlySet<string> };
}
class RelationActionCancelled extends Error {}

/** 每个项目共用一个匹配文件，内部按源 JSON 相对路径隔离。 */
export class RelationController implements vscode.Disposable {
    private readonly changed = new vscode.EventEmitter<string>();
    readonly onDidChange = this.changed.event;
    private readonly expansionChanged = new vscode.EventEmitter<{ uri: string; line: number; version: number }>();
    readonly onDidToggleExpansion = this.expansionChanged.event;
    private readonly expansion: RelationExpansionState;
    private readonly subscriptions: vscode.Disposable[] = [];
    private readonly states = new Map<string, { version: number; state: RelationState }>();
    private readonly parsedDocuments = new Map<string, { version: number; parsed: RelationDocument }>();
    private readonly detailViews = new WeakMap<RelationState, {
        epoch: number | undefined; index: RelationIndex; rules: RelationRules; revision: number;
        lines: Map<number, RelationResult[]>; cascade?: Promise<RelationCascade>;
    }>();
    private readonly detailNotifications = new Map<string, { timer: ReturnType<typeof setTimeout>; lines: Map<number, () => boolean> }>();
    private readonly cascadeWatchers = new Set<string>();
    private cascadeInvalidation?: ReturnType<typeof setTimeout>;
    private cascadeRevision = 0;
    private readonly epochs = new Map<string, number>();
    private index?: RelationIndex;
    private disposed = false;
    private writes: Promise<void> = Promise.resolve();
    private actions: Promise<void> = Promise.resolve();
    private readonly stores = new Map<string, RelationStore>();
    private readonly storeContents = new Map<string, string>();
    private readonly storeTimers = new Map<string, ReturnType<typeof setTimeout>>();

    constructor(private readonly context: vscode.ExtensionContext, private readonly tables: TableDescriptions) {
        this.expansion = new RelationExpansionState(context.workspaceState);
        const invalidate = () => this.invalidate();
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
                const message = `关联查询: ${error instanceof Error ? error.message : String(error)}`;
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
            vscode.commands.registerCommand(relationCommands.add, guarded((value, field) => this.add(value, field), '正在添加字段关联…')),
            vscode.commands.registerCommand(relationCommands.rescan, guarded((value, field) => this.rescan(value, field), '正在全搜索当前字段关联…')),
            vscode.commands.registerCommand(relationCommands.clear, guarded(value => this.clear(value), '正在清空当前 JSON 的匹配表…')),
            vscode.commands.registerCommand(relationCommands.details, guarded((...args) => this.details(...args))),
            vscode.commands.registerCommand(relationCommands.toggle, guarded((value, version, line, key, expanded) => this.toggleExpansion(value, version, line, key, expanded)))
        );
        const watcher = vscode.workspace.createFileSystemWatcher('**/i18zhConfigData.json');
        this.subscriptions.push(watcher, watcher.onDidChange(invalidate), watcher.onDidCreate(invalidate), watcher.onDidDelete(invalidate));
    }

    private invalidate() {
        this.index = undefined;
        for (const uri of this.states.keys()) { this.bump(uri); }
        this.states.clear();
        this.changed.fire('');
    }

    /** 目标 JSON 可以在工作区外；只监听级联实际读取的文件，保存/拉取后废弃旧结果。 */
    private watchCascade(cascade: RelationCascade) {
        if (this.disposed) { return; }
        for (const file of cascade.dependencies) {
            const key = process.platform === 'win32' ? file.toLowerCase() : file;
            if (this.cascadeWatchers.has(key)) { continue; }
            this.cascadeWatchers.add(key);
            const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(path.dirname(file), path.basename(file)));
            const changed = () => {
                clearTimeout(this.cascadeInvalidation);
                this.cascadeInvalidation = setTimeout(() => { if (!this.disposed) { this.invalidate(); } }, 150);
            };
            this.subscriptions.push(watcher, watcher.onDidChange(changed), watcher.onDidCreate(changed), watcher.onDidDelete(changed));
        }
    }

    private async cascadeFor(document: vscode.TextDocument, index: RelationIndex, valid: () => boolean) {
        const store = await this.storeFor(document);
        this.ensureCurrent(valid);
        const rules = await store.snapshot();
        this.ensureCurrent(valid);
        const configured = vscode.workspace.getConfiguration('json-reading.relations', document).get<string>('i18nFile', '').trim();
        return new RelationCascade({ index, root: store.root, sourceFile: document.uri.fsPath, rules,
            i18nFile: configured ? path.resolve(path.dirname(document.uri.fsPath), configured) : undefined });
    }

    private bump(uri: string) {
        clearTimeout(this.detailNotifications.get(uri)?.timer);
        this.detailNotifications.delete(uri);
        const next = (this.epochs.get(uri) ?? 0) + 1; this.epochs.set(uri, next); return next;
    }
    private notifyDetails(uri: string, line: number, valid: () => boolean) {
        // 同次渲染的多个行/目标通常一起完成，只刷新一次，避免 Hover 连续重开。
        const lines = this.detailNotifications.get(uri)?.lines ?? new Map<number, () => boolean>();
        lines.set(line, valid);
        clearTimeout(this.detailNotifications.get(uri)?.timer);
        const entry = { lines, timer: setTimeout(() => {
            if (this.detailNotifications.get(uri) !== entry) { return; }
            this.detailNotifications.delete(uri);
            const completed = new Set([...lines].filter(([, current]) => current()).map(([line]) => line));
            if (!completed.size) { return; }
            // 其他可见行稍后完成只重绘装饰，不能反复关闭/重开当前行 Hover。
            const editor = vscode.window.activeTextEditor;
            this.changed.fire(editor?.document.uri.toString() === uri && completed.has(editor.selection.active.line) ? uri : '');
        }, 0) };
        this.detailNotifications.set(uri, entry);
    }
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
            // 任意目标 JSON 的规则变化，也会影响其他 JSON 已展开的下级关联。
            this.cascadeRevision++;
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
        const cells = relationCellsInRange(this.parsed(document), start, end);
        // 只查看首列 ID 时不触发任何关联 I/O。
        if (!cells.length) { return; }
        const state = this.get(document);
        return state ? { uri: document.uri.toString(), cells, state, results: this.results(document, line, cells, state),
            expansion: { version: document.version, line, expanded: this.expansion.get(document.uri.toString()),
                collapsed: this.expansion.getCollapsed(document.uri.toString()) } } : undefined;
    }

    /** 展开只是个人显示偏好，不修改共享匹配表，也不重新扫描或读取已缓存的记录。 */
    private async toggleExpansion(value: unknown, version: unknown, line: unknown, key: unknown, expanded: unknown) {
        const document = this.document(value), uri = document.uri.toString();
        if (typeof version !== 'number' || version !== document.version || document.isClosed || this.disposed) {
            throw new RelationActionCancelled('文档已变化，请重新查看后再展开或收起。');
        }
        if (typeof line !== 'number' || !Number.isInteger(line) || line < 0 || line >= document.lineCount
            || typeof key !== 'string' || typeof expanded !== 'boolean') { throw new Error('展开参数无效。'); }
        const view = this.view(document, line);
        const validKey = view?.results?.some(result => !result.loading && cascadeBranchKeys(result.expandedRows ?? [],
            cascadeRootKey(result.column, result.field, result.target)).has(key));
        if (!validKey) { throw new RelationActionCancelled('当前关联已变化，请重新查看后再展开或收起。'); }
        const epoch = this.epochs.get(uri), revision = this.cascadeRevision;
        await this.expansion.set(uri, key, expanded);
        if (this.disposed || document.isClosed || document.version !== version || this.epochs.get(uri) !== epoch
            || this.cascadeRevision !== revision) { return; }
        this.changed.fire('');
        this.expansionChanged.fire({ uri, line, version });
    }

    /** 完整关联行只随当前视图请求，文档级加载仍仅保留轻量摘要。 */
    private results(document: vscode.TextDocument, line: number, cells: RelationCell[], state: RelationState): RelationResult[] | undefined {
        const index = this.index;
        if (state.loading || !index || this.tables.isUpdating) { return; }
        const uri = document.uri.toString(), epoch = this.epochs.get(uri), version = document.version;
        let cached = this.detailViews.get(state);
        if (!cached || cached.epoch !== epoch || cached.rules !== state.rules || cached.index !== index || cached.revision !== this.cascadeRevision) {
            cached = { epoch, index, rules: state.rules, revision: this.cascadeRevision, lines: new Map() };
            this.detailViews.set(state, cached);
        }
        const previous = cached.lines.get(line);
        if (previous) { return previous; }
        const results: RelationResult[] = [];
        cached.lines.set(line, results);
        const tables = new Map(state.data.map(table => [targetKey(table.target), table]));
        const groups = new Map<string, { target: RelationTarget; results: RelationResult[] }>();
        const identities = new Set<string>();
        for (const cell of cells) {
            if (cell.column === 0) { continue; }
            const field = fieldKey(cell.column, cell.field);
            for (const candidate of Object.values(state.rules.fields[field]?.targets ?? {})) {
                if (candidate.decision === 'rejected') { continue; }
                const key = targetKey(candidate.target), table = tables.get(key);
                if (!table) { continue; }
                for (const id of valuesForRule(cell, candidate)) {
                    if (id.startsWith('i18n_') || !table.rows.get(id)?.length) { continue; }
                    const identity = JSON.stringify([field, key, id]);
                    if (identities.has(identity)) { continue; }
                    identities.add(identity);
                    const result: RelationResult = { field: cell.field, column: cell.column, target: candidate.target, id, rows: [], loading: true };
                    results.push(result);
                    let group = groups.get(key);
                    if (!group) { group = { target: candidate.target, results: [] }; groups.set(key, group); }
                    group.results.push(result);
                }
            }
        }
        const valid = () => !this.disposed && !document.isClosed && document.version === version && this.epochs.get(uri) === epoch
            && this.states.get(uri)?.state === state && this.index === index && this.detailViews.get(state) === cached && cached.rules === state.rules
            && cached.revision === this.cascadeRevision;
        for (const group of groups.values()) {
            void index.recordsMany(group.target, new Set(group.results.map(result => result.id))).then(async records => {
                if (!valid()) { return; }
                for (const result of group.results) {
                    result.rows = records.get(result.id) ?? [];
                }
                cached.cascade ??= this.cascadeFor(document, index, valid);
                const cascade = await cached.cascade;
                this.ensureCurrent(valid);
                let expanded: CascadeRow[];
                try { expanded = await cascade.expand(group.target, [...records.values()].flat(), valid); }
                finally { if (valid()) { this.watchCascade(cascade); } }
                if (!valid()) { return; }
                for (const result of group.results) {
                    result.expandedRows = expanded.filter(row => row.id === result.id);
                    result.loading = false;
                    if (!result.rows.length) { result.error = '未读取到完整关联记录，请刷新策划表索引。'; }
                }
                this.notifyDetails(uri, line, valid);
            }).catch(error => {
                if (!valid()) { return; }
                for (const result of group.results) {
                    result.loading = false;
                    result.error = error instanceof Error ? error.message : String(error);
                }
                this.notifyDetails(uri, line, valid);
            });
        }
        return results;
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
                catch (error) { state.translationError = `中文表读取失败: ${error instanceof Error ? error.message : String(error)}`; }
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
                    state.error = `部分关联表读取失败: ${[...new Set(failed)].join('；')}`;
                    if (rescan) { throw new Error(state.error); }
                }
            }
            this.ensureCurrent(valid);
            if (rescan) { await this.save(uri, rules, valid); }
            this.ensureCurrent(valid);
        } catch (error) {
            if (valid()) { state.error = `关联搜索失败: ${error instanceof Error ? error.message : String(error)}（未将失败记为空结果）`; }
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

    private async saveAction(uri: string, epoch: number, rules: RelationRules | undefined, valid: () => boolean) {
        try { await this.save(uri, rules, valid); }
        catch (error) {
            // 操作开始已废弃旧请求；保存失败后重新读盘，不能留下永久 loading 的旧视图。
            if (!this.disposed && this.epochs.get(uri) === epoch) {
                this.states.delete(uri);
                this.changed.fire(uri);
            }
            throw error;
        }
    }

    private async scanField(document: vscode.TextDocument, parsed: RelationDocument, requested: unknown, action = '全搜索'): Promise<string> {
        if (requested !== undefined) {
            if (typeof requested !== 'string') { throw new Error('字段参数无效，请重新打开悬浮提示。'); }
            selectRelationField(parsed, requested);
            return requested;
        }
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document !== document) { throw new Error(`请在对应 JSON 的数据字段上放置光标后再${action}。`); }
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
        const selected = await vscode.window.showQuickPick(choices, { title: `选择要${action}的字段`,
            placeHolder: action === '全搜索' ? '仅搜索选中字段在此 JSON 中的所有记录' : '为选中字段在此 JSON 中的所有记录添加关联' });
        if (!selected) { throw new RelationActionCancelled(`已取消字段${action}。`); }
        return selected.key;
    }

    /** 默认搜索当前配置目录；浏览入口只用于选择表，不把目标 JSON 路径写入规则。 */
    private async chooseTargetJson(document: vscode.TextDocument, field: string, valid: () => boolean): Promise<string | undefined> {
        const directory = path.dirname(document.uri.fsPath);
        const entries = await fs.readdir(directory, { withFileTypes: true });
        this.ensureCurrent(valid);
        const choices: (vscode.QuickPickItem & { file?: string; browse?: boolean })[] = entries
            .filter(entry => entry.isFile() && /\.jsonc?$/i.test(entry.name) && !isRelationFile(path.join(directory, entry.name)))
            .sort((left, right) => left.name.localeCompare(right.name))
            .map(entry => ({ label: entry.name, description: directory, file: path.join(directory, entry.name) }));
        choices.push({ label: '浏览其他 JSON 文件…', browse: true });
        const selected = await vscode.window.showQuickPick(choices, {
            title: `为字段「${JSON.parse(field)[1]}」选择目标 JSON`,
            placeHolder: '输入文件名搜索当前目录，或浏览其他 JSON 文件', matchOnDescription: true, ignoreFocusOut: true
        });
        this.ensureCurrent(valid);
        if (!selected) { return; }
        if (!selected.browse) { return selected.file; }
        const files = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
            defaultUri: vscode.Uri.file(directory), filters: { '配置 JSON': ['json', 'jsonc'] }, openLabel: '选择关联目标 JSON' });
        this.ensureCurrent(valid);
        if (!files?.[0]) { return; }
        if (files[0].scheme !== 'file') { throw new Error('请选择本地配置 JSON 文件。'); }
        return files[0].fsPath;
    }

    /** 文件选择只接受现有表格格式；普通 JSON 和共享匹配表不能充当配置表。 */
    private async validateTargetJson(file: string): Promise<string[]> {
        if (!/\.jsonc?$/i.test(file) || isRelationFile(file)) { throw new Error('请选择数据 JSON 文件，匹配表自身不能作为关联目标。'); }
        const identity = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
        if (vscode.workspace.textDocuments.some(document => identity(document.uri.fsPath) === identity(file) && document.isDirty)) {
            throw new Error('目标 JSON 有未保存修改，请先保存后再添加关联。');
        }
        const errors: ParseError[] = [], jsonc = /\.jsonc$/i.test(file);
        const value: unknown = parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''), errors,
            { allowTrailingComma: jsonc, disallowComments: !jsonc });
        if (errors.length || !Array.isArray(value) || !Array.isArray(value[0]) || !value[0].length ||
            value[0].some(field => typeof field !== 'string') || value.slice(1).some(row => !Array.isArray(row))) {
            throw new Error(`${path.basename(file)} 不是首行字段名的表格 JSON。`);
        }
        return value[0] as string[];
    }

    /** 手动选择只新增该字段的目标；已有条件/提取规则必须明确选择，不能被无条件关联绕过。 */
    private async add(value: unknown, requested: unknown) {
        const document = this.document(value), state = this.readyState(document), uri = document.uri.toString(), version = document.version;
        if (!this.tables.directory) { throw new Error('请先选择策划表目录，再添加关联。'); }
        const index = this.index ??= new RelationIndex(this.tables.tableSettings);
        let epoch = this.epochs.get(uri);
        const valid = () => !this.disposed && !document.isClosed && document.version === version && !this.tables.isUpdating
            && this.states.get(uri)?.state === state && this.epochs.get(uri) === epoch && this.index === index;
        const field = await this.scanField(document, state.parsed, requested, '添加关联');
        this.ensureCurrent(valid);
        const file = await this.chooseTargetJson(document, field, valid);
        if (!file) { return; }
        const header = await this.validateTargetJson(file);
        this.ensureCurrent(valid);
        const targets = await index.resolveTargets(file);
        this.ensureCurrent(valid);
        if (!targets.length) { throw new Error('没有找到目标 JSON 对应的策划工作簿。'); }
        const selected = targets.length === 1 ? { target: targets[0] } : await vscode.window.showQuickPick(targets.map(target => ({
            label: target.file, description: target.sheet, target
        })), { title: `选择 ${path.basename(file)} 对应的工作簿和页签`, ignoreFocusOut: true });
        this.ensureCurrent(valid);
        if (!selected) { return; }
        const target = selected.target;
        const baseKey = targetKey({ ...target, keyField: undefined });
        const sameTable = Object.entries(state.rules.fields[field]?.targets ?? {}).filter(([, rule]) =>
            targetKey({ ...rule.target, keyField: undefined }) === baseKey);
        let existingRule: string | undefined;
        if (sameTable.some(([, rule]) => rule.when || rule.extract || (rule.target.keyField && rule.target.keyField.toLowerCase() !== 'id'))) {
            const selectedRule = await vscode.window.showQuickPick(sameTable.map(([key, rule]) => ({
                label: `当前状态: ${rule.decision === 'accepted' ? '已确认' : rule.decision === 'rejected' ? '已排除' : '新增等待'}`,
                description: rule.when ? `${rule.when.field} = ${rule.when.values.join(' / ')}` : undefined, key
            })), { title: '选择要启用的关联', placeHolder: '选择后启用该关联', ignoreFocusOut: true });
            this.ensureCurrent(valid);
            if (!selectedRule) { return; }
            existingRule = selectedRule.key;
        }
        const next = addManualRelation(state.rules, field, target, existingRule);
        const candidate = next.fields[field].targets[existingRule ?? ruleKey(target)];
        const keyField = candidate.target.keyField ?? 'ID';
        if (header.filter(name => name.toLowerCase() === keyField.toLowerCase()).length !== 1) {
            throw new Error(`目标 JSON ${path.basename(file)} 必须包含唯一的 ${keyField} 字段。`);
        }
        if (state.rules.fields[field]?.targets[existingRule ?? ruleKey(target)]?.decision === 'accepted') {
            return `字段「${JSON.parse(field)[1]}」已存在该关联，无需重复添加。`;
        }
        const metadata = await index.metadata(candidate.target);
        this.ensureCurrent(valid);
        if ([...metadata.keys()].filter(name => name.toLowerCase() === keyField.toLowerCase()).length !== 1) {
            throw new Error(`目标页签 ${candidate.target.sheet} 必须包含唯一的 ${keyField} 字段。`);
        }
        // 当前值尚未命中也可建立字段关系；读取成功后再保存，避免把不可读的表写入匹配表。
        await index.read(candidate.target);
        this.ensureCurrent(valid);
        epoch = this.bump(uri);
        await this.saveAction(uri, epoch, next, valid);
        this.ensureCurrent(valid);
        this.states.delete(uri);
        this.get(document);
        this.changed.fire(uri);
        return `已为字段「${JSON.parse(field)[1]}」添加关联: ${path.basename(target.file)} / ${target.sheet}。`;
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
        await this.saveAction(id, epoch, next, valid);
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
        await this.saveAction(uri, epoch, undefined, valid);
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
        clearTimeout(this.cascadeInvalidation);
        this.detailNotifications.forEach(entry => clearTimeout(entry.timer));
        this.detailNotifications.clear();
        this.storeTimers.forEach(timer => clearTimeout(timer));
        this.subscriptions.forEach(item => item.dispose());
        this.states.clear(); this.parsedDocuments.clear(); this.changed.dispose(); this.expansionChanged.dispose();
    }
}
