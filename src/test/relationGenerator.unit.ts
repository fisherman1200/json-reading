import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fieldKey, targetKey, type RelationRules } from '../relations';

test('离线生成器覆盖清单、拒绝歧义目标并保留已有确认/排除', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'json-relations-generator-'));
    const source = 'assets/resources/ClientConfig/SourceConfigData.json';
    const other = 'assets/resources/ClientConfig/Object.json';
    const field = fieldKey(1, 'Ref');
    const known = { file: 'Data/known.xlsm', sheet: 'Known', names: ['knownconfig'] };
    const kept = { file: 'Data/kept.xlsm', sheet: 'Kept', names: [] };
    const pending = { file: 'Data/pending.xlsm', sheet: 'Pending', names: [] };
    const existing = { version: 1, files: { [source]: { fields: { [field]: { scanned: true, targets: {
        [targetKey(known)]: { target: known, decision: 'rejected' },
        [targetKey(kept)]: { target: kept, decision: 'accepted' },
        [targetKey(pending)]: { target: pending, decision: 'pending' }
    } } } } } };
    const output = path.join(root, 'generated.json');
    const write = async (file: string, value: unknown) => {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, JSON.stringify(value));
    };
    try {
        await write(path.join(root, source), [['ID', 'Ref', 'Type', 'Reward', 'Text', 'Bundle'], [1, 100, 2, [100, 20], 'i18n_1', ['100:20', '200:30']]]);
        await write(path.join(root, other), { ordinary: true });
        await write(path.join(root, 'extensions/json_reading/relations.json'), existing);
        await write(path.join(root, 'inventory.json'), { configs: [
            { file: 'SourceConfigData.json', name: 'SourceConfig', header: ['ID', 'Ref', 'Type', 'Reward', 'Text', 'Bundle'] },
            { file: 'Object.json', name: 'Object', header: null }
        ], catalogue: [
            { ...known, header: { A: 'ID' } },
            { file: 'Data/group.xlsm', sheet: 'Group', names: ['groupconfig'], header: { A: 'ID', B: 'GroupId' } },
            { file: 'Data/a.xlsm', sheet: 'Same', names: ['ambiguous'], header: { A: 'ID' } },
            { file: 'Data/b.xlsm', sheet: 'Same', names: ['ambiguous'], header: { A: 'ID' } }
        ] });
        await write(path.join(root, 'proposals.json'), [
            { source: 'SourceConfig', field: 'Ref', target: 'KnownConfig' },
            { source: 'SourceConfig', field: 'Ref', target: 'KnownConfig', when: { field: 'Type', values: [2] } },
            { source: 'SourceConfig', field: 'ID', target: 'KnownConfig' },
            { source: 'SourceConfig', field: 'Type', target: 'Ambiguous' },
            { source: 'SourceConfig', field: 'Bundle', target: 'KnownConfig', extract: { arrayIndex: 0, separator: ':', index: 0 } },
            { source: 'SourceConfig', field: 'Bundle', target: 'KnownConfig', extract: { separator: ':', index: 0 } },
            { source: 'SourceConfig', field: 'Reward', target: 'GroupConfig', keyField: 'GroupId',
                when: { field: 'Type', values: [2] }, extract: { arrayIndex: 0 } }
        ]);
        await promisify(execFile)(process.execPath, [path.resolve(__dirname, '../../scripts/build-client-relation-map.cjs'),
            root, path.join(root, 'inventory.json'), output, path.join(root, 'proposals.json')]);
        const result = JSON.parse(await fs.readFile(output, 'utf8')) as { files: Record<string, RelationRules> };
        const fields = result.files[source].fields;
        assert.deepEqual(result.files[other].fields, {});
        assert.equal(fields[fieldKey(0, 'ID')], undefined);
        assert.deepEqual(fields[fieldKey(2, 'Type')], { scanned: true, targets: {} });
        assert.equal(fields[field].targets[targetKey(known)].decision, 'rejected');
        assert.equal(fields[field].targets[targetKey(kept)].decision, 'accepted');
        assert.equal(fields[field].targets[targetKey(pending)], undefined);
        assert.equal(Object.keys(fields[field].targets).length, 2);
        const reward = Object.values(fields[fieldKey(3, 'Reward')].targets)[0];
        assert.deepEqual(reward.extract, { arrayIndex: 0 });
        assert.deepEqual(reward.when, { field: 'Type', values: [2] });
        assert.equal(reward.target.keyField, 'GroupId');
        const bundles = Object.values(fields[fieldKey(5, 'Bundle')].targets);
        assert.equal(bundles.length, 1);
        assert.deepEqual(bundles[0].extract, { separator: ':', index: 0 });
        assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'extensions/json_reading/relations.json'), 'utf8')), existing);
        const summary = JSON.parse(await fs.readFile(output + '.summary.json', 'utf8'));
        assert.equal(summary.omitted.length, 2);
        assert.equal(summary.preserved, 2);
        assert.equal(summary.i18nFields, 1);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});
