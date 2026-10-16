import * as vscode from 'vscode';
import * as path from 'node:path';
import type { TableView } from './tableDescriptions';
import { syncTablesCommand, type GitView } from './tableGitController';
import type { RelationView } from './relationController';
import { appendFieldRelations, appendRecordResults, appendTranslationResults, trustHoverCommands } from './relationHover';
import { noteHtml } from './hoverNote';

export const openWorkbookCommand = 'json-reading.openSourceWorkbook';

/** 表格内容一律作为纯文本追加，避免策划说明中的 Markdown 或链接被执行/渲染。 */
export function createFieldHover(fields: string[], table?: TableView, git?: GitView, relations?: RelationView): vscode.MarkdownString {
    // Markdown 忽略开头的普通换行，用空白段落与 GitLens 内容隔开。
    const hover = new vscode.MarkdownString().appendMarkdown('&nbsp;\n\n');
    for (const [index, field] of fields.entries()) {
        if (index) { hover.appendMarkdown('\n\n'); }
        hover.appendText(`字段名: ${JSON.stringify(field).slice(1, -1)}`);
        const details = table?.state === 'ready' ? table.fields?.get(field) : undefined;
        if (details?.description) { hover.appendText(`    描述: ${details.description}`); }
        appendFieldRelations(hover, field, relations, openWorkbookCommand);
        const note = details ? noteHtml(details.detail) : '';
        if (note) {
            hover.supportHtml = true;
            hover.appendMarkdown(`\n\n${note}\n\n`);
        }
    }
    if (table?.state === 'ready') {
        if (table.source) {
            // 只信任扩展自己的打开命令；参数编码可保留中文、空格和路径中的特殊字符。
            const target = `command:${openWorkbookCommand}?${encodeURIComponent(JSON.stringify([table.source.file, table.source.sheet]))}`;
            const label = new vscode.MarkdownString().appendText(`${path.basename(table.source.file)} / ${table.source.sheet}`).value;
            trustHoverCommands(hover, openWorkbookCommand);
            hover.appendText('\n\n来源: ');
            hover.appendMarkdown(`[${label}](${target} "打开源工作簿并切换到对应页签")`);
        }
    } else if (table?.message) {
        hover.appendText(`\n\n${table.message}`);
    }
    if (git) {
        hover.supportThemeIcons = true;
        hover.appendMarkdown('\n\n---\n\n');
        if (git.busy) {
            hover.appendMarkdown('$(sync~spin) ');
            hover.appendText('正在更新策划表…');
        } else {
            const target = `command:${syncTablesCommand}?${encodeURIComponent(JSON.stringify([git.file]))}`;
            trustHoverCommands(hover, syncTablesCommand);
            hover.appendMarkdown(`[$(sync)](${target} "切换到 JSON 同名分支并 Fetch / Pull 策划表")  `);
            if (git.jsonBranch !== undefined && git.tableBranch !== undefined) {
                if (!git.jsonBranch || git.jsonBranch !== git.tableBranch) {
                    hover.supportHtml = true;
                    hover.appendMarkdown('<span style="color:#cca700;">$(warning)</span> ');
                }
                hover.appendText(`策划表: ${git.tableBranch || '分离 HEAD'}  /  JSON: ${git.jsonBranch || '分离 HEAD'}`);
            } else { hover.appendText(git.message ?? ''); }
        }
    }
    appendRecordResults(hover, fields, relations);
    appendTranslationResults(hover, fields, relations);
    return hover;
}
