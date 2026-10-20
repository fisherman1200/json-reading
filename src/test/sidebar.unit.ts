import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { runInThisContext } from 'node:vm';
import type * as vscode from 'vscode';
import type { RelationState } from '../relationController';
import type { TableView } from '../tableDescriptions';
import type { GitView } from '../tableGitController';
import type { JsonReadingSidebar, SidebarNode } from '../sidebar';
import { emptyRules, fieldKey, parseRelations, ruleKey, type RelationTarget } from '../relations';

class TestEvent<T> {
    readonly listeners = new Set<(value: T) => unknown>();
    readonly event = (listener: (value: T) => unknown) => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    };
    fire(value: T) { for (const listener of [...this.listeners]) { listener(value); } }
    dispose() { this.listeners.clear(); }
}

class Position {
    constructor(readonly line: number, readonly character: number) {}
}
class Range {
    readonly start: Position;
    readonly end: Position;
    constructor(start: Position | number, end: Position | number, endLine?: number, endCharacter?: number) {
        this.start = typeof start === 'number' ? new Position(start, end as number) : start;
        this.end = typeof end === 'number' ? new Position(endLine!, endCharacter!) : end;
    }
}
class Selection extends Range {
    readonly anchor: Position;
    readonly active: Position;
    constructor(start: Position, end: Position) { super(start, end); this.anchor = start; this.active = end; }
}
class TabInputText { constructor(readonly uri: vscode.Uri) {} }

/** 保留真实侧栏与纯数据模型，仅替换 VS Code 和已有控制器的入口。 */
function harness() {
    const root = path.resolve('virtual-sidebar-project');
    const activeChanged = new TestEvent<vscode.TextEditor | undefined>();
    const documentChanged = new TestEvent<{ document: vscode.TextDocument }>();
    const documentClosed = new TestEvent<vscode.TextDocument>();
    const configurationChanged = new TestEvent<{ affectsConfiguration: (name: string) => boolean }>();
    const trustChanged = new TestEvent<void>();
    const tabsChanged = new TestEvent<void>(), tabGroupsChanged = new TestEvent<void>();
    const tableChanged = new TestEvent<void>(), gitChanged = new TestEvent<void>(), relationChanged = new TestEvent<string>();
    const subscriptions = [activeChanged, documentChanged, documentClosed, configurationChanged, trustChanged, tabsChanged, tabGroupsChanged,
        tableChanged, gitChanged, relationChanged];
    const commands = new Map<string, (...args: unknown[]) => unknown>();
    const executed: { command: string; args: unknown[] }[] = [];
    const warnings: string[] = [], errors: string[] = [], information: string[] = [];
    const documents: vscode.TextDocument[] = [];
    const counts = { tables: 0, git: 0, relations: 0 };
    const states = new Map<string, RelationState>();
    const controls = {
        table: { state: 'ready', source: { file: path.join(root, 'tables', 'source.xlsm'), sheet: '源页签' }, fields: new Map() } as TableView,
        git: { file: '', jsonBranch: 'main', tableBranch: 'develop' } as GitView
    };
    const views: { id: string; visible: boolean; disposed: boolean; event: TestEvent<{ visible: boolean }>; provider: unknown }[] = [];
    function uri(file: string) {
        return { scheme: 'file', fsPath: file, path: file.replace(/\\/g, '/'), toString: () => `file://${file.replace(/\\/g, '/')}` };
    }
    const window = {
        activeTextEditor: undefined as vscode.TextEditor | undefined,
        onDidChangeActiveTextEditor: activeChanged.event,
        tabGroups: { onDidChangeTabs: tabsChanged.event, onDidChangeTabGroups: tabGroupsChanged.event,
            activeTabGroup: { activeTab: undefined as { input: TabInputText } | undefined } },
        createTreeView: (id: string, options: { treeDataProvider: unknown }) => {
            const entry = { id, visible: false, disposed: false, event: new TestEvent<{ visible: boolean }>(), provider: options.treeDataProvider };
            views.push(entry);
            return { get visible() { return entry.visible; }, onDidChangeVisibility: entry.event.event,
                dispose: () => { entry.disposed = true; entry.event.dispose(); } };
        },
        showWarningMessage: (message: string) => { warnings.push(message); },
        showErrorMessage: (message: string) => { errors.push(message); },
        showInformationMessage: (message: string) => { information.push(message); },
        showTextDocument: async (document: vscode.TextDocument) => {
            select(document);
            return window.activeTextEditor!;
        }
    };
    const workspace = {
        isTrusted: true, textDocuments: documents,
        onDidChangeTextDocument: documentChanged.event,
        onDidCloseTextDocument: documentClosed.event,
        onDidChangeConfiguration: configurationChanged.event,
        onDidGrantWorkspaceTrust: trustChanged.event
    };
    const tables = { directory: path.join(root, 'tables'), isUpdating: false, onDidChange: tableChanged.event,
        get: (_file: string) => { counts.tables++; return controls.table; } };
    const git = { onDidChange: gitChanged.event,
        get: (file: string) => { counts.git++; return { ...controls.git, file }; } };
    const relations = { onDidChange: relationChanged.event,
        get: (document: vscode.TextDocument) => { counts.relations++; return states.get(document.uri.toString()); },
        view: () => { throw new Error('侧栏不应加载级联视图'); } };
    const mockedVSCode = {
        window, workspace, EventEmitter: TestEvent, Position, Range, Selection, TabInputText,
        TreeItem: class { constructor(public label: string, public collapsibleState = 0) {} },
        TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
        ThemeIcon: class { constructor(readonly id: string) {} },
        ThemeColor: class { constructor(readonly id: string) {} },
        TextEditorRevealType: { InCenter: 0, InCenterIfOutsideViewport: 1 },
        Uri: { file: uri, parse: (value: string) => uri(value.replace(/^file:\/\//, '')) },
        commands: {
            registerCommand: (name: string, handler: (...args: unknown[]) => unknown) => {
                commands.set(name, handler); return { dispose: () => commands.delete(name) };
            },
            executeCommand: async (command: string, ...args: unknown[]) => {
                if (command !== 'setContext') { executed.push({ command, args }); }
            }
        }
    };
    const injected = new Map<string, unknown>([
        ['vscode', mockedVSCode],
        ['./relationController', { relationCommands: { add: 'json-reading.addRelation', decide: 'json-reading.decideRelation' } }],
        ['./tableGitController', { syncTablesCommand: 'json-reading.syncTables' }],
        ['./fieldHover', { openWorkbookCommand: 'json-reading.openSourceWorkbook' }]
    ]);
    const filename = path.join(__dirname, '..', 'sidebar.js'), load = createRequire(filename);
    const exported = { exports: {} as typeof import('../sidebar') };
    const execute = runInThisContext(`(function(require, module, exports) {\n${fs.readFileSync(filename, 'utf8')}\n})`, { filename }) as
        (require: (name: string) => unknown, module: typeof exported, exports: typeof exported.exports) => void;
    execute(name => injected.has(name) ? injected.get(name) : load(name), exported, exported.exports);
    const sidebar: JsonReadingSidebar = new exported.exports.JsonReadingSidebar(tables, git, relations);
    function document(name: string, text = '[["ID","Ref","Ref"],[1,100,200]]', languageId = 'json') {
        const documentUri = uri(path.join(root, name));
        const mutable = { uri: documentUri, version: 1, languageId, isClosed: false,
            getText: () => text, positionAt: (offset: number) => {
                const lines = text.slice(0, offset).split('\n');
                return new Position(lines.length - 1, lines.at(-1)!.length);
            } };
        const doc = mutable as unknown as vscode.TextDocument;
        documents.push(doc);
        const state: RelationState = { parsed: parseRelations(text, languageId === 'jsonc'), rules: emptyRules(),
            data: [], translations: new Map(), loading: false, tableDirectory: tables.directory };
        states.set(doc.uri.toString(), state);
        return { doc, mutable, state };
    }
    const reveals: Range[] = [];
    function select(document: vscode.TextDocument | undefined) {
        window.activeTextEditor = document ? { document, selection: new Selection(new Position(0, 0), new Position(0, 0)),
            revealRange: (range: Range) => reveals.push(range) } as unknown as vscode.TextEditor : undefined;
        window.tabGroups.activeTabGroup.activeTab = document ? { input: new TabInputText(document.uri) } : undefined;
        activeChanged.fire(window.activeTextEditor);
    }
    function visible(id: string, value = true) {
        const view = views.find(view => view.id === id);
        assert.ok(view, `未注册侧栏 ${id}`);
        view.visible = value; view.event.fire({ visible: value });
    }
    async function invoke(name: string, ...args: unknown[]) {
        const command = commands.get(`json-reading.sidebar.${name}`);
        assert.ok(command, `未注册侧栏命令 ${name}`);
        await command(...args);
    }
    return { sidebar, root, tables, states, controls, counts, views, window, workspace, commands, executed, warnings, errors, information,
        activeChanged, documentChanged, documentClosed, configurationChanged, trustChanged, tabsChanged, tabGroupsChanged, tableChanged, gitChanged, relationChanged,
        subscriptions, reveals, document, select, visible, invoke };
}

function fixture() {
    const h = harness(), source = h.document('SourceData.json');
    const field = fieldKey(1, 'Ref'), target: RelationTarget = { file: 'Data/items.xlsm', sheet: '道具', names: ['itemconfig'] };
    const pending = ruleKey(target), accepted = ruleKey(target, { field: 'Kind', values: [2] });
    const rejected = ruleKey(target, { field: 'Kind', values: [3] });
    source.state.rules.fields[field] = { scanned: true, targets: {
        [pending]: { target, decision: 'pending' },
        [accepted]: { target, decision: 'accepted', when: { field: 'Kind', values: [2] } },
        [rejected]: { target, decision: 'rejected', when: { field: 'Kind', values: [3] } }
    } };
    h.select(source.doc);
    h.visible('json-reading.relations');
    return { ...h, ...source, field, target, pending, accepted, rejected };
}

async function findField(sidebar: JsonReadingSidebar, key: string): Promise<SidebarNode> {
    const nodes = await sidebar.relationProvider.getChildren();
    const found = nodes.find(node => node.entry.kind === 'field' && node.entry.field === key);
    assert.ok(found, `没有显示字段 ${key}`);
    return found;
}

test('侧栏隐藏时不读取控制器，可见时只读取字段摘要并保持同名列独立', async t => {
    const h = harness(); t.after(() => h.sidebar.dispose());
    const { doc } = h.document('SourceData.json');
    h.select(doc); h.sidebar.refresh();
    assert.deepEqual(h.counts, { tables: 0, git: 0, relations: 0 });
    assert.deepEqual(h.views.map(view => view.id).sort(), ['json-reading.relations', 'json-reading.tableStatus']);
    h.visible('json-reading.relations');
    assert.ok(h.counts.relations > 0);
    const fields = (await h.sidebar.relationProvider.getChildren()).filter(node => node.entry.kind === 'field');
    assert.deepEqual(fields.map(node => node.entry.field), [fieldKey(1, 'Ref'), fieldKey(2, 'Ref')]);
    assert.equal(h.sidebar.relationProvider.getTreeItem(fields[0]), fields[0]);
    assert.deepEqual(h.executed, [], '显示摘要不能执行扫描或写入命令');
    h.visible('json-reading.relations', false);
    const before = { ...h.counts };
    h.tableChanged.fire(); h.gitChanged.fire(); h.relationChanged.fire(doc.uri.toString());
    await new Promise<void>(resolve => setTimeout(resolve, 70));
    assert.deepEqual(h.counts, before, '关闭侧栏后后台事件不能继续触发读取');
});

test('侧栏字段和目标操作绑定原 JSON 与精确规则，打开工作簿和定位不触发级联查询', async t => {
    const h = fixture(); t.after(() => h.sidebar.dispose());
    const field = await findField(h.sidebar, h.field);
    const children = await h.sidebar.relationProvider.getChildren(field);
    const target = children.find(node => node.entry.kind === 'target')!;
    assert.ok(target);
    const excluded = children.find(node => node.entry.kind === 'group')!;
    const rejected = (await h.sidebar.relationProvider.getChildren(excluded))[0];
    // 点击侧栏会移走编辑器焦点，但当前文本标签仍指向源 JSON。
    h.window.activeTextEditor = undefined;
    h.activeChanged.fire(undefined);
    await h.invoke('add', field);
    await h.invoke('accept', target);
    await h.invoke('reject', target);
    await h.invoke('accept', rejected);
    await h.invoke('openWorkbook', target);
    await h.invoke('sync');
    assert.deepEqual(h.executed, [
        { command: 'json-reading.addRelation', args: [h.doc.uri.toString(), h.field] },
        { command: 'json-reading.decideRelation', args: [h.doc.uri.toString(), h.field, [...target.entry.keys!], 'accepted'] },
        { command: 'json-reading.decideRelation', args: [h.doc.uri.toString(), h.field, [...target.entry.keys!], 'rejected'] },
        { command: 'json-reading.decideRelation', args: [h.doc.uri.toString(), h.field, [h.rejected], 'accepted'] },
        { command: 'json-reading.openSourceWorkbook', args: [path.resolve(h.tables.directory, h.target.file), h.target.sheet] },
        { command: 'json-reading.syncTables', args: [h.doc.uri.fsPath] }
    ]);
    assert.deepEqual([...target.entry.keys!].sort(), [h.pending, h.accepted].sort());
    await h.invoke('revealField', field);
    const cell = h.state.parsed.cells.find(cell => cell.column === 1)!;
    assert.deepEqual(h.window.activeTextEditor!.selection.anchor, h.doc.positionAt(cell.start));
    assert.deepEqual(h.window.activeTextEditor!.selection.active, h.doc.positionAt(cell.end));
    assert.equal(h.reveals.length, 1);
    assert.deepEqual(h.errors, []);
});

test('切换文档、版本或规则变化后旧节点拒绝执行，不会操作新的 JSON', async t => {
    for (const reason of ['active', 'version', 'rules', 'directory', 'closed'] as const) {
        await t.test(reason, async t => {
            const h = fixture(); t.after(() => h.sidebar.dispose());
            const node = await findField(h.sidebar, h.field);
            if (reason === 'active') { h.select(h.document('OtherData.json').doc); }
            if (reason === 'version') { h.mutable.version++; }
            if (reason === 'rules') { h.state.rules.fields[h.field].targets[h.pending].decision = 'accepted'; }
            if (reason === 'directory') { h.tables.directory = path.join(h.root, 'other-tables'); }
            if (reason === 'closed') { h.mutable.isClosed = true; }
            await h.invoke('add', node);
            assert.deepEqual(h.executed, []);
            assert.ok(h.errors.length + h.warnings.length + h.information.length > 0, '过期操作必须有可见反馈');
        });
    }
});

test('未信任工作区和同步中的侧栏节点不能执行字段操作', async t => {
    for (const reason of ['trust', 'tablesUpdating', 'gitBusy'] as const) {
        await t.test(reason, async t => {
            const h = fixture(); t.after(() => h.sidebar.dispose());
            const node = await findField(h.sidebar, h.field);
            if (reason === 'trust') { h.workspace.isTrusted = false; }
            if (reason === 'tablesUpdating') { h.tables.isUpdating = true; }
            if (reason === 'gitBusy') { h.controls.git.busy = true; }
            await h.invoke('add', node);
            assert.deepEqual(h.executed, []);
            assert.ok(h.errors.length + h.warnings.length + h.information.length > 0);
        });
    }
});

test('活动文件变化清空旧字段，普通 JSON、非 JSON 和匹配表均显示提示', async t => {
    const h = fixture(); t.after(() => h.sidebar.dispose());
    for (const [name, text, language] of [
        ['Readme.txt', '文本', 'plaintext'],
        ['Object.json', '{"name":"对象"}', 'json'],
        ['extensions/json_reading/relations.json', '[["ID","Ref"],[1,100]]', 'json']
    ]) {
        const before = h.counts.relations;
        h.select(h.document(name, text, language).doc);
        h.sidebar.refresh();
        const nodes = await h.sidebar.relationProvider.getChildren();
        assert.ok(nodes.length);
        assert.ok(nodes.every(node => node.entry.kind === 'message'), name);
        assert.equal(h.counts.relations, before + (name === 'Object.json' ? 1 : 0),
            `${name} 只允许通过摘要识别普通 JSON，不得读取非 JSON 或匹配表`);
    }
    h.select(h.doc);
    h.sidebar.refresh();
    assert.ok(await findField(h.sidebar, h.field));
    h.select(undefined);
    h.sidebar.refresh();
    assert.ok((await h.sidebar.relationProvider.getChildren()).every(node => node.entry.kind === 'message'));
});

test('普通或暂时无效 JSON 修复为表格数据后，仅文档事件即可恢复字段列表', async t => {
    for (const initial of ['{"name":"普通对象"}', '[["ID","Ref"],[1,']) {
        await t.test(initial, async t => {
            const h = harness(); t.after(() => h.sidebar.dispose());
            const { doc, mutable, state } = h.document('SourceData.json', initial);
            h.select(doc); h.visible('json-reading.relations');
            assert.equal(state.parsed.cells.length, 0);
            assert.ok(h.sidebar.relationProvider.getChildren().every(node => node.entry.kind === 'message'));
            const repaired = '[["ID","Ref"],[1,100]]';
            mutable.getText = () => repaired;
            mutable.version++;
            state.parsed = parseRelations(repaired);
            h.documentChanged.fire({ document: doc });
            for (let elapsed = 0; !h.sidebar.relationProvider.getChildren().some(node => node.entry.kind === 'field') && elapsed < 500; elapsed += 10) {
                await new Promise<void>(resolve => setTimeout(resolve, 10));
            }
            assert.ok(await findField(h.sidebar, fieldKey(1, 'Ref')));
            assert.deepEqual(h.executed, [], '恢复字段不需要额外 Git 或写入操作');
        });
    }
});

test('关联规则加载期间，已定位的来源工作簿节点仍可打开', async t => {
    const h = fixture(); t.after(() => h.sidebar.dispose());
    h.state.loading = true;
    h.sidebar.refresh();
    assert.ok(h.sidebar.relationProvider.getChildren().every(node => node.entry.kind === 'message'));
    const source = h.sidebar.tableProvider.getChildren().find(node => node.entry.kind === 'target' && !node.entry.field);
    assert.ok(source?.entry.target);
    await h.invoke('openWorkbook', source);
    assert.deepEqual(h.executed, [{
        command: 'json-reading.openSourceWorkbook',
        args: [path.resolve(h.tables.directory, source.entry.target.file), source.entry.target.sheet]
    }]);
    assert.deepEqual(h.warnings, []);
    assert.deepEqual(h.errors, []);
});

test('表格、Git、规则和文档事件刷新可见侧栏，dispose 清理命令与订阅', async () => {
    const h = fixture();
    let changes = 0;
    const subscription = h.sidebar.relationProvider.onDidChangeTreeData(() => { changes++; });
    for (const update of [
        () => h.tableChanged.fire(), () => h.gitChanged.fire(), () => h.relationChanged.fire(h.doc.uri.toString()),
        () => h.documentChanged.fire({ document: h.doc }),
        () => h.configurationChanged.fire({ affectsConfiguration: () => true })
    ]) {
        const before = changes;
        update();
        for (let elapsed = 0; changes === before && elapsed < 500; elapsed += 10) {
            await new Promise<void>(resolve => setTimeout(resolve, 10));
        }
        assert.ok(changes > before);
    }
    assert.equal(h.commands.size, 7);
    h.sidebar.dispose();
    subscription.dispose();
    const before = { ...h.counts }, beforeChanges = changes;
    h.sidebar.refresh(); h.activeChanged.fire(h.window.activeTextEditor); h.tableChanged.fire(); h.gitChanged.fire(); h.relationChanged.fire(h.doc.uri.toString());
    assert.deepEqual(h.counts, before);
    assert.equal(changes, beforeChanges);
    assert.equal(h.commands.size, 0);
    assert.ok(h.views.every(view => view.disposed));
    assert.ok(h.subscriptions.every(event => event.listeners.size === 0));
});
