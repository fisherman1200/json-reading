import * as vscode from 'vscode';
import * as path from 'node:path';
import type { TableView } from './tableDescriptions';

export const openWorkbookCommand = 'json-reading.openSourceWorkbook';

/** 将备注转成 HTML 单元格文本，避免原始内容被解释为标签或 Markdown。 */
function escapeCell(text: string): string {
    return text.replace(/[&<>"'`*_[\]\\|~]/g, character => `&#${character.codePointAt(0)};`);
}

/** 表格内容一律作为纯文本追加，避免策划说明中的 Markdown 或链接被执行/渲染。 */
export function createFieldHover(fields: string[], table?: TableView): vscode.MarkdownString {
    const label = fields.map(field => JSON.stringify(field).slice(1, -1)).join(' · ');
    // Markdown 忽略开头的普通换行，用空白段落与 GitLens 内容隔开。
    const hover = new vscode.MarkdownString().appendMarkdown('&nbsp;\n\n').appendText(`字段名：${label}`);
    if (table?.state === 'ready') {
        for (const field of fields) {
            const details = table.fields?.get(field);
            if (!details) { continue; }
            if (fields.length > 1) { hover.appendText(`     ${field}`); }
            if (details.description) { hover.appendText(`    描述：${details.description}`); }
            if (details.detail && details.detail !== details.description) {
                // 两列布局让每行备注从同一位置开始，不依赖字体宽度或手动补空格。
                hover.supportHtml = true;
                const rows = details.detail.split(/\r\n|\r|\n/).map((line, index) =>
                    `<tr><td>${index === 0 ? '备注：' : ''}</td><td>${escapeCell(line) || '&nbsp;'}</td></tr>`
                ).join('');
                hover.appendMarkdown(`\n\n<table><tbody>${rows}</tbody></table>\n\n`);
            }
        }
        if (table.source) {
            // 只信任扩展自己的打开命令；参数编码可保留中文、空格和路径中的特殊字符。
            const target = `command:${openWorkbookCommand}?${encodeURIComponent(JSON.stringify([table.source.file, table.source.sheet]))}`;
            const filename = new vscode.MarkdownString().appendText(path.basename(table.source.file)).value;
            hover.isTrusted = { enabledCommands: [openWorkbookCommand] };
            hover.appendText('\n\n来源：');
            hover.appendMarkdown(`[${filename}](${target} "打开源工作簿并切换到对应页签")`);
            hover.appendText(` / ${table.source.sheet}`);
        }
    } else if (table?.message) {
        hover.appendText(`\n\n${table.message}`);
    }
    return hover;
}
