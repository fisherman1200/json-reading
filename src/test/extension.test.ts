import * as assert from 'assert';
import * as vscode from 'vscode';
import { createFieldHover, openWorkbookCommand } from '../fieldHover';
import { HoverRefresh } from '../hoverRefresh';

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



suite('策划表悬浮提示', () => {
    test('自动重开支持行中光标，不改变选区，切换文件后释放临时内容', async () => {
        const document = await vscode.workspace.openTextDocument({ language: 'json', content: '[["ID"],[123]]' });
        const editor = await vscode.window.showTextDocument(document);
        const position = new vscode.Position(0, 2);
        const selected = new Promise<void>(resolve => {
            const subscription = vscode.window.onDidChangeTextEditorSelection(event => {
                if (event.textEditor === editor) { subscription.dispose(); resolve(); }
            });
        });
        editor.selection = new vscode.Selection(position, position);
        await selected;
        const refresh = new HoverRefresh();
        try {
            const commands = await vscode.commands.getCommands(true);
            assert.ok(commands.includes('editor.action.hideHover'));
            assert.ok(commands.includes('editor.action.showHover'));
            await refresh.show(editor, new vscode.MarkdownString('更新后的字段说明'));
            assert.ok(editor.selection.active.isEqual(position));
            const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', document.uri, position);
            assert.ok(hovers.some(hover => hover.contents.some(content => typeof content !== 'string' && 'value' in content && content.value.includes('更新后的字段说明'))));
            await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
            const remaining = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', document.uri, position).then(value => value, () => []);
            assert.ok(!remaining.some(hover => hover.contents.some(content => typeof content !== 'string' && 'value' in content && content.value.includes('更新后的字段说明'))));
        } finally {
            refresh.dispose();
            if (vscode.window.activeTextEditor === editor) { await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor'); }
        }
    });
    test('显示第 3 行简述、第 2 行详情与来源，并保留顶部留白', () => {
        const hover = createFieldHover(['Type'], {
            state: 'ready', source: { file: 'example.xlsm', sheet: '奖励' },
            fields: new Map([['Type', { description: '奖励类型', detail: '第一种\n第二种' }]])
        });
        assert.ok(hover.value.startsWith('&nbsp;\n\n'));
        for (const value of ['Type', '奖励类型', '第一种', '第二种', 'example', '奖励']) {
            assert.ok(hover.value.includes(value), value);
        }
        assert.ok(hover.value.indexOf('奖励类型') < hover.value.indexOf('第一种'));
        assert.deepStrictEqual(hover.isTrusted, { enabledCommands: [openWorkbookCommand] });
        assert.ok(hover.supportHtml);
    });
    test('缺少表格时保留字段名，表格说明中的 Markdown 作为纯文本', () => {
        assert.ok(createFieldHover(['ID']).value.includes('ID'));
        const hover = createFieldHover(['ID'], {
            state: 'ready', fields: new Map([['ID', { description: '**标题**', detail: '[执行](command:bad)' }]])
        });
        assert.ok(!hover.value.includes('**标题**'));
        assert.ok(!hover.value.includes('[执行](command:bad)'));
    });
    test('注册策划目录选择、索引刷新和重名工作簿选择命令', async () => {
        const commands = await vscode.commands.getCommands(true);
        for (const command of ['selectTableDirectory', 'refreshTableIndex', 'selectTableWorkbook', 'openSourceWorkbook', 'syncTables']) {
            assert.ok(commands.includes('json-reading.' + command));
        }
    });
    test('刷新按钮绑定 JSON 路径，分支不匹配显示警告，同步中禁用按钮', () => {
        const file = 'D:\\项目\\ConfigData.json';
        const hover = createFieldHover(['ID'], undefined, { file, jsonBranch: 'feature/test', tableBranch: 'main' });
        assert.ok(hover.supportThemeIcons);
        assert.ok(hover.value.includes('color:#cca700;'));
        assert.ok(hover.value.includes('$(warning)'));
        const match = hover.value.match(/command:json-reading\.syncTables\?([^\s)]+)/);
        assert.ok(match);
        assert.deepStrictEqual(JSON.parse(decodeURIComponent(match[1])), [file]);
        assert.ok(!createFieldHover(['ID'], undefined, { file, jsonBranch: 'main', tableBranch: 'main' }).value.includes('$(warning)'));
        const busy = createFieldHover(['ID'], undefined, { file, busy: true });
        assert.ok(busy.value.includes('$(sync~spin)'));
        assert.ok(!busy.value.includes('command:json-reading.syncTables'));
    });
    test('来源链接保留中文和特殊字符路径，仅授权打开工作簿命令', () => {
        const file = 'D:\\策划 表\\活动[1]#奖励.xlsm';
        const hover = createFieldHover(['ID'], { state: 'ready', source: { file, sheet: '奖励' } });
        const match = hover.value.match(/command:json-reading\.openSourceWorkbook\?([^\s)]+)/);
        assert.ok(match);
        assert.deepStrictEqual(JSON.parse(decodeURIComponent(match[1])), [file, '奖励']);
        assert.deepStrictEqual(hover.isTrusted, { enabledCommands: [openWorkbookCommand] });
        assert.ok(!hover.value.includes('D:\\策划 表'));
    });
});
