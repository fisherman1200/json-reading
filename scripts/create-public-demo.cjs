// All values are fictional. Generates an isolated workspace for documentation screenshots.
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { execFileSync } = require('node:child_process');
const { ZipFile } = require('yazl');
const root = path.resolve(__dirname, '..', '.vscode-test', 'public-demo');
const xml = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[ch]));
async function workbook(file, sheet, rows) {
    const zip = new ZipFile();
    const data = rows.map((values, index) => `<row r="${index + 1}">${values.map((value, col) =>
        `<c r="${String.fromCharCode(65 + col)}${index + 1}" t="inlineStr"><is><t>${xml(value)}</t></is></c>`).join('')}</row>`).join('');
    for (const [name, text] of Object.entries({
        'xl/workbook.xml': `<workbook xmlns:r="urn:relationships"><sheets><sheet name="${xml(sheet)}" r:id="rId1"/></sheets></workbook>`,
        'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="/xl/worksheets/sheet1.xml"/></Relationships>',
        'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${data}</sheetData></worksheet>`
    })) zip.addBuffer(Buffer.from(text), name);
    zip.end();
    await pipeline(zip.outputStream, syncFs.createWriteStream(file));
}
async function main() {
    const project = path.join(root, 'demo-project'), tables = path.join(root, 'demo-tables');
    await fs.mkdir(path.join(project, '.vscode'), { recursive: true });
    await fs.mkdir(path.join(project, 'extensions/json_reading'), { recursive: true });
    await fs.mkdir(tables, { recursive: true });
    const header = ['ID', 'name', 'exchangeCost', 'limitCount', 'enabled'];
    const product = [1001, 'i18n_demo_product', '2001:5', -1, true];
    const points = [['ID', 'name', 'desc', 'itemType'], [2001, 'i18n_demo_points', 'i18n_demo_description', 1]];
    await fs.writeFile(path.join(project, 'ProductConfigData.json'), JSON.stringify([header, product], null, 2) + '\n');
    await fs.writeFile(path.join(project, 'PointsConfigData.json'), JSON.stringify(points, null, 2) + '\n');
    await fs.writeFile(path.join(project, 'i18zhConfigData.json'), JSON.stringify([
        ['KeyID', 'Desc'], ['i18n_demo_product', '演示马克杯'],
        ['i18n_demo_points', '演示积分'], ['i18n_demo_description', '用于兑换演示商品的虚构积分。']
    ], null, 2) + '\n');
    await workbook(path.join(tables, '注册表.xlsm'), '注册', [
        ['页签', '导出名'], ['商品', 'ProductConfig'], ['积分', 'PointsConfig']
    ]);
    await workbook(path.join(tables, '演示商品.xlsm'), '商品', [
        ['虚构演示数据'], ['', '', '格式为 积分编号:数量；本例仅用于演示。', '-1 表示不限次数；正整数表示最多可兑换次数。'],
        ['商品编号', '名称', '兑换消耗', '限购次数', '是否启用'], [], header, product
    ]);
    await workbook(path.join(tables, '演示积分.xlsm'), '积分', [
        ['虚构演示数据'], ['演示编号，不对应真实资产。', '', '', '1：演示积分\n2：演示兑换券\n仅用于文档示例。'],
        ['积分编号', '名称', '描述', '类型'], [], points[0], points[1]
    ]);
    const target = { file: '演示积分.xlsm', sheet: '积分', names: ['pointsconfig'] };
    const { ruleKey, fieldKey } = require('../out/relations');
    const extract = { separator: ':', index: 0 };
    const rule = { target, decision: 'accepted', extract };
    await fs.writeFile(path.join(project, 'extensions/json_reading/relations.json'), JSON.stringify({ version: 1, files: {
        'ProductConfigData.json': { fields: { [fieldKey(2, 'exchangeCost')]: { scanned: true, targets: { [ruleKey(target, undefined, extract)]: rule } } } }
    } }, null, 2));
    await fs.writeFile(path.join(project, '.vscode/settings.json'), JSON.stringify({
        'json-reading.tables.directory': tables, 'json-reading.fieldHints.displayMode': 'all',
        'workbench.colorTheme': 'Default Dark Modern', 'editor.fontSize': 16,
        'editor.minimap.enabled': false, 'editor.stickyScroll.enabled': false,
        'editor.hover.delay': 100, 'editor.hover.above': false,
        'editor.renderLineHighlight': 'none', 'editor.scrollBeyondLastLine': false,
        'breadcrumbs.enabled': false, 'workbench.startupEditor': 'none', 'telemetry.telemetryLevel': 'off',
        'git.enabled': false, 'workbench.tips.enabled': false,
        'editor.unicodeHighlight.nonBasicASCII': false, 'editor.unicodeHighlight.ambiguousCharacters': false
    }, null, 2));
    for (const directory of [project, tables]) {
        if (!syncFs.existsSync(path.join(directory, '.git'))) execFileSync('git', ['init', '-b', 'demo/catalog', directory], { windowsHide: true, stdio: 'pipe' });
    }
    console.log(JSON.stringify({ root, project, tables }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
