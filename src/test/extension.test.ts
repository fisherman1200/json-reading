import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'node:path';
import { createFieldHover, openWorkbookCommand } from '../fieldHover';
import { HoverRefresh } from '../hoverRefresh';
import { resolveRelationDocument } from '../relationDocument';
import { relationCommands, type RelationView } from '../relationController';
import { addCandidates, emptyRules, parseRelations, fieldKey, targetKey, ruleKey, type TargetData, type TargetRule } from '../relations';

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
    test('关联按钮兼容 URI 编码、对象和 Windows 盘符大小写，不误操作当前其他文档', () => {
        const document = { uri: vscode.Uri.file('D:\\项目 空格\\ConfigData.json'), languageId: 'json' } as vscode.TextDocument;
        const other = { uri: vscode.Uri.file('D:\\Other.json'), languageId: 'json' } as vscode.TextDocument;
        for (const argument of [document.uri.toString(), document.uri.toString(true), document.uri, document.uri.toJSON(), document.uri.fsPath]) {
            assert.strictEqual(resolveRelationDocument(argument, [document, other], other), document);
        }
        if (process.platform === 'win32') {
            assert.strictEqual(resolveRelationDocument('file:///d:/项目%20空格/configdata.json', [document]), document);
        }
        assert.strictEqual(resolveRelationDocument(undefined, [document], document), document);
        assert.throws(() => resolveRelationDocument('file:///d:/Missing.json', [document, other], other), /未打开/);
        const mapping = { uri: vscode.Uri.file('D:\\cn\\extensions\\json_reading\\relations.json'), languageId: 'json' } as vscode.TextDocument;
        assert.throws(() => resolveRelationDocument(mapping.uri, [mapping]), /匹配表自身/);
    });
    test('关联紧随字段描述显示，表名链接打开 Excel，中文保留且多字段互不串行', () => {
        const parsed = parseRelations('[["ID","Item","Name"],[1,100,"i18n_1"]]');
        const target = { file: 'Data/矿石[1].xlsm', sheet: '矿石', names: ['oreconfig'] };
        const data: TargetData[] = [{ target, rows: new Map([['100', [{ id: '100', row: 6, values: [['Name', '铁矿']] }]]]) }];
        const rules = addCandidates(emptyRules(), parsed, data, true);
        const view: RelationView = { uri: 'file:///project/TestData.json', cells: parsed.cells,
            state: { tableDirectory: path.resolve('策划表'), parsed, rules, data, translations: new Map([['i18n_1', '[不执行](command:bad)']]), loading: false } };
        const hover = createFieldHover(['ID', 'Item', 'Name'], { state: 'ready', fields: new Map([
            ['Item', { description: '奖励道具', detail: '道具备注' }], ['Name', { description: '名称', detail: '' }]
        ]) }, { file: '/project/TestData.json', jsonBranch: 'main', tableBranch: 'main' }, view);
        assert.ok(hover.value.includes('已匹配：'));
        assert.ok(hover.value.includes('中文：'));
        assert.ok(hover.value.indexOf('奖励道具') < hover.value.indexOf('已匹配：'));
        assert.ok(hover.value.indexOf('已匹配：') < hover.value.indexOf('道具备注'));
        assert.ok(hover.value.indexOf('道具备注') < hover.value.indexOf('字段名：Name'));
        for (const obsolete of ['关联查询', 'Item：100', '铁矿', '匹配记录', '全部字段', 'Data/矿石']) {
            assert.ok(!hover.value.includes(obsolete), obsolete);
        }
        assert.ok(!hover.value.includes('[不执行](command:bad)'));
        const match = hover.value.match(/command:json-reading\.decideRelation\?([^\s)]+)/);
        assert.ok(match);
        assert.deepStrictEqual(JSON.parse(decodeURIComponent(match[1])), [view.uri, fieldKey(1, 'Item'), [targetKey(target)], 'accepted']);
        const workbook = hover.value.match(/command:json-reading\.openSourceWorkbook\?([^\s)]+)/)!;
        assert.deepStrictEqual(JSON.parse(decodeURIComponent(workbook[1])), [path.resolve(view.state.tableDirectory, target.file), target.sheet]);
        assert.ok(!hover.value.includes('command:json-reading.rescanRelations'));
        const clear = hover.value.match(/command:json-reading\.clearRelations\?([^\s)]+)/)!;
        assert.deepStrictEqual(JSON.parse(decodeURIComponent(clear[1])), [view.uri]);
        const trusted = typeof hover.isTrusted === 'object' ? hover.isTrusted.enabledCommands : [];
        for (const command of [openWorkbookCommand, relationCommands.decide, relationCommands.clear, 'json-reading.syncTables']) {
            assert.ok(trusted?.includes(command));
        }
        assert.ok(!trusted?.includes(relationCommands.details));
        assert.ok(hover.value.includes('color:#388a34;'));
        assert.ok(hover.value.includes('color:#f14c4c;'));
        rules.fields[fieldKey(1, 'Item')].targets[targetKey(target)].decision = 'rejected';
        const excluded = createFieldHover(['Item'], undefined, undefined, view);
        assert.ok(!excluded.value.includes('已匹配：'));
        assert.ok(excluded.value.includes('无匹配'));
        assert.ok(!createFieldHover(['ID'], undefined, undefined, view).value.includes('json-reading.rescanRelations'));
        assert.ok(!createFieldHover(['Name'], undefined, undefined, view).value.includes('无匹配'));
    });
    test('同页签多个值和适用规则合并一次展示，按钮批量决定且排除不适用规则', () => {
        const parsed = parseRelations('[["ID","Type","Rewards"],[1,2,"1001:20,1002:30"]]');
        const target = { file: '矿石.xlsm', sheet: '矿石', names: [], keyField: 'OreID' };
        const candidate: TargetRule = { target, decision: 'accepted', when: { field: 'Type', values: [2] }, extract: { listSeparator: ',', separator: ':', index: 0 } };
        const ruleId = ruleKey(target, candidate.when, candidate.extract), field = fieldKey(2, 'Rewards');
        const another: TargetRule = { ...candidate, when: undefined };
        const anotherId = ruleKey(target, another.when, another.extract);
        const inactive: TargetRule = { ...candidate, when: { field: 'Type', values: [3] } };
        const inactiveId = ruleKey(target, inactive.when, inactive.extract);
        const rules = emptyRules();
        rules.fields[field] = { scanned: true, targets: { [ruleId]: candidate, [anotherId]: another, [inactiveId]: inactive } };
        const data: TargetData[] = [{ target, rows: new Map([
            ['1001', [{ id: '1001', row: 6, values: [['Name', '铁矿']] }]],
            ['1002', [{ id: '1002', row: 7, values: [['Name', '铜矿']] }]]
        ]) }];
        const view = { uri: 'file:///project/TestData.json', cells: parsed.cells.filter(cell => cell.field === 'Rewards'),
            state: { tableDirectory: path.resolve('策划表'), parsed, rules, data, translations: new Map<string, string>(), loading: false } };
        const hover = createFieldHover(['Rewards'], undefined, undefined, view);
        assert.strictEqual(hover.value.match(/command:json-reading\.openSourceWorkbook\?/g)?.length, 1);
        assert.strictEqual(hover.value.match(/command:json-reading\.decideRelation\?/g)?.length, 1);
        assert.ok(!hover.value.includes('Rewards：'));
        assert.ok(!hover.value.includes('OreID'));
        const decision = hover.value.match(/command:json-reading\.decideRelation\?([^\s)]+)/)!;
        assert.deepStrictEqual(JSON.parse(decodeURIComponent(decision[1])), [view.uri, field, [ruleId, anotherId], 'rejected']);
        data[0].rows.clear();
        assert.ok(createFieldHover(['Rewards'], undefined, undefined, view).value.includes('无匹配'));
    });
    test('加载失败和加载中不误报无匹配，匹配只依据当前单元格', () => {
        const parsed = parseRelations('[["ID","Item"],[1,100],[2,200]]');
        const target = { file: '矿石.xlsm', sheet: '矿石', names: [] };
        const data: TargetData[] = [{ target, rows: new Map([['200', [{ id: '200', row: 6, values: [] }]]]) }];
        const rules = addCandidates(emptyRules(), parsed, data, true);
        const view: RelationView = { uri: 'file:///project/TestData.json', cells: [parsed.cells[0]],
            state: { tableDirectory: path.resolve('策划表'), parsed, rules, data, translations: new Map(), loading: false } };
        assert.ok(createFieldHover(['Item'], undefined, undefined, view).value.includes('无匹配'));
        view.state.loading = true;
        const loading = createFieldHover(['Item'], undefined, undefined, view);
        assert.ok(loading.value.includes('正在读取关联'));
        assert.ok(!loading.value.includes('无匹配'));
        assert.ok(!loading.value.includes('command:json-reading.rescanRelations'));
        view.state.loading = false;
        view.state.error = '源工作簿暂时不可读取';
        const failed = createFieldHover(['Item'], undefined, undefined, view);
        assert.ok(failed.value.includes('源工作簿暂时不可读取'));
        assert.ok(!failed.value.includes('无匹配'));
        const translated = parseRelations('[["ID","Name"],[1,"i18n_1"]]');
        const translationView: RelationView = { ...view, cells: translated.cells, state: { ...view.state, parsed: translated, error: undefined, translationError: '翻译文件无法读取' } };
        const failedTranslation = createFieldHover(['Name'], undefined, undefined, translationView);
        assert.ok(failedTranslation.value.includes('翻译文件无法读取'));
        assert.ok(!failedTranslation.value.includes('未找到对应'));
        assert.ok(!failedTranslation.value.includes('无匹配'));
    });
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
