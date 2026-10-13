import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { collectFieldHints } from '../fieldHints';

test('maps scalar values by column, including null, booleans and escaped strings', () => {
    const hints = collectFieldHints('[\n["ID","Name","Flag","Empty"],\n[\n1,\n"a, \\"quoted\\"",\ntrue,\nnull\n]\n]');
    assert.deepEqual([...hints], [[3, ['ID']], [4, ['Name']], [5, ['Flag']], [6, ['Empty']]]);
});

test('nested arrays and objects retain the parent field on every line', () => {
    const text = '[\n["ID", "Attribute", "Name"],\n[\n1,\n[\n"AttackProp:0.10",\n{"nested": [1, 2]}\n],\n"Alice"\n]\n]';
    assert.deepEqual([...collectFieldHints(text)], [
        [3, ['ID']], [4, ['Attribute']], [5, ['Attribute']],
        [6, ['Attribute']], [7, ['Attribute']], [8, ['Name']]
    ]);
});

test('multiple columns sharing one source line are combined in order', () => {
    assert.deepEqual([...collectFieldHints('[["ID","Name"],[1,"A"],[2,"B"]]')], [[0, ['ID', 'Name']]]);
});

test('CRLF and Unicode do not shift line mapping', () => {
    assert.deepEqual([...collectFieldHints('[\r\n["名字"],\r\n["😀"]\r\n]')], [[2, ['名字']]]);
});

test('ignores ordinary objects, invalid headers, empty files and broken JSON', () => {
    for (const text of ['', '{}', '[]', '[[],[1]]', '[["ID",2],[1,2]]', '[["ID"],[1,]]', '[["ID"],[', '[["ID"],[1]] garbage']) {
        assert.equal(collectFieldHints(text).size, 0, text);
    }
});

test('short rows keep their columns; excess values and non-array rows are ignored', () => {
    assert.deepEqual([...collectFieldHints('[\n["ID","Name"],\n[1],\nnull,\n[2,"B",3]\n]')], [[2, ['ID']], [4, ['ID', 'Name']]]);
});

test('JSONC comments and trailing commas are supported only in JSONC mode', () => {
    const text = '[\n["ID"], // header\n[1,],\n]';
    assert.equal(collectFieldHints(text).size, 0);
    assert.deepEqual([...collectFieldHints(text, true)], [[2, ['ID']]]);
});
