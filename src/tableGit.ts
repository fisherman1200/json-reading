import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';

/** 所有参数直接传给 Git，不经 shell；禁止交互提示，避免扩展后台无限等待。 */
export async function runGit(cwd: string, ...args: string[]): Promise<string> {
    try {
        const result = await promisify(execFile)('git', ['-C', cwd, ...args], {
            windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024,
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
        });
        return result.stdout.trim();
    } catch (error) {
        throw new Error((error as { stderr?: string }).stderr?.trim() || 'Git 执行失败，请检查 Git 安装、网络或登录状态。');
    }
}

export interface BranchState { jsonRoot: string; tableRoot: string; jsonBranch: string; tableBranch: string }

export async function inspectBranches(jsonFile: string, directory: string): Promise<BranchState> {
    const [jsonRoot, tableRoot] = await Promise.all([
        runGit(path.dirname(jsonFile), 'rev-parse', '--show-toplevel'),
        runGit(directory, 'rev-parse', '--show-toplevel')
    ]);
    const [jsonBranch, tableBranch] = await Promise.all([
        runGit(jsonRoot, 'branch', '--show-current'), runGit(tableRoot, 'branch', '--show-current')
    ]);
    return { jsonRoot, tableRoot, jsonBranch, tableBranch };
}

async function assertClean(root: string) {
    if (await runGit(root, 'status', '--porcelain', '--untracked-files=all')) {
        throw new Error('策划表仓库有未提交或未跟踪的文件，请先处理后再更新（包括 Excel 临时文件）。');
    }
    for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'BISECT_LOG']) {
        const file = await runGit(root, 'rev-parse', '--git-path', marker);
        if (await fs.stat(path.resolve(root, file)).then(() => true, () => false)) {
            throw new Error('策划表仓库正在合并、变基或执行其他 Git 操作，请先完成该操作。');
        }
    }
}

/** 仅修改策划表仓库；没有同名远端分支时停止，不创建无来源分支。 */
export async function syncTables(jsonFile: string, directory: string, report: (message: string) => void = () => {}) {
    const initial = await inspectBranches(jsonFile, directory);
    const target = initial.jsonBranch;
    if (!target) { throw new Error('JSON 仓库处于分离 HEAD 状态，无法确定对应分支。'); }
    if (initial.jsonRoot.toLowerCase() === initial.tableRoot.toLowerCase()) {
        throw new Error('JSON 与策划表位于同一仓库，不能单独切换策划表分支。');
    }
    const root = initial.tableRoot;
    await runGit(root, 'check-ref-format', '--branch', target);
    await assertClean(root);
    // 固定从 origin 更新，避免多远端或本地 upstream 指向其他分支时拉错内容。
    await runGit(root, 'remote', 'get-url', 'origin');
    report('正在 Fetch 策划表仓库…');
    const remoteRef = `refs/remotes/origin/${target}`;
    // 显式获取目标引用，远端已删除的分支不能被旧的本地缓存冒充。
    await runGit(root, 'fetch', 'origin', `refs/heads/${target}:${remoteRef}`);
    await runGit(root, 'show-ref', '--verify', remoteRef).catch(() => {
        throw new Error(`策划表 origin 中没有同名分支: ${target}`);
    });
    const current = await inspectBranches(jsonFile, directory);
    if (current.jsonBranch !== target || current.tableBranch !== initial.tableBranch) {
        throw new Error('更新期间分支发生变化，请重新点击更新。');
    }
    await assertClean(root);
    const local = await runGit(root, 'show-ref', '--verify', `refs/heads/${target}`).then(() => true, () => false);
    report(`正在切换策划表分支: ${target}`);
    if (current.tableBranch !== target) {
        if (local) { await runGit(root, 'switch', '--no-guess', target); }
        else { await runGit(root, 'switch', '--track', '-c', target, remoteRef); }
    }
    report('正在 Pull 策划表（仅快进）…');
    await runGit(root, 'pull', '--ff-only', '--no-rebase', 'origin', `refs/heads/${target}`);
    return target;
}
