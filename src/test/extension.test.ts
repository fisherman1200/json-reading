import * as assert from 'assert';
import * as vscode from 'vscode';

// 在真实 VS Code 扩展宿主中验证激活与命令切换；不检查最终像素布局。
suite('JSON field hints', () => {
    test('opening JSON activates the extension and the command toggles both modes', async () => {
        const extension = vscode.extensions.all.find(item => item.packageJSON.name === 'json-reading');
        assert.ok(extension);
        await extension.activate();
        const document = await vscode.workspace.openTextDocument({ language: 'json', content: '[["ID","Name"],[1,"Alice"]]' });
        await vscode.window.showTextDocument(document);
        const configuration = vscode.workspace.getConfiguration('json-reading', document);
        // 保留原配置，在 finally 中恢复，避免测试污染后续运行。
        const original = configuration.inspect<string>('fieldHints.displayMode')?.globalValue;
        try {
            await configuration.update('fieldHints.displayMode', 'selected', vscode.ConfigurationTarget.Global);
            await vscode.commands.executeCommand('json-reading.toggleFieldHintsMode');
            // 配置对象是读取时的快照，更新后需重新获取才能断言最新值。
            assert.strictEqual(vscode.workspace.getConfiguration('json-reading', document).get('fieldHints.displayMode'), 'all');
            await vscode.commands.executeCommand('json-reading.toggleFieldHintsMode');
            assert.strictEqual(vscode.workspace.getConfiguration('json-reading', document).get('fieldHints.displayMode'), 'selected');
        } finally {
            await configuration.update('fieldHints.displayMode', original, vscode.ConfigurationTarget.Global);
            // 丢弃临时文档，避免关闭时出现保存对话框阻塞测试。
            await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
        }
    });
});


