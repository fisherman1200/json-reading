import * as vscode from 'vscode';

/** 原生显示命令使用光标位置；临时 Provider 让行中光标也能看到行尾字段说明。 */
export class HoverRefresh implements vscode.Disposable {
    private provider?: vscode.Disposable;
    private generation = 0;
    private readonly subscriptions: vscode.Disposable[];

    constructor() {
        this.subscriptions = [
            vscode.window.onDidChangeActiveTextEditor(() => this.clear()),
            vscode.window.onDidChangeTextEditorSelection(() => this.clear()),
            vscode.workspace.onDidChangeTextDocument(() => this.clear())
        ];
    }

    private clear() {
        this.generation++;
        this.provider?.dispose();
        this.provider = undefined;
    }

    async show(editor: vscode.TextEditor, message: vscode.MarkdownString) {
        this.clear();
        const generation = this.generation;
        const document = editor.document;
        const position = editor.selection.active;
        const line = document.lineAt(position.line);
        const current = () => generation === this.generation && vscode.window.activeTextEditor === editor;
        // 行尾已有 decoration.hoverMessage，避免 Provider 再追加一份相同内容。
        if (position.character < line.range.end.character) {
            this.provider = vscode.languages.registerHoverProvider({ language: document.languageId, scheme: document.uri.scheme }, {
                provideHover: (candidate, at) => candidate === document && at.isEqual(position) && current()
                    ? new vscode.Hover(message, new vscode.Range(position, position)) : undefined
            });
        }
        try {
            await vscode.commands.executeCommand('editor.action.hideHover');
            if (current()) {
                await vscode.commands.executeCommand('editor.action.showHover', { focus: 'noAutoFocus' });
            }
        } catch {
            // 界面刷新失败不影响已经完成的 Git 同步；下次手动悬停仍可查看。
            this.clear();
        }
    }

    dispose() {
        this.clear();
        this.subscriptions.forEach(item => item.dispose());
    }
}
