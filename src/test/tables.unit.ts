import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { TableIndex, configName, type TableSettings } from '../tableIndex';
import { readSheetNames, readSheetRows } from '../workbookReader';

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
    assert.match(result.message!, /查找名称：missingconfig）/);
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
