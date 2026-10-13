import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { runGit, syncTables, inspectBranches } from '../tableGit';

test('策划表同步：远端分支、本地分支、快进、脏目录、分叉和缺失分支', async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'json-reading-git-'));
    const remote = path.join(temp, 'remote');
    const seed = path.join(temp, 'seed');
    const tables = path.join(temp, '策划 表');
    const json = path.join(temp, 'json');
    const file = path.join(json, 'ConfigData.json');
    const identity = async (root: string) => {
        await runGit(root, 'config', 'user.email', 'test@example.invalid');
        await runGit(root, 'config', 'user.name', 'Test');
    };
    try {
        await fs.mkdir(remote); await fs.mkdir(seed); await fs.mkdir(json);
        await runGit(remote, 'init', '--bare');
        await runGit(seed, 'init', '-b', 'main'); await identity(seed);
        await fs.writeFile(path.join(seed, 'table.txt'), 'initial');
        await runGit(seed, 'add', '.'); await runGit(seed, 'commit', '-m', 'initial');
        await runGit(seed, 'remote', 'add', 'origin', remote);
        await runGit(seed, 'push', '-u', 'origin', 'main');
        await runGit(temp, 'clone', '-b', 'main', remote, tables); await identity(tables);
        await runGit(seed, 'switch', '-c', 'feature/test');
        await fs.writeFile(path.join(seed, 'table.txt'), 'feature');
        await runGit(seed, 'commit', '-am', 'feature');
        await runGit(seed, 'push', '-u', 'origin', 'feature/test');
        await runGit(json, 'init', '-b', 'feature/test'); await identity(json);
        await fs.writeFile(file, '[]'); await runGit(json, 'add', '.'); await runGit(json, 'commit', '-m', 'json');
        // JSON 自身的未提交修改不影响策划表操作。
        await fs.writeFile(file, '[1]');
        await syncTables(file, tables);
        assert.equal((await inspectBranches(file, tables)).tableBranch, 'feature/test');
        assert.equal(await fs.readFile(path.join(tables, 'table.txt'), 'utf8'), 'feature');
        assert.equal(await fs.readFile(file, 'utf8'), '[1]');
        await fs.writeFile(path.join(seed, 'table.txt'), 'updated');
        await runGit(seed, 'commit', '-am', 'update'); await runGit(seed, 'push');
        await runGit(tables, 'switch', 'main');
        await syncTables(file, tables);
        assert.equal(await fs.readFile(path.join(tables, 'table.txt'), 'utf8'), 'updated');
        await fs.writeFile(path.join(tables, 'untracked.txt'), 'preserve');
        await assert.rejects(syncTables(file, tables), /未提交或未跟踪/);
        await fs.unlink(path.join(tables, 'untracked.txt'));
        await fs.writeFile(path.join(tables, 'local.txt'), 'local');
        await runGit(tables, 'add', '.'); await runGit(tables, 'commit', '-m', 'local');
        const localHead = await runGit(tables, 'rev-parse', 'HEAD');
        await fs.writeFile(path.join(seed, 'table.txt'), 'diverged');
        await runGit(seed, 'commit', '-am', 'diverged'); await runGit(seed, 'push');
        await assert.rejects(syncTables(file, tables));
        assert.equal(await runGit(tables, 'rev-parse', 'HEAD'), localHead);
        await runGit(json, 'switch', '-c', 'missing');
        await assert.rejects(syncTables(file, tables));
        assert.equal(await runGit(tables, 'branch', '--show-current'), 'feature/test');
        await runGit(json, 'checkout', '--detach');
        await assert.rejects(syncTables(file, tables), /分离 HEAD/);
        await assert.rejects(syncTables(path.join(tables, 'ConfigData.json'), tables), /同一仓库/);
    } finally {
        // 仅清理由本测试创建的临时目录。
        await fs.rm(temp, { recursive: true, force: true });
    }
});
