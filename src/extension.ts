import * as vscode from 'vscode';
import { collectFieldHints } from './fieldHints';

type DisplayMode = 'all' | 'selected';

export function activate(context: vscode.ExtensionContext) {
    const decoration = vscode.window.createTextEditorDecorationType({
        after: {
            margin: '0 0 0 2em',
            color: new vscode.ThemeColor('descriptionForeground'),
            backgroundColor: new vscode.ThemeColor('textCodeBlock.background'),
            fontStyle: 'normal'
        },
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
    });
    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    status.command = 'json-reading.toggleFieldHintsMode';
    status.name = 'JSON 字段名提示';
    const cache = new Map<vscode.TextDocument, { version: number; hints: Map<number, string[]> }>();
    const pending = new Map<vscode.TextDocument, ReturnType<typeof setTimeout>>();
    const supported = (document: vscode.TextDocument) =>
        document.languageId === 'json' || document.languageId === 'jsonc';
    const modeFor = (document: vscode.TextDocument): DisplayMode =>
        vscode.workspace.getConfiguration('json-reading', document).get<DisplayMode>('fieldHints.displayMode', 'selected');

    function updateStatus() {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !supported(editor.document)) {
            status.hide();
            return;
        }
        const mode = modeFor(editor.document);
        status.text = `$(list-selection) 字段名：${mode === 'all' ? '全部行' : '选中行'}`;
        status.tooltip = '点击切换 JSON 字段名提示：全部行 / 仅选中行';
        status.show();
    }

    function render(editor: vscode.TextEditor) {
        const document = editor.document;
        if (!supported(document) || pending.has(document)) {
            editor.setDecorations(decoration, []);
            return;
        }
        let entry = cache.get(document);
        if (!entry || entry.version !== document.version) {
            entry = { version: document.version, hints: collectFieldHints(document.getText(), document.languageId === 'jsonc') };
            cache.set(document, entry);
        }
        const mode = modeFor(document);
        const options: vscode.DecorationOptions[] = [];
        // Decorate the viewport only, even in all-lines mode, for large data files.
        const lines = new Set<number>();
        for (const range of editor.visibleRanges) {
            for (let line = range.start.line; line <= range.end.line; line++) {
                lines.add(line);
            }
        }
        for (const line of lines) {
            if (mode === 'selected' && !editor.selections.some(selection => {
                // A selection ending at column zero does not include that final line.
                const end = !selection.isEmpty && selection.end.character === 0
                    ? selection.end.line - 1 : selection.end.line;
                return line >= selection.start.line && line <= end;
            })) {
                continue;
            }
            const fields = entry.hints.get(line);
            if (!fields?.length) {
                continue;
            }
            const end = document.lineAt(line).range.end;
            // Escape control characters so a header can never inject extra display lines.
            const label = fields.map(field => JSON.stringify(field).slice(1, -1)).join(' · ');
            options.push({
                range: new vscode.Range(end, end),
                renderOptions: { after: { contentText: `  ${label}  ` } },
                hoverMessage: `字段名：${label}`
            });
        }
        editor.setDecorations(decoration, options);
    }

    function refresh() {
        vscode.window.visibleTextEditors.forEach(render);
        updateStatus();
    }

    context.subscriptions.push(
        decoration, status,
        vscode.commands.registerCommand('json-reading.toggleFieldHintsMode', async () => {
            const document = vscode.window.activeTextEditor?.document;
            if (!document || !supported(document)) {
                return;
            }
            const config = vscode.workspace.getConfiguration('json-reading', document);
            const inspected = config.inspect<DisplayMode>('fieldHints.displayMode');
            // Change the effective scope, including language-specific overrides.
            const target = inspected?.workspaceFolderLanguageValue !== undefined || inspected?.workspaceFolderValue !== undefined
                ? vscode.ConfigurationTarget.WorkspaceFolder
                : inspected?.workspaceLanguageValue !== undefined || inspected?.workspaceValue !== undefined
                    ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
            const languageOverride = inspected?.workspaceFolderLanguageValue !== undefined ||
                inspected?.workspaceLanguageValue !== undefined || inspected?.globalLanguageValue !== undefined;
            await config.update('fieldHints.displayMode', modeFor(document) === 'all' ? 'selected' : 'all', target, languageOverride);
        }),
        vscode.window.onDidChangeActiveTextEditor(refresh),
        vscode.window.onDidChangeVisibleTextEditors(refresh),
        vscode.window.onDidChangeTextEditorSelection(event => render(event.textEditor)),
        vscode.window.onDidChangeTextEditorVisibleRanges(event => render(event.textEditor)),
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('json-reading')) {
                refresh();
            }
        }),
        vscode.workspace.onDidChangeTextDocument(event => {
            if (!supported(event.document) || !event.contentChanges.length) {
                return;
            }
            clearTimeout(pending.get(event.document));
            cache.delete(event.document);
            // Clear stale positions immediately and debounce parsing while typing.
            const timer = setTimeout(() => {
                pending.delete(event.document);
                vscode.window.visibleTextEditors.filter(editor => editor.document === event.document).forEach(render);
            }, 150);
            pending.set(event.document, timer);
            vscode.window.visibleTextEditors.filter(editor => editor.document === event.document).forEach(render);
        }),
        vscode.workspace.onDidCloseTextDocument(document => {
            clearTimeout(pending.get(document));
            pending.delete(document);
            cache.delete(document);
        }),
        { dispose: () => {
            pending.forEach(timer => clearTimeout(timer));
            pending.clear();
            cache.clear();
        } }
    );
    refresh();
}
