import * as yauzl from 'yauzl';
import { SaxesParser } from 'saxes';
import * as path from 'node:path';
import type { Readable } from 'node:stream';

export interface SheetInfo { name: string; entry: string }
export type SheetRows = Map<number, Map<string, string>>;

/** XLSM 是 ZIP 容器。只读所需 XML，不加载或执行 VBA，也不解压到磁盘。 */
class WorkbookZip {
    private constructor(private zip: yauzl.ZipFile, private entries: Map<string, yauzl.Entry>) {}

    static async open(file: string): Promise<WorkbookZip> {
        return new Promise((resolve, reject) => {
            yauzl.open(file, { lazyEntries: true, autoClose: false }, (error, zip) => {
                if (error || !zip) { reject(error ?? new Error('无法打开工作簿')); return; }
                const entries = new Map<string, yauzl.Entry>();
                zip.on('error', error => { zip.close(); reject(error); });
                zip.on('entry', (entry: yauzl.Entry) => {
                    entries.set(entry.fileName, entry);
                    zip.readEntry();
                });
                zip.on('end', () => resolve(new WorkbookZip(zip, entries)));
                zip.readEntry();
            });
        });
    }

    has(entry: string) { return this.entries.has(entry); }
    close() { this.zip.close(); }

    /** 按块解析，表头读取完成后停止解压后续数据行。 */
    async xml(entryName: string, configure: (parser: SaxesParser) => void, done: () => boolean = () => false) {
        const entry = this.entries.get(entryName);
        if (!entry) { throw new Error(`工作簿缺少 ${entryName}`); }
        const stream = await new Promise<Readable>((resolve, reject) => {
            this.zip.openReadStream(entry, (error, result) => {
                if (error || !result) { reject(error ?? new Error('无法读取 XML')); } else { resolve(result); }
            });
        });
        const parser = new SaxesParser();
        configure(parser);
        stream.setEncoding('utf8');
        try {
            for await (const chunk of stream) {
                parser.write(String(chunk));
                if (done()) { return; }
            }
            parser.close();
        } finally { stream.destroy(); }
    }

    async sheets(): Promise<SheetInfo[]> {
        const relationships = new Map<string, string>();
        await this.xml('xl/_rels/workbook.xml.rels', parser => {
            parser.on('opentag', tag => {
                if (tag.name.split(':').pop() === 'Relationship' && tag.attributes.TargetMode !== 'External') {
                    const target = String(tag.attributes.Target ?? '');
                    relationships.set(String(tag.attributes.Id), target.startsWith('/')
                        ? target.slice(1) : path.posix.normalize(path.posix.join('xl', target)));
                }
            });
        });
        const sheets: SheetInfo[] = [];
        await this.xml('xl/workbook.xml', parser => {
            parser.on('opentag', tag => {
                if (tag.name.split(':').pop() === 'sheet') {
                    const entry = relationships.get(String(tag.attributes['r:id']));
                    if (entry) { sheets.push({ name: String(tag.attributes.name), entry }); }
                }
            });
        });
        return sheets;
    }

    async rows(sheet: SheetInfo, maxRow: number): Promise<SheetRows> {
        const rows: SheetRows = new Map();
        const sharedCells: { row: number; column: string; index: number }[] = [];
        let row = 0, column = '', type = '', value = '', collecting = false, finished = false;
        await this.xml(sheet.entry, parser => {
            parser.on('opentag', tag => {
                const name = tag.name.split(':').pop();
                if (name === 'row') { row = Number(tag.attributes.r); }
                if (row > maxRow) { finished = true; return; }
                if (name === 'c') {
                    column = String(tag.attributes.r ?? '').replace(/\d+$/, '');
                    type = String(tag.attributes.t ?? '');
                    value = '';
                }
                if (name === 'v' || (name === 't' && type === 'inlineStr')) { collecting = true; }
            });
            const text = (part: string) => { if (collecting && row <= maxRow) { value += part; } };
            parser.on('text', text);
            parser.on('cdata', text);
            parser.on('closetag', tag => {
                const name = tag.name.split(':').pop();
                if (name === 'v' || name === 't') { collecting = false; }
                if (name === 'c' && row <= maxRow && column) {
                    if (!rows.has(row)) { rows.set(row, new Map()); }
                    if (type === 's') { sharedCells.push({ row, column, index: Number(value) }); }
                    else { rows.get(row)!.set(column, value); }
                }
                if (name === 'row' && row >= maxRow) { finished = true; }
            });
        }, () => finished);
        if (sharedCells.length) {
            const needed = new Set(sharedCells.map(cell => cell.index));
            const strings = new Map<number, string>();
            let index = -1, text = '', inText = false, phonetic = false;
            await this.xml('xl/sharedStrings.xml', parser => {
                parser.on('opentag', tag => {
                    const name = tag.name.split(':').pop();
                    if (name === 'si') { index++; text = ''; }
                    if (name === 'rPh') { phonetic = true; }
                    if (name === 't' && !phonetic) { inText = true; }
                });
                const append = (part: string) => { if (inText && needed.has(index)) { text += part; } };
                parser.on('text', append);
                parser.on('cdata', append);
                parser.on('closetag', tag => {
                    const name = tag.name.split(':').pop();
                    if (name === 't') { inText = false; }
                    if (name === 'rPh') { phonetic = false; }
                    if (name === 'si' && needed.has(index)) { strings.set(index, text); }
                });
            }, () => strings.size === needed.size);
            for (const cell of sharedCells) {
                rows.get(cell.row)!.set(cell.column, strings.get(cell.index) ?? '');
            }
        }
        return rows;
    }
}

export async function readSheetNames(file: string): Promise<SheetInfo[]> {
    const workbook = await WorkbookZip.open(file);
    try { return await workbook.sheets(); } finally { workbook.close(); }
}

export async function readSheetRows(file: string, sheetName: string, maxRow: number): Promise<SheetRows> {
    const workbook = await WorkbookZip.open(file);
    try {
        const sheet = (await workbook.sheets()).find(sheet => sheet.name === sheetName);
        if (!sheet) { throw new Error(`找不到页签：${sheetName}`); }
        return await workbook.rows(sheet, maxRow);
    } finally { workbook.close(); }
}
