import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { TableIndex, configName, type TableSettings } from '../tableIndex';
import { readSheetNames, readSheetRows } from '../workbookReader';
import { RelationIndex } from '../relations';

// 最小 OOXML ZIP 测试夹具，不依赖 Excel 安装，也不携带真实策划数据或宏。
function zip(entries: Record<string, string>): Buffer {
    const locals: Buffer[] = [], central: Buffer[] = [];
    let offset = 0;
    for (const [name, text] of Object.entries(entries)) {
        const filename = Buffer.from(name), data = Buffer.from(text);
        let crc = 0xffffffff;
        for (const byte of data) {
            crc ^= byte;
            for (let bit = 0; bit < 8; bit++) { crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
        }
        crc = (crc ^ 0xffffffff) >>> 0;
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
        local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(filename.length, 26);
        const record = Buffer.alloc(46);
        record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6);
        record.writeUInt32LE(crc, 16); record.writeUInt32LE(data.length, 20); record.writeUInt32LE(data.length, 24);
        record.writeUInt16LE(filename.length, 28); record.writeUInt32LE(offset, 42);
        locals.push(local, filename, data); central.push(record, filename);
        offset += local.length + filename.length + data.length;
    }
    const directory = Buffer.concat(central), end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
    end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, directory, end]);
}
function workbook(sheet: string, rows: string, strings = '') {
    return zip({
        'xl/workbook.xml': `<workbook xmlns:r="urn:relationships"><sheets><sheet name="${sheet}" r:id="rId1"/></sheets></workbook>`,
        'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="/xl/worksheets/sheet1.xml"/></Relationships>',
        'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${rows}</sheetData></worksheet>`,
        'xl/sharedStrings.xml': `<sst>${strings}</sst>`
    });
}
const cell = (ref: string, text: string) => `<c r="${ref}" t="inlineStr"><is><t>${text}</t></is></c>`;
const registryRows = `<row r="1">${cell('A1', '页签')}${cell('B1', '导出名')}</row><row r="2">${cell('A2', '奖励')}${cell('B2', '^RewardConfig')}</row>`;
const dataRows = `<row r="2">${cell('B2', '第一条\n第二条')}</row><row r="3">${cell('A3', '编号')}${cell('B3', '奖励类型')}</row><row r="5">${cell('A5', 'ID')}${cell('B5', 'Type')}</row><row r="6">${cell('A6', '1')}</row>`;
async function fixture(t: { after(fn: () => Promise<void>): void }) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'json-reading-tables-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    await fs.mkdir(path.join(directory, 'Data'));
    await fs.writeFile(path.join(directory, 'Data', '注册表.xlsm'), workbook('注册', registryRows));
    await fs.writeFile(path.join(directory, 'Data', 'unknown-name.xlsm'), workbook('奖励', dataRows));
    const settings: TableSettings = { directory, registry: '', fieldRow: 5, descriptionRow: 3, detailRow: 2, overrides: {} };
    return { directory, settings };
}

test('normalizes front/back-end prefixes and JSON/CSV extensions', () => {
    for (const name of ['@RewardConfig', '^RewardConfig.csv', 'RewardConfig.JSON', '/data/RewardConfig.jsonc']) {
        assert.equal(configName(name), 'rewardconfig');
    }
});

test('手动目标 JSON 通过注册表定位 XLSM 页签和所有别名，只读取数据表表头', async t => {
    const { directory, settings } = await fixture(t);
    await fs.writeFile(path.join(directory, 'Data', '注册表.xlsm'), workbook('注册', registryRows +
        `<row r="3">${cell('A3', '奖励')}${cell('B3', '@RewardAlias')}</row>`));
    const reader = require('../workbookReader') as typeof import('../workbookReader');
    const original = reader.readSheetRows, reads: { file: string; limit: number }[] = [];
    t.mock.method(reader, 'readSheetRows', (...args: Parameters<typeof original>) => {
        reads.push({ file: args[0], limit: args[2] });
        return original(...args);
    });
    const targets = await new RelationIndex(settings).resolveTargets(path.join(directory, 'ClientConfig', 'RewardConfigData.json'));
    assert.deepEqual(targets, [{ file: 'Data/unknown-name.xlsm', sheet: '奖励', names: ['rewardconfig', 'rewardalias'] }]);
    const tableReads = reads.filter(read => path.basename(read.file) !== '注册表.xlsm');
    assert.deepEqual(tableReads, [{ file: path.join(directory, 'Data', 'unknown-name.xlsm'), limit: 5 }]);
});

test('手动目标反查返回所有重名页签候选并尊重该 JSON 的工作簿选择', async t => {
    const { directory, settings } = await fixture(t);
    await fs.writeFile(path.join(directory, 'copy.xlsm'), workbook('奖励', dataRows));
    const index = new RelationIndex(settings), targets = await index.resolveTargets('RewardConfigData.json');
    assert.deepEqual(targets.map(target => target.file).sort(), ['Data/unknown-name.xlsm', 'copy.xlsm']);
    assert.ok(targets.every(target => target.sheet === '奖励' && target.names.join() === 'rewardconfig'));
    const selected = await new RelationIndex({ ...settings, overrides: { RewardConfigData: 'copy.xlsm' } }).resolveTargets('RewardConfigData.json');
    assert.deepEqual(selected, [{ file: 'copy.xlsm', sheet: '奖励', names: ['rewardconfig'] }]);
    await assert.rejects(new RelationIndex({ ...settings, overrides: { RewardConfigData: '../outside.xlsm' } }).resolveTargets('RewardConfigData.json'), /工作簿选择/);
});

test('手动目标不存在或索引读取失败时抛出中文错误，不返回空候选冒充成功', async t => {
    const { directory, settings } = await fixture(t);
    await assert.rejects(new RelationIndex(settings).resolveTargets('UnknownData.json'), /注册表中没有此 JSON/);
    await fs.writeFile(path.join(directory, 'Data', 'unknown-name.xlsm'), '损坏的工作簿');
    await assert.rejects(new RelationIndex(settings).resolveTargets('RewardConfigData.json'), /策划表读取失败/);
});

test('目标候选必须位于策划目录内且仍属于当前页签索引', async t => {
    const { directory, settings } = await fixture(t);
    const outside = { file: path.resolve(directory, '..', 'outside.xlsm'), sheet: '奖励', names: ['rewardconfig'] };
    const lookup = t.mock.method(TableIndex.prototype, 'lookup', async () => ({ state: 'ready' as const, source: outside }));
    t.mock.method(TableIndex.prototype, 'sources', async () => [outside]);
    await assert.rejects(new RelationIndex(settings).resolveTargets('RewardConfigData.json'), /超出策划目录/);
    lookup.mock.mockImplementation(async () => ({ state: 'ready' as const, source: { ...outside, file: path.join(directory, 'not-indexed.xlsm') } }));
    await assert.rejects(new RelationIndex(settings).resolveTargets('RewardConfigData.json'), /不在当前索引/);
});

test('每层关联说明按 XLSM 字段名读取第 3/2 行，忽略无字段名辅助列并缓存页签', async t => {
    const { directory, settings } = await fixture(t);
    const target = { file: 'Data/unknown-name.xlsm', sheet: '奖励', names: [] };
    const withAuxiliary = dataRows.replace(cell('B3', '奖励类型'), cell('B3', '奖励类型') + cell('Z3', '无字段名的辅助列说明'));
    await fs.writeFile(path.join(directory, target.file), workbook('奖励', withAuxiliary));
    const index = new RelationIndex(settings);
    const first = await index.metadata(target);
    assert.deepEqual(first.get('Type'), { description: '奖励类型', detail: '第一条\n第二条' });
    assert.deepEqual(first.get('ID'), { description: '编号', detail: '' });
    assert.equal(first.size, 2);
    await fs.writeFile(path.join(directory, target.file), '后续已损坏，不应为同页签再次读取');
    assert.strictEqual(await index.metadata({ ...target, keyField: 'Type' }), first);
});

test('关联索引扫描未注册页签，重复 ID 保留全部记录，完整列按需读取', async t => {
    const { directory, settings } = await fixture(t);
    await fs.writeFile(path.join(directory, 'extra.xlsm'), workbook('未注册资源',
        `<row r="5">${cell('A5', 'ID')}${cell('B5', 'Name')}${cell('C5', 'Amount')}</row>` +
        `<row r="6">${cell('A6', '100')}${cell('B6', '矿石')}${cell('C6', '20')}</row>` +
        `<row r="7">${cell('A7', '100')}${cell('B7', '矿石变体')}${cell('C7', '30')}</row>`));
    const index = new RelationIndex(settings), all = await index.scan();
    const extra = all.find(table => table.target.sheet === '未注册资源')!;
    assert.equal(extra.rows.get('100')?.length, 2);
    assert.ok(!extra.rows.get('100')?.[0].values.some(([field]) => field === 'Amount'));
    const records = await index.records(extra.target, '100');
    assert.equal(records[0].values.find(([field]) => field === 'Amount')?.[1], '20');
    assert.equal(records[1].values.find(([field]) => field === 'Amount')?.[1], '30');
});

test('关联索引支持明确指定非 ID 键，同页签多个索引互不混淆', async t => {
    const { directory, settings } = await fixture(t);
    await fs.writeFile(path.join(directory, 'group.xlsm'), workbook('分组',
        `<row r="5">${cell('A5', 'ID')}${cell('B5', 'GroupID')}${cell('C5', 'Name')}</row>` +
        `<row r="6">${cell('A6', '100')}${cell('B6', '8')}${cell('C6', '一组')}</row>` +
        `<row r="7">${cell('A7', '200')}${cell('B7', '8')}${cell('C7', '另一组')}</row>`));
    const index = new RelationIndex(settings), target = { file: 'group.xlsm', sheet: '分组', names: [] };
    const ids = await index.read(target), groups = await index.read({ ...target, keyField: 'GroupID' });
    assert.equal(ids.rows.get('100')?.length, 1);
    assert.equal(ids.rows.get('8'), undefined);
    assert.equal(groups.rows.get('8')?.length, 2);
    const records = await index.records({ ...target, keyField: 'GroupID' }, '8');
    assert.deepEqual(records.map(record => record.values.find(([field]) => field === 'ID')?.[1]), ['100', '200']);
    await assert.rejects(index.read({ ...target, keyField: 'Missing' }), /缺少键字段/);
});

test('当前视图的多 ID 完整记录批量读取，重复请求共享缓存并保留所有同键行', async t => {
    const { directory, settings } = await fixture(t);
    const headers = `<row r="5">${cell('A5', 'ID')}${cell('B5', 'itemId')}${cell('C5', 'range')}${cell('D5', 'fix')}</row>`;
    const data = [
        ['100', '501', '1:5', '0'], ['100', '502', '5:10', '1'], ['200', '503', '2:8', ''],
        ['300', '504', '10:20', '0'], ['400', '505', '20:30', '1']
    ].map((row, index) => `<row r="${index + 6}">${row.map((value, column) => cell(`${String.fromCharCode(65 + column)}${index + 6}`, value)).join('')}</row>`).join('');
    await fs.writeFile(path.join(directory, 'details.xlsm'), workbook('明细', headers + data));
    const index = new RelationIndex(settings), target = { file: 'details.xlsm', sheet: '明细', names: [] };
    const summary = await index.read(target);
    assert.deepEqual(summary.rows.get('100')?.[0].values, []);
    // 替换模块边界计数，仍读取真实的最小 XLSM 夹具。
    const reader = require('../workbookReader') as typeof import('../workbookReader');
    const original = reader.readSheetRows;
    let reads = 0;
    t.mock.method(reader, 'readSheetRows', (...args: Parameters<typeof original>) => { reads++; return original(...args); });
    const first = index.recordsMany(target, ['100', '100', '200']);
    const second = index.recordsMany(target, ['200', '300']);
    const [a, b] = await Promise.all([first, second]);
    assert.equal(reads, 1);
    assert.deepEqual([...a.keys()], ['100', '200']);
    assert.equal(a.get('100')?.length, 2);
    assert.deepEqual(a.get('100')![0].values, [['ID', '100'], ['itemId', '501'], ['range', '1:5'], ['fix', '0']]);
    assert.equal(a.get('100')![1].values[1][1], '502');
    assert.equal(a.get('200')![0].values[3][1], '');
    assert.strictEqual(a.get('200'), b.get('200'));
    assert.strictEqual(await index.records(target, '100'), a.get('100'));
    assert.deepEqual((await index.recordsMany(target, ['missing'])).get('missing'), []);
    assert.equal(reads, 1);
    await index.recordsMany(target, ['400']);
    assert.equal(reads, 2);
});

test('完整记录读取失败按 ID 缓存，重绘不重复读，刷新索引后才重试', async t => {
    const { settings } = await fixture(t);
    const target = { file: 'Data/unknown-name.xlsm', sheet: '奖励', names: [] };
    const index = new RelationIndex(settings);
    await index.read(target);
    const reader = require('../workbookReader') as typeof import('../workbookReader');
    let reads = 0;
    const mocked = t.mock.method(reader, 'readSheetRows', async () => { reads++; throw new Error('明细工作簿被占用'); });
    const requests = await Promise.allSettled([index.recordsMany(target, ['1']), index.recordsMany(target, ['1'])]);
    assert.ok(requests.every(result => result.status === 'rejected'));
    await assert.rejects(index.recordsMany(target, ['1']), /被占用/);
    assert.equal(reads, 1);
    mocked.mock.restore();
    assert.equal((await new RelationIndex(settings).recordsMany(target, ['1'])).get('1')?.length, 1);
});

test('摘要之后键值变化时拒绝旧行号，防止展示错误关联记录', async t => {
    const { directory, settings } = await fixture(t);
    const target = { file: 'Data/unknown-name.xlsm', sheet: '奖励', names: [] };
    const index = new RelationIndex(settings);
    await index.read(target);
    await fs.writeFile(path.join(directory, target.file), workbook('奖励', dataRows.replace(cell('A6', '1'), cell('A6', '999'))));
    await assert.rejects(index.recordsMany(target, ['1']), /记录已变化/);
});
test('resolves unknown workbook name recursively and matches exact field names', async t => {
    const { directory, settings } = await fixture(t);
    await fs.writeFile(path.join(directory, '~$locked.xlsm'), 'temporary');
    const result = await new TableIndex(settings).lookup('RewardConfig.json');
    assert.equal(result.state, 'ready');
    assert.equal(result.source?.sheet, '奖励');
    assert.equal(path.basename(result.source!.file), 'unknown-name.xlsm');
    assert.deepEqual(result.fields?.get('Type'), { description: '奖励类型', detail: '第一条\n第二条' });
    assert.equal(result.fields?.get('ID')?.detail, '');
    assert.equal(result.fields?.get('type'), undefined);
});
test('detects ambiguity and respects a saved workbook choice', async t => {
    const { directory, settings } = await fixture(t);
    await fs.writeFile(path.join(directory, 'copy.xlsm'), workbook('奖励', dataRows));
    const result = await new TableIndex(settings).lookup('RewardConfig.json');
    assert.equal(result.state, 'ambiguous');
    assert.equal(result.candidates?.length, 2);
    const selected = await new TableIndex({ ...settings, overrides: { RewardConfig: 'copy.xlsm' } }).lookup('RewardConfig.json');
    assert.equal(selected.state, 'ready');
    assert.equal(path.basename(selected.source!.file), 'copy.xlsm');
});
test('missing entries and invalid overrides never guess another sheet', async t => {
    const { settings } = await fixture(t);
    assert.equal((await new TableIndex(settings).lookup('Other.json')).state, 'missing');
    assert.equal((await new TableIndex({ ...settings, overrides: { RewardConfig: 'missing.xlsm' } }).lookup('RewardConfig.json')).state, 'missing');
});
test('duplicate registries require explicit configuration', async t => {
    const { directory, settings } = await fixture(t);
    await fs.writeFile(path.join(directory, '注册表.xlsm'), workbook('注册', registryRows));
    assert.equal((await new TableIndex(settings).lookup('RewardConfig.json')).state, 'error');
    assert.equal((await new TableIndex({ ...settings, registry: 'Data/注册表.xlsm' }).lookup('RewardConfig.json')).state, 'ready');
});
test('malformed workbooks and missing directories return a diagnostic', async t => {
    const { directory, settings } = await fixture(t);
    await fs.writeFile(path.join(directory, 'broken.xlsm'), 'not a zip');
    const result = await new TableIndex(settings).lookup('RewardConfig.json');
    assert.equal(result.state, 'error');
    assert.match(result.message!, /无法读取/);
    assert.equal((await new TableIndex({ ...settings, directory: path.join(directory, 'missing') }).lookup('RewardConfig.json')).state, 'error');
});
test('shared strings join rich text, preserve entities, and ignore phonetic annotations', async t => {
    const { directory } = await fixture(t);
    const file = path.join(directory, 'shared.xlsm');
    await fs.writeFile(file, workbook('共享字符串', '<row r="3"><c r="A3" t="s"><v>0</v></c></row><row r="5"><c r="A5" t="s"><v>1</v></c></row>',
        '<si><r><t>奖励 &amp; </t></r><r><t>类型</t></r><rPh><t>pinyin</t></rPh></si><si><t>Type</t></si>'));
    assert.equal((await readSheetNames(file))[0].name, '共享字符串');
    const rows = await readSheetRows(file, '共享字符串', 5);
    assert.equal(rows.get(3)?.get('A'), '奖励 & 类型');
    assert.equal(rows.get(5)?.get('A'), 'Type');
});
test('a fresh index picks up changed descriptions and custom header rows', async t => {
    const { directory, settings } = await fixture(t);
    const index = new TableIndex(settings);
    await index.lookup('RewardConfig.json');
    await fs.writeFile(path.join(directory, 'Data', 'unknown-name.xlsm'), workbook('奖励', dataRows.replace('奖励类型', '新描述')));
    const refreshed = await new TableIndex(settings).lookup('RewardConfig.json');
    assert.equal(refreshed.fields?.get('Type')?.description, '新描述');
    const custom = await new TableIndex({ ...settings, fieldRow: 3, descriptionRow: 5 }).lookup('RewardConfig.json');
    assert.equal(custom.fields?.get('新描述')?.description, 'Type');
});

test('strips client Data suffix and preserves workbook override keys', async t => {
    const { settings } = await fixture(t);
    const result = await new TableIndex(settings).lookup('RewardConfigData.json');
    assert.equal(result.state, 'ready');
    assert.equal(result.fields?.get('Type')?.description, '奖励类型');
    const chosen = await new TableIndex({ ...settings, overrides: { RewardConfigData: 'Data/unknown-name.xlsm' } }).lookup('RewardConfigData.json');
    assert.equal(chosen.state, 'ready');
});
test('strips Data before matching even when the unstripped name exists', async t => {
    const { directory, settings } = await fixture(t);
    const exactRow = `<row r="3">${cell('A3', '精确页签')}${cell('B3', '@RewardConfigData')}</row>`;
    await fs.writeFile(path.join(directory, 'Data', '注册表.xlsm'), workbook('注册', registryRows + exactRow));
    await fs.writeFile(path.join(directory, 'exact.xlsm'), workbook('精确页签', dataRows));
    const result = await new TableIndex(settings).lookup('RewardConfigData.json');
    assert.equal(result.state, 'ready');
    assert.equal(result.source?.sheet, '奖励');
});
test('missing entry diagnostic includes the filename and stripped registry name', async t => {
    const { settings } = await fixture(t);
    const result = await new TableIndex(settings).lookup('MissingConfigData.json');
    assert.equal(result.state, 'missing');
    assert.match(result.message!, /MissingConfigData\.json/);
    assert.match(result.message!, /查找名称: missingconfig）/);
});

test('removes only one trailing Data and preserves Data inside registry names', async t => {
    const { directory, settings } = await fixture(t);
    const rows = `<row r="2">${cell('A2', '奖励')}${cell('B2', 'UnitDataConfigData')}</row>`;
    await fs.writeFile(path.join(directory, 'Data', '注册表.xlsm'), workbook('注册', rows));
    const index = new TableIndex(settings);
    assert.equal((await index.lookup('UnitDataConfigDataDATA.json')).state, 'ready');
    // 去掉后缀后没有匹配项时，不再退回完整 JSON 名称。
    assert.equal((await index.lookup('UnitDataConfigData.json')).state, 'missing');
});
