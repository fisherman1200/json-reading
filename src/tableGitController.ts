import * as vscode from 'vscode';
import { inspectBranches, syncTables } from './tableGit';
import type { TableDescriptions } from './tableDescriptions';

export const syncTablesCommand = 'json-reading.syncTables';
export interface GitView { file: string; jsonBranch?: string; tableBranch?: string; message?: string; busy?: boolean; loading?: boolean }

/** 缓存分支状态，光标移动不启动 Git；轮询仅检查当前可见 JSON。 */
export class TableGitController implements vscode.Disposable {
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChange = this.changed.event;
    private readonly synced = new vscode.EventEmitter<string>();
    readonly onDidSync = this.synced.event;
    private readonly cache = new Map<string, GitView>();
    private readonly subscriptions: vscode.Disposable[] = [];
    private busy = false;
    private disposed = false;
    private generation = 0;
    private readonly timer: ReturnType<typeof setInterval>;

    constructor(private readonly tables: TableDescriptions) {
        this.subscriptions.push(vscode.commands.registerCommand(syncTablesCommand, (file?: unknown) => this.sync(file)),
            vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('json-reading.tables.directory')) { this.invalidate(); } }),
            vscode.window.onDidChangeWindowState(e => { if (e.focused) { this.invalidate(); } }));
        this.timer = setInterval(() => { if (!this.busy && vscode.window.state.focused) { this.invalidate(); } }, 10000);
    }

    private invalidate() {
        this.generation++;
        this.cache.clear();
        if (!this.disposed) { this.changed.fire(); }
    }

    get(file: string): GitView | undefined {
        if (this.disposed || !vscode.workspace.isTrusted || !this.tables.directory) { return; }
        if (this.busy) { return { file, busy: true, message: '正在更新策划表…' }; }
        const cached = this.cache.get(file);
        if (cached) { return cached; }
        const pending = { file, loading: true, message: '正在检查策划表分支…' };
        this.cache.set(file, pending);
        const generation = this.generation;
        void inspectBranches(file, this.tables.directory).then(
            state => ({ file, jsonBranch: state.jsonBranch, tableBranch: state.tableBranch }),
            () => ({ file, message: '无法读取分支，请检查 Git 安装以及 JSON、策划表所在仓库。' })
        ).then(view => {
            if (this.disposed || generation !== this.generation) { return; }
            this.cache.set(file, view);
            this.changed.fire();
        });
        return pending;
    }

    private async sync(value: unknown) {
        if (this.busy) { return; }
        const uri = typeof value === 'string' ? vscode.Uri.file(value) : vscode.window.activeTextEditor?.document.uri;
        if (!vscode.workspace.isTrusted || !uri || uri.scheme !== 'file' || !/\.jsonc?$/i.test(uri.fsPath) || !this.tables.directory) {
            void vscode.window.showErrorMessage('请在受信任的工作区打开本地 JSON，并配置策划表目录。');
            return;
        }
        const directory = this.tables.directory;
        this.busy = true;
        this.tables.setUpdating(true);
        this.invalidate();
        try {
            // 同步过程显示在状态栏，完成后通过通知告知结果。
            const branch = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: '更新策划表' },
                progress => syncTables(uri.fsPath, directory, message => progress.report({ message })));
            void vscode.window.showInformationMessage(`策划表已更新到 ${branch}。`);
        } catch (error) {
            void vscode.window.showErrorMessage(`策划表更新失败：${error instanceof Error ? error.message : String(error)}。请检查当前策划表分支；已完成的切换不会自动回退。`);
        } finally {
            this.busy = false;
            // Pull 失败前也可能已经切换分支，因此失败时同样清空字段缓存。
            if (!this.disposed) {
                this.tables.setUpdating(false);
                this.invalidate();
                this.synced.fire(uri.fsPath);
            }
        }
    }

    dispose() {
        this.disposed = true;
        this.generation++;
        clearInterval(this.timer);
        this.subscriptions.forEach(item => item.dispose());
        this.changed.dispose();
        this.synced.dispose();
        this.cache.clear();
    }
}
