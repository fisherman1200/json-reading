import * as vscode from 'vscode';
import * as path from 'node:path';
import { isRelationFile } from './relationStore';

/** 命令链接中的 URI 可能经过编码规范化；文件身份不能依赖原始字符串完全相等。 */
export function resolveRelationDocument(value: unknown, documents: readonly vscode.TextDocument[], active?: vscode.TextDocument): vscode.TextDocument {
    let document: vscode.TextDocument | undefined;
    if (value === undefined) { document = active; }
    else {
        let uri: vscode.Uri;
        try {
            if (typeof value === 'string') {
                uri = path.isAbsolute(value) ? vscode.Uri.file(value) : vscode.Uri.parse(value, true);
            } else if (value instanceof vscode.Uri) { uri = value; }
            else if (value && typeof value === 'object' && 'scheme' in value && 'path' in value &&
                typeof value.scheme === 'string' && typeof value.path === 'string') {
                uri = vscode.Uri.from(value as { scheme: string; path: string; authority?: string });
            } else { throw new Error('无效参数'); }
        } catch { throw new Error('按钮中的文件参数无效，请重新打开悬浮提示。'); }
        if (uri.scheme !== 'file') { throw new Error('关联查询仅支持本地数据 JSON 文件。'); }
        const key = (file: string) => {
            const normalized = path.normalize(file);
            return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
        };
        document = documents.find(item => item.uri.scheme === 'file' && key(item.uri.fsPath) === key(uri.fsPath));
        if (!document) { throw new Error(`按钮对应的文件未打开：${uri.fsPath}。请重新打开该文件的悬浮提示。`); }
    }
    if (!document) { throw new Error('请先打开需要查询的数据 JSON 文件。'); }
    if (isRelationFile(document.uri.fsPath)) { throw new Error('关联匹配表自身不参与查询，请打开源数据 JSON。'); }
    if (document.uri.scheme !== 'file' || !['json', 'jsonc'].includes(document.languageId)) {
        throw new Error('关联查询需要本地 JSON / JSONC 文档，请检查右下角的语言模式。');
    }
    return document;
}
