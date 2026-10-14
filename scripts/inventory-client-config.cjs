#!/usr/bin/env node
/* 读取 JSON 表头和注册表中的工作簿页签，为离线代码分析准备清单。 */
const fs = require('node:fs/promises');
const path = require('node:path');
const { TableIndex } = require('../out/tableIndex');
const { readSheetRows } = require('../out/workbookReader');

async function main() {
    const [project, tableDirectory, output, fieldRow = '5'] = process.argv.slice(2);
    if (!project || !tableDirectory || !output) {
        throw new Error('用法：node scripts/inventory-client-config.cjs <工程目录> <策划表目录> <输出.json> [字段行号]');
    }
    const row = Number(fieldRow);
    if (!Number.isInteger(row) || row < 1) { throw new Error('字段行号必须是正整数。'); }
    const directory = path.resolve(tableDirectory);
    const configDirectory = path.join(project, 'assets/resources/ClientConfig');
    const configs = [];
    for (const file of (await fs.readdir(configDirectory)).filter(file => /\.json$/i.test(file)).sort()) {
        const value = JSON.parse((await fs.readFile(path.join(configDirectory, file), 'utf8')).replace(/^\uFEFF/, ''));
        const header = Array.isArray(value) && Array.isArray(value[0]) && value[0].length
            && value[0].every(field => typeof field === 'string') ? value[0] : null;
        configs.push({ file, name: file.replace(/\.json$/i, '').replace(/Data$/, ''), header,
            rows: Array.isArray(value) ? Math.max(0, value.length - 1) : 0 });
    }
    const index = new TableIndex({ directory, registry: '', fieldRow: row,
        descriptionRow: 3, detailRow: 2, overrides: {} });
    const catalogue = [];
    for (const source of await index.sources()) {
        const rows = await readSheetRows(source.file, source.sheet, row);
        catalogue.push({ file: path.relative(directory, source.file).replaceAll('\\', '/'),
            sheet: source.sheet, names: source.names,
            header: Object.fromEntries([...rows.get(row) || []].map(([column, field]) => [column, field.trim()])) });
    }
    await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
    await fs.writeFile(output, JSON.stringify({ configs, catalogue }, null, 2) + '\n');
    console.log(JSON.stringify({ json: configs.length, tables: configs.filter(config => config.header).length, sheets: catalogue.length }));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
