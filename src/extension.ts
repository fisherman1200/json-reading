import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { collectFieldHints } from './fieldHints';
import { TableDescriptions } from './tableDescriptions';
import { createFieldHover, openWorkbookCommand } from './fieldHover';
import { TableGitController } from './tableGitController';
import { HoverRefresh } from './hoverRefresh';
import { RelationController } from './relationController';
import { isRelationFile } from './relationStore';

// all：所有可见数据行；selected：光标所在行及多行/多光标选区。
type DisplayMode = 'all' | 'selected';

/** 扩展激活入口：创建界面元素、订阅编辑器事件，并渲染已打开的文件。 */
export function activate(context: vscode.ExtensionContext) {
    // after 在范围末尾追加虚拟文字，不修改 JSON 内容；使用主题颜色适配明暗主题。
    // 目前与 GitLens 一样使用 after，VS Code 没有公开跨扩展的排序优先级。
    const descriptions = new TableDescriptions();
    const tableGit = new TableGitController(descriptions);
    const hoverRefresh = new HoverRefresh();
    const relations = new RelationController(context, descriptions);
    let hoverAfterLoad: string | undefined;
    const decoration = vscode.window.createTextEditorDecorationType({
        after: {
            margin: '0 0 0 2em',
            color: new vscode.ThemeColor('descriptionForeground'),
            backgroundColor: new vscode.ThemeColor('textCodeBlock.background'),
            fontStyle: 'normal'
        },
        // 在范围边界输入时不让装饰范围自动扩张；实际位置由编辑事件重新计算。
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
    });
    // 此处的 100 只影响状态栏条目的排列，不影响编辑器内的提示顺序。
    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    status.command = 'json-reading.toggleFieldHintsMode';
    status.name = 'JSON 字段名提示';
    // 同一文档可在多个分栏打开：按文档和版本复用解析结果，选区变化无需重新解析。
    const cache = new Map<vscode.TextDocument, { version: number; hints: Map<number, string[]> }>();
    // 每份文档各有一个防抖计时器，互不影响；等待期间隐藏旧位置上的提示。
    const pending = new Map<vscode.TextDocument, ReturnType<typeof setTimeout>>();
    const supported = (document: vscode.TextDocument) =>
        !isRelationFile(document.uri.fsPath) && (document.languageId === 'json' || document.languageId === 'jsonc');
    // 传入文档，使读取结果包含当前工作区、文件夹及语言专属配置。
    const modeFor = (document: vscode.TextDocument): DisplayMode =>
        vscode.workspace.getConfiguration('json-reading', document).get<DisplayMode>('fieldHints.displayMode', 'selected');

    /** 状态栏只跟随当前活动编辑器，切换到非 JSON 文件时隐藏入口。 */
    function updateStatus() {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !supported(editor.document)) {
            status.hide();
            return;
        }
        const mode = modeFor(editor.document);
        status.text = `$(list-selection) 字段名: ${mode === 'all' ? '全部行' : '选中行'}`;
        status.tooltip = '点击切换 JSON 字段名提示: 全部行 / 仅选中行';
        status.show();
    }

    /** 将字段映射转换为一个编辑器的装饰；不同分栏可以拥有不同选区。 */
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
        const table = entry.hints.size ? descriptions.get(document.uri.fsPath) : undefined;
        const git = entry.hints.size && document.uri.scheme === 'file' ? tableGit.get(document.uri.fsPath) : undefined;
        // 只为当前编辑器的表格加载登记一次重开；Git 后台轮询本身不触发。
        // 同步过程由 onDidSync 登记，避免同步结束时重复弹出。
        if (table?.state === 'loading' && !git?.busy && editor === vscode.window.activeTextEditor) {
            hoverAfterLoad = document.uri.fsPath;
        }
        const mode = modeFor(document);
        const options: vscode.DecorationOptions[] = [];
        // 全部行模式也只向 VS Code 提交可见行的装饰；滚动时再补齐，减少渲染开销。
        const lines = new Set<number>();
        for (const range of editor.visibleRanges) {
            for (let line = range.start.line; line <= range.end.line; line++) {
                lines.add(line);
            }
        }
        for (const line of lines) {
            if (mode === 'selected' && !editor.selections.some(selection => {
                // 非空选区若结束于下一行第 0 列，实际没有选中那一行；空选区仍代表光标行。
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
            // 将零宽范围锚定在行尾，提示不占用或替换任何源码字符。
            const end = document.lineAt(line).range.end;
            // 转义字段名里的换行等控制字符，避免标签破坏行尾布局；同一行的字段合并显示。
            const label = fields.map(field => JSON.stringify(field).slice(1, -1)).join(' · ');
            const hoverMessage = createFieldHover(fields, table, git, relations.view(document, line));
            options.push({
                range: new vscode.Range(end, end),
                renderOptions: { after: { contentText: `  ${label}  ` } },
                hoverMessage
            });
        }
        editor.setDecorations(decoration, options);
    }

    /** 切换文件或配置时，刷新所有可见分栏及状态栏。 */
    function refresh() {
        vscode.window.visibleTextEditors.forEach(render);
        updateStatus();
        refreshLoadedHover();
    }

    function refreshLoadedHover() {
        if (!hoverAfterLoad) { return; }
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.uri.fsPath !== hoverAfterLoad || !supported(editor.document)) {
            hoverAfterLoad = undefined;
            return;
        }
        const table = descriptions.get(hoverAfterLoad);
        const git = editor.document.uri.scheme === 'file' ? tableGit.get(hoverAfterLoad) : undefined;
        const relation = relations.view(editor.document, editor.selection.active.line);
        // 完整关联行按视图加载，也需等待读取完成再重开，避免展示空摘要。
        if (table?.state === 'loading' || git?.loading || git?.busy || relation?.state.loading || relation?.results?.some(result => result.loading) || pending.has(editor.document)) { return; }
        hoverAfterLoad = undefined;
        if ((!table && !relation) || !vscode.window.state.focused) { return; }
        const fields = cache.get(editor.document)?.hints.get(editor.selection.active.line);
        if (fields?.length) { void hoverRefresh.show(editor, createFieldHover(fields, table, git, relation)); }
    }

    // VS Code 在扩展停用时统一释放这些装饰、状态栏、命令和事件监听器。
    context.subscriptions.push(
        decoration, status, descriptions, tableGit, hoverRefresh, relations,
        relations.onDidChange(uri => {
            if (vscode.window.activeTextEditor?.document.uri.toString() === uri) {
                hoverAfterLoad = vscode.window.activeTextEditor.document.uri.fsPath;
            }
            refresh();
        }),
        relations.onDidToggleExpansion(({ uri, line, version }) => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.uri.toString() !== uri || editor.document.version !== version
                || !vscode.window.state.focused || pending.has(editor.document)) { return; }
            if (editor.selection.active.line !== line) {
                vscode.window.setStatusBarMessage('已保存展开/收起状态，请重新悬停此行查看。', 3000);
                return;
            }
            const fields = cache.get(editor.document)?.hints.get(line);
            if (!fields?.length) { return; }
            void hoverRefresh.show(editor, createFieldHover(fields, descriptions.get(editor.document.uri.fsPath),
                tableGit.get(editor.document.uri.fsPath), relations.view(editor.document, line)), line);
        }),
        tableGit.onDidSync(file => { hoverAfterLoad = file; refresh(); }),
        tableGit.onDidChange(refresh),
        descriptions.onDidChange(refresh),
        vscode.commands.registerCommand(openWorkbookCommand, async (file: unknown, sheet: unknown) => {
            try {
                if (!vscode.workspace.isTrusted) {
                    throw new Error('请先信任当前工作区。');
                }
                if (typeof file !== 'string' || !path.isAbsolute(file) || path.extname(file).toLowerCase() !== '.xlsm') {
                    throw new Error('来源不是有效的 XLSM 文件路径。');
                }
                if (!(await fs.stat(file)).isFile()) {
                    throw new Error('来源文件不存在或不是普通文件。');
                }
                if (typeof sheet !== 'string' || !sheet.trim()) {
                    throw new Error('缺少目标页签名称，请重新打开悬浮提示。');
                }
                // Windows 通过 Excel COM 激活目标页签；已有工作簿优先复用。
                if (process.platform === 'win32') {
                    const script = await fs.readFile(context.asAbsolutePath('scripts/openWorkbook.ps1'), 'utf8');
                    // 路径和页签名通过环境变量传递，不拼进脚本，兼容中文及特殊字符。
                    await promisify(execFile)('powershell.exe', [
                        '-NoProfile', '-NonInteractive', '-Command', script
                    ], {
                        windowsHide: true,
                        env: { ...process.env, JSON_READING_WORKBOOK: file, JSON_READING_SHEET: sheet }
                    });
                } else if (!await vscode.env.openExternal(vscode.Uri.file(file))) {
                    throw new Error('系统无法打开此工作簿，请检查 XLSM 的默认打开程序。');
                } else {
                    void vscode.window.showInformationMessage(`已打开工作簿；自动切换页签仅支持 Windows Excel，请手动选择“${sheet}”。`);
                }
            } catch (error) {
                // execFile 的 message 包含整段脚本，优先显示 PowerShell 的实际错误输出。
                const stderr = (error as { stderr?: string } | null)?.stderr?.trim();
                void vscode.window.showErrorMessage(`打开策划表失败: ${stderr || (error instanceof Error ? error.message : String(error))}`);
            }
        }),
        vscode.commands.registerCommand('json-reading.toggleFieldHintsMode', async () => {
            const document = vscode.window.activeTextEditor?.document;
            if (!document || !supported(document)) {
                return;
            }
            const config = vscode.workspace.getConfiguration('json-reading', document);
            const inspected = config.inspect<DisplayMode>('fieldHints.displayMode');
            // 优先更新已有的文件夹/工作区设置，否则保存到用户设置；同时保留语言覆盖方式。
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
        // 选区变化或滚动只重绘对应编辑器；文档版本不变时命中解析缓存。
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
            // 输入会改变源码位置：立即清除旧提示，连续输入停止 150ms 后再解析并刷新同文档分栏。
            const timer = setTimeout(() => {
                pending.delete(event.document);
                vscode.window.visibleTextEditors.filter(editor => editor.document === event.document).forEach(render);
                refreshLoadedHover();
            }, 150);
            pending.set(event.document, timer);
            vscode.window.visibleTextEditors.filter(editor => editor.document === event.document).forEach(render);
        }),
        // 文档关闭时释放缓存和计时器，避免持有已关闭文档。
        vscode.workspace.onDidCloseTextDocument(document => {
            clearTimeout(pending.get(document));
            pending.delete(document);
            cache.delete(document);
        }),
        // 扩展停用时也要取消尚未触发的回调，防止继续访问已释放的装饰。
        { dispose: () => {
            pending.forEach(timer => clearTimeout(timer));
            pending.clear();
            cache.clear();
        } }
    );
    // 扩展可能在 JSON 已打开后才激活，因此注册事件后还需主动渲染一次。
    refresh();
}
