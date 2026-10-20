import * as vscode from 'vscode';
import * as path from 'node:path';
import type { TableDescriptions, TableView } from './tableDescriptions';
import { syncTablesCommand, type GitView, type TableGitController } from './tableGitController';
import { relationCommands, type RelationController, type RelationState } from './relationController';
import { openWorkbookCommand } from './fieldHover';
import { isRelationFile } from './relationStore';
import { fieldKey } from './relations';
import { buildRelationEntries, type SidebarEntry } from './sidebarModel';

const prefix = 'json-reading.sidebar.';
interface SourceBinding {
    document: vscode.TextDocument;
    version: number;
    directory: string;
}

/** 节点绑定显示时的源文件；操作不依赖点击按钮后编辑器焦点在哪里。 */
export class SidebarNode extends vscode.TreeItem {
    readonly children: SidebarNode[];
    readonly rulesSnapshot?: string;

    constructor(readonly entry: SidebarEntry, readonly source?: SourceBinding, state?: RelationState) {
        super(entry.label, entry.children?.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        this.id = `${source?.document.uri.toString() ?? 'status'}:${entry.id}`;
        this.description = entry.description;
        this.tooltip = entry.tooltip ?? entry.label;
        this.contextValue = entry.contextValue;
        this.iconPath = new vscode.ThemeIcon(entry.icon, entry.color ? new vscode.ThemeColor(entry.color) : undefined);
        this.rulesSnapshot = entry.field ? JSON.stringify(state?.rules.fields[entry.field] ?? null) : undefined;
        this.children = (entry.children ?? []).map(child => new SidebarNode(child, source, state));
        if (entry.kind === 'target' && source) {
            this.command = { command: prefix + 'openWorkbook', title: '打开策划表', arguments: [this] };
        }
    }
}

class SidebarProvider implements vscode.TreeDataProvider<SidebarNode>, vscode.Disposable {
    private readonly changed = new vscode.EventEmitter<SidebarNode | undefined>();
    readonly onDidChangeTreeData = this.changed.event;
    private roots: SidebarNode[] = [];
    getTreeItem(node: SidebarNode): vscode.TreeItem { return node; }
    getChildren(node?: SidebarNode): SidebarNode[] { return node?.children ?? this.roots; }
    replace(nodes: SidebarNode[]) { this.roots = nodes; this.changed.fire(undefined); }
    dispose() { this.roots = []; this.changed.dispose(); }
}

const message = (id: string, label: string, icon = 'info', color?: string): SidebarEntry =>
    ({ id, kind: 'message', label, icon, color });

/** 两个原生树视图复用悬浮框的状态和命令，不主动展开关联记录或全表扫描。 */
export class JsonReadingSidebar implements vscode.Disposable {
    readonly tableProvider = new SidebarProvider();
    readonly relationProvider = new SidebarProvider();
    private readonly tableView: vscode.TreeView<SidebarNode>;
    private readonly relationView: vscode.TreeView<SidebarNode>;
    private readonly subscriptions: vscode.Disposable[] = [];
    private readonly issued = new WeakSet<SidebarNode>();
    private readonly contexts = new Map<string, boolean>();
    private source?: SourceBinding;
    private timer?: ReturnType<typeof setTimeout>;
    private disposed = false;

    constructor(
        private readonly tables: Pick<TableDescriptions, 'directory' | 'isUpdating' | 'get' | 'onDidChange'>,
        private readonly git: Pick<TableGitController, 'get' | 'onDidChange'>,
        private readonly relations: Pick<RelationController, 'get' | 'onDidChange'>
    ) {
        this.tableView = vscode.window.createTreeView('json-reading.tableStatus', { treeDataProvider: this.tableProvider });
        this.relationView = vscode.window.createTreeView('json-reading.relations', { treeDataProvider: this.relationProvider });
        const schedule = () => this.schedule();
        const register = (name: string, handler: (node?: unknown) => unknown) =>
            vscode.commands.registerCommand(prefix + name, handler);
        this.subscriptions.push(
            this.tableView, this.relationView, this.tableProvider, this.relationProvider,
            this.tableView.onDidChangeVisibility(() => this.refresh()),
            this.relationView.onDidChangeVisibility(() => this.refresh()),
            vscode.window.onDidChangeActiveTextEditor(schedule),
            vscode.window.tabGroups.onDidChangeTabs(schedule),
            vscode.window.tabGroups.onDidChangeTabGroups(schedule),
            vscode.workspace.onDidChangeTextDocument(event => {
                // 无效 JSON 暂时没有 source；修正语法后也要能重新识别当前文件。
                if (event.document === this.source?.document || event.document === this.currentDocument()) { this.schedule(150); }
            }),
            vscode.workspace.onDidCloseTextDocument(schedule),
            vscode.workspace.onDidChangeConfiguration(event => {
                if (event.affectsConfiguration('json-reading')) { this.schedule(); }
            }),
            vscode.workspace.onDidGrantWorkspaceTrust(schedule),
            tables.onDidChange(schedule), git.onDidChange(schedule),
            relations.onDidChange(uri => {
                if (!uri || uri === this.source?.document.uri.toString()) { this.schedule(); }
            }),
            register('refresh', () => this.refresh()),
            register('sync', () => this.sync()),
            register('add', node => this.fieldAction(node, 'add')),
            register('accept', node => this.fieldAction(node, 'accepted')),
            register('reject', node => this.fieldAction(node, 'rejected')),
            register('openWorkbook', node => this.openWorkbook(node)),
            register('revealField', node => this.revealField(node))
        );
        this.refresh();
    }

    private schedule(delay = 40) {
        if (this.disposed) { return; }
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.refresh(), delay);
    }

    private setContext(name: string, value: boolean) {
        if (this.contexts.get(name) === value) { return; }
        this.contexts.set(name, value);
        void vscode.commands.executeCommand('setContext', 'jsonReading.sidebar.' + name, value);
    }

    private currentDocument(): vscode.TextDocument | undefined {
        const editor = vscode.window.activeTextEditor;
        const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        // 焦点进入侧栏时 activeTextEditor 可能为空，但当前文本标签仍然有效。
        const document = editor?.document ?? (input instanceof vscode.TabInputText
            ? vscode.workspace.textDocuments.find(item => item.uri.toString() === input.uri.toString()) : undefined);
        return document && !document.isClosed && document.uri.scheme === 'file'
            && ['json', 'jsonc'].includes(document.languageId) && !isRelationFile(document.uri.fsPath) ? document : undefined;
    }

    private nodes(entries: SidebarEntry[], source?: SourceBinding, state?: RelationState): SidebarNode[] {
        const nodes = entries.map(entry => new SidebarNode(entry, source, state));
        const remember = (node: SidebarNode) => { this.issued.add(node); node.children.forEach(remember); };
        nodes.forEach(remember);
        return nodes;
    }

    refresh(): void {
        if (this.disposed) { return; }
        clearTimeout(this.timer);
        const directory = this.tables.directory;
        this.setContext('hasDirectory', !!directory);
        this.setContext('busy', this.tables.isUpdating);
        // 隐藏侧栏不增加查询。再次显示时从当前文档与共享缓存生成全部状态。
        if (!this.tableView.visible && !this.relationView.visible) {
            this.source = undefined;
            this.setContext('hasDocument', false);
            return;
        }
        const document = this.currentDocument();
        const base: SidebarEntry[] = [{
            ...message('directory', directory ? '策划表目录' : '尚未选择策划表目录', 'folder'),
            description: directory ? path.basename(directory) : '点击上方文件夹按钮',
            tooltip: directory || '选择包含注册表和 XLSM 的策划表目录'
        }];
        if (!vscode.workspace.isTrusted) {
            this.showUnavailable(base, '请先信任当前工作区，再读取策划表和关联规则。', 'lock');
            return;
        }
        if (this.tables.isUpdating) {
            this.showUnavailable(base, '正在更新策划表…', 'sync~spin');
            return;
        }
        const state = document ? this.relations.get(document) : undefined;
        if (!document || !state?.parsed.cells.length) {
            this.showUnavailable(base, '请打开本地表格 JSON 文件；匹配表自身不参与查询。');
            return;
        }
        const source: SourceBinding = { document, version: document.version, directory };
        this.source = source;
        this.setContext('hasDocument', true);
        this.relationView.description = path.basename(document.uri.fsPath);
        base.push({ ...message('json', '当前 JSON', 'json'), description: path.basename(document.uri.fsPath), tooltip: document.uri.fsPath });
        const table = this.tables.get(document.uri.fsPath);
        const git = this.git.get(document.uri.fsPath);
        this.setContext('busy', !!git?.busy);
        this.tableProvider.replace(this.nodes([...base, ...this.tableEntries(table, git)], source));
        if (state.loading) {
            this.relationProvider.replace(this.nodes([message('loading', '正在读取关联规则…', 'loading~spin')]));
            return;
        }
        const entries = buildRelationEntries(state.parsed, state.rules, table?.state === 'ready' ? table.fields : undefined);
        if (state.error) { entries.unshift(message('error', state.error, 'warning', 'editorWarning.foreground')); }
        this.relationProvider.replace(this.nodes(entries, source, state));
    }

    private showUnavailable(base: SidebarEntry[], label: string, icon = 'info') {
        this.source = undefined;
        this.setContext('hasDocument', false);
        this.relationView.description = undefined;
        this.tableProvider.replace(this.nodes([...base, message('status', label, icon)]));
        this.relationProvider.replace(this.nodes([message('status', label, icon)]));
    }

    private tableEntries(table: TableView | undefined, git: GitView | undefined): SidebarEntry[] {
        const entries: SidebarEntry[] = [];
        if (git?.message) { entries.push(message('git', git.message, git.busy || git.loading ? 'sync~spin' : 'warning')); }
        if (git?.jsonBranch) {
            entries.push({ ...message('jsonBranch', 'JSON 分支', 'git-branch'), description: git.jsonBranch });
        }
        if (git?.tableBranch) {
            entries.push({ ...message('tableBranch', '策划表分支', 'git-branch'), description: git.tableBranch });
        }
        if (git?.jsonBranch && git.tableBranch) {
            const matches = git.jsonBranch === git.tableBranch;
            entries.push(message('branches', matches ? '分支一致' : '分支不一致，可点击上方同步按钮',
                matches ? 'check' : 'warning', matches ? undefined : 'editorWarning.foreground'));
        }
        if (table?.state === 'ready' && table.source) {
            const source = table.source;
            entries.push({
                id: 'source', kind: 'target', label: `${path.basename(source.file)} / ${source.sheet}`, icon: 'file',
                tooltip: `来源: ${source.file} / ${source.sheet}`,
                target: { file: source.file, sheet: source.sheet, names: [] }
            });
        } else if (table?.message) {
            entries.push(message('table', table.message, table.state === 'loading' ? 'loading~spin' : 'warning'));
        }
        return entries;
    }

    private validateSource(source: SourceBinding | undefined): source is SourceBinding {
        return !this.disposed && !!source && vscode.workspace.isTrusted && !this.tables.isUpdating
            && source.document === this.currentDocument() && !source.document.isClosed
            && source.version === source.document.version && source.directory === this.tables.directory
            && source.document === this.source?.document;
    }

    private stale() {
        if (this.disposed) { return; }
        void vscode.window.showWarningMessage('侧栏内容已变化或正在更新，请刷新后重新选择。');
        this.refresh();
    }

    private boundNode(value: unknown): { node: SidebarNode; source: SourceBinding } | undefined {
        if (!(value instanceof SidebarNode) || !this.issued.has(value) || !this.validateSource(value.source)) {
            this.stale(); return;
        }
        if (this.git.get(value.source.document.uri.fsPath)?.busy) { this.stale(); return; }
        return { node: value, source: value.source };
    }

    private validateNode(value: unknown): { node: SidebarNode; source: SourceBinding; state: RelationState } | undefined {
        const bound = this.boundNode(value);
        if (!bound) { return; }
        const { node, source } = bound, state = this.relations.get(source.document);
        if (!state || state.loading || state.tableDirectory !== source.directory) {
            this.stale(); return;
        }
        const field = node.entry.field;
        if (field && (!state.parsed.cells.some(cell => fieldKey(cell.column, cell.field) === field)
            || node.rulesSnapshot !== JSON.stringify(state.rules.fields[field] ?? null))) {
            this.stale(); return;
        }
        return { node, source, state };
    }

    private async fieldAction(value: unknown, action: 'add' | 'accepted' | 'rejected') {
        const valid = this.validateNode(value);
        if (!valid) { return; }
        const { node, source } = valid, entry = node.entry;
        if (action === 'add' && entry.kind === 'field' && entry.field && source.directory) {
            await vscode.commands.executeCommand(relationCommands.add, source.document.uri.toString(), entry.field);
        } else if (action !== 'add' && entry.kind === 'target' && entry.field && entry.keys?.length) {
            await vscode.commands.executeCommand(relationCommands.decide, source.document.uri.toString(), entry.field, entry.keys, action);
        }
        this.refresh();
    }

    private async sync() {
        const source = this.source;
        if (!this.validateSource(source) || !source.directory || this.git.get(source.document.uri.fsPath)?.busy) { this.stale(); return; }
        await vscode.commands.executeCommand(syncTablesCommand, source.document.uri.fsPath);
        this.refresh();
    }

    private async openWorkbook(value: unknown) {
        // 来源工作簿只依赖注册表，不必等待其他关联目标和中文表读取完成。
        const valid = value instanceof SidebarNode && !value.entry.field ? this.boundNode(value) : this.validateNode(value);
        if (!valid?.node.entry.target) { return; }
        const { node, source } = valid, target = node.entry.target!;
        if (!node.entry.field) {
            const current = this.tables.get(source.document.uri.fsPath);
            if (current?.state !== 'ready' || current.source?.file !== target.file || current.source.sheet !== target.sheet) { this.stale(); return; }
        }
        const file = path.resolve(source.directory, target.file), relative = path.relative(source.directory, file);
        if (!source.directory || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
            void vscode.window.showErrorMessage('关联工作簿不在当前策划表目录内。'); return;
        }
        await vscode.commands.executeCommand(openWorkbookCommand, file, target.sheet);
    }

    private async revealField(value: unknown) {
        const valid = this.validateNode(value);
        if (!valid || valid.node.entry.kind !== 'field') { return; }
        const cell = valid.state.parsed.cells.find(cell => fieldKey(cell.column, cell.field) === valid.node.entry.field);
        if (!cell) { return; }
        const { document } = valid.source;
        const editor = await vscode.window.showTextDocument(document, { preview: false });
        if (!this.validateSource(valid.source)) { return; }
        const start = document.positionAt(cell.start), end = document.positionAt(cell.end);
        editor.selection = new vscode.Selection(start, end);
        editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }

    dispose() {
        this.disposed = true;
        clearTimeout(this.timer);
        this.source = undefined;
        this.subscriptions.forEach(subscription => subscription.dispose());
    }
}
