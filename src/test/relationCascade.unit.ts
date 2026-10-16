import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { CascadeCancelledError, RelationCascade, type CascadeRow } from '../relationCascade';
import { emptyRules, fieldKey, ruleKey, targetKey, type RelationIndex, type RelationRow, type RelationRules, type RelationTarget, type TargetRule } from '../relations';
import type { FieldDescription } from '../tableIndex';

const target = (name: string, keyField?: string): RelationTarget => ({ file: `${name}.xlsm`, sheet: name, names: [name], ...(keyField ? { keyField } : {}) });
const row = (id: string, values: [string, string][], number = 6): RelationRow => ({ id, row: number, values });
const rule = (to: RelationTarget, extra: Partial<TargetRule> = {}): TargetRule => ({ target: to, decision: 'accepted', ...extra });
function rules(...entries: [number, string, TargetRule[]][]): RelationRules {
    return { fields: Object.fromEntries(entries.map(([column, field, targets]) => [fieldKey(column, field), {
        scanned: true, targets: Object.fromEntries(targets.map(candidate => [ruleKey(candidate.target, candidate.when, candidate.extract), candidate]))
    }])) };
}
const field = (result: CascadeRow, name: string) => result.fields.find(value => value.name === name)!;

/** 这里只替换工作簿 IO，JSON 与翻译仍由实际临时文件读取，避免把 Excel 文本当成 JSON 语义。 */
class MemoryIndex {
    readonly calls: { target: RelationTarget; ids: string[] }[] = [];
    readonly records = new Map<string, Map<string, RelationRow[]>>();
    readonly descriptions = new Map<string, Map<string, FieldDescription>>();
    metadataHook?: (target: RelationTarget) => Promise<Map<string, FieldDescription>>;
    recordsHook?: (target: RelationTarget, ids: string[]) => Promise<Map<string, RelationRow[]>>;
    async metadata(value: RelationTarget) {
        return this.metadataHook ? this.metadataHook(value) : this.descriptions.get(targetKey(value)) ?? new Map<string, FieldDescription>();
    }
    async recordsMany(value: RelationTarget, ids: string[]) {
        this.calls.push({ target: value, ids: [...ids] });
        if (this.recordsHook) { return this.recordsHook(value, ids); }
        return new Map(ids.map(id => [id, this.records.get(targetKey(value))?.get(id) ?? []]));
    }
    put(value: RelationTarget, ...rows: RelationRow[]) {
        const found = this.records.get(targetKey(value)) ?? new Map<string, RelationRow[]>();
        for (const record of rows) { found.set(record.id, [...found.get(record.id) ?? [], record]); }
        this.records.set(targetKey(value), found);
    }
}
async function fixture(t: { after(fn: () => Promise<void>): void }) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'json-reading-cascade-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const directory = path.join(root, 'ClientConfig');
    await fs.mkdir(directory);
    const index = new MemoryIndex(), snapshot: Record<string, RelationRules> = {};
    async function json(name: string, content: unknown, relation?: RelationRules, folder = 'ClientConfig') {
        const relative = `${folder}/${name}Data.json`, file = path.join(root, relative);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, JSON.stringify(content));
        if (relation) { snapshot[relative] = relation; }
        return file;
    }
    const cascade = () => new RelationCascade({ index: index as unknown as RelationIndex, root, sourceFile: path.join(directory, 'SourceData.json'), rules: snapshot });
    return { root, directory, index, snapshot, json, cascade };
}

test('递归按目标 JSON 列号、条件与数组提取；每层保留 XLSM 全字段和说明、中文', async t => {
    const f = await fixture(t), a = target('RewardConfig'), item = target('ItemConfig'), leaf = target('LeafConfig');
    const rewards = rule(item, { when: { field: 'Kind', values: [2] }, extract: { separator: ':', index: 0 } });
    await f.json('RewardConfig', [['ID', 'Kind', 'Rewards', 'Plain', 'Name', 'Empty'], [1, 2, ['501:9', '502:8', '501:99'], [601, 100], 'i18n_parent', []]], rules(
        [0, 'ID', [rule(leaf)]],
        [1, 'Kind', [rule(leaf, { decision: 'rejected' })]],
        [2, 'Rewards', [rewards, rule(item, { ...rewards, when: { field: 'Kind', values: ['2', '3'] } })]],
        [3, 'Plain', [rule(leaf, { extract: { arrayIndex: 0 } })]],
        [5, 'Empty', [rule(leaf)]]
    ));
    await f.json('ItemConfig', [['ID', 'Name', 'Next', 'Kind'], [501, 'i18n_child', 701, 1], [502, 'Second', 900, 30]], rules(
        [2, 'Next', [rule(leaf, { when: { field: 'Kind', values: [1] } })]],
        [3, 'Kind', [rule(leaf, { decision: 'rejected' })]]
    ));
    await f.json('i18zhConfig', [['ID', 'KeyID', 'Desc'], [1, 'i18n_parent', '奖励'], [2, 'i18n_child', '星羽铸币']]);
    f.index.descriptions.set(targetKey(a), new Map([['Rewards', { description: '奖励内容', detail: '格式 ID:数量' }]]));
    f.index.descriptions.set(targetKey(item), new Map([['Name', { description: '道具名称', detail: '中文 key' }]]));
    f.index.descriptions.set(targetKey(leaf), new Map([['Value', { description: '末层说明', detail: '末层备注' }]]));
    f.index.put(item, row('501', [['Name', 'i18n_child'], ['ID', '501'], ['Next', '701'], ['Kind', '1']]),
        row('502', [['ID', '502'], ['Name', 'Second'], ['Next', '900'], ['Kind', '30']]));
    f.index.put(leaf, row('601', [['ID', '601'], ['Value', '完整字段']]), row('701', [['ID', '701'], ['Value', '继续关联']]));
    const engine = f.cascade();
    const [result] = await engine.expand(a, [row('1', [['Name', 'i18n_parent'], ['ID', '1'], ['Plain', '601,100'], ['Kind', '2'], ['Rewards', '501:9,502:8,501:99'], ['Empty', '']])]);
    assert.deepEqual(result.fields.map(value => value.name), ['Name', 'ID', 'Plain', 'Kind', 'Rewards', 'Empty']);
    assert.equal(field(result, 'Rewards').value, '501:9,502:8,501:99');
    assert.equal(field(result, 'Rewards').description, '奖励内容');
    assert.equal(field(result, 'Rewards').detail, '格式 ID:数量');
    assert.deepEqual(field(result, 'Name').translations, [{ key: 'i18n_parent', text: '奖励' }]);
    assert.equal(field(result, 'ID').children, undefined);
    assert.equal(field(result, 'Kind').children, undefined);
    assert.equal(field(result, 'Empty').children, undefined);
    assert.deepEqual(field(result, 'Plain').children?.map(child => child.id), ['601']);
    assert.deepEqual(field(result, 'Rewards').children?.map(child => child.id), ['501', '502']);
    const firstItem = field(result, 'Rewards').children![0].rows[0];
    assert.equal(field(firstItem, 'Name').description, '道具名称');
    assert.deepEqual(field(firstItem, 'Name').translations, [{ key: 'i18n_child', text: '星羽铸币' }]);
    assert.equal(field(field(firstItem, 'Next').children![0].rows[0], 'Value').detail, '末层备注');
    assert.equal(field(field(result, 'Rewards').children![1].rows[0], 'Next').children, undefined);
    assert.deepEqual(f.index.calls.map(call => [call.target.sheet, call.ids]), [['LeafConfig', ['601']], ['ItemConfig', ['501', '502']], ['LeafConfig', ['701']]]);
    assert.ok(engine.dependencies.has(path.join(f.directory, 'ItemConfigData.json')));
    assert.ok(engine.dependencies.has(path.join(f.directory, 'i18zhConfigData.json')));
});

test('非 ID 键命中的多条记录按首列 ID 对齐，JSON 与 Excel 列顺序不同仍准确', async t => {
    const f = await fixture(t), group = target('GroupConfig', 'Group'), leaf = target('LeafConfig');
    await f.json('GroupConfig', [['ID', 'Group', 'Pair', 'Kind'], [10, 8, [100, 1], 1], [20, 8, [200, 3], 2]], rules(
        [2, 'Pair', [rule(leaf, { extract: { arrayIndex: 0 } })]]
    ));
    f.index.put(leaf, row('100', [['ID', '100']]), row('200', [['ID', '200']]));
    const result = await f.cascade().expand(group, [
        row('8', [['Pair', '100,1'], ['ID', '10'], ['Group', '8'], ['Kind', '1']], 6),
        row('8', [['Group', '8'], ['Kind', '2'], ['ID', '20'], ['Pair', '200,3']], 7)
    ]);
    assert.equal(result.length, 2);
    assert.deepEqual(result.map(value => field(value, 'Pair').children?.map(child => child.id)), [['100'], ['200']]);
    assert.deepEqual(result.map(value => value.row), [6, 7]);
});

test('JSON 同键记录不能唯一对齐时明确提示，不能猜数组；未找到目标 ID 同样提示', async t => {
    const f = await fixture(t), a = target('A'), b = target('B');
    await f.json('A', [['ID', 'Ref'], [1, [100, 2]], [1, [200, 3]]], rules([1, 'Ref', [rule(b, { extract: { arrayIndex: 0 } })]]));
    const engine = f.cascade();
    const [ambiguous] = await engine.expand(a, [row('1', [['ID', '1'], ['Ref', '100,2']])]);
    assert.match(ambiguous.message!, /无法唯一对齐/);
    const [missing] = await engine.expand(a, [row('404', [['ID', '404'], ['Ref', '100,2']])]);
    assert.match(missing.message!, /未找到 ID = 404/);
    assert.equal(f.index.calls.length, 0);
});

test('没有目标 JSON 或没有匹配规则是普通叶子，仍显示 XLSM 描述且不扫描', async t => {
    const f = await fixture(t), missing = target('Missing'), noRules = target('NoRules');
    await f.json('NoRules', [['ID', 'Ref'], [1, 999]]);
    for (const value of [missing, noRules, { ...missing, names: [] }]) {
        f.index.descriptions.set(targetKey(value), new Map([['Ref', { description: '字段说明', detail: '备注' }]]));
        const [result] = await f.cascade().expand(value, [row('1', [['ID', '1'], ['Ref', '999']])]);
        assert.equal(result.message, undefined);
        assert.equal(field(result, 'Ref').description, '字段说明');
        assert.equal(field(result, 'Ref').children, undefined);
    }
    assert.equal(f.index.calls.length, 0);
});

test('目标优先同目录；异目录同名配置歧义显式提示并记录候选依赖', async t => {
    const f = await fixture(t), a = target('A'), leaf = target('Leaf');
    const matching = rules([1, 'Ref', [rule(leaf)]]);
    const first = await f.json('A', [['ID', 'Ref'], [1, 100]], matching, 'Other');
    const second = await f.json('A', [['ID', 'Ref'], [1, 200]], matching, 'More');
    const ambiguous = f.cascade(), [bad] = await ambiguous.expand(a, [row('1', [['ID', '1'], ['Ref', '300']])]);
    assert.match(bad.message!, /多个同名候选/);
    assert.ok(ambiguous.dependencies.has(first) && ambiguous.dependencies.has(second));
    await f.json('A', [['ID', 'Ref'], [1, 300]], matching);
    f.index.put(leaf, row('300', [['ID', '300']]));
    const [good] = await f.cascade().expand(a, [row('1', [['ID', '1'], ['Ref', '300']])]);
    assert.equal(good.message, undefined);
    assert.equal(field(good, 'Ref').children?.[0].id, '300');
});

test('存在已配置目标却文件损坏、记录读取失败或键缺失时保留原行并明确说明', async t => {
    const f = await fixture(t), a = target('A'), b = target('B');
    const file = await f.json('A', [['ID', 'Ref'], [1, 100]], rules([1, 'Ref', [rule(b)]]));
    await fs.writeFile(file, '{ broken');
    const [broken] = await f.cascade().expand(a, [row('1', [['ID', '1'], ['Ref', '100']])]);
    assert.match(broken.message!, /不是有效/);
    assert.equal(field(broken, 'Ref').value, '100');
    await f.json('A', [['ID', 'Ref'], [1, 100]], rules([1, 'Ref', [rule(b)]]));
    const [missing] = await f.cascade().expand(a, [row('1', [['ID', '1'], ['Ref', '100']])]);
    assert.match(field(missing, 'Ref').children![0].message!, /未找到 ID = 100/);
    f.index.recordsHook = async () => { throw new Error('工作簿已删除'); };
    const [failed] = await f.cascade().expand(a, [row('1', [['ID', '1'], ['Ref', '100']])]);
    assert.match(field(failed, 'Ref').children![0].message!, /工作簿已删除/);
});

test('循环只在当前递归路径停止，不妨碍同层其他字段关联到同一记录', async t => {
    const f = await fixture(t), a = target('A'), b = target('B');
    await f.json('A', [['ID', 'Ref', 'Other'], [1, 2, 2]], rules([1, 'Ref', [rule(b)]], [2, 'Other', [rule(b)]]));
    await f.json('B', [['ID', 'Back'], [2, 1]], rules([1, 'Back', [rule(a)]]));
    const original = row('1', [['ID', '1'], ['Ref', '2'], ['Other', '2']]);
    f.index.put(a, original); f.index.put(b, row('2', [['ID', '2'], ['Back', '1']]));
    const [result] = await f.cascade().expand(a, [original]);
    for (const name of ['Ref', 'Other']) {
        const child = field(result, name).children![0].rows[0];
        const cycle = field(child, 'Back').children![0].rows[0];
        assert.match(cycle.message!, /循环关联/);
        assert.equal(field(cycle, 'Ref').children, undefined);
    }
});

test('i18n 中文缺项/读取错误明确显示；默认路径与自定义路径都会记录依赖', async t => {
    const f = await fixture(t), a = { ...target('A'), names: [] };
    const records = [row('1', [['ID', '1'], ['Name', 'i18n_ok,i18n_missing']])];
    await f.json('i18zhConfig', [['ID', 'KeyID', 'Desc'], [1, 'i18n_ok', '中文']]);
    const [result] = await f.cascade().expand(a, records);
    assert.deepEqual(field(result, 'Name').translations, [{ key: 'i18n_ok', text: '中文' }, { key: 'i18n_missing', error: '未找到对应 KeyID' }]);
    const engine = new RelationCascade({ index: f.index as unknown as RelationIndex, root: f.root, sourceFile: path.join(f.directory, 'SourceData.json'), rules: {}, i18nFile: '../不存在.json' });
    const [bad] = await engine.expand(a, records);
    assert.ok(field(bad, 'Name').translations!.every(value => /中文表读取失败/.test(value.error!)));
    assert.ok(engine.dependencies.has(path.join(f.root, '不存在.json')));
});

test('关联记录数量有限并明确标记省略，不能默默截断或继续读取超额目标', async t => {
    const f = await fixture(t), a = target('A'), b = target('B');
    const ids = Array.from({ length: 305 }, (_, index) => index + 100);
    await f.json('A', [['ID', 'Refs'], [1, ids]], rules([1, 'Refs', [rule(b)]]));
    f.index.put(b, ...ids.map(id => row(String(id), [['ID', String(id)]])));
    const [result] = await f.cascade().expand(a, [row('1', [['ID', '1'], ['Refs', ids.join(',')]])]);
    assert.equal(f.index.calls[0].ids.length, 299);
    assert.equal(field(result, 'Refs').children!.length, 299);
    assert.match(field(result, 'Refs').message!, /6 个关联键未展开/);
});

test('首个根记录耗尽递归预算后，其他已加载根记录保留全字段说明并逐一提示', async t => {
    const f = await fixture(t), a = target('A'), b = target('B');
    const ids = Array.from({ length: 300 }, (_, index) => index + 100);
    await f.json('A', [['ID', 'Refs'], [1, ids], [2, [999]], [3, [1000]]], rules([1, 'Refs', [rule(b)]]));
    f.index.descriptions.set(targetKey(a), new Map([['Refs', { description: '引用说明', detail: '引用备注' }]]));
    f.index.put(b, ...ids.map(id => row(String(id), [['ID', String(id)]])));
    const result = await f.cascade().expand(a, [row('1', [['ID', '1'], ['Refs', ids.join(',')]]), row('2', [['ID', '2'], ['Refs', '999']], 7), row('3', [['ID', '3'], ['Refs', '1000']], 8)]);
    assert.deepEqual(result.map(value => value.id), ['1', '2', '3']);
    for (const skipped of result.slice(1)) {
        assert.match(skipped.message!, /300 条关联记录上限/);
        assert.equal(skipped.fields.length, 2);
        assert.equal(field(skipped, 'Refs').description, '引用说明');
        assert.equal(field(skipped, 'Refs').detail, '引用备注');
        assert.equal(field(skipped, 'Refs').children, undefined);
    }
    assert.equal(f.index.calls.length, 1);
    assert.equal(f.index.calls[0].ids.length, 299);
});

test('过期回调在 metadata 或完整记录 await 后阻止后续 IO，取消不是读取失败', async t => {
    const f = await fixture(t), a = target('A'), b = target('B');
    await f.json('A', [['ID', 'Ref'], [1, 2]], rules([1, 'Ref', [rule(b)]]));
    let current = true;
    f.index.metadataHook = async () => { current = false; return new Map(); };
    await assert.rejects(f.cascade().expand(a, [row('1', [['ID', '1'], ['Ref', '2']])], () => current), CascadeCancelledError);
    assert.equal(f.index.calls.length, 0);
    f.index.metadataHook = undefined; current = true;
    f.index.recordsHook = async () => { current = false; return new Map([['2', [row('2', [['ID', '2']])]]]); };
    await assert.rejects(f.cascade().expand(a, [row('1', [['ID', '1'], ['Ref', '2']])], () => current), CascadeCancelledError);
    assert.equal(f.index.calls.length, 1);
});

test('共享快照只匹配注册名与文件去除一次 Data 后的名称，不用模糊名字猜目标', async t => {
    const f = await fixture(t), a = target('SomeData');
    await f.json('Some', [['ID', 'Name'], [1, '不应匹配']], emptyRules());
    await f.json('SomeData', [['ID', 'Name'], [1, '精确匹配']], emptyRules());
    const engine = f.cascade(), [result] = await engine.expand(a, [row('1', [['ID', '1'], ['Name', '原表']])]);
    assert.equal(result.message, undefined);
    assert.deepEqual([...engine.dependencies], [path.join(f.directory, 'SomeDataData.json')]);
});

test('未重新导出时仅阻止不一致引用或条件规则，其他字段和当前 XLSM 中文仍正常', async t => {
    const f = await fixture(t), a = target('A'), b = target('B');
    await f.json('A', [['ID', 'Changed', 'Conditional', 'Kind', 'Good', 'Name'], [1, 100, 200, 1, 300, 'i18n_old']], rules(
        [1, 'Changed', [rule(b)]],
        [2, 'Conditional', [rule(b, { when: { field: 'Kind', values: [1] } })]],
        [4, 'Good', [rule(b)]]
    ));
    await f.json('i18zhConfig', [['ID', 'KeyID', 'Desc'], [1, 'i18n_old', '旧名称'], [2, 'i18n_new', '新名称']]);
    f.index.put(b, row('300', [['ID', '300']]));
    const [result] = await f.cascade().expand(a, [row('1', [['ID', '1'], ['Changed', '101'], ['Conditional', '200'], ['Kind', '2'], ['Good', '3.00e2'], ['Name', 'i18n_new']])]);
    assert.match(field(result, 'Changed').message!, /XLSM 与 JSON 值不一致/);
    assert.equal(field(result, 'Changed').value, '101');
    assert.equal(field(result, 'Changed').children, undefined);
    assert.match(field(result, 'Conditional').message!, /条件字段 Kind/);
    assert.equal(field(result, 'Conditional').children, undefined);
    assert.equal(field(result, 'Good').children![0].id, '300');
    assert.deepEqual(field(result, 'Name').translations, [{ key: 'i18n_new', text: '新名称' }]);
    assert.deepEqual(f.index.calls.map(call => call.ids), [['300']]);
});

test('数组只允许确定的导出形式，旧数量/嵌套歧义停止，空默认值和布尔条件兼容', async t => {
    const f = await fixture(t), a = target('A'), b = target('B');
    const pair = rule(b, { extract: { arrayIndex: 0 } });
    await f.json('A', [['ID', 'Changed', 'Ambiguous', 'Nested', 'Empty', 'Zero', 'Enabled', 'BooleanRef'],
        [1, [100, 1], ['100,1', '200'], [[100, 1]], [], 0, true, 300]], rules(
        [1, 'Changed', [pair]], [2, 'Ambiguous', [pair]], [3, 'Nested', [pair]],
        [4, 'Empty', [rule(b)]], [5, 'Zero', [rule(b)]], [7, 'BooleanRef', [rule(b, { when: { field: 'Enabled', values: ['true'] } })]]
    ));
    f.index.put(b, row('0', [['ID', '0']]), row('300', [['ID', '300']]));
    const [result] = await f.cascade().expand(a, [row('1', [['ID', '1'], ['Changed', '100,2'], ['Ambiguous', '100,1,200'], ['Nested', '100,1'], ['Empty', ''], ['Zero', ''], ['Enabled', 'TRUE'], ['BooleanRef', '300']])]);
    for (const name of ['Changed', 'Ambiguous', 'Nested']) {
        assert.match(field(result, name).message!, /不一致或无法确定/);
        assert.equal(field(result, name).children, undefined);
    }
    assert.equal(field(result, 'Empty').message, undefined);
    assert.equal(field(result, 'Empty').children, undefined);
    assert.equal(field(result, 'Zero').children![0].id, '0');
    // 现有规则只接受 string/number 条件值，boolean 本身不转成普通关联值。
    assert.equal(field(result, 'BooleanRef').message, undefined);
    assert.equal(field(result, 'BooleanRef').children, undefined);
    const nested = JSON.stringify([[100, 1]]);
    const [exact] = await f.cascade().expand(a, [row('1', [['ID', '1'], ['Changed', '100,1'], ['Ambiguous', '["100,1","200"]'], ['Nested', nested], ['Empty', ''], ['Zero', ''], ['Enabled', 'TRUE'], ['BooleanRef', '300']])]);
    assert.equal(field(exact, 'Nested').message, undefined);
    assert.equal(field(exact, 'Ambiguous').message, undefined);
});
