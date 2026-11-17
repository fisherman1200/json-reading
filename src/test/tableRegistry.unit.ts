import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runInThisContext } from 'node:vm';
import { createRequire } from 'node:module';
import type { TableDescriptions } from '../tableDescriptions';

test('选择注册表保存相对路径并刷新；取消、过期选择和未信任工作区不写入', async t => {
    for (const mode of ['select', 'cancel', 'stale', 'untrusted']) {
        await t.test(mode, async () => {
            const commands = new Map<string, () => Promise<void>>();
            const writes: unknown[] = [];
            const directory = path.resolve('tables');
            let change: (() => void) | undefined;
            let refreshes = 0;
            const disposable = { dispose() {} };
            class EventEmitter {
                event = () => disposable;
                fire() { refreshes++; }
                dispose() {}
            }
            const vscode = {
                EventEmitter, RelativePattern: class {}, ConfigurationTarget: { Workspace: 2, Global: 1 },
                commands: { registerCommand: (name: string, callback: () => Promise<void>) => { commands.set(name, callback); return disposable; } },
                workspace: {
                    isTrusted: mode !== 'untrusted', workspaceFolders: [{ uri: { fsPath: directory } }],
                    onDidChangeConfiguration: (callback: (event: unknown) => void) => { change = () => callback({ affectsConfiguration: () => true }); return disposable; },
                    onDidGrantWorkspaceTrust: () => disposable,
                    getConfiguration: () => ({ get: (key: string, fallback: unknown) => key === 'directory' ? directory : fallback,
                        update: async (...args: unknown[]) => { writes.push(args); change?.(); } }),
                    createFileSystemWatcher: () => ({ ...disposable, onDidCreate() {}, onDidChange() {}, onDidDelete() {} })
                },
                window: {
                    createOutputChannel: () => ({ ...disposable, appendLine() {} }),
                    showInformationMessage() {}, showWarningMessage() {},
                    showErrorMessage(message: string) { assert.fail(message); },
                    showQuickPick: async (items: { label: string }[]) => {
                        assert.deepEqual(items.map(item => item.label), ['Data/注册表.xlsm', 'DataCommon/注册表.xlsm']);
                        if (mode === 'stale') { change?.(); }
                        return mode === 'cancel' ? undefined : items[1];
                    }
                }
            };
            const filename = path.join(__dirname, '..', 'tableDescriptions.js');
            const localRequire = createRequire(filename);
            const module = { exports: {} as { TableDescriptions: new () => TableDescriptions } };
            const load = runInThisContext('(function(require,module,exports){' + fs.readFileSync(filename, 'utf8') + '\n})', { filename });
            load((name: string) => name === 'vscode' ? vscode : name === './tableIndex' ? {
                TableIndex: class {}, findRegistries: async () => ['Data', 'DataCommon'].map(folder => path.join(directory, folder, '注册表.xlsm'))
            } : localRequire(name), module, module.exports);
            const tables = new module.exports.TableDescriptions();
            const before = refreshes;
            try {
                await commands.get('json-reading.selectTableRegistry')!();
                assert.deepEqual(writes, mode === 'select' ? [['registry', 'DataCommon/注册表.xlsm', 2]] : []);
                if (mode === 'select') { assert.ok(refreshes > before); }
            } finally { tables.dispose(); }
        });
    }
});
