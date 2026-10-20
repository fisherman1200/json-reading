import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildRelationEntries } from '../sidebarModel';
import { emptyRules, fieldKey, parseRelations, ruleKey, type RelationTarget, type TargetRule } from '../relations';

const target: RelationTarget = { file: 'Data/Items.xlsm', sheet: '道具', names: ['itemconfig'] };

test('侧栏按列和字段名去重，首列排除，同名列独立并保留没有规则的字段', () => {
    const parsed = parseRelations('[["ID","Ref","Ref","Text"],[1,10,20,"i18n_1"],[2,11,21,"i18n_2"]]');
    // 即使调用方给出首列 cell，也不生成可操作的首列节点。
    parsed.cells.push({ ...parsed.cells[0], field: 'ID', column: 0 });
    const entries = buildRelationEntries(parsed, emptyRules(), new Map([['Ref', { description: '关联\n道具', detail: '完整备注' }]]));
    assert.deepEqual(entries.map(entry => entry.label), ['Ref', 'Ref', 'Text']);
    assert.deepEqual(entries.map(entry => entry.field), [fieldKey(1, 'Ref'), fieldKey(2, 'Ref'), fieldKey(3, 'Text')]);
    assert.equal(new Set(entries.map(entry => entry.id)).size, 3);
    assert.ok(entries.every(entry => entry.contextValue === 'jsonReadingField' && entry.children?.[0].kind === 'message'));
    assert.equal(entries[0].description, '关联 道具 · 关联 0');
    assert.match(entries[0].tooltip!, /列: 2\n描述: 关联\n道具\n备注: 完整备注/);
});

test('同页签条件和非 ID 键合并为一个启用目标，已排除规则独立成组且可恢复', () => {
    const parsed = parseRelations('[["ID","Ref"],[1,999]]'), field = fieldKey(1, 'Ref'), rules = emptyRules();
    const accepted: TargetRule = { target, decision: 'accepted', when: { field: 'Type', values: [1] } };
    const pending: TargetRule = { target: { ...target, file: 'Data\\Items.xlsm', keyField: 'GroupID', names: ['groupconfig'] },
        decision: 'pending', when: { field: 'Type', values: [2] }, extract: { separator: ':', index: 0 } };
    const rejected: TargetRule = { target, decision: 'rejected', when: { field: 'Type', values: [3] } };
    const keys = [accepted, pending, rejected].map(candidate => ruleKey(candidate.target, candidate.when, candidate.extract));
    rules.fields[field] = { scanned: true, targets: { [keys[0]]: accepted, [keys[1]]: pending, [keys[2]]: rejected } };
    const before = structuredClone(rules), entries = buildRelationEntries(parsed, rules);
    assert.equal(entries[0].description, '关联 1 · 已排除 1');
    const [active, excluded] = entries[0].children!;
    assert.equal(active.label, 'Items.xlsm / 道具');
    assert.equal(active.contextValue, 'jsonReadingTargetPending');
    assert.equal(active.icon, 'link');
    assert.deepEqual(active.keys?.slice().sort(), keys.slice(0, 2).sort());
    assert.deepEqual(active.target, { file: 'Data/Items.xlsm', sheet: '道具', names: ['groupconfig', 'itemconfig'] });
    assert.match(active.tooltip!, /Data\/Items.xlsm \/ 道具/);
    assert.match(active.tooltip!, /待确认 1 条规则，已确认 1 条规则/);
    assert.match(active.tooltip!, /条件: Type = 2/);
    assert.match(active.tooltip!, /键: GroupID/);
    assert.match(active.tooltip!, /值分隔符: ":"，取第 0 项/);
    assert.equal(excluded.kind, 'group');
    assert.equal(excluded.label, '已排除 (1)');
    assert.equal(excluded.children?.[0].contextValue, 'jsonReadingTargetRejected');
    assert.deepEqual(excluded.children?.[0].keys, [keys[2]]);
    assert.notEqual(active.id, excluded.children?.[0].id);
    assert.deepEqual(rules, before);
});

test('没有当前值命中仍显示持久关联，目标顺序和标识不受数据行及规则插入顺序影响', () => {
    const field = fieldKey(1, 'Ref'), rules = emptyRules();
    const other: RelationTarget = { file: 'Another/Items.xlsm', sheet: '道具', names: ['otherconfig'] };
    const a: TargetRule = { target, decision: 'accepted', when: { field: 'MissingType', values: [10] } };
    const b: TargetRule = { target: other, decision: 'accepted' };
    const aKey = ruleKey(target, a.when), bKey = ruleKey(other);
    rules.fields[field] = { scanned: false, targets: { [aKey]: a, [bKey]: b } };
    const parsed = parseRelations('[["ID","Ref"],[1,null],[2,123456789]]');
    const first = buildRelationEntries(parsed, rules);
    const reversed = { fields: { [field]: { scanned: false, targets: { [bKey]: b, [aKey]: a } } } };
    const second = buildRelationEntries(parseRelations('[["ID","Ref"],[10,"unmatched"]]'), reversed);
    assert.deepEqual(first, second);
    const children = first[0].children!;
    assert.equal(children.length, 2);
    assert.ok(children.every(entry => entry.contextValue === 'jsonReadingTargetAccepted' && entry.icon === 'check'));
    assert.equal(children[0].label, children[1].label);
    assert.notEqual(children[0].id, children[1].id);
    assert.notEqual(children[0].tooltip, children[1].tooltip);
});

test('只有排除规则时显示信息和排除组，已扫描空字段与未扫描字段不混为一谈', () => {
    const parsed = parseRelations('[["ID","Ref","Empty"],[1,1,2]]'), field = fieldKey(1, 'Ref'), rules = emptyRules();
    rules.fields[field] = { scanned: true, targets: { [ruleKey(target)]: { target, decision: 'rejected' } } };
    rules.fields[fieldKey(2, 'Empty')] = { scanned: true, targets: {} };
    const entries = buildRelationEntries(parsed, rules);
    assert.equal(entries[0].children?.[0].label, '暂无启用的关联');
    assert.equal(entries[0].children?.[1].children?.[0].icon, 'circle-slash');
    assert.equal(entries[1].children?.[0].label, '暂无关联，可点击加号选择目标 JSON');
    assert.deepEqual(buildRelationEntries(parseRelations('{}'), rules), []);
});

test('说明与备注保持纯文本，长描述仅简述截短，完整备注不写入 HTML 或命令链接', () => {
    const parsed = parseRelations('[["ID","Ref"],[1,1]]'), description = '说明'.repeat(40), detail = '<script>&" [备注](command:example)';
    const entry = buildRelationEntries(parsed, emptyRules(), new Map([['Ref', { description, detail }]]))[0];
    assert.equal(entry.description, '说明'.repeat(30) + '… · 关联 0');
    assert.ok(entry.tooltip?.includes(description));
    assert.ok(entry.tooltip?.includes(detail));
    assert.equal(typeof entry.tooltip, 'string');
});
