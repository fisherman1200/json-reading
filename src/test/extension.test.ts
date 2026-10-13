import * as assert from 'assert';
import * as vscode from 'vscode';

suite('JSON field hints', () => {
    test('opening JSON activates the extension and the command toggles both modes', async () => {
        const extension = vscode.extensions.all.find(item => item.packageJSON.name === 'json-reading');
        assert.ok(extension);
        await extension.activate();
        const document = await vscode.workspace.openTextDocument({ language: 'json', content: '[["ID","Name"],[1,"Alice"]]' });
        await vscode.window.showTextDocument(document);
        const configuration = vscode.workspace.getConfiguration('json-reading', document);
        const original = configuration.inspect<string>('fieldHints.displayMode')?.globalValue;
        try {
            await configuration.update('fieldHints.displayMode', 'selected', vscode.ConfigurationTarget.Global);
            await vscode.commands.executeCommand('json-reading.toggleFieldHintsMode');
            assert.strictEqual(vscode.workspace.getConfiguration('json-reading', document).get('fieldHints.displayMode'), 'all');
            await vscode.commands.executeCommand('json-reading.toggleFieldHintsMode');
            assert.strictEqual(vscode.workspace.getConfiguration('json-reading', document).get('fieldHints.displayMode'), 'selected');
        } finally {
            await configuration.update('fieldHints.displayMode', original, vscode.ConfigurationTarget.Global);
            await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
        }
    });
});


