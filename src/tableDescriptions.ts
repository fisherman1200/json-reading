import * as vscode from 'vscode';
import * as path from 'node:path';
import { TableIndex, configName, type TableResult, type TableSettings } from './tableIndex';

export type TableView = TableResult | { state: 'loading'; message: string };

/** 管理异步查询和文件监听，保证移动光标只读内存、不等待磁盘扫描。 */
export class TableDescriptions implements vscode.Disposable {
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChange = this.changed.event;
    private readonly output = vscode.window.createOutputChannel('JSON Reading');
    private readonly subscriptions: vscode.Disposable[] = [];
    private watcher?: vscode.FileSystemWatcher;
    private timer?: ReturnType<typeof setTimeout>;
    private index?: TableIndex;
    private results = new Map<string, TableView>();
    private generation = 0;
    private disposed = false;
    private updating = false;

    get directory(): string { return this.settings().directory; }

    setUpdating(value: boolean) {
        this.updating = value;
        this.reset();
    }

    constructor() {
        this.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration(event => {
                if (event.affectsConfiguration('json-reading.tables')) { this.reset(); }
            }),
            vscode.workspace.onDidGrantWorkspaceTrust(() => this.reset()),
            vscode.commands.registerCommand('json-reading.refreshTableIndex', () => this.reset()),
            vscode.commands.registerCommand('json-reading.selectTableDirectory', async () => {
                const selected = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: '选择策划表目录' });
                if (selected?.[0]) { await this.save('directory', selected[0].fsPath); }
            }),
            vscode.commands.registerCommand('json-reading.selectTableWorkbook', () => this.chooseWorkbook())
        );
        this.reset();
    }

    private settings(): TableSettings {
        const config = vscode.workspace.getConfiguration('json-reading.tables');
        const directory = config.get<string>('directory', '').trim();
        return {
            directory: directory ? path.resolve(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '', directory) : '',
            registry: config.get<string>('registry', ''),
            fieldRow: config.get<number>('fieldRow', 5),
            descriptionRow: config.get<number>('descriptionRow', 3),
            detailRow: config.get<number>('detailRow', 2),
            overrides: config.get<Record<string, string>>('workbookOverrides', {})
        };
    }

    private async save(key: string, value: unknown) {
        await vscode.workspace.getConfiguration('json-reading.tables').update(key, value,
            vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
    }

    private reset() {
        clearTimeout(this.timer);
        this.watcher?.dispose();
        this.watcher = undefined;
        this.generation++;
        this.results.clear();
        const settings = this.settings();
        this.index = settings.directory && vscode.workspace.isTrusted
            ? new TableIndex(settings, message => this.output.appendLine(message)) : undefined;
        if (this.index) {
            const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(settings.directory, '**/*'));
            const invalidate = (uri: vscode.Uri) => {
                if (!/\.xlsm$/i.test(uri.fsPath) || path.basename(uri.fsPath).startsWith('~$')) { return; }
                clearTimeout(this.timer);
                // 合并 Excel 保存和外部 Git 更新产生的一组事件。
                this.timer = setTimeout(() => this.reset(), 500);
            };
            watcher.onDidCreate(invalidate);
            watcher.onDidChange(invalidate);
            watcher.onDidDelete(invalidate);
            this.watcher = watcher;
        }
        this.changed.fire();
    }

    get(jsonFile: string): TableView | undefined {
        if (this.updating) { return { state: 'loading', message: '正在更新策划表…' }; }
        if (!this.index || this.disposed) { return undefined; }
        const existing = this.results.get(jsonFile);
        if (existing) { return existing; }
        const loading: TableView = { state: 'loading', message: '正在读取策划表说明…' };
        this.results.set(jsonFile, loading);
        const generation = this.generation;
        void this.index.lookup(jsonFile).then(result => {
            // 文件或配置可能在读取过程中变化，旧请求不得覆盖新结果。
            if (this.disposed || generation !== this.generation) { return; }
            this.results.set(jsonFile, result);
            this.changed.fire();
        });
        return loading;
    }

    private async chooseWorkbook() {
        const document = vscode.window.activeTextEditor?.document;
        const settings = this.settings();
        if (!document || !['json', 'jsonc'].includes(document.languageId) || !settings.directory || !vscode.workspace.isTrusted) {
            void vscode.window.showInformationMessage('请在受信任的工作区配置策划表目录，并打开对应 JSON 文件。');
            return;
        }
        // 忽略已保存的选择，使用户可以重新选择其他同名页签的工作簿。
        const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '查找策划工作簿' },
            () => new TableIndex({ ...settings, overrides: {} }, message => this.output.appendLine(message)).lookup(document.uri.fsPath));
        const candidates = result.candidates ?? (result.source ? [result.source] : []);
        if (!candidates.length) { void vscode.window.showInformationMessage(result.message ?? '未找到工作簿。'); return; }
        const chosen = await vscode.window.showQuickPick(candidates.map(source => ({
            label: path.relative(settings.directory, source.file), description: source.sheet, source
        })), { title: '选择当前 JSON 对应的工作簿' });
        if (chosen) {
            await this.save('workbookOverrides', { ...settings.overrides, [configName(document.uri.fsPath)]: path.relative(settings.directory, chosen.source.file) });
        }
    }

    dispose() {
        this.disposed = true;
        this.generation++;
        clearTimeout(this.timer);
        this.watcher?.dispose();
        this.subscriptions.forEach(item => item.dispose());
        this.changed.dispose();
        this.output.dispose();
        this.results.clear();
    }
}
