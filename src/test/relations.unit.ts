import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { addCandidates, addManualRelation, emptyRules, fieldKey, parseRelations, parseTranslations, targetKey, ruleKey, valuesForRule, targetsForDocument, selectRelationField, decideRelationRules, relationCellsInRange, type TargetData, type TargetRule } from '../relations';
import { RelationStore, isRelationFile, relationFile, normalizeRules } from '../relationStore';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const table = (sheet: string, ids: string[]): TargetData => ({ target: { file: 'test.xlsm', sheet, names: [] },
    rows: new Map(ids.map(id => [id, [{ id, row: 6, values: [['Name', sheet]] }]])) });

test('首列 ID 不参与；数组/多条记录汇总，i18n 组合字符串提取且不误拆数量', () => {
    const text = '[["ID","Ref","Text"],[99,[1,2],"i18n_1,i18n_2"],[100,null,"1001,20"]]';
    const parsed = parseRelations(text);
    assert.equal(parsed.cells.length, 4);
    assert.ok(parsed.cells.every(cell => cell.column !== 0));
    assert.deepEqual([...parsed.values.get(fieldKey(1, 'Ref'))!], ['1', '2']);
    assert.deepEqual([...parsed.values.get(fieldKey(2, 'Text'))!], ['i18n_1', 'i18n_2', '1001,20']);
    assert.equal(text.slice(parsed.cells[0].start, parsed.cells[0].end), '[1,2]');
    assert.equal(parseRelations('[["ID"],[1]]').cells.length, 0);
    assert.equal(parseRelations('[["ID","Ref"],[1,').cells.length, 0);
});

test('全扫描列出全部候选，确认/排除保留；再次查询不扩大全扫描', () => {
    const parsed = parseRelations('[["ID","Item"],[1,100],[2,200]]');
    const a = table('道具', ['100']), b = table('矿石', ['200']), c = table('资源', ['100']);
    const field = fieldKey(1, 'Item');
    const rules = addCandidates(emptyRules(), parsed, [a, b], true);
    assert.equal(Object.keys(rules.fields[field].targets).length, 2);
    rules.fields[field].targets[targetKey(a.target)].decision = 'accepted';
    rules.fields[field].targets[targetKey(b.target)].decision = 'rejected';
    const normal = addCandidates(rules, parsed, [a, b, c]);
    assert.equal(Object.keys(normal.fields[field].targets).length, 2);
    const rescan = addCandidates(rules, parsed, [a, b, c], true);
    assert.equal(rescan.fields[field].targets[targetKey(a.target)].decision, 'accepted');
    assert.equal(rescan.fields[field].targets[targetKey(b.target)].decision, 'rejected');
    assert.equal(rescan.fields[field].targets[targetKey(c.target)].decision, 'pending');
});

test('无结果和空值记为已扫描，直到显式再扫描；i18n 不匹配普通表 ID', () => {
    const parsed = parseRelations('[["ID","Item","Text","Empty"],[1,404,"i18n_1",null]]');
    const rules = addCandidates(emptyRules(), parsed, [table('道具', ['1', 'i18n_1'])], true);
    assert.ok(Object.values(rules.fields).every(rule => rule.scanned && !Object.keys(rule.targets).length));
    const next = addCandidates(rules, parsed, [table('新增', ['404'])]);
    assert.equal(Object.keys(next.fields[fieldKey(1, 'Item')].targets).length, 0);
    assert.equal(Object.keys(addCandidates(next, parsed, [table('新增', ['404'])], true).fields[fieldKey(1, 'Item')].targets).length, 1);
});

test('中文表按 KeyID 查询 Desc，不将数值 ID 当成翻译 key', () => {
    const translations = parseTranslations('[["ID","KeyID","Desc"],[1,"i18n_1","跳过"],[2,"i18n_2","购买"]]');
    assert.equal(translations.get('i18n_1'), '跳过');
    assert.equal(translations.get('1'), undefined);
    assert.throws(() => parseTranslations('[["ID","Desc"],[1,"错误"]]'), /KeyID/);
});

test('缺少匹配规则时不自动扫描，也不把未分析字段保存为空结论', () => {
    const parsed = parseRelations('[["ID","Priority"],[1,0],[2,1]]');
    const rules = addCandidates(emptyRules(), parsed, [table('RedisConfig', ['0', '1'])]);
    assert.deepEqual(rules, emptyRules());
    assert.deepEqual(targetsForDocument(rules, parsed), []);
    const manual = addCandidates(rules, parsed, [table('RedisConfig', ['0', '1'])], true);
    assert.equal(Object.values(manual.fields[fieldKey(1, 'Priority')].targets)[0].decision, 'pending');
});

test('全搜索只汇总当前字段所有行，同名其他列和未扫描字段保持不变', () => {
    const parsed = parseRelations('[["ID","Ref","Ref","Other"],[1,100,200,0],[2,101,201,1]]');
    const first = fieldKey(1, 'Ref'), second = fieldKey(2, 'Ref');
    const known = table('已排除', ['100']), sameColumn = table('当前列候选', ['101']), otherColumn = table('其他列候选', ['200', '201']);
    const previous = emptyRules();
    previous.fields[first] = { scanned: true, targets: { [targetKey(known.target)]: { target: known.target, decision: 'rejected' } } };
    previous.fields[second] = { scanned: false, targets: { [targetKey(otherColumn.target)]: { target: otherColumn.target, decision: 'accepted' } } };
    const before = structuredClone(previous), selected = selectRelationField(parsed, first);
    assert.deepEqual([...selected.values.keys()], [first]);
    assert.deepEqual([...selected.values.get(first)!], ['100', '101']);
    assert.equal(selected.cells.length, 2);
    const next = addCandidates(previous, selected, [known, sameColumn, otherColumn], true);
    assert.deepEqual(next.fields[second], before.fields[second]);
    assert.equal(next.fields[fieldKey(3, 'Other')], undefined);
    assert.deepEqual(Object.keys(next.fields[first].targets).sort(), [targetKey(known.target), targetKey(sameColumn.target)].sort());
    assert.equal(next.fields[first].targets[targetKey(known.target)].decision, 'rejected');
    assert.deepEqual(previous, before);
    assert.throws(() => selectRelationField(parsed, fieldKey(0, 'ID')), /首列/);
    assert.throws(() => selectRelationField(parsed, fieldKey(1, 'Other')), /不存在/);
    assert.throws(() => selectRelationField(parsed, 'bad-key'), /不存在/);
    const firstId = parsed.primaryRanges[0];
    assert.equal('[["ID","Ref","Ref","Other"],[1,100,200,0],[2,101,201,1]]'.slice(firstId.start, firstId.end), '1');
});

test('合并候选按钮一次确认或排除多个规则，失效参数不会部分修改', () => {
    const field = fieldKey(1, 'Item'), target = table('道具', ['100']).target;
    const a: TargetRule = { target, decision: 'pending' }, b: TargetRule = { target, decision: 'accepted', when: { field: 'Type', values: [1] } };
    const keys = [ruleKey(target), ruleKey(target, b.when)], previous = emptyRules();
    previous.fields[field] = { scanned: true, targets: { [keys[0]]: a, [keys[1]]: b } };
    const before = structuredClone(previous);
    const accepted = decideRelationRules(previous, field, keys, 'accepted');
    assert.ok(Object.values(accepted.fields[field].targets).every(rule => rule.decision === 'accepted'));
    const rejected = decideRelationRules(previous, field, [...keys, keys[0]], 'rejected');
    assert.ok(Object.values(rejected.fields[field].targets).every(rule => rule.decision === 'rejected'));
    assert.throws(() => decideRelationRules(previous, field, [keys[0], 'expired'], 'accepted'), /失效/);
    assert.throws(() => decideRelationRules(previous, field, [], 'rejected'), /失效/);
    assert.deepEqual(previous, before);
});

test('手动关联只新增当前字段的已确认 ID 规则，重复添加不新增且不修改输入', () => {
    const field = fieldKey(1, 'Item'), otherField = fieldKey(2, 'Item');
    const target = { file: 'Data\\items.xlsm', sheet: '道具', names: ['itemconfig'] };
    const otherTarget = table('矿石', []).target, previous = emptyRules();
    previous.fields[field] = { scanned: true, targets: { [targetKey(otherTarget)]: { target: otherTarget, decision: 'rejected' } } };
    previous.fields[otherField] = { scanned: false, targets: { [targetKey(otherTarget)]: { target: otherTarget, decision: 'pending' } } };
    const before = structuredClone(previous), targetBefore = structuredClone(target);
    const next = addManualRelation(previous, field, target);
    assert.equal(next.fields[field].scanned, true);
    assert.deepEqual(next.fields[field].targets[targetKey(target)], { target: { ...target, file: 'Data/items.xlsm' }, decision: 'accepted' });
    assert.deepEqual(next.fields[field].targets[targetKey(otherTarget)], previous.fields[field].targets[targetKey(otherTarget)]);
    assert.deepEqual(next.fields[otherField], previous.fields[otherField]);
    assert.deepEqual(addManualRelation(next, field, target), next);
    assert.deepEqual(previous, before);
    next.fields[field].targets[targetKey(target)].target.names.push('changed');
    assert.deepEqual(target, targetBefore);
    const fresh = addManualRelation(emptyRules(), field, target);
    assert.equal(fresh.fields[field].scanned, false);
});

test('手动选择复用并去重已有默认 ID 规则', () => {
    const field = fieldKey(1, 'Item'), target = table('道具', []).target;
    const previous = emptyRules();
    previous.fields[field] = { scanned: true, targets: {
        legacy: { target: { ...target, keyField: 'ID' }, decision: 'rejected' },
        [targetKey(target)]: { target, decision: 'pending' }
    } };
    const next = addManualRelation(previous, field, target);
    assert.deepEqual(Object.keys(next.fields[field].targets), [targetKey(target)]);
    assert.deepEqual(next.fields[field].targets[targetKey(target)], { target, decision: 'accepted' });
    assert.equal(previous.fields[field].targets.legacy.decision, 'rejected');
});

test('默认 ID 与特殊规则同时存在时也必须选择，不能静默恢复已排除的无条件规则', () => {
    const field = fieldKey(1, 'Item'), target = table('道具', []).target;
    const condition: TargetRule = { target, decision: 'accepted', when: { field: 'Type', values: [2] } };
    const conditionalKey = ruleKey(target, condition.when), previous = emptyRules();
    previous.fields[field] = { scanned: true, targets: {
        [targetKey(target)]: { target, decision: 'rejected' }, [conditionalKey]: condition
    } };
    const before = structuredClone(previous);
    assert.throws(() => addManualRelation(previous, field, target), /选择现有规则/);
    const selected = addManualRelation(previous, field, target, conditionalKey);
    assert.equal(selected.fields[field].targets[targetKey(target)].decision, 'rejected');
    assert.deepEqual(selected.fields[field].targets[conditionalKey], condition);
    const explicitDefault = addManualRelation(previous, field, target, targetKey(target));
    assert.equal(explicitDefault.fields[field].targets[targetKey(target)].decision, 'accepted');
    assert.deepEqual(explicitDefault.fields[field].targets[conditionalKey], condition);
    assert.deepEqual(previous, before);
});

test('同表特殊规则必须明确选择，保留条件、提取和非 ID 键，失效或其他目标不可接受', () => {
    const field = fieldKey(1, 'Reward'), target = table('奖励', []).target;
    const special: TargetRule = { target: { ...target, keyField: 'GroupID' }, decision: 'rejected',
        when: { field: 'Type', values: [1] }, extract: { separator: ':', index: 0 } };
    const other = table('其他表', []).target, key = ruleKey(special.target, special.when, special.extract);
    const previous = emptyRules();
    previous.fields[field] = { scanned: false, targets: { [key]: special, [targetKey(other)]: { target: other, decision: 'pending' } } };
    const before = structuredClone(previous);
    assert.throws(() => addManualRelation(previous, field, target), /选择现有规则/);
    const next = addManualRelation(previous, field, target, key);
    assert.deepEqual(next.fields[field].targets[key], { ...special, decision: 'accepted' });
    assert.deepEqual(next.fields[field].targets[targetKey(other)], before.fields[field].targets[targetKey(other)]);
    assert.equal(Object.keys(next.fields[field].targets).length, 2);
    assert.throws(() => addManualRelation(previous, field, target, targetKey(other)), /不属于当前目标表/);
    assert.throws(() => addManualRelation(previous, field, target, 'expired'), /已失效/);
    assert.throws(() => addManualRelation(previous, fieldKey(2, 'Other'), target, key), /已失效/);
    assert.throws(() => addManualRelation(emptyRules(), field, special.target), /非 ID 键必须选择已有规则/);
    for (const candidate of [
        { target, decision: 'pending' as const, when: special.when },
        { target, decision: 'pending' as const, extract: special.extract },
        { target: special.target, decision: 'pending' as const }
    ]) {
        const rules = { fields: { [field]: { scanned: false, targets: { [ruleKey(candidate.target, candidate.when, candidate.extract)]: candidate } } } };
        assert.throws(() => addManualRelation(rules, field, target), /选择现有规则/);
    }
    assert.deepEqual(previous, before);
});

test('按同一记录的类型字段分流，嵌套数组逐项提取组合值，不把数量当 ID', () => {
    const parsed = parseRelations('[["ID","ItemType","Rewards"],[1,2,[["1001,20"],["1002,30"]]],[2,3,["1003,40"]]]');
    const target = table('矿石', ['1001', '1002']).target;
    const candidate: TargetRule = { target, decision: 'accepted', when: { field: 'ItemType', values: [2] }, extract: { separator: ',', index: 0 } };
    const rewards = parsed.cells.filter(cell => cell.field === 'Rewards');
    assert.equal(rewards[0].row.ID, 1);
    assert.deepEqual(rewards[0].raw, [['1001,20'], ['1002,30']]);
    assert.deepEqual(valuesForRule(rewards[0], candidate), ['1001', '1002']);
    assert.deepEqual(valuesForRule(rewards[1], candidate), []);
    assert.deepEqual(valuesForRule(rewards[0], { ...candidate, when: { field: 'Missing', values: [2] } }), []);
    const lists = parseRelations('[["ID","Rewards"],[1,["1001:20,1002:30",["1003:40"]]]]').cells[0];
    const listRule = { target, decision: 'accepted' as const, extract: { listSeparator: ',', separator: ':', index: 0 } };
    assert.deepEqual(valuesForRule(lists, listRule), ['1001', '1002', '1003']);
    assert.notEqual(ruleKey(target, undefined, listRule.extract), ruleKey(target, undefined, { separator: ':', index: 0 }));
    const rules = emptyRules();
    const key = ruleKey(target, candidate.when, candidate.extract);
    rules.fields[fieldKey(2, 'Rewards')] = { scanned: true, targets: { [key]: candidate } };
    assert.deepEqual(targetsForDocument(rules, parsed), [target]);
    assert.deepEqual(targetsForDocument(rules, parseRelations('[["ID","ItemType","Rewards"],[1,3,"1001,20"]]')), []);
    const rescanned = addCandidates(rules, parsed, [table('矿石', ['1001,20'])], true);
    assert.deepEqual(Object.keys(rescanned.fields[fieldKey(2, 'Rewards')].targets), [key]);
});

test('原生数组明确选取 ID 位置，数量不参与匹配，并可继续拆分选中字符串', () => {
    const parsed = parseRelations('[["ID","Reward"],[1,[1001,20]],[2,["1002:30","1003:40"]],[3,"1004:50"]]');
    const target = table('道具', ['1001']).target;
    const candidate: TargetRule = { target, decision: 'accepted', extract: { arrayIndex: 0 } };
    assert.deepEqual(valuesForRule(parsed.cells[0], candidate), ['1001']);
    assert.deepEqual(valuesForRule(parsed.cells[2], candidate), []);
    const composite: TargetRule = { ...candidate, extract: { arrayIndex: 0, separator: ':', index: 0 } };
    assert.deepEqual(valuesForRule(parsed.cells[1], composite), ['1002']);
    const rules = emptyRules(), field = fieldKey(1, 'Reward');
    rules.fields[field] = { scanned: true, targets: { [ruleKey(target, undefined, candidate.extract)]: candidate } };
    assert.deepEqual(normalizeRules(rules), rules);
    const invalid = structuredClone(rules);
    Object.values(invalid.fields[field].targets)[0].extract = { arrayIndex: 0, index: 1 };
    assert.throws(() => normalizeRules(invalid), /提取/);
});

test('嵌套数组按行查询保留原始顶层索引和条件上下文，括号不回退到完整值', () => {
    const lines = ['[', '["ID","Type","Ref"],', '[1,2,[', '["1001:20",', '"1002:30"],', '["1003:40"]', ']]', ']'];
    const text = lines.join('\r\n'), parsed = parseRelations(text);
    const at = (line: number) => {
        const start = lines.slice(0, line).reduce((offset, value) => offset + value.length + 2, 0);
        return relationCellsInRange(parsed, start, start + lines[line].length).find(cell => cell.field === 'Ref')!;
    };
    const original = parsed.cells.find(cell => cell.field === 'Ref')!;
    const first: TargetRule = { target: table('道具', []).target, decision: 'accepted', when: { field: 'Type', values: [2] },
        extract: { arrayIndex: 0, separator: ':', index: 0 } };
    const second = { ...first, extract: { ...first.extract, arrayIndex: 1 } };
    assert.deepEqual(valuesForRule(at(3), first), ['1001']);
    assert.deepEqual(valuesForRule(at(4), first), ['1002']);
    assert.deepEqual(valuesForRule(at(5), first), []);
    assert.deepEqual(valuesForRule(at(4), second), []);
    assert.deepEqual(valuesForRule(at(5), second), ['1003']);
    assert.deepEqual(valuesForRule(at(6), first), []);
    assert.deepEqual(valuesForRule(at(4), { ...first, when: { field: 'Type', values: [3] } }), []);
    assert.deepEqual(at(4).values, ['1002:30']);
    assert.strictEqual(at(4).raw, original.raw);
    assert.strictEqual(at(4).row, original.row);
    assert.deepEqual(valuesForRule(original, first), ['1001', '1002']);
    assert.deepEqual([...parsed.values.get(fieldKey(2, 'Ref'))!], ['1001:20', '1002:30', '1003:40']);
});

test('同一目标多条条件规则与不同目标键分别保存；旧规则键保持兼容', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'json-reading-routing-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const target = table('矿石', ['1001']).target;
    const first: TargetRule = { target, decision: 'accepted', when: { field: 'Type', values: [1] }, extract: { separator: ',', index: 0 } };
    const second: TargetRule = { ...first, when: { field: 'Type', values: [2] }, extract: { separator: ';', index: 1 } };
    const alternate: TargetRule = { target: { ...target, keyField: 'GroupID' }, decision: 'accepted' };
    const field = fieldKey(2, 'Item'), rules = emptyRules();
    rules.fields[field] = { scanned: true, targets: Object.fromEntries([first, second, alternate].map(candidate => [ruleKey(candidate.target, candidate.when, candidate.extract), candidate])) };
    const store = new RelationStore(root), source = path.join(root, 'TestData.json');
    await store.write(source, rules);
    assert.deepEqual(await store.read(source), rules);
    assert.equal(Object.keys(normalizeRules(rules).fields[field].targets).length, 3);
    assert.equal(ruleKey(target), targetKey(target));
    assert.equal(targetKey({ ...target, keyField: 'ID' }), targetKey(target));
    assert.notEqual(targetKey(alternate.target), targetKey(target));
    const defaultKey = emptyRules();
    defaultKey.fields[field] = { scanned: true, targets: { legacy: { target: { ...target, keyField: ' ID ' }, decision: 'accepted' } } };
    assert.deepEqual(normalizeRules(defaultKey).fields[field].targets, { [targetKey(target)]: { target, decision: 'accepted' } });
    assert.equal(ruleKey(target, { field: 'Type', values: [2, '1', 2] }), ruleKey(target, { field: 'Type', values: [1, 2] }));
    const invalid = structuredClone(rules);
    Object.values(invalid.fields[field].targets)[0].extract!.index = -1;
    assert.throws(() => normalizeRules(invalid), /提取/);
    Object.values(invalid.fields[field].targets)[0].extract!.index = 0;
    Object.values(invalid.fields[field].targets)[0].when!.values = [];
    assert.throws(() => normalizeRules(invalid), /条件/);
});

test('共享单文件按源相对路径隔离，重启/项目搬迁保留，清除 A 不影响 B', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'json-reading-store-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const first = new RelationStore(root);
    const a = path.join(root, 'A/Same.json'), b = path.join(root, 'B/Same.json');
    const parsed = parseRelations('[["ID","Item"],[1,100]]');
    const rules = addCandidates(emptyRules(), parsed, [table('道具', ['100'])], true);
    await first.write(a, rules);
    await first.write(b, rules);
    const text = await fs.readFile(first.file, 'utf8');
    assert.deepEqual(Object.keys(JSON.parse(text).files), ['A/Same.json', 'B/Same.json']);
    assert.ok(!text.includes(root));
    const restarted = new RelationStore(root);
    assert.deepEqual(await restarted.read(a), rules);
    const copy = new RelationStore(path.join(root, 'other-location'));
    await fs.mkdir(path.dirname(copy.file), { recursive: true });
    await fs.copyFile(first.file, copy.file);
    assert.deepEqual(await copy.read(path.join(copy.root, 'A/Same.json')), rules);
    await restarted.write(a);
    assert.equal(await restarted.read(a), undefined);
    assert.deepEqual(await restarted.read(b), rules);
    assert.deepEqual(await fs.readdir(path.dirname(first.file)), ['relations.json']);
    const snapshot = await restarted.snapshot();
    assert.deepEqual(snapshot, { 'B/Same.json': rules });
    snapshot['B/Same.json'].fields = {};
    assert.deepEqual(await restarted.read(b), rules);
});

test('并发窗口合并不同 JSON 与不同目标，冲突决策报错而非覆盖', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'json-reading-concurrent-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const a = new RelationStore(root), b = new RelationStore(root), source = path.join(root, 'Data.json');
    const parsed = parseRelations('[["ID","Item"],[1,100]]');
    const one = table('道具', ['100']), two = table('矿石', ['100']);
    const base = addCandidates(emptyRules(), parsed, [one, two], true);
    await Promise.all([a.write(source, base), b.write(path.join(root, 'Other.json'), base)]);
    const field = fieldKey(1, 'Item'), oneKey = targetKey(one.target), twoKey = targetKey(two.target);
    const first = structuredClone(base), second = structuredClone(base);
    first.fields[field].targets[oneKey].decision = 'accepted';
    second.fields[field].targets[twoKey].decision = 'rejected';
    await Promise.all([a.write(source, first, base), b.write(source, second, base)]);
    const saved = (await a.read(source))!;
    assert.equal(saved.fields[field].targets[oneKey].decision, 'accepted');
    assert.equal(saved.fields[field].targets[twoKey].decision, 'rejected');
    const stale = structuredClone(base);
    stale.fields[field].targets[oneKey].decision = 'rejected';
    await assert.rejects(b.write(source, stale, base), /其他窗口或成员/);
    assert.deepEqual(await a.read(source), saved);
});

test('损坏或冲突匹配表不覆盖；自有文件和越界源路径不参与查询', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'json-reading-invalid-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const store = new RelationStore(root);
    await fs.mkdir(path.dirname(store.file), { recursive: true });
    const invalid = '<<<<<<< HEAD\n{}';
    await fs.writeFile(store.file, invalid);
    await assert.rejects(store.write(path.join(root, 'Data.json'), emptyRules()), /不会覆盖原文件/);
    assert.equal(await fs.readFile(store.file, 'utf8'), invalid);
    assert.ok(isRelationFile(path.join(root, relationFile)));
    await assert.rejects(store.write(store.file, emptyRules()), /不能是关联匹配表/);
    await assert.rejects(store.write(path.join(root, '../Outside.json'), emptyRules()), /必须位于项目/);
    assert.equal(parseRelations('{"files":{}}').cells.length, 0);
    assert.equal(parseRelations('[{"ID":1,"Name":"x"}]').cells.length, 0);
    assert.equal(parseRelations('[1,2,3]').cells.length, 0);
});
