import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runInThisContext } from 'node:vm';
import { createRequire } from 'node:module';
import type * as vscode from 'vscode';
import type { RelationController, RelationState } from '../relationController';
import type { TableDescriptions } from '../tableDescriptions';
import * as relations from '../relations';
import * as relationStore from '../relationStore';
import type { RelationRules, RelationTarget, TargetData } from '../relations';

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

/** 仅替换编辑器、磁盘和 XLSM 边界，命令调度、选列、规则计算和保存流程执行真实代码。 */
function harness() {
    const root = path.resolve('virtual-relation-controller-project');
    const commands = new Map<string, (...args: unknown[]) => Promise<void>>();
    const disk = new Map<string, RelationRules>();
    const writes: { file: string; rules?: RelationRules }[] = [];
    const documents: vscode.TextDocument[] = [];
    const information: string[] = [], errors: string[] = [], warnings: string[] = [], events: string[] = [];
    const progress: { location: number; title: string }[] = [];
    const controls = {
        tables: [] as TargetData[],
        scanError: undefined as Error | undefined,
        scanGate: undefined as Promise<TargetData[]> | undefined,
        scanStarted: undefined as ReturnType<typeof deferred<void>> | undefined,
        writeGate: undefined as Promise<void> | undefined,
        writeStarted: undefined as ReturnType<typeof deferred<void>> | undefined,
        readGate: undefined as Promise<void> | undefined,
        scans: 0
    };
    const tableDescriptions = {
        directory: path.join(root, 'tables'),
        tableSettings: { directory: path.join(root, 'tables') },
        isUpdating: false,
        onDidInvalidate: noopEvent
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
        showQuickPick: async () => undefined
    };
    class MemoryStore {
        readonly file = path.join(root, relationStore.relationFile);
        async read(file: string) {
            await controls.readGate;
            return structuredClone(disk.get(file));
        }
        async write(file: string, rules?: RelationRules) {
            controls.writeStarted?.resolve();
            await controls.writeGate;
            writes.push({ file, rules: structuredClone(rules) });
            if (rules) { disk.set(file, structuredClone(rules)); }
            else { disk.delete(file); }
            events.push('write:complete');
        }
    }
    class MemoryIndex {
        async scan() {
            controls.scans++;
            controls.scanStarted?.resolve();
            if (controls.scanError) { throw controls.scanError; }
            return controls.scanGate ? await controls.scanGate : controls.tables;
        }
        async read(target: RelationTarget) {
            const found = controls.tables.find(item => relations.targetKey(item.target) === relations.targetKey(target));
            if (!found) { throw new Error('测试关联表不存在'); }
            return found;
        }
    }
    const mockedVSCode = {
        EventEmitter: TestEvent,
        ProgressLocation: { Window: 10 },
        RelativePattern: class { constructor(readonly base: string, readonly pattern: string) {} },
        window,
        workspace: {
            isTrusted: true, textDocuments: documents,
            getWorkspaceFolder: () => ({ uri: { fsPath: root } }),
            onDidChangeConfiguration: noopEvent, onDidChangeTextDocument: noopEvent, onDidCloseTextDocument: noopEvent,
            createFileSystemWatcher: () => ({ dispose() {}, onDidChange: noopEvent, onDidCreate: noopEvent, onDidDelete: noopEvent }),
            getConfiguration: () => ({ get: (_name: string, fallback: unknown) => fallback })
        },
        commands: { registerCommand: (name: string, command: (...args: unknown[]) => Promise<void>) => {
            commands.set(name, command);
            return { dispose: () => commands.delete(name) };
        } }
    };
    const injected = new Map<string, unknown>([
        ['vscode', mockedVSCode],
        ['./relations', { ...relations, RelationIndex: MemoryIndex }],
        ['./relationStore', { ...relationStore, RelationStore: MemoryStore }],
        ['node:fs/promises', { readFile: async () => JSON.stringify([...disk]) }],
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
    const context = { workspaceState: { get: () => undefined, update: async () => {} } };
    const controller: RelationController = new exported.exports.RelationController(
        context as unknown as vscode.ExtensionContext, tableDescriptions as unknown as TableDescriptions);
    function document(name: string, text: string, initial?: RelationRules) {
        const file = path.join(root, name);
        const uri = { fsPath: file, scheme: 'file', toString: () => `file://${file.replace(/\\/g, '/')}` };
        const mutable = { uri, languageId: 'json', version: 1, isClosed: false, isDirty: false, getText: () => text };
        const doc = mutable as unknown as vscode.TextDocument;
        documents.push(doc);
        if (initial) { disk.set(file, structuredClone(initial)); }
        return { doc, mutable };
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
    return { controller, controls, tableDescriptions, disk, writes, information, errors, warnings, events, progress, document, ready, invoke };
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
