import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runInThisContext } from 'node:vm';
import { createRequire } from 'node:module';
import type * as vscode from 'vscode';
import type { RelationController, RelationState } from '../relationController';
import type { CascadeRow } from '../relationCascade';
import { cascadeFieldKey, cascadeRootKey } from '../relationExpansion';
import type { TableDescriptions } from '../tableDescriptions';
import * as relations from '../relations';
import * as relationStore from '../relationStore';
import type { RelationRow, RelationRules, RelationTarget, TargetData, TargetRule } from '../relations';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

class TestEvent<T> {
    private readonly listeners = new Set<(value: T) => void>();
    readonly event = (listener: (value: T) => void) => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    };
    fire(value: T) { for (const listener of this.listeners) { listener(value); } }
    dispose() { this.listeners.clear(); }
}

const noopEvent = () => ({ dispose() {} });
const table = (sheet: string, ids: string[]): TargetData => ({
    target: { file: 'test.xlsm', sheet, names: [sheet] },
    rows: new Map(ids.map(id => [id, [{ id, row: 6, values: [['Name', sheet]] }]]))
});
type TestPickItem = { label: string; description?: string; [key: string]: unknown };
type TestPickChoice = (items: readonly TestPickItem[]) => TestPickItem | undefined | Promise<TestPickItem | undefined>;

/** 仅替换编辑器、磁盘和 XLSM 边界，命令调度、选列、规则计算和保存流程执行真实代码。 */
function harness() {
    const root = path.resolve('virtual-relation-controller-project');
    const commands = new Map<string, (...args: unknown[]) => Promise<void>>();
    const disk = new Map<string, RelationRules>();
    const writes: { file: string; rules?: RelationRules }[] = [];
    const documents: vscode.TextDocument[] = [];
    const files = new Map<string, string>();
    const directories = new Set<string>();
    const information: string[] = [], errors: string[] = [], warnings: string[] = [], events: string[] = [];
    const progress: { location: number; title: string }[] = [];
    const invalidated = new TestEvent<void>(), closed = new TestEvent<vscode.TextDocument>();
    const changes: string[] = [];
    const personalState = new Map<string, unknown>();
    const personalUpdates: { key: string; value: unknown }[] = [];
    const toggles: { uri: string; line: number; version: number }[] = [];
    const watchers: { pattern: string | { base: string; pattern: string }; change: TestEvent<void>; create: TestEvent<void>; remove: TestEvent<void> }[] = [];
    const controls = {
        tables: [] as TargetData[],
        scanError: undefined as Error | undefined,
        scanGate: undefined as Promise<TargetData[]> | undefined,
        scanStarted: undefined as ReturnType<typeof deferred<void>> | undefined,
        writeGate: undefined as Promise<void> | undefined,
        writeError: undefined as Error | undefined,
        writeStarted: undefined as ReturnType<typeof deferred<void>> | undefined,
        readGate: undefined as Promise<void> | undefined,
        detailGate: undefined as Promise<void> | undefined,
        detailGates: new Map<string, Promise<void>>(),
        detailError: undefined as Error | undefined,
        detailRows: new Map<string, Map<string, RelationRow[]>>(),
        detailCalls: [] as { target: RelationTarget; ids: string[] }[],
        cascadeGate: undefined as Promise<void> | undefined,
        cascadeStarted: undefined as ReturnType<typeof deferred<void>> | undefined,
        cascadeError: undefined as Error | undefined,
        cascadeRows: undefined as CascadeRow[] | undefined,
        cascadeCalls: [] as { target: RelationTarget; rows: RelationRow[] }[],
        cascadeOptions: [] as { root: string; sourceFile: string; rules: Record<string, RelationRules> }[],
        cascadeDependencies: [] as string[],
        personalGate: undefined as Promise<void> | undefined,
        personalStarted: undefined as ReturnType<typeof deferred<void>> | undefined,
        personalError: undefined as Error | undefined,
        pickChoices: [] as TestPickChoice[],
        pickCalls: [] as { items: readonly TestPickItem[]; options: unknown }[],
        dialogPaths: undefined as string[] | undefined,
        dialogCalls: [] as unknown[],
        openedDocuments: [] as unknown[],
        directoryReads: [] as string[],
        fileReads: [] as string[],
        fileReadError: undefined as Error | undefined,
        fileReadGate: undefined as Promise<void> | undefined,
        fileReadStarted: undefined as ReturnType<typeof deferred<void>> | undefined,
        targets: new Map<string, RelationTarget[]>(),
        targetCalls: [] as string[],
        targetGate: undefined as Promise<void> | undefined,
        targetStarted: undefined as ReturnType<typeof deferred<void>> | undefined,
        targetError: undefined as Error | undefined,
        metadata: new Map<string, Map<string, { description: string; detail: string }>>(),
        metadataCalls: [] as RelationTarget[],
        metadataError: undefined as Error | undefined,
        indexReads: [] as RelationTarget[],
        indexReadError: undefined as Error | undefined,
        scans: 0
    };
    const tableDescriptions = {
        directory: path.join(root, 'tables'),
        tableSettings: { directory: path.join(root, 'tables') },
        isUpdating: false,
        onDidInvalidate: invalidated.event
    };
    const window = {
        activeTextEditor: undefined as vscode.TextEditor | undefined,
        withProgress: async <T>(options: { location: number; title: string }, task: () => Promise<T>) => {
            progress.push(options); events.push('progress:start');
            try { return await task(); }
            finally { events.push('progress:end'); }
        },
        showInformationMessage: (message: string) => { information.push(message); events.push('information'); },
        showErrorMessage: (message: string) => { errors.push(message); events.push('error'); },
        showWarningMessage: (message: string) => { warnings.push(message); events.push('warning'); },
        showQuickPick: async (items: readonly TestPickItem[], options: unknown) => {
            controls.pickCalls.push({ items, options });
            return controls.pickChoices.shift()?.(items);
        },
        showOpenDialog: async (options: unknown) => {
            controls.dialogCalls.push(options);
            return controls.dialogPaths?.map(uri);
        },
        showTextDocument: async (value: unknown) => {
            controls.openedDocuments.push(value);
            throw new Error('测试不应打开目标编辑器');
        }
    };
    class MemoryStore {
        readonly root = root;
        readonly file = path.join(root, relationStore.relationFile);
        async snapshot() {
            return Object.fromEntries([...disk].map(([file, rules]) => [path.relative(root, file).replace(/\\/g, '/'), structuredClone(rules)]));
        }
        async read(file: string) {
            await controls.readGate;
            return structuredClone(disk.get(file));
        }
        async write(file: string, rules?: RelationRules) {
            controls.writeStarted?.resolve();
            await controls.writeGate;
            if (controls.writeError) { throw controls.writeError; }
            writes.push({ file, rules: structuredClone(rules) });
            if (rules) { disk.set(file, structuredClone(rules)); }
            else { disk.delete(file); }
            events.push('write:complete');
        }
    }
    class MemoryIndex {
        async resolveTargets(file: string) {
            controls.targetCalls.push(file); controls.targetStarted?.resolve();
            await controls.targetGate;
            if (controls.targetError) { throw controls.targetError; }
            return controls.targets.get(file) ?? [];
        }
        async metadata(target: RelationTarget) {
            controls.metadataCalls.push(target);
            if (controls.metadataError) { throw controls.metadataError; }
            return controls.metadata.get(relations.targetKey(target)) ?? new Map([['ID', { description: '编号', detail: '' }]]);
        }
        async scan() {
            controls.scans++;
            controls.scanStarted?.resolve();
            if (controls.scanError) { throw controls.scanError; }
            return controls.scanGate ? await controls.scanGate : controls.tables;
        }
        async read(target: RelationTarget) {
            controls.indexReads.push(target);
            if (controls.indexReadError) { throw controls.indexReadError; }
            const found = controls.tables.find(item => relations.targetKey(item.target) === relations.targetKey(target));
            if (!found) { throw new Error('测试关联表不存在'); }
            return found;
        }
        async recordsMany(target: RelationTarget, ids: Iterable<string>) {
            const selected = [...ids];
            controls.detailCalls.push({ target, ids: selected });
            await (controls.detailGates.get(relations.targetKey(target)) ?? controls.detailGate);
            if (controls.detailError) { throw controls.detailError; }
            const rows = controls.detailRows.get(relations.targetKey(target));
            return new Map(selected.map(id => [id, structuredClone(rows?.get(id) ?? [])]));
        }
    }
    class MemoryCascade {
        readonly dependencies = new Set(controls.cascadeDependencies);
        constructor(options: { root: string; sourceFile: string; rules: Record<string, RelationRules> }) {
            controls.cascadeOptions.push({ root: options.root, sourceFile: options.sourceFile, rules: structuredClone(options.rules) });
        }
        async expand(target: RelationTarget, rows: RelationRow[]) {
            controls.cascadeCalls.push({ target, rows: structuredClone(rows) });
            controls.cascadeStarted?.resolve();
            await controls.cascadeGate;
            if (controls.cascadeError) { throw controls.cascadeError; }
            return structuredClone(controls.cascadeRows ?? rows.map(row => ({ id: row.id, row: row.row,
                fields: row.values.map(([name, value]) => ({ name, value })) })));
        }
    }
    const mockedVSCode = {
        EventEmitter: TestEvent,
        Position: class { constructor(readonly line: number, readonly character: number) {} },
        ProgressLocation: { Window: 10 },
        RelativePattern: class { constructor(readonly base: string, readonly pattern: string) {} },
        Uri: { file: uri },
        window,
        workspace: {
            isTrusted: true, textDocuments: documents,
            openTextDocument: async (value: unknown) => {
                controls.openedDocuments.push(value);
                throw new Error('测试不应打开目标编辑器');
            },
            getWorkspaceFolder: () => ({ uri: { fsPath: root } }),
            onDidChangeConfiguration: noopEvent, onDidChangeTextDocument: noopEvent, onDidCloseTextDocument: closed.event,
            createFileSystemWatcher: (pattern: string | { base: string; pattern: string }) => {
                const watcher = { pattern, change: new TestEvent<void>(), create: new TestEvent<void>(), remove: new TestEvent<void>() };
                watchers.push(watcher);
                return { dispose: () => { watcher.change.dispose(); watcher.create.dispose(); watcher.remove.dispose(); },
                    onDidChange: watcher.change.event, onDidCreate: watcher.create.event, onDidDelete: watcher.remove.event };
            },
            getConfiguration: () => ({ get: (_name: string, fallback: unknown) => fallback })
        },
        commands: { registerCommand: (name: string, command: (...args: unknown[]) => Promise<void>) => {
            commands.set(name, command);
            return { dispose: () => commands.delete(name) };
        } }
    };
    const injected = new Map<string, unknown>([
        ['vscode', mockedVSCode],
        ['./relations', { ...relations, RelationIndex: MemoryIndex, readTranslations: async () => new Map([['i18n_1', '中文说明'], ['i18n_2', '第二条说明']]) }],
        ['./relationStore', { ...relationStore, RelationStore: MemoryStore }],
        ['./relationCascade', { RelationCascade: MemoryCascade }],
        ['node:fs/promises', {
            readFile: async (file: string) => {
                if (file === path.join(root, relationStore.relationFile)) { return JSON.stringify([...disk]); }
                controls.fileReads.push(file); controls.fileReadStarted?.resolve();
                await controls.fileReadGate;
                if (controls.fileReadError) { throw controls.fileReadError; }
                if (!files.has(file)) { throw Object.assign(new Error('虚拟文件不存在'), { code: 'ENOENT' }); }
                return files.get(file)!;
            },
            readdir: async (directory: string, options?: { withFileTypes?: boolean }) => {
                controls.directoryReads.push(directory);
                const entries = [...files.keys(), ...directories].filter(file => path.dirname(file) === directory);
                return options?.withFileTypes ? entries.map(file => ({ name: path.basename(file),
                    isFile: () => files.has(file), isDirectory: () => directories.has(file) })) : entries.map(file => path.basename(file));
            }
        }],
        ['./relationDocument', { resolveRelationDocument: (uri: unknown) => {
            const found = uri === undefined ? window.activeTextEditor?.document : documents.find(doc => doc.uri.toString() === uri);
            if (!found) { throw new Error('按钮对应的文件未打开'); }
            return found;
        } }]
    ]);
    const filename = path.join(__dirname, '..', 'relationController.js');
    const requireFromController = createRequire(filename);
    const exported = { exports: {} as typeof import('../relationController') };
    const execute = runInThisContext(`(function(require, module, exports) {\n${fs.readFileSync(filename, 'utf8')}\n})`, { filename }) as
        (load: (name: string) => unknown, module: typeof exported, exports: typeof exported.exports) => void;
    execute(name => injected.has(name) ? injected.get(name) : requireFromController(name), exported, exported.exports);
    const context = { workspaceState: {
        get: (key: string) => structuredClone(personalState.get(key)),
        update: async (key: string, value: unknown) => {
            if (key.startsWith('relations.expansion.')) {
                controls.personalStarted?.resolve();
                await controls.personalGate;
                if (controls.personalError) { throw controls.personalError; }
                personalUpdates.push({ key, value: structuredClone(value) });
            }
            if (value === undefined) { personalState.delete(key); }
            else { personalState.set(key, structuredClone(value)); }
        }
    } };
    const controller: RelationController = new exported.exports.RelationController(
        context as unknown as vscode.ExtensionContext, tableDescriptions as unknown as TableDescriptions);
    controller.onDidChange(uri => changes.push(uri));
    controller.onDidToggleExpansion(event => toggles.push(event));
    function uri(file: string) {
        return { fsPath: file, path: file.replace(/\\/g, '/'), scheme: 'file', toString: () => `file://${file.replace(/\\/g, '/')}` };
    }
    function file(name: string, text: string) {
        const file = path.resolve(root, name);
        files.set(file, text);
        return file;
    }
    function document(name: string, text: string, initial?: RelationRules) {
        const filename = file(name, text);
        const documentUri = uri(filename);
        const lines = text.split('\n');
        const mutable = {
            uri: documentUri, languageId: path.extname(filename).toLowerCase() === '.jsonc' ? 'jsonc' : 'json', version: 1, lineCount: lines.length, isClosed: false, isDirty: false, getText: () => text,
            offsetAt: (position: vscode.Position) => lines.slice(0, position.line).reduce((sum, line) => sum + line.length + 1, 0) + position.character,
            lineAt: (line: number) => ({ range: { start: { line, character: 0 }, end: { line, character: lines[line].length } } })
        };
        const doc = mutable as unknown as vscode.TextDocument;
        documents.push(doc);
        if (initial) { disk.set(filename, structuredClone(initial)); }
        return { doc, mutable };
    }
    function select(document: vscode.TextDocument, line: number) {
        window.activeTextEditor = { document, selection: { active: { line, character: 0 } } } as vscode.TextEditor;
    }
    async function ready(doc: vscode.TextDocument): Promise<RelationState> {
        const state = controller.get(doc);
        assert.ok(state);
        if (state.loading) {
            await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(() => { subscription.dispose(); reject(new Error('关联读取未完成')); }, 3000);
                const subscription = controller.onDidChange(uri => {
                    if (uri === doc.uri.toString() && !state.loading) {
                        clearTimeout(timeout); subscription.dispose(); resolve();
                    }
                });
            });
        }
        assert.equal(state.error, undefined);
        return state;
    }
    const invoke = (name: keyof typeof exported.exports.relationCommands, ...args: unknown[]) => {
        const command = commands.get(exported.exports.relationCommands[name]);
        assert.ok(command);
        return command(...args);
    };
    return { controller, controls, tableDescriptions, disk, writes, information, errors, warnings, events, progress,
        changes, personalUpdates, toggles, invalidated, closed, watchers, window, files, directories, file, document, select, ready, invoke };
}

test('字段全搜索只保存该列所有行，进度覆盖扫描与保存，成功通知在完成之后', async t => {
    const h = harness(); t.after(() => h.controller.dispose());
    const selected = relations.fieldKey(1, 'Ref'), other = relations.fieldKey(2, 'Ref');
    const a = table('当前列第一行', ['100']), b = table('当前列第二行', ['101']), c = table('其他列', ['200']);
    h.controls.tables = [a, b, c];
    const previous: RelationRules = { fields: { [other]: { scanned: false, targets: { [relations.targetKey(c.target)]: { target: c.target, decision: 'rejected' } } } } };
    const { doc } = h.document('SourceData.json', '[["ID","Ref","Ref"],[1,100,200],[2,101,201]]', previous);
    await h.ready(doc);
    const scan = deferred<TargetData[]>(), saved = deferred<void>();
    h.controls.scanGate = scan.promise; h.controls.scanStarted = deferred<void>();
    h.controls.writeGate = saved.promise; h.controls.writeStarted = deferred<void>();
    const action = h.invoke('rescan', doc.uri.toString(), selected);
    await h.controls.scanStarted.promise;
    assert.equal(h.information.length, 0);
    assert.equal(h.writes.length, 0);
    assert.equal(h.progress[0].location, 10);
    scan.resolve(h.controls.tables);
    await h.controls.writeStarted.promise;
    assert.equal(h.information.length, 0);
    saved.resolve();
    await action;
    assert.equal(h.writes.length, 1);
    const result = h.disk.get(doc.uri.fsPath)!;
    assert.deepEqual(result.fields[other], previous.fields[other]);
    assert.deepEqual(Object.keys(result.fields[selected].targets).sort(), [relations.targetKey(a.target), relations.targetKey(b.target)].sort());
    assert.equal(result.fields[relations.fieldKey(0, 'ID')], undefined);
    assert.match(h.information[0], /Ref.*全搜索完成.*2/);
    assert.deepEqual(h.events, ['progress:start', 'write:complete', 'progress:end', 'information']);
    assert.deepEqual(h.errors, []);
});

test('全搜索失败显示错误，不保存空结果或误发成功通知', async t => {
    const h = harness(); t.after(() => h.controller.dispose());
    const { doc } = h.document('SourceData.json', '[["ID","Ref"],[1,100]]');
    await h.ready(doc);
    h.controls.scanError = new Error('读取工作簿失败');
    await h.invoke('rescan', doc.uri.toString(), relations.fieldKey(1, 'Ref'));
    assert.equal(h.writes.length, 0);
    assert.deepEqual(h.information, []);
    assert.match(h.errors[0], /读取工作簿失败/);
    assert.deepEqual(h.events, ['progress:start', 'progress:end', 'error']);
});

test('读取中、更新中和无效字段操作均有反馈，首列不能全搜索', async t => {
    const h = harness(); t.after(() => h.controller.dispose());
    const { doc } = h.document('SourceData.json', '[["ID","Ref"],[1,100]]');
    const reading = deferred<void>(); h.controls.readGate = reading.promise;
    h.controller.get(doc);
    await h.invoke('rescan', doc.uri.toString(), relations.fieldKey(1, 'Ref'));
    assert.match(h.errors.at(-1)!, /正在读取/);
    reading.resolve(); h.controls.readGate = undefined;
    await h.ready(doc);
    h.tableDescriptions.isUpdating = true;
    await h.invoke('rescan', doc.uri.toString(), relations.fieldKey(1, 'Ref'));
    assert.match(h.errors.at(-1)!, /正在更新/);
    h.tableDescriptions.isUpdating = false;
    await h.invoke('rescan', doc.uri.toString(), relations.fieldKey(0, 'ID'));
    assert.match(h.errors.at(-1)!, /首列/);
    await h.invoke('rescan', doc.uri.toString(), 123);
    assert.match(h.errors.at(-1)!, /参数无效/);
    assert.equal(h.errors.length, 4);
    assert.equal(h.controls.scans, 0);
    assert.equal(h.writes.length, 0);
    assert.deepEqual(h.information, []);
});

test('文档在扫描期间变化会提示操作结束，不保存过期结果或报成功', async t => {
    const h = harness(); t.after(() => h.controller.dispose());
    const { doc, mutable } = h.document('SourceData.json', '[["ID","Ref"],[1,100]]');
    await h.ready(doc);
    const scan = deferred<TargetData[]>();
    h.controls.scanGate = scan.promise; h.controls.scanStarted = deferred<void>();
    const action = h.invoke('rescan', doc.uri.toString(), relations.fieldKey(1, 'Ref'));
    await h.controls.scanStarted.promise;
    mutable.version++;
    scan.resolve([]);
    await action;
    assert.equal(h.writes.length, 0);
    assert.deepEqual(h.information, []);
    assert.deepEqual(h.errors, []);
    assert.match(h.warnings[0], /文档或索引已变化/);
});

test('合并候选的确认和排除每次只保存一次，失效 keys 不产生部分成功', async t => {
    const h = harness(); t.after(() => h.controller.dispose());
    const a = table('道具', ['100']); h.controls.tables = [a];
    const field = relations.fieldKey(1, 'Ref'), when = { field: 'Kind', values: [1] };
    const keys = [relations.ruleKey(a.target), relations.ruleKey(a.target, when)];
    const initial: RelationRules = { fields: { [field]: { scanned: true, targets: {
        [keys[0]]: { target: a.target, decision: 'pending' },
        [keys[1]]: { target: a.target, when, decision: 'pending' }
    } } } };
    const { doc } = h.document('SourceData.json', '[["ID","Ref","Kind"],[1,100,1]]', initial);
    await h.ready(doc);
    await h.invoke('decide', doc.uri.toString(), field, keys, 'accepted');
    assert.equal(h.writes.length, 1);
    assert.ok(Object.values(h.disk.get(doc.uri.fsPath)!.fields[field].targets).every(rule => rule.decision === 'accepted'));
    assert.match(h.information[0], /已确认字段「Ref」/);
    await h.invoke('decide', doc.uri.toString(), field, keys, 'rejected');
    assert.equal(h.writes.length, 2);
    assert.ok(Object.values(h.disk.get(doc.uri.fsPath)!.fields[field].targets).every(rule => rule.decision === 'rejected'));
    assert.match(h.information[1], /已排除字段「Ref」/);
    await h.invoke('decide', doc.uri.toString(), field, [keys[0], 'expired'], 'accepted');
    assert.equal(h.writes.length, 2);
    assert.equal(h.information.length, 2);
    assert.match(h.errors[0], /候选已失效/);
    assert.ok(Object.values(h.disk.get(doc.uri.fsPath)!.fields[field].targets).every(rule => rule.decision === 'rejected'));
    assert.ok(h.progress.every(entry => entry.location === 10));
});

test('清空只删除当前 JSON 规则，完成后通知且不自动重新扫描', async t => {
    const h = harness(); t.after(() => h.controller.dispose());
    const rules: RelationRules = { fields: { [relations.fieldKey(1, 'Ref')]: { scanned: true, targets: {} } } };
    const first = h.document('FirstData.json', '[["ID","Ref"],[1,100]]', rules).doc;
    const second = h.document('SecondData.json', '[["ID","Ref"],[1,200]]', rules).doc;
    await h.ready(first); await h.ready(second);
    await h.invoke('clear', first.uri.toString());
    assert.equal(h.writes.length, 1);
    assert.equal(h.writes[0].file, first.uri.fsPath);
    assert.equal(h.disk.has(first.uri.fsPath), false);
    assert.deepEqual(h.disk.get(second.uri.fsPath), rules);
    assert.match(h.information[0], /已清空 FirstData\.json.*其他 JSON 保持不变/);
    assert.equal(h.progress[0].location, 10);
    assert.equal(h.controls.scans, 0);
    assert.deepEqual((await h.ready(first)).rules, relations.emptyRules());
    assert.equal(h.controls.scans, 0);
    assert.deepEqual(h.events, ['progress:start', 'write:complete', 'progress:end', 'information']);
});

function rulesFor(column: number, field: string, ...rules: TargetRule[]): RelationRules {
    return { fields: { [relations.fieldKey(column, field)]: {
        scanned: true, targets: Object.fromEntries(rules.map(rule => [relations.ruleKey(rule.target, rule.when, rule.extract), rule]))
    } } };
}

function lineOf(document: vscode.TextDocument, text: string) {
    const line = document.getText().split('\n').findIndex(value => value.trim() === text);
    assert.notEqual(line, -1, `找不到测试数据行：${text}`);
    return line;
}

function manualFixture(h: ReturnType<typeof harness>, previous?: RelationRules) {
    const target = table('Items', ['100']);
    h.controls.tables = [target];
    const source = h.document('SourceData.json', '[\n ["ID", "Ref", "Other"],\n [\n  1,\n  100,\n  200\n ]\n]', previous);
    const file = h.file('TargetData.json', '[["ID","Name"],[100,"物品"]]');
    h.controls.targets.set(file, [target.target]);
    return { ...source, field: relations.fieldKey(1, 'Ref'), target, file };
}

function chooseFile(h: ReturnType<typeof harness>, file: string) {
    h.controls.pickChoices.push(items => {
        const found = items.find(item => item.file === file);
        assert.ok(found, `未提供目标文件：${file}`);
        return found;
    });
}

test('手动添加只保存当前字段，保存完成才通知并重新加载，目标无需与当前值碰撞', async t => {
    const h = harness(); t.after(() => h.controller.dispose());
    const other = table('Other', ['200']);
    const previous = rulesFor(2, 'Other', { target: other.target, decision: 'rejected' });
    const { doc, field, target, file } = manualFixture(h, previous);
    // 字段关联由用户指定；没有当前 ID 命中也不能退回全搜索。
    target.rows.clear();
    h.controls.tables.push(other);
    const second = h.document('SecondData.json', '[["ID","Other"],[2,200]]', previous).doc;
    h.file('readme.txt', '忽略非 JSON');
    h.directories.add(path.join(path.dirname(file), 'Folder.json'));
    await h.ready(doc);
    chooseFile(h, file);
    const saved = deferred<void>();
    h.controls.writeGate = saved.promise; h.controls.writeStarted = deferred<void>();
    const action = h.invoke('add', doc.uri.toString(), field);
    await h.controls.writeStarted.promise;
    assert.deepEqual(h.information, []);
    assert.equal(h.writes.length, 0);
    assert.equal(h.progress[0].location, 10);
    saved.resolve(); await action;
    assert.equal(h.writes.length, 1);
    assert.equal(h.writes[0].file, doc.uri.fsPath);
    const next = h.disk.get(doc.uri.fsPath)!;
    assert.deepEqual(next.fields[relations.fieldKey(2, 'Other')], previous.fields[relations.fieldKey(2, 'Other')]);
    assert.deepEqual(next.fields[field].targets, { [relations.targetKey(target.target)]: { target: target.target, decision: 'accepted' } });
    assert.deepEqual(h.disk.get(second.uri.fsPath), previous);
    assert.equal(JSON.stringify(next).includes(file), false, '共享规则只记录工作簿和页签，不增加目标 JSON 路径');
    assert.deepEqual((await h.ready(doc)).rules, next);
    assert.equal(h.controller.get(doc)?.data.length, 1);
    assert.deepEqual(h.controls.targetCalls, [file]);
    assert.equal(h.controls.pickCalls.length, 1);
    assert.equal(h.controls.pickCalls[0].items.some(item => item.label === 'readme.txt' || item.label === 'Folder.json'), false);
    assert.equal(h.controls.scans, 0);
    assert.deepEqual(h.controls.openedDocuments, []);
    assert.deepEqual(h.errors, []);
    assert.equal(h.information.length, 1);
    assert.match(h.information[0], /Ref.*添加关联.*Items/);
    assert.deepEqual(h.events, ['progress:start', 'write:complete', 'progress:end', 'information']);
});

test('命令面板按当前数据字段添加，可浏览其他目录 JSONC，期间不切换编辑器', async t => {
    const h = harness(); t.after(() => h.controller.dispose());
    const { doc, field, target } = manualFixture(h);
    const external = h.file(path.resolve('virtual-other-configs', 'ExternalData.jsonc'), '\uFEFF[\n // 配置说明\n ["id","Name"],\n [100,"物品"],\n]');
    h.controls.targets.set(external, [target.target]);
    h.controls.dialogPaths = [external];
    h.controls.pickChoices.push(items => items.find(item => item.browse === true));
    h.select(doc, lineOf(doc, '100,'));
    const editor = h.window.activeTextEditor;
    await h.ready(doc);
    await h.invoke('add');
    assert.equal(h.writes.length, 1);
    assert.deepEqual(Object.keys(h.disk.get(doc.uri.fsPath)!.fields), [field]);
    assert.deepEqual(h.controls.fileReads, [external]);
    assert.deepEqual(h.controls.targetCalls, [external]);
    assert.equal(h.controls.dialogCalls.length, 1);
    const options = h.controls.dialogCalls[0] as { defaultUri: vscode.Uri; canSelectMany: boolean; filters: Record<string, string[]> };
    assert.equal(options.defaultUri.fsPath, path.dirname(doc.uri.fsPath));
    assert.equal(options.canSelectMany, false);
    assert.deepEqual(Object.values(options.filters), [['json', 'jsonc']]);
    assert.equal(h.window.activeTextEditor, editor);
    assert.deepEqual(h.controls.openedDocuments, []);
    assert.deepEqual(h.errors, []);
    await h.ready(doc);
});

test('一个目标 JSON 对应多个页签时只保存用户选中的工作簿和页签', async t => {
    const h = harness(); t.after(() => h.controller.dispose());
    const { doc, field, target, file } = manualFixture(h);
    const selected = table('ItemsV2', ['100']); selected.target.file = 'other.xlsm';
    h.controls.tables.push(selected);
    h.controls.targets.set(file, [target.target, selected.target]);
    chooseFile(h, file);
    h.controls.pickChoices.push(items => items.find(item => item.target === selected.target));
    await h.ready(doc); await h.invoke('add', doc.uri.toString(), field);
    assert.deepEqual(h.disk.get(doc.uri.fsPath)!.fields[field].targets,
        { [relations.targetKey(selected.target)]: { target: selected.target, decision: 'accepted' } });
    assert.equal(h.controls.pickCalls.length, 2);
    assert.deepEqual(h.controls.metadataCalls, [selected.target]);
    assert.equal(h.controls.indexReads.every(item => item.sheet === selected.target.sheet), true);
    await h.ready(doc);
});

test('启用已有特殊关联保留条件、提取和非 ID 目标键，不新增无条件替代规则', async t => {
    const h = harness(); t.after(() => h.controller.dispose());
    const target = table('Items', ['100']); target.target.keyField = 'quality';
    const when = { field: 'Other', values: [200] }, extract = { separator: ':', index: 0, listSeparator: ',' };
    const rule: TargetRule = { target: target.target, decision: 'rejected', when, extract };
    const sibling: TargetRule = { target: target.target, decision: 'rejected', when: { field: 'Other', values: [201] } };
    const previous = rulesFor(1, 'Ref', rule, sibling);
    const { doc, field, file } = manualFixture(h, previous);
    h.files.set(file, '[["Quality","Name"],[100,"品质配置"]]');
    h.controls.tables = [target];
    h.controls.metadata.set(relations.targetKey(target.target), new Map([['Quality', { description: '品质', detail: '' }]]));
    const chosen = relations.ruleKey(rule.target, rule.when, rule.extract);
    chooseFile(h, file);
    h.controls.pickChoices.push(items => items.find(item => item.key === chosen));
    await h.ready(doc); await h.invoke('add', doc.uri.toString(), field);
    const next = h.disk.get(doc.uri.fsPath)!;
    const expected = structuredClone(previous); expected.fields[field].targets[chosen].decision = 'accepted';
    assert.deepEqual(next, expected);
    assert.equal(h.writes.length, 1);
    assert.equal(h.controls.pickCalls.length, 2);
    assert.deepEqual(h.controls.pickCalls[1], {
        items: [
            { label: '当前状态: 已排除', description: 'Other = 200', key: chosen },
            { label: '当前状态: 已排除', description: 'Other = 201', key: relations.ruleKey(sibling.target, sibling.when) }
        ],
        options: { title: '选择要启用的关联', placeHolder: '选择后启用该关联', ignoreFocusOut: true }
    });
    assert.deepEqual(h.controls.metadataCalls, [target.target]);
    assert.equal(Object.keys(next.fields[field].targets).length, 2);
    assert.deepEqual(h.errors, []);
    await h.ready(doc);
});

test('默认 ID 与条件规则共存时必须明确选择，恢复默认关联不改变条件规则', async t => {
    for (const decision of ['accepted', 'pending', 'rejected'] as const) {
        await t.test(decision, async t => {
            const h = harness(); t.after(() => h.controller.dispose());
            const target = table('Items', ['100']);
            const previous = rulesFor(1, 'Ref', { target: target.target, decision },
                { target: target.target, decision: 'rejected', when: { field: 'Other', values: [200] } });
            const { doc, field, file } = manualFixture(h, previous);
            chooseFile(h, file);
            h.controls.pickChoices.push(items => items.find(item => item.key === relations.ruleKey(target.target)));
            await h.ready(doc); await h.invoke('add', doc.uri.toString(), field);
            assert.equal(h.controls.pickCalls.length, 2, '混合规则不能静默恢复无条件关联');
            assert.deepEqual(h.controls.pickCalls[1].items[0], {
                label: `当前状态: ${decision === 'accepted' ? '已确认' : decision === 'pending' ? '新增等待' : '已排除'}`,
                description: undefined, key: relations.ruleKey(target.target)
            });
            assert.equal(h.writes.length, decision === 'accepted' ? 0 : 1);
            const expected = structuredClone(previous);
            expected.fields[field].targets[relations.ruleKey(target.target)].decision = 'accepted';
            assert.deepEqual(h.disk.get(doc.uri.fsPath), expected);
            assert.equal(h.information.length, 1);
            if (decision === 'accepted') {
                assert.match(h.information[0], /无需重复添加/);
                assert.deepEqual(h.controls.metadataCalls, []);
            }
            assert.deepEqual(h.errors, []);
            await h.ready(doc);
        });
    }
});

test('取消文件、浏览窗口、目标页签或特殊规则选择均不保存也不发成功通知', async t => {
    for (const stage of ['file', 'browse', 'target', 'rule'] as const) {
        await t.test(stage, async t => {
            const h = harness(); t.after(() => h.controller.dispose());
            const previous = stage === 'rule' ? rulesFor(1, 'Ref', {
                target: table('Items', []).target, decision: 'rejected', when: { field: 'Other', values: [200] }
            }) : undefined;
            const { doc, field, file, target } = manualFixture(h, previous);
            if (stage === 'browse') { h.controls.pickChoices.push(items => items.find(item => item.browse === true)); }
            else if (stage !== 'file') { chooseFile(h, file); }
            if (stage === 'target') { h.controls.targets.set(file, [target.target, table('Alternative', []).target]); }
            await h.ready(doc); await h.invoke('add', doc.uri.toString(), field);
            assert.deepEqual(h.disk.get(doc.uri.fsPath), previous);
            assert.equal(h.writes.length, 0);
            assert.deepEqual(h.information, []);
            assert.deepEqual(h.errors, []);
            assert.deepEqual(h.warnings, []);
            assert.equal(h.controls.scans, 0);
        });
    }
});

test('手动目标必须是表格 JSON，非法格式在定位工作簿前拒绝', async t => {
    const invalid = {
        object: '{"ID":100}',
        header: '[["ID",10],[100,"物品"]]',
        row: '[["ID","Name"],{"ID":100}]',
        syntax: '[["ID"],[100]',
        commentInJson: '[/*注释*/["ID"],[100]]'
    };
    for (const [name, text] of Object.entries(invalid)) {
        await t.test(name, async t => {
            const h = harness(); t.after(() => h.controller.dispose());
            const { doc, field, file } = manualFixture(h);
            h.files.set(file, text); chooseFile(h, file);
            await h.ready(doc); await h.invoke('add', doc.uri.toString(), field);
            assert.equal(h.writes.length, 0);
            assert.deepEqual(h.information, []);
            assert.equal(h.errors.length, 1);
            assert.deepEqual(h.controls.targetCalls, []);
        });
    }
});

test('默认关联要求目标 JSON 包含唯一 ID 列，允许工作表中同 ID 的多条记录', async t => {
    for (const kind of ['missing', 'duplicateColumn', 'duplicateRows'] as const) {
        await t.test(kind, async t => {
            const h = harness(); t.after(() => h.controller.dispose());
            const { doc, field, file } = manualFixture(h);
            h.files.set(file, kind === 'missing' ? '[["Key","Name"],[100,"物品"]]'
                : kind === 'duplicateColumn' ? '[["ID","id"],[100,100]]'
                : '[["ID","Name"],[100,"第一条"],[100,"第二条"]]');
            chooseFile(h, file);
            await h.ready(doc); await h.invoke('add', doc.uri.toString(), field);
            assert.deepEqual(h.controls.targetCalls, [file]);
            if (kind === 'duplicateRows') {
                assert.equal(h.writes.length, 1);
                assert.deepEqual(h.errors, []);
                await h.ready(doc);
            } else {
                assert.equal(h.writes.length, 0);
                assert.deepEqual(h.information, []);
                assert.equal(h.errors.length, 1);
                assert.deepEqual(h.controls.metadataCalls, []);
            }
        });
    }
});

test('未保存的目标 JSON 与匹配表自身不能作为手动目标', async t => {
    for (const kind of ['dirty', 'relations', 'extension'] as const) {
        await t.test(kind, async t => {
            const h = harness(); t.after(() => h.controller.dispose());
            const { doc, field, file } = manualFixture(h);
            if (kind === 'dirty') {
                h.document(file, h.files.get(file)!).mutable.isDirty = true;
                chooseFile(h, file);
            } else {
                h.controls.pickChoices.push(items => items.find(item => item.browse === true));
                h.controls.dialogPaths = [h.file(kind === 'relations' ? relationStore.relationFile : 'Notes.txt', '[["ID"],[100]]')];
            }
            await h.ready(doc); await h.invoke('add', doc.uri.toString(), field);
            assert.equal(h.writes.length, 0);
            assert.deepEqual(h.information, []);
            assert.equal(h.errors.length, 1);
            assert.deepEqual(h.controls.targetCalls, []);
        });
    }
});

test('工作簿未映射、键列不唯一或读取失败时不保存手动关联', async t => {
    for (const kind of ['unmapped', 'missingId', 'duplicateId', 'metadata', 'read'] as const) {
        await t.test(kind, async t => {
            const h = harness(); t.after(() => h.controller.dispose());
            const { doc, field, file, target } = manualFixture(h);
            if (kind === 'unmapped') { h.controls.targets.set(file, []); }
            if (kind === 'missingId') { h.controls.metadata.set(relations.targetKey(target.target), new Map()); }
            if (kind === 'duplicateId') {
                h.controls.metadata.set(relations.targetKey(target.target), new Map(['ID', 'id'].map(name => [name, { description: '', detail: '' }])));
            }
            if (kind === 'metadata') { h.controls.metadataError = new Error('无法读取表头'); }
            if (kind === 'read') { h.controls.indexReadError = new Error('无法读取工作簿'); }
            chooseFile(h, file);
            await h.ready(doc); await h.invoke('add', doc.uri.toString(), field);
            assert.equal(h.writes.length, 0);
            assert.deepEqual(h.information, []);
            assert.equal(h.errors.length, 1);
            assert.equal(h.controls.scans, 0);
        });
    }
});

test('选择目标期间源版本、关闭状态或策划表索引变化都会阻止保存', async t => {
    for (const kind of ['version', 'close', 'invalidate', 'updating'] as const) {
        await t.test(kind, async t => {
            const h = harness(); t.after(() => h.controller.dispose());
            const { doc, mutable, field, file } = manualFixture(h);
            const gate = deferred<void>();
            h.controls.targetGate = gate.promise; h.controls.targetStarted = deferred<void>();
            chooseFile(h, file);
            await h.ready(doc);
            const action = h.invoke('add', doc.uri.toString(), field);
            await h.controls.targetStarted.promise;
            if (kind === 'version') { mutable.version++; }
            if (kind === 'close') { mutable.isClosed = true; h.closed.fire(doc); }
            if (kind === 'invalidate') { h.invalidated.fire(); }
            if (kind === 'updating') { h.tableDescriptions.isUpdating = true; }
            gate.resolve(); await action;
            assert.equal(h.writes.length, 0);
            assert.deepEqual(h.information, []);
            assert.equal(h.warnings.length + h.errors.length, 1);
            assert.deepEqual(h.controls.metadataCalls, []);
        });
    }
});

test('手动关联保存失败不误报成功并允许重新加载原规则', async t => {
    const h = harness(); t.after(() => h.controller.dispose());
    const { doc, field, file } = manualFixture(h);
    const previous = await h.ready(doc);
    chooseFile(h, file);
    h.controls.writeError = new Error('匹配表不可写');
    await h.invoke('add', doc.uri.toString(), field);
    assert.equal(h.writes.length, 0);
    assert.equal(h.disk.has(doc.uri.fsPath), false);
    assert.deepEqual(h.information, []);
    assert.match(h.errors[0], /匹配表不可写/);
    const restored = await h.ready(doc);
    assert.notEqual(restored, previous);
    assert.deepEqual(restored.rules, relations.emptyRules());
    assert.equal(restored.loading, false);
    assert.equal(h.controls.scans, 0);
});

test('手动添加拒绝首列 ID 和伪造字段，在显示候选或读取目标前结束', async t => {
    for (const field of [relations.fieldKey(0, 'ID'), relations.fieldKey(1, 'Missing')]) {
        await t.test(field, async t => {
            const h = harness(); t.after(() => h.controller.dispose());
            const { doc } = manualFixture(h);
            await h.ready(doc); await h.invoke('add', doc.uri.toString(), field);
            assert.equal(h.writes.length, 0);
            assert.equal(h.errors.length, 1);
            assert.deepEqual(h.controls.pickCalls, []);
            assert.deepEqual(h.controls.fileReads, []);
            assert.deepEqual(h.controls.targetCalls, []);
        });
    }
});

// 完整记录完成会在下一轮事件中合并刷新；等待该通知窗口也覆盖失败与取消路径。
const settleDetails = () => new Promise<void>(resolve => setTimeout(resolve, 10));

function detailFixture(h: ReturnType<typeof harness>) {
    const target = table('rewards', ['100', '101']);
    const full: RelationRow = { id: '100', row: 435, values: [['ID', '100'], ['itemId', '11014002'], ['range', ''], ['fix', '10']] };
    h.controls.tables = [target];
    h.controls.detailRows.set(relations.targetKey(target.target), new Map([
        ['100', [full]], ['101', [{ id: '101', row: 436, values: [['ID', '101'], ['itemId', '11022010'], ['range', ''], ['fix', '1']] }]]
    ]));
    const rules = rulesFor(1, 'Ref', { target: target.target, decision: 'accepted' });
    return { target, full, rules };
}

test('完整记录仅在 hover 当前值时加载，同一行并发请求合并并保留空字段，首列与 i18n 不读取详情', async t => {
    const h = harness(); t.after(() => h.controller.dispose());
    const { target, full, rules } = detailFixture(h);
    const other = table('未悬停的目标', ['200', '201']); h.controls.tables.push(other);
    Object.assign(rules.fields, rulesFor(2, 'Other', { target: other.target, decision: 'accepted' }).fields);
    const { doc } = h.document('SourceData.json', JSON.stringify([
        ['ID', 'Ref', 'Other', 'Text'], [1, 100, 200, 'i18n_1'], [2, 101, 201, '']
    ], null, 2), rules);
    const state = await h.ready(doc);
    assert.equal(h.controls.detailCalls.length, 0);
    assert.equal(h.controller.view(doc, lineOf(doc, '1,')), undefined);
    const translated = h.controller.view(doc, lineOf(doc, '"i18n_1"'));
    assert.equal(translated?.state.translations.get('i18n_1'), '中文说明');
    assert.equal(translated?.results?.length ?? 0, 0);
    assert.equal(h.controls.detailCalls.length, 0);
    assert.equal(state.data.length, 2);
    const gate = deferred<void>(); h.controls.detailGate = gate.promise;
    const line = lineOf(doc, '100,');
    h.select(doc, line);
    const before = h.changes.length;
    const view = h.controller.view(doc, line)!;
    assert.equal(view.results?.length, 1);
    assert.equal(view.results![0].loading, true);
    h.controller.view(doc, line); h.controller.view(doc, line);
    assert.deepEqual(h.controls.detailCalls, [{ target: target.target, ids: ['100'] }]);
    assert.equal(h.changes.length, before);
    gate.resolve(); await settleDetails();
    const loaded = h.controller.view(doc, line)!.results!;
    assert.equal(loaded[0].loading, false);
    assert.deepEqual(loaded[0].rows, [full]);
    assert.equal(h.changes.length, before + 1);
    assert.equal(h.changes.at(-1), doc.uri.toString());
    assert.equal(h.controls.detailCalls.length, 1);
    assert.equal(h.controls.scans, 0);
    assert.equal(h.writes.length, 0);
});

test('同一值多条规则去重，数组组合值按条件提取并批量读取，重复主键保留所有记录', async t => {
    const h = harness(); t.after(() => h.controller.dispose());
    const { target, full } = detailFixture(h);
    const duplicate: RelationRow = { id: '100', row: 437, values: [['ID', '100'], ['itemId', '另一条记录']] };
    target.rows.get('100')!.push(duplicate);
    h.controls.detailRows.get(relations.targetKey(target.target))!.get('100')!.push(duplicate);
    const rejected = table('已排除', ['100']); h.controls.tables.push(rejected);
    const extract = { separator: ':', index: 0, listSeparator: ',' };
    const rules = rulesFor(1, 'Ref',
        { target: target.target, decision: 'accepted', when: { field: 'Kind', values: [1] }, extract },
        { target: target.target, decision: 'pending', when: { field: 'Kind', values: [1, 3] }, extract },
        { target: rejected.target, decision: 'rejected', extract });
    const { doc } = h.document('SourceData.json', `[
 ["ID","Ref","Kind"],
 [
  1,
  ["100:2,101:3", "100:9", "999:1"],
  1
 ],
 [
  2,
  ["100:5"],
  2
 ]
]`, rules);
    await h.ready(doc);
    assert.equal(h.controller.view(doc, lineOf(doc, '["100:5"],'))?.results?.length ?? 0, 0);
    assert.equal(h.controls.detailCalls.length, 0);
    const line = lineOf(doc, '["100:2,101:3", "100:9", "999:1"],');
    h.select(doc, line);
    const view = h.controller.view(doc, line)!;
    assert.deepEqual(view.results!.map(result => result.id).sort(), ['100', '101']);
    assert.deepEqual(h.controls.detailCalls, [{ target: target.target, ids: ['100', '101'] }]);
    await settleDetails();
    const result = h.controller.view(doc, line)!.results!;
    assert.deepEqual(result.find(item => item.id === '100')!.rows, [full, duplicate]);
    assert.ok(result.every(item => item.column === 1 && item.field === 'Ref' && !item.loading));
    assert.equal(h.controls.detailCalls.length, 1);
    assert.equal(h.controls.scans, 0);
});

test('完整记录读取失败会结束 loading 并缓存错误，重复 hover 不循环重试', async t => {
    const h = harness(); t.after(() => h.controller.dispose());
    const { rules } = detailFixture(h);
    const { doc } = h.document('SourceData.json', JSON.stringify([['ID', 'Ref'], [1, 100]], null, 2), rules);
    await h.ready(doc);
    h.controls.detailError = new Error('工作簿已被移动');
    const line = lineOf(doc, '100');
    h.select(doc, line);
    h.controller.view(doc, line);
    await settleDetails();
    const result = h.controller.view(doc, line)!.results![0];
    assert.equal(result.loading, false);
    assert.match(result.error!, /工作簿已被移动/);
    assert.deepEqual(result.rows, []);
    h.controller.view(doc, line); await settleDetails();
    assert.equal(h.controls.detailCalls.length, 1);
});

test('文档版本变化、关闭和策划目录失效后，旧详情请求完成不再触发刷新', async t => {
    for (const cause of ['version', 'close', 'invalidate'] as const) {
        await t.test(cause, async t => {
            const h = harness(); t.after(() => h.controller.dispose());
            const { rules } = detailFixture(h);
            const { doc, mutable } = h.document('SourceData.json', JSON.stringify([['ID', 'Ref'], [1, 100]], null, 2), rules);
            await h.ready(doc);
            const gate = deferred<void>(); h.controls.detailGate = gate.promise;
            h.select(doc, lineOf(doc, '100'));
            h.controller.view(doc, lineOf(doc, '100'));
            assert.equal(h.controls.detailCalls.length, 1);
            if (cause === 'version') { mutable.version++; }
            else if (cause === 'close') { mutable.isClosed = true; h.closed.fire(doc); }
            else { h.invalidated.fire(); }
            const changes = h.changes.length;
            gate.resolve(); await settleDetails();
            assert.equal(h.changes.length, changes);
        });
    }
});

test('排除或清空规则后不再显示旧详情，进行中的旧请求也不重新刷新', async t => {
    for (const action of ['decide', 'clear'] as const) {
        await t.test(action, async t => {
            const h = harness(); t.after(() => h.controller.dispose());
            const { target, rules } = detailFixture(h);
            const { doc } = h.document('SourceData.json', JSON.stringify([['ID', 'Ref'], [1, 100]], null, 2), rules);
            await h.ready(doc);
            const gate = deferred<void>(); h.controls.detailGate = gate.promise;
            const line = lineOf(doc, '100');
            h.select(doc, line);
            assert.equal(h.controller.view(doc, line)?.results?.length, 1);
            if (action === 'decide') {
                await h.invoke('decide', doc.uri.toString(), relations.fieldKey(1, 'Ref'), relations.ruleKey(target.target), 'rejected');
            } else { await h.invoke('clear', doc.uri.toString()); }
            await h.ready(doc);
            assert.equal(h.controller.view(doc, line)?.results?.length ?? 0, 0);
            const changes = h.changes.length;
            gate.resolve(); await settleDetails();
            assert.equal(h.changes.length, changes);
            assert.equal(h.controller.view(doc, line)?.results?.length ?? 0, 0);
            assert.equal(h.controls.detailCalls.length, 1);
        });
    }
});

test('多行详情同时完成合并通知，其他可见行稍后完成仅重绘而不重开当前 hover', async t => {
    for (const timing of ['sameBatch', 'later'] as const) {
        await t.test(timing, async t => {
            const h = harness(); t.after(() => h.controller.dispose());
            const { target, full, rules } = detailFixture(h);
            const other = table('其他目标', ['200']); h.controls.tables.push(other);
            h.controls.detailRows.set(relations.targetKey(other.target), other.rows);
            Object.assign(rules.fields, rulesFor(2, 'Other', { target: other.target, decision: 'accepted' }).fields);
            const { doc } = h.document('SourceData.json', JSON.stringify([['ID', 'Ref', 'Other'], [1, 100, 200]], null, 2), rules);
            await h.ready(doc);
            const first = deferred<void>(), second = deferred<void>();
            h.controls.detailGates.set(relations.targetKey(target.target), first.promise);
            h.controls.detailGates.set(relations.targetKey(other.target), second.promise);
            const activeLine = lineOf(doc, '100,'), otherLine = lineOf(doc, '200');
            h.select(doc, activeLine);
            h.controller.view(doc, activeLine); h.controller.view(doc, otherLine);
            const before = h.changes.length;
            first.resolve();
            if (timing === 'sameBatch') { second.resolve(); }
            await settleDetails();
            assert.deepEqual(h.changes.slice(before), [doc.uri.toString()]);
            assert.deepEqual(h.controller.view(doc, activeLine)!.results![0].rows, [full]);
            if (timing === 'later') {
                assert.equal(h.controller.view(doc, otherLine)!.results![0].loading, true);
                second.resolve(); await settleDetails();
                assert.deepEqual(h.changes.slice(before), [doc.uri.toString(), '']);
            }
            assert.equal(h.controller.view(doc, otherLine)!.results![0].loading, false);
            assert.equal(h.controls.detailCalls.length, 2);
        });
    }
});

test('详情完成时无当前编辑器或已经切到其他文件，只刷新装饰', async t => {
    for (const selection of ['none', 'otherDocument'] as const) {
        await t.test(selection, async t => {
            const h = harness(); t.after(() => h.controller.dispose());
            const { rules } = detailFixture(h);
            const { doc } = h.document('SourceData.json', JSON.stringify([['ID', 'Ref'], [1, 100]], null, 2), rules);
            await h.ready(doc);
            const gate = deferred<void>(); h.controls.detailGate = gate.promise;
            const line = lineOf(doc, '100'); h.select(doc, line);
            h.controller.view(doc, line);
            if (selection === 'none') { h.window.activeTextEditor = undefined; }
            else { h.select(h.document('OtherData.json', '[]').doc, line); }
            const before = h.changes.length;
            gate.resolve(); await settleDetails();
            assert.deepEqual(h.changes.slice(before), ['']);
            assert.equal(h.controller.view(doc, line)!.results![0].loading, false);
        });
    }
});

test('确认或清空保存失败后恢复原规则和详情加载，旧 pending 请求不会把 hover 卡住', async t => {
    for (const action of ['decide', 'clear'] as const) {
        await t.test(action, async t => {
            const h = harness(); t.after(() => h.controller.dispose());
            const { target, full, rules } = detailFixture(h);
            const { doc } = h.document('SourceData.json', JSON.stringify([['ID', 'Ref'], [1, 100]], null, 2), rules);
            const original = await h.ready(doc);
            const gate = deferred<void>(); h.controls.detailGate = gate.promise;
            const line = lineOf(doc, '100'); h.select(doc, line);
            assert.equal(h.controller.view(doc, line)!.results![0].loading, true);
            h.controls.writeError = new Error('匹配表写入失败');
            const before = h.changes.length;
            if (action === 'decide') {
                await h.invoke('decide', doc.uri.toString(), relations.fieldKey(1, 'Ref'), relations.ruleKey(target.target), 'rejected');
            } else { await h.invoke('clear', doc.uri.toString()); }
            assert.match(h.errors.at(-1)!, /匹配表写入失败/);
            assert.deepEqual(h.information, []);
            assert.equal(h.writes.length, 0);
            assert.deepEqual(h.disk.get(doc.uri.fsPath), rules);
            assert.deepEqual(h.changes.slice(before), [doc.uri.toString()]);
            h.controls.detailGate = undefined; h.controls.writeError = undefined;
            const recovered = await h.ready(doc);
            assert.notEqual(recovered, original);
            assert.deepEqual(recovered.rules, rules);
            h.controller.view(doc, line); await settleDetails();
            assert.deepEqual(h.controller.view(doc, line)!.results![0].rows, [full]);
            assert.equal(h.controller.view(doc, line)!.results![0].loading, false);
            const completed = h.changes.length;
            gate.resolve(); await settleDetails();
            assert.equal(h.changes.length, completed);
            assert.equal(h.controls.detailCalls.length, 2);
        });
    }
});

test('初始规则读取期间清空失败也能重新加载，旧 summary 请求不会永久保持 loading', async t => {
    const h = harness(); t.after(() => h.controller.dispose());
    const { rules } = detailFixture(h);
    const { doc } = h.document('SourceData.json', JSON.stringify([['ID', 'Ref'], [1, 100]], null, 2), rules);
    const reading = deferred<void>(); h.controls.readGate = reading.promise;
    const original = h.controller.get(doc)!;
    assert.equal(original.loading, true);
    h.document(relationStore.relationFile, '{}').mutable.isDirty = true;
    const before = h.changes.length;
    await h.invoke('clear', doc.uri.toString());
    assert.match(h.errors.at(-1)!, /未保存修改/);
    assert.deepEqual(h.changes.slice(before), [doc.uri.toString()]);
    assert.equal(h.writes.length, 0);
    assert.deepEqual(h.information, []);
    reading.resolve(); h.controls.readGate = undefined;
    const recovered = await h.ready(doc);
    assert.notEqual(recovered, original);
    assert.equal(recovered.loading, false);
    assert.deepEqual(recovered.rules, rules);
    assert.equal(recovered.data.length, 1);
    assert.equal(h.controls.scans, 0);
});

test('多行数组逐行只加载当前元素，文档级摘要仍保留整列值', async t => {
    const h = harness(); t.after(() => h.controller.dispose());
    const { target, full, rules } = detailFixture(h);
    const { doc } = h.document('SourceData.json', JSON.stringify([['ID', 'Ref'], [1, [100, 101]]], null, 2), rules);
    const state = await h.ready(doc);
    assert.deepEqual([...state.parsed.values.get(relations.fieldKey(1, 'Ref'))!], ['100', '101']);
    assert.ok(state.data[0].rows.has('100') && state.data[0].rows.has('101'));
    assert.equal(h.controls.detailCalls.length, 0);
    const firstLine = lineOf(doc, '100,'), secondLine = lineOf(doc, '101');
    h.select(doc, firstLine);
    const first = h.controller.view(doc, firstLine)!;
    assert.deepEqual(first.cells.flatMap(cell => cell.values), ['100']);
    assert.deepEqual(first.results!.map(result => result.id), ['100']);
    assert.deepEqual(h.controls.detailCalls, [{ target: target.target, ids: ['100'] }]);
    const second = h.controller.view(doc, secondLine)!;
    assert.deepEqual(second.cells.flatMap(cell => cell.values), ['101']);
    assert.deepEqual(second.results!.map(result => result.id), ['101']);
    assert.deepEqual(h.controls.detailCalls, [{ target: target.target, ids: ['100'] }, { target: target.target, ids: ['101'] }]);
    await settleDetails();
    assert.deepEqual(h.controller.view(doc, firstLine)!.results![0].rows, [full]);
    assert.equal(h.controller.view(doc, secondLine)!.results![0].rows[0].id, '101');
    assert.equal(h.controls.scans, 0);
});

test('i18n 多行数组的 view 仅包含当前行 key，保留对应中文翻译', async t => {
    const h = harness(); t.after(() => h.controller.dispose());
    const { doc } = h.document('SourceData.json', JSON.stringify([['ID', 'Text'], [1, ['i18n_1', 'i18n_2']]], null, 2));
    await h.ready(doc);
    for (const [text, key, translation] of [['"i18n_1",', 'i18n_1', '中文说明'], ['"i18n_2"', 'i18n_2', '第二条说明']]) {
        const line = lineOf(doc, text); h.select(doc, line);
        const view = h.controller.view(doc, line)!;
        assert.deepEqual(view.cells.flatMap(cell => cell.values), [key]);
        assert.equal(view.state.translations.get(key), translation);
        assert.equal(view.results?.length ?? 0, 0);
    }
    assert.equal(h.controls.detailCalls.length, 0);
});

test('数组独立括号行与数组内空行均不加载整数组关联', async t => {
    const h = harness(); t.after(() => h.controller.dispose());
    const { rules } = detailFixture(h);
    const lines = ['[', ' ["ID","Ref"],', ' [', '  1,', '  [', '   100,', '', '   101', '  ]', ' ]', ']'];
    const { doc } = h.document('SourceData.json', lines.join('\n'), rules);
    await h.ready(doc);
    for (const line of [4, 6, 8]) {
        h.select(doc, line);
        const view = h.controller.view(doc, line);
        assert.deepEqual(view?.cells.flatMap(cell => cell.values) ?? [], []);
        assert.equal(view?.results?.length ?? 0, 0);
    }
    await settleDetails();
    assert.equal(h.controls.detailCalls.length, 0);
});

test('同一行有多个数组元素时仍批量读取该行全部值', async t => {
    const h = harness(); t.after(() => h.controller.dispose());
    const { target, rules } = detailFixture(h);
    const { doc } = h.document('SourceData.json', '[\n ["ID","Ref"],\n [\n  1,\n  [100,101]\n ]\n]', rules);
    await h.ready(doc);
    const line = lineOf(doc, '[100,101]'); h.select(doc, line);
    const view = h.controller.view(doc, line)!;
    assert.deepEqual(view.cells.flatMap(cell => cell.values), ['100', '101']);
    assert.deepEqual(view.results!.map(result => result.id), ['100', '101']);
    assert.deepEqual(h.controls.detailCalls, [{ target: target.target, ids: ['100', '101'] }]);
    await settleDetails();
    assert.ok(h.controller.view(doc, line)!.results!.every(result => !result.loading && result.rows.length === 1));
});

test('数组按行查看仍保留 when 整条记录上下文和 arrayIndex 原始下标，数量行不查询 ID', async t => {
    const h = harness(); t.after(() => h.controller.dispose());
    const { target, full } = detailFixture(h);
    target.rows.set('20', [{ id: '20', row: 440, values: [['ID', '20']] }]);
    h.controls.detailRows.get(relations.targetKey(target.target))!.set('20', target.rows.get('20')!);
    const rules = rulesFor(1, 'Ref', { target: target.target, decision: 'accepted', when: { field: 'Kind', values: [1] }, extract: { arrayIndex: 0 } });
    const { doc } = h.document('SourceData.json', JSON.stringify([
        ['ID', 'Ref', 'Kind'], [1, [100, 20], 1], [2, [101, 30], 2]
    ], null, 2), rules);
    await h.ready(doc);
    for (const text of ['20', '101,']) {
        const line = lineOf(doc, text); h.select(doc, line);
        assert.equal(h.controller.view(doc, line)?.results?.length ?? 0, 0);
    }
    assert.equal(h.controls.detailCalls.length, 0);
    const line = lineOf(doc, '100,'); h.select(doc, line);
    const view = h.controller.view(doc, line)!;
    assert.equal(view.cells[0].row.Kind, 1);
    assert.deepEqual(view.results!.map(result => result.id), ['100']);
    assert.deepEqual(h.controls.detailCalls, [{ target: target.target, ids: ['100'] }]);
    await settleDetails();
    assert.deepEqual(h.controller.view(doc, line)!.results![0].rows, [full]);
});

test('递归详情仍在读取时保持 loading，完整子关联和字段说明就绪后才通知当前行', async t => {
    const h = harness(); t.after(() => h.controller.dispose());
    const { target, full, rules } = detailFixture(h);
    const { doc } = h.document('SourceData.json', JSON.stringify([['ID', 'Ref'], [1, 100]], null, 2), rules);
    await h.ready(doc);
    const gate = deferred<void>(); h.controls.cascadeGate = gate.promise;
    h.controls.cascadeStarted = deferred<void>();
    h.controls.cascadeRows = [{ id: '100', row: 435, fields: [
        { name: 'ID', value: '100', description: '奖励ID' },
        { name: 'itemId', value: '11014002', description: '道具id', children: [{
            target: { file: 'items.xlsm', sheet: '道具', names: ['itemconfig'] }, id: '11014002', rows: [{
                id: '11014002', row: 25, fields: [{ name: 'name', value: 'i18n_1', description: '名称', detail: '道具中文名称',
                    translations: [{ key: 'i18n_1', text: '中文说明' }] }]
            }]
        }] }
    ] }];
    const line = lineOf(doc, '100'); h.select(doc, line);
    const before = h.changes.length;
    const pending = h.controller.view(doc, line)!.results![0];
    await h.controls.cascadeStarted.promise;
    assert.equal(pending.loading, true);
    assert.equal(pending.expandedRows, undefined);
    assert.equal(h.changes.length, before);
    assert.deepEqual(h.controls.cascadeCalls, [{ target: target.target, rows: [full] }]);
    h.controller.view(doc, line);
    assert.equal(h.controls.cascadeCalls.length, 1);
    gate.resolve(); await settleDetails();
    const result = h.controller.view(doc, line)!.results![0];
    assert.equal(result.loading, false);
    assert.equal(result.error, undefined);
    assert.deepEqual(result.rows, [full]);
    assert.deepEqual(result.expandedRows, h.controls.cascadeRows);
    assert.deepEqual(h.changes.slice(before), [doc.uri.toString()]);
});

test('递归详情读取期间文档失效，完成后不写回展开结果或触发旧 hover 刷新', async t => {
    const h = harness(); t.after(() => h.controller.dispose());
    const { rules } = detailFixture(h);
    const { doc, mutable } = h.document('SourceData.json', JSON.stringify([['ID', 'Ref'], [1, 100]], null, 2), rules);
    await h.ready(doc);
    const gate = deferred<void>(); h.controls.cascadeGate = gate.promise;
    h.controls.cascadeStarted = deferred<void>();
    const line = lineOf(doc, '100'); h.select(doc, line);
    const pending = h.controller.view(doc, line)!.results![0];
    await h.controls.cascadeStarted.promise;
    mutable.version++;
    const before = h.changes.length;
    gate.resolve(); await settleDetails();
    assert.equal(pending.expandedRows, undefined);
    assert.equal(h.changes.length, before);
    assert.equal(h.writes.length, 0);
});

test('递归详情失败保留已经取得的原始记录并明确报错，不重复重试', async t => {
    const h = harness(); t.after(() => h.controller.dispose());
    const { full, rules } = detailFixture(h);
    const { doc } = h.document('SourceData.json', JSON.stringify([['ID', 'Ref'], [1, 100]], null, 2), rules);
    await h.ready(doc);
    h.controls.cascadeError = new Error('子关联 JSON 无法读取');
    const line = lineOf(doc, '100'); h.select(doc, line);
    const before = h.changes.length;
    h.controller.view(doc, line); await settleDetails();
    const result = h.controller.view(doc, line)!.results![0];
    assert.equal(result.loading, false);
    assert.match(result.error!, /子关联 JSON 无法读取/);
    assert.deepEqual(result.rows, [full]);
    assert.deepEqual(h.changes.slice(before), [doc.uri.toString()]);
    h.controller.view(doc, line); await settleDetails();
    assert.equal(h.controls.cascadeCalls.length, 1);
    assert.equal(h.controls.detailCalls.length, 1);
});

test('保存其他 JSON 的深层规则后，源 JSON 重新展开并取得最新共享规则快照', async t => {
    const h = harness(); t.after(() => h.controller.dispose());
    const { target, rules } = detailFixture(h);
    target.target.names = ['childconfig'];
    const leaf = table('末级目标', ['200']); h.controls.tables.push(leaf);
    const childRules = rulesFor(1, 'Ref', { target: leaf.target, decision: 'accepted' });
    const source = h.document('SourceData.json', JSON.stringify([['ID', 'Ref'], [1, 100]], null, 2), rules).doc;
    const child = h.document('ChildConfigData.json', JSON.stringify([['ID', 'Ref'], [100, 200]], null, 2), childRules).doc;
    const state = await h.ready(source); await h.ready(child);
    const line = lineOf(source, '100'); h.select(source, line);
    h.controller.view(source, line); await settleDetails();
    assert.ok(h.controller.view(source, line)!.results![0].expandedRows?.length);
    assert.equal(h.controls.cascadeOptions.length, 1);
    const key = relations.ruleKey(leaf.target), field = relations.fieldKey(1, 'Ref');
    assert.equal(h.controls.cascadeOptions[0].rules['ChildConfigData.json'].fields[field].targets[key].decision, 'accepted');
    await h.invoke('decide', child.uri.toString(), field, key, 'rejected');
    assert.equal(h.errors.length, 0);
    assert.equal(h.controller.get(source), state);
    assert.equal(h.controller.view(source, line)!.results![0].loading, true);
    await settleDetails();
    const refreshed = h.controller.view(source, line)!.results![0];
    assert.equal(refreshed.loading, false);
    assert.ok(refreshed.expandedRows?.length);
    assert.equal(h.controls.cascadeCalls.length, 2);
    assert.equal(h.controls.cascadeOptions.length, 2);
    assert.ok(h.controls.cascadeOptions.every(options => options.sourceFile === source.uri.fsPath));
    assert.equal(h.controls.cascadeOptions[1].rules['ChildConfigData.json'].fields[field].targets[key].decision, 'rejected');
});

test('成功或失败展开均监听实际依赖 JSON，保存事件防抖合并后废弃旧状态', async t => {
    for (const initial of ['ready', 'error'] as const) {
        await t.test(initial, async t => {
            const h = harness(); t.after(() => h.controller.dispose());
            const { rules } = detailFixture(h);
            const source = h.document('SourceData.json', JSON.stringify([['ID', 'Ref'], [1, 100]], null, 2), rules).doc;
            const child = h.document('nested/ChildConfigData.json', '[]').doc;
            h.controls.cascadeDependencies = [child.uri.fsPath];
            if (initial === 'error') { h.controls.cascadeError = new Error('子 JSON 读取失败'); }
            const original = await h.ready(source);
            const line = lineOf(source, '100'); h.select(source, line);
            h.controller.view(source, line); await settleDetails();
            const dependencyWatchers = () => h.watchers.filter(watcher => typeof watcher.pattern !== 'string'
                && watcher.pattern.base === path.dirname(child.uri.fsPath) && watcher.pattern.pattern === path.basename(child.uri.fsPath));
            assert.equal(dependencyWatchers().length, 1);
            const watcher = dependencyWatchers()[0], before = h.changes.length;
            const notification = new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(() => { subscription.dispose(); reject(new Error('依赖保存未触发失效通知')); }, 1000);
                const subscription = h.controller.onDidChange(uri => {
                    if (uri === '') { clearTimeout(timeout); subscription.dispose(); resolve(); }
                });
            });
            watcher.change.fire(); watcher.change.fire(); watcher.create.fire();
            assert.equal(h.controller.get(source), original);
            assert.equal(h.changes.length, before);
            await notification;
            assert.deepEqual(h.changes.slice(before), ['']);
            h.controls.cascadeError = undefined;
            const refreshed = await h.ready(source);
            assert.notEqual(refreshed, original);
            h.controller.view(source, line); await settleDetails();
            assert.equal(h.controller.view(source, line)!.results![0].loading, false);
            assert.equal(h.controller.view(source, line)!.results![0].error, undefined);
            assert.equal(h.controls.cascadeCalls.length, 2);
            assert.equal(dependencyWatchers().length, 1);
        });
    }
});

async function expansionFixture(h: ReturnType<typeof harness>) {
    const { target, rules } = detailFixture(h);
    h.controls.cascadeRows = [{ id: '100', row: 435, fields: [
        { name: 'ID', value: '100' }, { name: 'itemId', value: '11014002', message: '子关联说明' }
    ] }];
    const { doc, mutable } = h.document('SourceData.json', JSON.stringify([['ID', 'Ref'], [1, 100]], null, 2), rules);
    await h.ready(doc);
    const line = lineOf(doc, '100'); h.select(doc, line);
    h.controller.view(doc, line); await settleDetails();
    const root = cascadeRootKey(1, 'Ref', target.target);
    return { doc, mutable, line, rules, key: cascadeFieldKey(root, 1, 'itemId'), leaf: cascadeFieldKey(root, 0, 'ID') };
}

test('展开收起仅保存个人偏好，保存完成后按顺序重绘与通知当前行，不重新读取关联', async t => {
    const h = harness(); t.after(() => h.controller.dispose());
    const { doc, line, key, rules } = await expansionFixture(h);
    const expansion = h.controller.view(doc, line)!.expansion!;
    assert.equal(expansion.version, doc.version);
    assert.equal(expansion.line, line);
    assert.equal(expansion.expanded.size, 0);
    assert.equal(expansion.collapsed?.size, 0);
    const events: string[] = [];
    const redraw = h.controller.onDidChange(uri => events.push(`changed:${uri}`));
    const toggle = h.controller.onDidToggleExpansion(() => events.push('toggle'));
    t.after(() => { redraw.dispose(); toggle.dispose(); });
    const gate = deferred<void>(); h.controls.personalGate = gate.promise; h.controls.personalStarted = deferred<void>();
    const action = h.invoke('toggle', doc.uri.toString(), doc.version, line, key, true);
    await h.controls.personalStarted.promise;
    assert.equal(h.controller.view(doc, line)!.expansion!.expanded.size, 0);
    assert.deepEqual(events, []);
    gate.resolve(); await action;
    assert.ok(h.controller.view(doc, line)!.expansion!.expanded.has(key));
    assert.equal(h.controller.view(doc, line)!.expansion!.collapsed!.has(key), false);
    assert.deepEqual(h.personalUpdates[0].value, { [key]: true });
    assert.deepEqual(events, ['changed:', 'toggle']);
    assert.deepEqual(h.toggles, [{ uri: doc.uri.toString(), line, version: doc.version }]);
    await h.invoke('toggle', doc.uri.toString(), doc.version, line, key, false);
    assert.equal(h.controller.view(doc, line)!.expansion!.expanded.size, 0);
    assert.ok(h.controller.view(doc, line)!.expansion!.collapsed!.has(key));
    assert.deepEqual(h.personalUpdates[1].value, { [key]: false });
    assert.equal(h.controls.detailCalls.length, 1);
    assert.equal(h.controls.cascadeCalls.length, 1);
    assert.equal(h.controls.scans, 0);
    assert.equal(h.writes.length, 0);
    assert.deepEqual(h.disk.get(doc.uri.fsPath), rules);
    assert.deepEqual(h.information, []);
});

test('展开命令拒绝旧版本、伪造或叶子键、无效行和非法布尔值，不写个人或共享状态', async t => {
    const h = harness(); t.after(() => h.controller.dispose());
    const { doc, line, key, leaf } = await expansionFixture(h);
    const before = h.changes.length;
    await h.invoke('toggle', doc.uri.toString(), doc.version - 1, line, key, true);
    await h.invoke('toggle', doc.uri.toString(), doc.version, line, 'forged', true);
    await h.invoke('toggle', doc.uri.toString(), doc.version, line, leaf, true);
    await h.invoke('toggle', doc.uri.toString(), doc.version, lineOf(doc, '1,'), key, true);
    for (const invalidLine of [-1, doc.lineCount, 1.5]) {
        await h.invoke('toggle', doc.uri.toString(), doc.version, invalidLine, key, true);
    }
    await h.invoke('toggle', doc.uri.toString(), doc.version, line, key, 'true');
    assert.equal(h.warnings.length, 4);
    assert.equal(h.errors.length, 4);
    assert.equal(h.personalUpdates.length, 0);
    assert.equal(h.writes.length, 0);
    assert.equal(h.controls.scans, 0);
    assert.equal(h.controls.detailCalls.length, 1);
    assert.equal(h.changes.length, before);
    assert.deepEqual(h.toggles, []);
});

test('个人展开偏好保存失败不改变当前状态或触发刷新，之后可以重试', async t => {
    const h = harness(); t.after(() => h.controller.dispose());
    const { doc, line, key } = await expansionFixture(h);
    h.controls.personalError = new Error('个人状态无法写入');
    const before = h.changes.length;
    await h.invoke('toggle', doc.uri.toString(), doc.version, line, key, true);
    assert.match(h.errors.at(-1)!, /个人状态无法写入/);
    assert.equal(h.controller.view(doc, line)!.expansion!.expanded.size, 0);
    assert.equal(h.personalUpdates.length, 0);
    assert.equal(h.changes.length, before);
    assert.deepEqual(h.toggles, []);
    h.controls.personalError = undefined;
    await h.invoke('toggle', doc.uri.toString(), doc.version, line, key, true);
    assert.ok(h.controller.view(doc, line)!.expansion!.expanded.has(key));
    assert.equal(h.personalUpdates.length, 1);
    assert.equal(h.toggles.length, 1);
    assert.equal(h.writes.length, 0);
});

test('个人偏好保存期间版本、关闭或索引失效后不触发旧行 hover 刷新', async t => {
    for (const cause of ['version', 'close', 'invalidate'] as const) {
        await t.test(cause, async t => {
            const h = harness(); t.after(() => h.controller.dispose());
            const { doc, mutable, line, key } = await expansionFixture(h);
            const gate = deferred<void>(); h.controls.personalGate = gate.promise; h.controls.personalStarted = deferred<void>();
            const action = h.invoke('toggle', doc.uri.toString(), doc.version, line, key, true);
            await h.controls.personalStarted.promise;
            if (cause === 'version') { mutable.version++; }
            else if (cause === 'close') { mutable.isClosed = true; h.closed.fire(doc); }
            else { h.invalidated.fire(); }
            const before = h.changes.length;
            gate.resolve(); await action;
            assert.equal(h.changes.length, before);
            assert.deepEqual(h.toggles, []);
            assert.equal(h.personalUpdates.length, 1);
            assert.equal(h.writes.length, 0);
        });
    }
});
