import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { cascadeBranchKeys, cascadeFieldKey, cascadeMatchKey, cascadeRootKey, RelationExpansionState } from '../relationExpansion';
import type { CascadeRow } from '../relationCascade';
import type { RelationTarget } from '../relations';

const target: RelationTarget = { file: 'Data/ItemBox.xlsm', sheet: 'rewards', names: ['boxrewardconfig'] };
const root = cascadeRootKey(6, 'pools', target);
const parent = cascadeFieldKey(root, 1, 'itemId');
const child = cascadeFieldKey(cascadeMatchKey(parent, target), 1, 'name');
const uri = 'file:///D:/project/assets/BoxConfigData.json';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

class MemoryMemento {
    readonly values = new Map<string, unknown>();
    readonly updates: { key: string; value: unknown }[] = [];
    gate?: Promise<void>;
    started?: ReturnType<typeof deferred>;
    failure?: Error;
    get<T>(key: string): T | undefined { return structuredClone(this.values.get(key)) as T | undefined; }
    async update(key: string, value: unknown) {
        this.started?.resolve();
        await this.gate;
        if (this.failure) { throw this.failure; }
        this.values.set(key, structuredClone(value));
        this.updates.push({ key, value: structuredClone(value) });
    }
}

test('默认没有显式偏好，展开保存 true，收起保存 false', async () => {
    const memento = new MemoryMemento(), state = new RelationExpansionState(memento);
    assert.equal(state.get(uri).size, 0);
    assert.equal(state.getCollapsed(uri).size, 0);
    assert.equal(memento.updates.length, 0);
    await state.set(uri, parent, true);
    assert.deepEqual([...state.get(uri)], [parent]);
    assert.deepEqual(memento.updates[0].value, { [parent]: true });
    assert.match(memento.updates[0].key, /^relations\.expansion\.v1\.[a-f0-9]{64}$/);
    await state.set(uri, parent, false);
    assert.equal(state.get(uri).size, 0);
    assert.deepEqual([...state.getCollapsed(uri)], [parent]);
    assert.deepEqual(memento.updates.at(-1)!.value, { [parent]: false });
});

test('重建状态对象恢复个人记忆，源 JSON 隔离，Windows URI 大小写一致', async () => {
    const memento = new MemoryMemento();
    await new RelationExpansionState(memento).set(uri, parent, true);
    const restored = new RelationExpansionState(memento);
    assert.ok(restored.get(uri).has(parent));
    assert.equal(restored.get('file:///D:/project/assets/OtherConfigData.json').size, 0);
    assert.equal(restored.get(uri.toUpperCase()).has(parent), process.platform === 'win32');
    const snapshot = restored.get(uri) as Set<string>;
    snapshot.clear();
    assert.ok(restored.get(uri).has(parent));
});

test('亲子分支独立记忆，收起父分支不会清掉子分支状态', async () => {
    const state = new RelationExpansionState(new MemoryMemento());
    await state.set(uri, parent, true);
    await state.set(uri, child, true);
    await state.set(uri, parent, false);
    assert.deepEqual([...state.get(uri)], [child]);
    assert.deepEqual([...state.getCollapsed(uri)], [parent]);
    await state.set(uri, parent, true);
    assert.deepEqual(new Set(state.get(uri)), new Set([parent, child]));
    assert.equal(state.getCollapsed(uri).size, 0);
});

test('显式收起重启后恢复且区别于未指定，旧 true 状态仍兼容', async () => {
    const memento = new MemoryMemento(), state = new RelationExpansionState(memento);
    await state.set(uri, parent, false);
    await state.set(uri, child, true);
    const restored = new RelationExpansionState(memento);
    assert.deepEqual([...restored.getCollapsed(uri)], [parent]);
    assert.deepEqual([...restored.get(uri)], [child]);
    assert.equal(restored.getCollapsed(uri).has(root), false);
    assert.equal(restored.get(uri).has(root), false);
    assert.equal(restored.getCollapsed('file:///D:/project/Other.json').size, 0);
    const snapshot = restored.getCollapsed(uri) as Set<string>;
    snapshot.clear();
    assert.ok(restored.getCollapsed(uri).has(parent));
    await restored.set(uri, parent, true);
    assert.equal(restored.getCollapsed(uri).has(parent), false);
    assert.ok(new RelationExpansionState(memento).get(uri).has(parent));
});

test('并发保存串行合并，保存完成前不暴露未落盘的展开状态', async () => {
    const memento = new MemoryMemento(), state = new RelationExpansionState(memento);
    const gate = deferred(); memento.gate = gate.promise; memento.started = deferred();
    const first = state.set(uri, parent, true);
    await memento.started.promise;
    const second = state.set(uri, child, true);
    assert.equal(state.get(uri).size, 0);
    assert.equal(memento.updates.length, 0);
    gate.resolve(); await Promise.all([first, second]);
    assert.equal(memento.updates.length, 2);
    assert.deepEqual(memento.updates[1].value, { [parent]: true, [child]: true });
    assert.deepEqual(new Set(state.get(uri)), new Set([parent, child]));
});

test('保存失败不更改内存或已存状态，后续操作仍可继续', async () => {
    const memento = new MemoryMemento(), state = new RelationExpansionState(memento);
    await state.set(uri, parent, true);
    memento.failure = new Error('状态存储失败');
    await assert.rejects(state.set(uri, parent, false), /状态存储失败/);
    assert.ok(state.get(uri).has(parent));
    assert.equal(state.getCollapsed(uri).has(parent), false);
    assert.ok(new RelationExpansionState(memento).get(uri).has(parent));
    assert.equal(memento.updates.length, 1);
    memento.failure = undefined;
    await state.set(uri, child, true);
    assert.deepEqual(new Set(state.get(uri)), new Set([parent, child]));
    await state.set(uri, parent, false);
    memento.failure = new Error('状态存储失败');
    await assert.rejects(state.set(uri, parent, true), /状态存储失败/);
    assert.ok(state.getCollapsed(uri).has(parent));
    assert.ok(new RelationExpansionState(memento).getCollapsed(uri).has(parent));
});

test('非法旧状态安全忽略，只恢复合法分支键的布尔偏好', async () => {
    const memento = new MemoryMemento();
    await new RelationExpansionState(memento).set(uri, parent, true);
    const storageKey = memento.updates[0].key;
    for (const invalid of [null, true, 'expanded', [parent], 1]) {
        memento.values.set(storageKey, invalid);
        assert.equal(new RelationExpansionState(memento).get(uri).size, 0);
        assert.equal(new RelationExpansionState(memento).getCollapsed(uri).size, 0);
    }
    memento.values.set(storageKey, { [parent]: true, [child]: 'true', invalid: true, [root]: false });
    assert.deepEqual([...new RelationExpansionState(memento).get(uri)], [parent]);
    assert.deepEqual([...new RelationExpansionState(memento).getCollapsed(uri)], [root]);
    await assert.rejects(new RelationExpansionState(memento).set(uri, 'invalid', true), /参数无效/);
});

test('结构键固定长度且区分源字段、目标表、主键及子字段位置', () => {
    const key = cascadeRootKey(6, 'pools', target);
    assert.equal(key, cascadeRootKey(6, 'pools', { ...target, names: ['renamedAlias'] }));
    const distinct = [key, cascadeRootKey(7, 'pools', target), cascadeRootKey(6, 'rewards', target),
        cascadeRootKey(6, 'pools', { ...target, sheet: 'other' }), cascadeRootKey(6, 'pools', { ...target, file: 'Other.xlsm' }),
        cascadeRootKey(6, 'pools', { ...target, keyField: 'Type' }), cascadeFieldKey(key, 0, 'Ref'),
        cascadeFieldKey(key, 1, 'Ref'), cascadeFieldKey(key, 0, 'Other'), cascadeMatchKey(key, target)];
    assert.equal(new Set(distinct).size, distinct.length);
    assert.ok(distinct.every(value => /^[a-f0-9]{64}$/.test(value)));
    let nested = key;
    for (let depth = 0; depth < 100; depth++) { nested = cascadeFieldKey(cascadeMatchKey(nested, target), 0, 'Ref'); }
    assert.equal(nested.length, 64);
});

test('收集所有可展开字段，重复记录共用结构键，ID 行号和值变化不改变标识', () => {
    const nested: CascadeRow = { id: '200', row: 20, fields: [{ name: 'name', value: 'i18n_1', translations: [{ key: 'i18n_1', text: '中文' }] }] };
    const row: CascadeRow = { id: '100', row: 10, fields: [
        { name: 'ID', value: '100' },
        { name: 'Ref', value: '200', children: [{ target, id: '200', rows: [nested] }] },
        { name: 'error', value: '300', message: '读取失败' },
        { name: 'missing', value: '400', children: [{ target, id: '400', rows: [], message: '未找到' }] },
        { name: 'plain', value: '500', children: [], translations: [] },
        { name: 'unmatched', value: '600', children: [{ target, id: '600', rows: [] }] }
    ] };
    const refKey = cascadeFieldKey(root, 1, 'Ref');
    const expected = new Set([refKey, cascadeFieldKey(root, 2, 'error'), cascadeFieldKey(root, 3, 'missing'), cascadeFieldKey(root, 5, 'unmatched'),
        cascadeFieldKey(cascadeMatchKey(refKey, target), 0, 'name')]);
    assert.deepEqual(cascadeBranchKeys([row, structuredClone(row)], root), expected);
    const changed = structuredClone(row);
    changed.id = '999'; changed.row = 999;
    changed.fields[1].value = '888';
    const match = changed.fields[1].children![0];
    match.id = '888'; match.rows[0].id = '888'; match.rows[0].row = 1000;
    match.rows[0].fields[0].value = 'i18n_changed';
    assert.deepEqual(cascadeBranchKeys([changed], root), expected);
    changed.fields[1].children![0].target = { ...target, sheet: 'another' };
    const otherTarget = cascadeBranchKeys([changed], root);
    assert.ok(otherTarget.has(refKey));
    assert.ok(!otherTarget.has(cascadeFieldKey(cascadeMatchKey(refKey, target), 0, 'name')));
});
