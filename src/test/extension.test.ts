import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createFieldHover, openWorkbookCommand } from '../fieldHover';
import { HoverRefresh } from '../hoverRefresh';
import { resolveRelationDocument } from '../relationDocument';
import { RelationController, relationCommands, type RelationView } from '../relationController';
import { cascadeRootKey, cascadeFieldKey, cascadeMatchKey, cascadeBranchKeys } from '../relationExpansion';
import type { CascadeField } from '../relationCascade';
import { addCandidates, decideRelationRules, emptyRules, parseRelations, fieldKey, targetKey, ruleKey, type TargetData, type TargetRule } from '../relations';

function decodeHtml(value: string): string {
    return value.replace(/&(#(?:x[\da-f]+|\d+)|nbsp|quot|apos|lt|gt|amp);/gi, (_, code: string) => {
        if (code.startsWith('#')) { return String.fromCodePoint(code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1))); }
        return ({ nbsp: ' ', quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' } as Record<string, string>)[code.toLowerCase()];
    });
}
/** 断言可见文本与原生 title 分开，防止把仅存于备注属性中的全文误认为正文。 */
function visibleHtml(value: string): string {
    return decodeHtml(value.replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]*>/g, ''));
}
const appendedText = (value: string) => new vscode.MarkdownString().appendText(value).value;
const noteTitles = (value: string) => [...value.matchAll(/<span\b[^>]*\btitle="([^"]*)"[^>]*><u>备注<\/u><\/span>/g)].map(match => decodeHtml(match[1]));
interface HtmlNode { tag: string; attributes: string; children: (HtmlNode | string)[]; parent?: HtmlNode }
/** 只解析扩展生成的 HTML，区分记录行和空的宽度占位表。 */
function htmlTree(value: string): HtmlNode {
    const root: HtmlNode = { tag: 'root', attributes: '', children: [] }, stack = [root];
    let offset = 0;
    for (const match of value.matchAll(/<(\/?)([a-z][\w-]*)\b([^>]*)>/gi)) {
        const parent = stack[stack.length - 1];
        parent.children.push(value.slice(offset, match.index));
        const tag = match[2].toLowerCase();
        if (match[1]) {
            assert.strictEqual(parent.tag, tag, `HTML 标签应成对闭合: ${tag}`);
            stack.pop();
        } else {
            const node: HtmlNode = { tag, attributes: match[3], children: [], parent };
            parent.children.push(node);
            if (!['br', 'wbr', 'hr', 'img'].includes(tag) && !match[3].endsWith('/')) { stack.push(node); }
        }
        offset = match.index + match[0].length;
    }
    stack[stack.length - 1].children.push(value.slice(offset));
    assert.strictEqual(stack.length, 1, 'HTML 块必须完整闭合');
    return root;
}
const elements = (node: HtmlNode): HtmlNode[] => node.children.filter((child): child is HtmlNode => typeof child !== 'string');
const descendants = (node: HtmlNode): HtmlNode[] => elements(node).flatMap(child => [child, ...descendants(child)]);
function nodeText(node: HtmlNode): string {
    return node.tag === 'br' ? '\n' : node.children.map(child => typeof child === 'string' ? decodeHtml(child) : nodeText(child)).join('');
}
function ancestor(node: HtmlNode, tag: string): HtmlNode | undefined {
    for (let parent = node.parent; parent; parent = parent.parent) { if (parent.tag === tag) { return parent; } }
    return undefined;
}
function ownText(node: HtmlNode): string {
    if (node.tag === 'br') { return '\n'; }
    return node.children.map(child => typeof child === 'string' ? decodeHtml(child)
        : child.tag === 'table' ? '' : ownText(child)).join('');
}
function recordRows(value: string) {
    return descendants(htmlTree(value)).filter(node => node.tag === 'tr').map(node => {
        let column = 0;
        return elements(node).filter(cell => cell.tag === 'td').map(cell => {
            const span = Number(cell.attributes.match(/\bcolspan="(\d+)"/)?.[1] ?? 1);
            // 空 td 的 br 仅保留该视觉行高度；换行由 tr 边界表示。
            const result = { node: cell, group: ancestor(cell, 'table')!, column, span, text: ownText(cell).replace(/^\n$/, '') };
            column += span;
            return result;
        });
    });
}
function groupRows(value: string) {
    return descendants(htmlTree(value)).filter(node => node.tag === 'tr').flatMap(node => {
        const group = ancestor(node, 'table')!;
        if (/\balign="left"/.test(group.attributes)) { return []; }
        const parts = elements(node).filter(cell => cell.tag === 'td').flatMap(elements).filter(part => part.tag === 'table');
        const label = parts.find(part => /\balign="left"/.test(part.attributes) && /\bwidth=/.test(part.attributes));
        const prefix = parts.find(part => /\balign="left"/.test(part.attributes) && !/\bwidth=/.test(part.attributes));
        const children = parts.find(part => !/\balign="left"/.test(part.attributes) && descendants(part).some(child => child.tag === 'tr'));
        return [{ node, group, label, prefix, children, labelText: label ? nodeText(label).replace(/^\n$/, '') : '', valueText: prefix ? nodeText(prefix).replace(/^\n$/, '') : '' }];
    });
}
function recordText(value: string): string {
    const rows = groupRows(value);
    const render = (group: HtmlNode): string => rows.filter(row => row.group === group).map(row =>
        (row.label ? row.labelText + ' ' : '') + row.valueText + (row.children ? render(row.children) : '')).join('\n');
    return [...new Set(rows.filter(row => !ancestor(row.group, 'table')).map(row => row.group))].map(render).join('\n');
}
function recordColumns(value: string): string[] {
    const groups = new Map<HtmlNode, Map<number, string>>();
    for (const row of groupRows(value)) {
        const columns = groups.get(row.group) ?? new Map<number, string>();
        columns.set(0, (columns.get(0) ?? '') + row.labelText);
        columns.set(1, (columns.get(1) ?? '') + row.valueText);
        groups.set(row.group, columns);
    }
    return [...groups.values()].flatMap(columns => [...columns.values()]);
}
function assertRecordLayout(value: string) {
    for (const table of descendants(htmlTree(value)).filter(node => node.tag === 'table')) {
        const rows = descendants(table).filter(node => node.tag === 'tr' && ancestor(node, 'table') === table);
        if (!rows.length) { assert.strictEqual(nodeText(table), '', '宽度占位表不能夹带可见数据'); }
        for (const row of rows) {
            assert.ok(elements(row).every(cell => cell.tag === 'td'), '记录行只包含当前组的单元格');
        }
    }
    assert.doesNotMatch(value, /<(?:pre|code|thead|th)\b|\browspan=/i);
}
function expandAll(view: RelationView): RelationView {
    const expanded = new Set<string>();
    for (const result of view.results ?? []) {
        for (const key of cascadeBranchKeys(result.expandedRows ?? [], cascadeRootKey(result.column, result.field, result.target))) { expanded.add(key); }
    }
    return { ...view, expansion: { line: 3, version: 7, expanded } };
}
function expansionControls(value: string) {
    return [...value.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].flatMap(match => {
        const href = decodeHtml(match[1].match(/\bhref="([^"]*)"/)?.[1] ?? '');
        const prefix = `command:${relationCommands.toggle}?`;
        return href.startsWith(prefix) ? [{ text: visibleHtml(match[2]), args: JSON.parse(decodeURIComponent(href.slice(prefix.length))) as unknown[], html: match[0] }] : [];
    });
}

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

    test('原生侧栏可以打开两个视图并注册字段操作命令', async () => {
        const commands = await vscode.commands.getCommands(true);
        for (const name of ['refresh', 'sync', 'add', 'accept', 'reject', 'openWorkbook', 'revealField']) {
            assert.ok(commands.includes('json-reading.sidebar.' + name), `缺少侧栏命令: ${name}`);
        }
        // 真实宿主执行视图 focus 会触发可见性回调，验证 view ID 与 provider 的连接。
        await vscode.commands.executeCommand('json-reading.tableStatus.focus');
        await vscode.commands.executeCommand('json-reading.relations.focus');
        await vscode.commands.executeCommand('json-reading.sidebar.refresh');
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
    test('关联紧随字段描述显示，表名链接打开 Excel，中文独立放末尾且对应所属字段', () => {
        const parsed = parseRelations('[["ID","Item","Name"],[1,100,"i18n_1"]]');
        const target = { file: 'Data/矿石[1].xlsm', sheet: '矿石', names: ['oreconfig'] };
        const data: TargetData[] = [{ target, rows: new Map([['100', [{ id: '100', row: 6, values: [['Name', '铁矿']] }]]]) }];
        const rules = addCandidates(emptyRules(), parsed, data, true);
        const view: RelationView = { uri: 'file:///project/TestData.json', cells: parsed.cells,
            state: { tableDirectory: path.resolve('策划表'), parsed, rules, data, translations: new Map([['i18n_1', '[不执行](command:bad)']]), loading: false } };
        const hover = createFieldHover(['ID', 'Item', 'Name'], { state: 'ready', fields: new Map([
            ['Item', { description: '奖励道具', detail: '道具备注' }], ['Name', { description: '名称', detail: '' }]
        ]) }, { file: '/project/TestData.json', jsonBranch: 'main', tableBranch: 'main' }, view);
        const visible = visibleHtml(hover.value);
        assert.ok(visible.includes('已匹配: '));
        assert.ok(visible.includes('中文: '));
        assert.ok(visible.indexOf('奖励道具') < visible.indexOf('已匹配: '));
        assert.ok(visible.indexOf('已匹配: ') < visible.indexOf('备注'));
        assert.ok(visible.indexOf('备注') < visible.indexOf('字段名: Name'));
        assert.ok(visible.includes('备注: 道具备注'));
        assert.deepStrictEqual(noteTitles(hover.value), []);
        assert.ok(visible.indexOf('无匹配') > visible.indexOf('描述: 名称'));
        assert.ok(visible.indexOf('无匹配') < visible.indexOf('策划表: '));
        assert.ok(visible.indexOf('中文: ') > visible.indexOf('策划表: '));
        assert.ok(visible.slice(visible.indexOf('策划表: ')).includes('Name'));
        for (const obsolete of ['关联查询', 'Item: 100', '铁矿', '匹配记录', '全部字段', 'Data/矿石']) {
            assert.ok(!hover.value.includes(obsolete), obsolete);
        }
        assert.ok(!hover.value.includes('[不执行](command:bad)'));
        const match = hover.value.match(/command:json-reading\.decideRelation\?([^\s)]+)/);
        assert.ok(match);
        assert.deepStrictEqual(JSON.parse(decodeURIComponent(match[1])), [view.uri, fieldKey(1, 'Item'), [targetKey(target)], 'accepted']);
        const workbook = hover.value.match(/command:json-reading\.openSourceWorkbook\?([^\s)]+)/)!;
        assert.deepStrictEqual(JSON.parse(decodeURIComponent(workbook[1])), [path.resolve(view.state.tableDirectory, target.file), target.sheet]);
        assert.ok(!hover.value.includes('command:json-reading.rescanRelations'));
        assert.ok(!hover.value.includes('command:json-reading.clearRelations'));
        assert.ok(!hover.value.includes('$(trash)'));
        const additions = [...hover.value.matchAll(/command:json-reading\.addRelation\?([^\s)]+)/g)];
        assert.deepStrictEqual(additions.map(match => JSON.parse(decodeURIComponent(match[1]))), [
            [view.uri, fieldKey(1, 'Item')], [view.uri, fieldKey(2, 'Name')]
        ]);
        const trusted = typeof hover.isTrusted === 'object' ? hover.isTrusted.enabledCommands : [];
        for (const command of [openWorkbookCommand, relationCommands.decide, relationCommands.add, 'json-reading.syncTables']) {
            assert.ok(trusted?.includes(command));
        }
        assert.ok(!trusted?.includes(relationCommands.clear));
        assert.ok(!trusted?.includes(relationCommands.details));
        assert.ok(hover.value.includes('<span style="color:#388a34;">$(check)</span>'));
        assert.ok(hover.value.includes('<span style="color:#f14c4c;">✖</span>'));
        rules.fields[fieldKey(1, 'Item')].targets[targetKey(target)].decision = 'rejected';
        const excluded = createFieldHover(['Item'], undefined, undefined, view);
        assert.ok(!visibleHtml(excluded.value).includes('已匹配: '));
        assert.ok(excluded.value.includes('无匹配'));
        const primary = createFieldHover(['ID'], undefined, undefined, view);
        assert.ok(!primary.value.includes('json-reading.rescanRelations'));
        assert.ok(!primary.value.includes('json-reading.addRelation'));
        assert.ok(!visibleHtml(primary.value).includes('中文: '));
        assert.ok(!primary.value.includes('不执行'));
        const name = createFieldHover(['Name'], undefined, undefined, view);
        assert.ok(name.value.includes('无匹配'));
        assert.ok(visibleHtml(name.value).indexOf('无匹配') < visibleHtml(name.value).indexOf('中文: '));
    });
    test('手动添加按钮精确绑定编码 URI 和同名字段列，读取中与匹配表自身不显示入口', () => {
        const field = '道具 [ID]&';
        const parsed = parseRelations(JSON.stringify([['ID', field, field], [1, 100, 200]]));
        const view: RelationView = { uri: vscode.Uri.file('D:\\项目 空格\\A #&[1]Data.json').toString(), cells: parsed.cells,
            state: { tableDirectory: path.resolve('策划表'), parsed, rules: emptyRules(), data: [], translations: new Map(), loading: false } };
        const hover = createFieldHover(['ID', field], undefined, undefined, view);
        const links = [...hover.value.matchAll(/\[<span style="color:#388a34;">✚<\/span>\]\(command:json-reading\.addRelation\?([^\s)]+)/g)];
        assert.strictEqual(links.length, 2);
        assert.deepStrictEqual(links.map(match => JSON.parse(decodeURIComponent(match[1]))), [
            [view.uri, fieldKey(1, field)], [view.uri, fieldKey(2, field)]
        ]);
        assert.strictEqual(visibleHtml(hover.value).match(/无匹配/g)?.length, 2, '没有当前值命中时也允许添加字段规则');
        assert.deepStrictEqual(typeof hover.isTrusted === 'object' ? [...hover.isTrusted.enabledCommands ?? []].sort() : [],
            [relationCommands.add]);
        assert.ok(hover.supportThemeIcons);
        assert.ok(!hover.value.includes('command:json-reading.rescanRelations'));
        view.state.loading = true;
        const loading = createFieldHover([field], undefined, undefined, view);
        assert.ok(!loading.value.includes('command:json-reading.addRelation'));
        assert.ok(!(typeof loading.isTrusted === 'object' && loading.isTrusted.enabledCommands?.includes(relationCommands.add)));
        const mapping = { uri: vscode.Uri.file('D:\\项目 空格\\extensions\\json_reading\\relations.json'), languageId: 'json' } as vscode.TextDocument;
        // 匹配表必须在访问实例缓存或读取文件之前被拒绝，无需创建第二个已注册命令的控制器。
        const mappingView = RelationController.prototype.view.call({} as RelationController, mapping, 0);
        assert.strictEqual(mappingView, undefined);
        assert.ok(!createFieldHover([field], undefined, undefined, mappingView).value.includes('command:json-reading.addRelation'));
    });
    test('同页签全部未排除规则合并展示，确认和排除包含未命中条件与不同目标键', () => {
        const parsed = parseRelations('[["ID","Type","Rewards"],[1,2,"1001:20,1002:30"]]');
        const target = { file: '矿石.xlsm', sheet: '矿石', names: [], keyField: 'OreID' };
        const candidate: TargetRule = { target, decision: 'accepted', when: { field: 'Type', values: [2] }, extract: { listSeparator: ',', separator: ':', index: 0 } };
        const ruleId = ruleKey(target, candidate.when, candidate.extract), field = fieldKey(2, 'Rewards');
        const another: TargetRule = { ...candidate, when: undefined };
        const anotherId = ruleKey(target, another.when, another.extract);
        const inactive: TargetRule = { ...candidate, decision: 'pending', when: { field: 'Type', values: [3] } };
        const inactiveId = ruleKey(target, inactive.when, inactive.extract);
        const alternate: TargetRule = { ...candidate, target: { ...target, keyField: 'ResourceID' } };
        const alternateId = ruleKey(alternate.target, alternate.when, alternate.extract);
        const rejected: TargetRule = { ...candidate, decision: 'rejected', when: { field: 'Type', values: [4] } };
        const rejectedId = ruleKey(target, rejected.when, rejected.extract);
        const rules = emptyRules();
        rules.fields[field] = { scanned: true, targets: {
            [ruleId]: candidate, [anotherId]: another, [inactiveId]: inactive, [alternateId]: alternate, [rejectedId]: rejected
        } };
        const data: TargetData[] = [{ target, rows: new Map([
            ['1001', [{ id: '1001', row: 6, values: [['Name', '铁矿']] }]],
            ['1002', [{ id: '1002', row: 7, values: [['Name', '铜矿']] }]]
        ]) }];
        const view = { uri: 'file:///project/TestData.json', cells: parsed.cells.filter(cell => cell.field === 'Rewards'),
            state: { tableDirectory: path.resolve('策划表'), parsed, rules, data, translations: new Map<string, string>(), loading: false } };
        const hover = createFieldHover(['Rewards'], undefined, undefined, view);
        assert.strictEqual(hover.value.match(/command:json-reading\.openSourceWorkbook\?/g)?.length, 1);
        assert.strictEqual(hover.value.match(/command:json-reading\.decideRelation\?/g)?.length, 2);
        assert.ok(!hover.value.includes('Rewards: '));
        assert.ok(!hover.value.includes('OreID'));
        assert.ok(hover.value.includes('<span style="color:#388a34;">$(check)</span>'), '未命中当前条件的待确认规则仍有确认入口');
        const decisions = [...hover.value.matchAll(/command:json-reading\.decideRelation\?([^\s)]+)/g)];
        assert.deepStrictEqual(decisions.map(match => JSON.parse(decodeURIComponent(match[1]))), [
            [view.uri, field, [ruleId, anotherId, inactiveId, alternateId], 'accepted'],
            [view.uri, field, [ruleId, anotherId, inactiveId, alternateId], 'rejected']
        ]);
        data[0].rows.clear();
        assert.strictEqual(createFieldHover(['Rewards'], undefined, undefined, view).value, hover.value, '摘要不依赖目标表是否有当前值记录');
        view.state.data = [];
        for (const cell of view.cells) { cell.values = []; }
        const rulesOnly = createFieldHover(['Rewards'], undefined, undefined, view);
        assert.strictEqual(rulesOnly.value, hover.value, '只保留规则时仍能查看和操作关联');
        assert.ok(!rulesOnly.value.includes('关联结果'), '规则摘要不能凭空生成底部记录');
    });
    test('道具关联排除后，无当前值命中的已确认 AB 关联仍可见且可单独排除', () => {
        const parsed = parseRelations('[["ID","Type","itemId","Other"],[1,1,11012001,11012001]]');
        const field = fieldKey(2, 'itemId'), otherField = fieldKey(3, 'Other');
        const item = { file: 'Data/Item.xlsm', sheet: '道具', names: ['itemconfig'] };
        const ab = { file: 'Data/ABTest.xlsm', sheet: 'AB', names: ['abconfig'] };
        const unrelated = { file: 'Data/Other.xlsm', sheet: '其他目标', names: [] };
        const itemRule: TargetRule = { target: item, decision: 'rejected' };
        const abRule: TargetRule = { target: ab, decision: 'accepted', when: { field: 'Type', values: [2] } };
        const abRejected: TargetRule = { ...abRule, decision: 'rejected', when: { field: 'Type', values: [3] } };
        const otherRule: TargetRule = { target: unrelated, decision: 'accepted' };
        const abKey = ruleKey(ab, abRule.when), excludedKey = ruleKey(ab, abRejected.when);
        const rules = emptyRules();
        rules.fields[field] = { scanned: true, targets: {
            [ruleKey(item)]: itemRule, [abKey]: abRule, [excludedKey]: abRejected, [ruleKey(unrelated)]: otherRule
        } };
        rules.fields[otherField] = { scanned: true, targets: { [abKey]: { ...abRule, decision: 'pending' } } };
        const view: RelationView = { uri: 'file:///project/BoxRewardConfigData.json',
            cells: parsed.cells.filter(cell => cell.field === 'itemId'),
            state: { tableDirectory: path.resolve('策划表'), parsed, rules,
                data: [{ target: item, rows: new Map([['11012001', [{ id: '11012001', row: 6, values: [['Name', '经验水晶']] }]]]) }],
                translations: new Map(), loading: false }, results: [] };
        const hover = createFieldHover(['itemId'], undefined, undefined, view);
        assert.ok(visibleHtml(hover.value).includes('已匹配: '));
        const links = [...hover.value.matchAll(/command:json-reading\.openSourceWorkbook\?([^\s)]+)/g)];
        assert.deepStrictEqual(links.map(match => JSON.parse(decodeURIComponent(match[1]))), [
            [path.resolve(view.state.tableDirectory, ab.file), ab.sheet],
            [path.resolve(view.state.tableDirectory, unrelated.file), unrelated.sheet]
        ]);
        assert.ok(!hover.value.includes('$(check)'), '已确认目标不显示绿勾');
        assert.ok(hover.value.includes('<span style="color:#f14c4c;">✖</span>'));
        assert.ok(!hover.value.includes('关联结果') && !hover.value.includes('经验水晶'));
        const actions = [...hover.value.matchAll(/command:json-reading\.decideRelation\?([^\s)]+)/g)]
            .map(match => JSON.parse(decodeURIComponent(match[1])) as [string, string, string[], 'accepted' | 'rejected']);
        assert.deepStrictEqual(actions, [
            [view.uri, field, [abKey], 'rejected'],
            [view.uri, field, [ruleKey(unrelated)], 'rejected']
        ]);
        const next = decideRelationRules(rules, actions[0][1], actions[0][2], actions[0][3]);
        assert.strictEqual(next.fields[field].targets[abKey].decision, 'rejected');
        for (const key of [ruleKey(item), excludedKey, ruleKey(unrelated)]) {
            assert.deepStrictEqual(next.fields[field].targets[key], rules.fields[field].targets[key]);
        }
        assert.deepStrictEqual(next.fields[otherField], rules.fields[otherField]);
    });
    test('关联摘要不依赖当前单元格命中，初始加载失败和加载中仍显示相应状态', () => {
        const parsed = parseRelations('[["ID","Item"],[1,100],[2,200]]');
        const target = { file: '矿石.xlsm', sheet: '矿石', names: [] };
        const data: TargetData[] = [{ target, rows: new Map([['200', [{ id: '200', row: 6, values: [] }]]]) }];
        const rules = addCandidates(emptyRules(), parsed, data, true);
        const view: RelationView = { uri: 'file:///project/TestData.json', cells: [parsed.cells[0]],
            state: { tableDirectory: path.resolve('策划表'), parsed, rules, data, translations: new Map(), loading: false } };
        const configured = createFieldHover(['Item'], undefined, undefined, view);
        assert.ok(visibleHtml(configured.value).includes('已匹配: '));
        assert.ok(!configured.value.includes('无匹配'));
        assert.ok(!configured.value.includes('关联结果'), '当前值无记录时只显示配置关系');
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
        assert.ok(failedTranslation.value.includes('无匹配'));
        assert.ok(failedTranslation.value.indexOf('无匹配') < failedTranslation.value.indexOf('翻译文件无法读取'));
    });
    test('关联完整记录放在底部，多个 ID 和重复键全部展示，单元格内容不会变成命令', () => {
        const parsed = parseRelations('[["ID","pools","Name"],[1,[1001,1002],"i18n_1"]]');
        const target = { file: 'Data/ItemBox.xlsm', sheet: 'rewards', names: ['boxrewardconfig'] };
        const data: TargetData[] = [{ target, rows: new Map([
            ['1001', [{ id: '1001', row: 6, values: [['Name', '摘要']] }]],
            ['1002', [{ id: '1002', row: 7, values: [] }, { id: '1002', row: 8, values: [] }]]
        ]) }];
        const rules = addCandidates(emptyRules(), parsed, data, true);
        rules.fields[fieldKey(1, 'pools')].targets[targetKey(target)].decision = 'accepted';
        const view: RelationView = { uri: 'file:///project/BoxConfigData.json', cells: parsed.cells,
            state: { tableDirectory: path.resolve('策划表'), parsed, rules, data, translations: new Map([['i18n_1', '宝箱名称']]), loading: false },
            results: [
                { field: 'pools', column: 1, target, id: '1001', loading: false, rows: [{ id: '1001', row: 6, values: [
                    ['ID', '1001'], ['type', 'item'], ['itemId', '1101001'], ['count', '0'], ['optional', ''],
                    ['note', '第一行\n第二行'], ['unsafe', '<img src="x">[执行](command:bad) $(sync)']
                ] }] },
                { field: 'pools', column: 1, target, id: '1002', loading: false, rows: [
                    { id: '1002', row: 7, values: [['ID', '1002'], ['weight', '10']] },
                    { id: '1002', row: 8, values: [['ID', '1002'], ['weight', '20']] }
                ] }
            ] };
        const hover = createFieldHover(['pools', 'Name'], { state: 'ready', source: { file: 'ItemBox.xlsm', sheet: '宝箱配置' } },
            { file: '/project/BoxConfigData.json', jsonBranch: 'main', tableBranch: 'main' }, view);
        const start = hover.value.indexOf('关联结果');
        const visible = visibleHtml(hover.value);
        assert.ok(visible.indexOf('关联结果') > visible.indexOf('策划表: '));
        assert.ok(visible.indexOf('已匹配: ') < visible.indexOf('来源: '));
        assert.ok(visible.indexOf('中文: 宝箱名称') > visible.indexOf('关联结果'));
        const records = hover.value.slice(start, hover.value.indexOf(appendedText('中文: 宝箱名称')));
        for (const value of ['(第 7 行)', '(第 8 行)']) {
            assert.ok(records.includes(new vscode.MarkdownString().appendText(value).value), value);
        }
        assert.ok(!records.includes('（第'));
        const text = recordText(records);
        for (const value of [/\bID +1001\b/, /\bID +1002\b/, /\btype +item\b/, /\bitemId +1101001\b/,
            /\bcount +0\b/, /\boptional +\(空\)/, /\bweight +10\b/, /\bweight +20\b/, /\bnote +第一行/]) {
            assert.match(text, value);
        }
        assert.ok(text.includes('第二行'));
        assert.equal(text.match(/\bID +1002\b/g)?.length, 2);
        assertRecordLayout(records);
        for (const value of ['pools', 'ItemBox.xlsm / rewards', 'ID = 1001', 'ID = 1002']) {
            assert.ok(!records.includes(new vscode.MarkdownString().appendText(value).value), value);
        }
        for (const value of ['摘要', '<img', '[执行](command:bad)', '$(sync)', '已匹配', '匹配记录', '全部字段']) {
            assert.ok(!records.includes(value), value);
        }
        assert.ok(!hover.value.includes('$(check)'));
        assert.ok(!createFieldHover(['ID'], undefined, undefined, view).value.includes('关联结果'));
        assert.ok(!createFieldHover(['Name'], undefined, undefined, view).value.includes('关联结果'));
    });
    test('深层关联字段显示描述备注，展开块逐层缩进且中文仍留在所属值之后', () => {
        const parsed = parseRelations('[["ID","pools","Name"],[1,1001,"i18n_1"]]');
        const target = { file: 'Data/ItemBox.xlsm', sheet: 'rewards', names: ['boxrewardconfig'] };
        const item = { file: 'Data/Item.xlsm', sheet: '道具', names: ['itemconfig'] };
        const data: TargetData[] = [{ target, rows: new Map([['1001', [{ id: '1001', row: 6, values: [] }]]]) }];
        const rules = addCandidates(emptyRules(), parsed, data, true);
        rules.fields[fieldKey(1, 'pools')].targets[targetKey(target)].decision = 'accepted';
        const view: RelationView = { uri: 'file:///project/BoxConfigData.json', cells: parsed.cells,
            state: { tableDirectory: path.resolve('策划表'), parsed, rules, data, translations: new Map([['i18n_1', '外层宝箱名称']]), loading: false },
            results: [{ field: 'pools', column: 1, target, id: '1001', loading: false,
                rows: [{ id: '1001', row: 6, values: [['legacy', '未展开旧内容']] }],
                expandedRows: [{ id: '1001', row: 6, fields: [
                    { name: 'fix', value: '10', description: '固定值', detail: ' 固定值 ' },
                    { name: 'range', value: '', description: '', detail: '' },
                    { name: 'source', value: '保留（源数据）', description: '描述（原文）' },
                    { name: 'itemId', value: '11014002', description: '道具 ID', detail: '奖励道具', children: [
                        { target: item, id: '11014002', rows: [{ id: '11014002', row: 12, fields: [
                            { name: 'ID', value: '11014002' },
                            { name: 'name', value: 'i18n_4397', description: '名称', translations: [{ key: 'i18n_4397', text: '星羽铸币' }] },
                            { name: 'desc', value: 'i18n_4697', description: '说明', translations: [{ key: 'i18n_4697', text: '用于在星羽祈愿中抽取翅膀' }] },
                            { name: 'quality', value: '2', description: '品质' },
                            { name: 'next', value: '1001', children: [{ target, id: '1001', rows: [
                                { id: '1001', row: 6, fields: [], message: '检测到循环关联，停止展开' }
                            ] }] }
                        ] }] }
                    ] }
                ] }] }] };
        const hover = createFieldHover(['pools', 'Name'], { state: 'ready', source: { file: 'ItemBox.xlsm', sheet: '宝箱配置' } },
            { file: '/project/BoxConfigData.json', jsonBranch: 'main', tableBranch: 'main' }, expandAll(view)).value;
        const records = hover.slice(hover.indexOf('关联结果'), hover.indexOf(appendedText('中文: 外层宝箱名称')));
        const text = recordText(records);
        for (const value of [/fix: 固定值\(备注\) +10/, /range +\(空\)/,
            /itemId: 道具 ID\(备注\) +11014002\s*▼: \{\s*ID +11014002/,
            /name: 名称 +i18n_4397\s*▼: \{\s*中文: 星羽铸币\}/,
            /quality: 品质 +2/, /next +1001\s*▼: \{\s*检测到循环关联，停止展开\}/]) {
            assert.match(text, value);
        }
        assert.deepStrictEqual(noteTitles(records), [' 固定值 ', '奖励道具']);
        assert.ok(text.includes('描述（原文）') && text.includes('保留（源数据）'));
        assert.ok(!text.includes('（备注）') && !text.includes('（空）'));
        const nameLine = recordRows(records).find(row => row.some(cell => cell.text === 'name: 名称'))!;
        assert.ok(nameLine);
        assert.ok(recordRows(records).flat().some(cell => cell.text.replace(/,$/, '') === '中文: 星羽铸币}'));
        assert.ok(recordRows(records).flat().some(cell => cell.text === 'i18n_4397▼: {'), '值后应直接连接展开箭头');
        assert.ok(!text.includes('奖励道具'));
        assert.ok(visibleHtml(hover).indexOf('关联结果') > visibleHtml(hover).indexOf('策划表: '));
        assert.ok(visibleHtml(hover).indexOf('中文: 外层宝箱名称') > visibleHtml(hover).indexOf('用于在星羽祈愿中抽取翅膀'));
        for (const value of ['固定值（固定值）', 'range（）', '未展开旧内容', 'Item.xlsm', 'ItemBox.xlsm', 'ID =', '$(search)', '$(check)']) {
            assert.ok(!records.includes(value), value);
        }
        assertRecordLayout(records);
        assert.doesNotMatch(text, /,\s*\}/);
    });
    test('递归多条记录保留行号，说明多行和异常信息均转义且保持缩进', () => {
        const parsed = parseRelations('[["ID","Item"],[1,100]]');
        const target = { file: '矿石.xlsm', sheet: '矿石', names: [] };
        const view: RelationView = { uri: 'file:///project/TestData.json', cells: parsed.cells,
            state: { tableDirectory: path.resolve('策划表'), parsed, rules: emptyRules(), data: [], translations: new Map(), loading: false },
            results: [{ field: 'Item', column: 1, target, id: '100', loading: false, rows: [], expandedRows: [
                { id: '100', row: 6, fields: [{ name: 'reward', value: '200', children: [
                    { target, id: '200', rows: [
                        { id: '200', row: 7, fields: [
                            { name: '<label>', value: '<img src="x"> & [执行](command:bad) $(sync)\r\n下一行',
                                description: '**描述**\r\n第二行', detail: '[备注](command:bad) <&>\r\n"引号"（原文）' },
                            { name: 'empty', value: '', detail: '只有备注' },
                            { name: 'multiline', value: '100\r\n200', description: '首行\n第二行\n第三行', message: '达到字段展开上限，停止展开' },
                            { name: 'blankline', value: '甲\n\n乙' },
                            { name: 'translations', value: 'i18n_1,i18n_2', translations: [
                                { key: 'i18n_1', error: '<错误> [执行](command:bad)' }, { key: 'i18n_2' }
                            ] }
                        ] },
                        { id: '200', row: 8, fields: [{ name: 'ID', value: '200' }], message: '达到展开记录上限，停止展开' }
                    ] },
                    { target, id: '300', rows: [], message: '读取失败：<文件> [执行](command:bad)' },
                    { target, id: '400', rows: [], message: '达到最大深度，停止展开' }
                ] }] }
            ] }] };
        const hover = createFieldHover(['Item'], undefined, undefined, expandAll(view)).value;
        const records = hover.slice(hover.indexOf('关联结果'));
        const text = recordText(records);
        const columns = recordColumns(records);
        for (const value of ['<label>: **描述**', '第二行', '(备注)', '<img src="x"> & [执行](command:bad) $(sync)', '下一行',
            'empty: (备注)', 'multiline: 首行', '第三行', '达到字段展开上限，停止展开',
            '读取失败: <错误> [执行](command:bad)', '未找到对应 KeyID',
            '达到展开记录上限，停止展开', '读取失败：<文件>', '达到最大深度，停止展开']) {
            assert.ok(columns.some(column => column.includes(value)), value);
        }
        assert.match(text, /第 1 条\(第 7 行\)\s*: \{/);
        assert.match(text, /第 2 条\(第 8 行\)\s*: \{/);
        assert.ok(text.includes('中文: i18n_1: 读取失败'));
        assert.ok(text.includes('中文: i18n_2: 未找到对应 KeyID'));
        assert.match(text, /甲[ \t]*\n[ \t]*\n[ \t]*乙/);
        assert.deepStrictEqual(noteTitles(records), ['[备注](command:bad) <&>\r\n"引号"（原文）', '只有备注']);
        assert.ok(!text.includes('[备注](command:bad)'));
        assert.ok(!text.includes('只有备注'));
        assertRecordLayout(records);
        assert.doesNotMatch(text, /,\s*\}/);
        assert.ok(!records.includes('未找到对应记录'));
        for (const value of ['<label>', '<img', '<错误>', '**描述**', '[执行](command:bad)', '$(sync)']) {
            assert.ok(!records.includes(value), value);
        }
    });
    test('同层值按列对齐，首子项紧接左括号，后续子项同列且右括号接在末项后', () => {
        const parsed = parseRelations('[["ID","Item"],[1,100]]');
        const target = { file: 'example.xlsm', sheet: '示例', names: [] };
        const longValue = '长叶值'.repeat(30), longMessage = '异常说明'.repeat(30);
        for (const value of ['7', '道具', 'e\u0301', '👩‍💻']) {
            const view: RelationView = { uri: 'file:///project/TestData.json', cells: parsed.cells,
                state: { tableDirectory: path.resolve('策划表'), parsed, rules: emptyRules(), data: [], translations: new Map(), loading: false },
                results: [{ field: 'Item', column: 1, target, id: '100', loading: false, rows: [], expandedRows: [
                    { id: '100', row: 6, message: longMessage, fields: [{ name: 'p', value, children: [{ target, id: '200', rows: [
                        { id: '200', row: 7, fields: [{ name: 'a', value: '1' }, { name: 'betaLong', value: '2' }] }
                    ] }] }, { name: 'longerName', value: longValue }] }
                ] }] };
            const hover = createFieldHover(['Item'], undefined, undefined, expandAll(view)).value;
            assertRecordLayout(hover);
            const rows = groupRows(hover);
            const firstIndex = rows.findIndex(row => row.labelText === 'p');
            const first = rows[firstIndex];
            const childRows = rows.filter(row => row.group === first.children);
            const child = childRows.find(row => row.labelText === 'a')!;
            const last = childRows.find(row => row.labelText === 'betaLong')!;
            const laterIndex = rows.findIndex(row => row.labelText === 'longerName');
            const later = rows[laterIndex];
            assert.ok(first && child && last && later);
            assert.strictEqual(first.valueText, `${value}▼: {`, '父值与箭头必须直接相邻');
            assert.strictEqual(first.prefix?.parent, first.children?.parent, '父前缀与子组应位于同一个局部视觉行');
            const siblings = elements(first.prefix!.parent!);
            assert.strictEqual(siblings.indexOf(first.children!), siblings.indexOf(first.prefix!) + 1, '首子组紧随左括号，不插入共享数据列');
            assert.strictEqual(childRows[0], child, '第一子项不应额外换行');
            assert.strictEqual(child.valueText, '1,');
            assert.strictEqual(last.valueText, '2},', '右括号应直接接最后子项');
            assert.strictEqual(first.group, later.group);
            assert.strictEqual(first.label?.attributes.match(/\bwidth="([^"]+)"/)?.[1], later.label?.attributes.match(/\bwidth="([^"]+)"/)?.[1], '同组标签共享宽度以对齐值起点');
            assert.strictEqual(child.label?.attributes.match(/\bwidth="([^"]+)"/)?.[1], last.label?.attributes.match(/\bwidth="([^"]+)"/)?.[1]);
            assert.notStrictEqual(first.group, child.group, '子树应有自己的对齐组');
            assert.strictEqual(rows.slice(laterIndex).filter(row => row.group === later.group).map(row => row.valueText).join(''), longValue);
            assert.strictEqual(rows.slice(0, firstIndex).filter(row => row.group === first.group).map(row => row.valueText).join(''), longMessage + ',');
            const continuation = rows.slice(laterIndex + 1).filter(row => row.group === later.group);
            assert.ok(continuation.length > 0, '长值应拆为同组续行');
            assert.ok(continuation.every(row => row.labelText === ''));
            assert.ok(!rows.some(row => /^\},?$/.test(row.valueText)), '闭括号不能另起一行');
            assert.doesNotMatch(recordText(hover), /,\s*\}/);
        }
    });
    test('长译文和 ASCII 显式分行且续行同列，不改写原文、链接或备注', () => {
        const parsed = parseRelations('[["ID","Item"],[1,100]]');
        const target = { file: 'example.xlsm', sheet: '示例', names: [] };
        const ascii = ['ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.repeat(3), 'ABCDEF7', 'ABCDEFG8', 'ABCDEFGHIJKLMNO', 'W'.repeat(24)].join(' ');
        const translation = '这里是一段可以自然折行的中文说明'.repeat(24) + '<script>"&[执行](command:bad)' + ascii;
        const detail = `备注：${ascii} <>&" （原文）`;
        const view: RelationView = { uri: 'file:///project/A%20%26ConfigData.json', cells: parsed.cells,
            state: { tableDirectory: path.resolve('策划表'), parsed, rules: emptyRules(), data: [], translations: new Map(), loading: false },
            expansion: { line: 1, version: 2, expanded: new Set() },
            results: [{ field: 'Item', column: 1, target, id: '100', loading: false, rows: [], expandedRows: [
                { id: '100', row: 6, fields: [{ name: 'name', value: ascii, detail,
                    translations: [{ key: 'i18n_1', text: translation }] }] }
            ] }] };
        const hover = createFieldHover(['Item'], undefined, undefined, view).value;
        const records = hover.slice(hover.indexOf('关联结果'));
        const rows = groupRows(records);
        const first = rows.find(row => row.labelText.includes('name:'))!;
        const parentRows = rows.filter(row => row.group === first.group);
        const opening = parentRows.find(row => row.children)!;
        const translated = rows.filter(row => row.group === opening.children);
        assert.strictEqual(parentRows.map(row => row.labelText).join(''), 'name: (备注)');
        assert.strictEqual(parentRows.map(row => row.valueText).join(''), `${ascii}▼: {`);
        assert.strictEqual(translated.map(row => row.valueText).join(''), `中文: ${translation}}`);
        assert.strictEqual(opening.prefix?.parent, opening.children?.parent, '首段中文应紧随父值所在视觉行的左括号');
        assert.strictEqual(parentRows[parentRows.length - 1], opening, '子组从父值最后一段开始');
        assert.ok(parentRows.length > 1 && translated.length > 1, '长可见数据应生成明确的视觉续行');
        assert.ok(translated.every(row => !row.label && row.group === opening.children), '译文续行保留自己的局部起点');
        assert.deepStrictEqual(noteTitles(records), [detail]);
        const nodes = descendants(htmlTree(records));
        const note = nodes.find(node => node.tag === 'span' && /\btitle=/.test(node.attributes))!;
        assert.ok(note?.parent);
        assert.strictEqual(nodeText(note.parent), '(备注)');
        assert.match(note.parent.attributes, /display:\s*inline-block/);
        const controls = expansionControls(records);
        const key = cascadeFieldKey(cascadeRootKey(1, 'Item', target), 0, 'name');
        assert.deepStrictEqual(controls.map(control => control.args), [[view.uri, 2, 1, key, false]]);
        for (const node of nodes) { assert.ok(!node.attributes.includes('<wbr'), '换行标记不能写入 HTML 属性'); }
        for (const value of ['<script>', '[执行](command:bad)', '<>&"']) { assert.ok(!records.includes(value), value); }
        assertRecordLayout(records);
    });
    test('深层级联保持首项同行及每层独立分组，内容和所有闭括号完整显示', () => {
        const parsed = parseRelations('[["ID","Item"],[1,100]]');
        const target = { file: 'example.xlsm', sheet: '示例', names: [] };
        let field: CascadeField = { name: 'level8', value: '最深层值' };
        for (let depth = 7; depth >= 0; depth--) {
            field = { name: `level${depth}`, value: String(depth), children: [
                { target, id: String(depth + 1), rows: [{ id: String(depth + 1), row: depth + 7, fields: [field] }] }
            ] };
        }
        const view: RelationView = { uri: 'file:///project/TestData.json', cells: parsed.cells,
            state: { tableDirectory: path.resolve('策划表'), parsed, rules: emptyRules(), data: [], translations: new Map(), loading: false },
            results: [{ field: 'Item', column: 1, target, id: '100', loading: false, rows: [],
                expandedRows: [{ id: '100', row: 6, fields: [field] }] }] };
        const hover = createFieldHover(['Item'], undefined, undefined, expandAll(view)).value;
        assertRecordLayout(hover);
        const rows = groupRows(hover);
        let current = rows.find(row => row.labelText === 'level0')!;
        for (let depth = 0; depth <= 8; depth++) {
            assert.strictEqual(current.labelText, `level${depth}`);
            if (depth < 8) {
                assert.strictEqual(current.valueText, `${depth}▼: {`);
                assert.strictEqual(current.prefix?.parent, current.children?.parent, '第一子项应继续父值所在的局部视觉行');
                current = rows.find(row => row.group === current.children)!;
            }
        }
        assert.strictEqual(current.valueText, '最深层值' + '}'.repeat(8));
        assert.strictEqual(recordText(hover).match(/\}/g)?.length, 8);
        assert.strictEqual(expansionControls(hover).length, 8);
    });
    test('长值在边界分行时保留组合字符与完整 emoji，不拆到不同视觉行', () => {
        const parsed = parseRelations('[["ID","Item"],[1,100]]');
        const target = { file: 'example.xlsm', sheet: '示例', names: [] };
        const graphemes = ['👩‍💻', '👨‍👩‍👧‍👦', '👍🏽', 'e\u0301'];
        const values = graphemes.map(grapheme => 'W'.repeat(21) + grapheme + 'tail');
        const view: RelationView = { uri: 'file:///project/TestData.json', cells: parsed.cells,
            state: { tableDirectory: path.resolve('策划表'), parsed, rules: emptyRules(), data: [], translations: new Map(), loading: false },
            results: [{ field: 'Item', column: 1, target, id: '100', loading: false, rows: [], expandedRows: [
                { id: '100', row: 6, fields: values.map((value, index) => ({ name: `g${index}`, value })) }
            ] }] };
        const hover = createFieldHover(['Item'], undefined, undefined, view).value;
        const rows = groupRows(hover);
        assert.ok(rows.length > values.length, '夹在宽字母后的组合字符应覆盖视觉行边界');
        assert.strictEqual(rows.map(row => row.valueText).join(''), values.join(','));
        for (const grapheme of graphemes) {
            assert.strictEqual(rows.filter(row => row.valueText.includes(grapheme)).length, 1, `${grapheme} 必须完整地出现在一个单元格内`);
        }
        assertRecordLayout(hover);
    });
    test('普通级联默认收起、i18n默认展开，纯图标控件保留准确参数与显式收起状态', () => {
        const parsed = parseRelations('[["ID","Item"],[1,100]]');
        const target = { file: 'Data/主表.xlsm', sheet: '主表', names: [] };
        const item = { file: 'Data/道具.xlsm', sheet: '道具', names: [] };
        const view: RelationView = { uri: 'file:///project/A%20%26TestData.json', cells: parsed.cells,
            state: { tableDirectory: path.resolve('策划表'), parsed, rules: emptyRules(), data: [], translations: new Map(), loading: false },
            results: [{ field: 'Item', column: 1, target, id: '100', loading: false, rows: [], expandedRows: [
                { id: '100', row: 6, fields: [
                    { name: 'ID', value: '100' },
                    { name: 'ref', value: '200', description: '源描述：保留', children: [{ target: item, id: '200', rows: [
                        { id: '200', row: 7, fields: [{ name: 'child', value: '子层值' }, { name: 'next', value: '300', children: [
                            { target, id: '300', rows: [{ id: '300', row: 8, fields: [{ name: 'secret', value: '最深层值' }] }] }
                        ] }, { name: 'nestedName', value: 'i18n_nested', translations: [{ key: 'i18n_nested', text: '子层中文' }] }] }
                    ] }] },
                    { name: 'message', value: '5', message: '错误：源数据' },
                    { name: 'name', value: 'i18n_1', translations: [{ key: 'i18n_1', text: '翻译：源数据' }] }
                ] }
            ] }] };
        const draw = () => createFieldHover(['Item'], { state: 'ready', fields: new Map([
            ['Item', { description: '顶层说明：保留', detail: '备注：原文' }]
        ]) }, undefined, view);
        const initial = draw(), collapsed = recordText(initial.value);
        for (const value of ['ID', '100', 'ref: 源描述：保留', '200', 'message', '5', 'name', 'i18n_1']) { assert.ok(collapsed.includes(value), value); }
        for (const value of ['子层值', '最深层值', '错误：源数据', '子层中文']) { assert.ok(!collapsed.includes(value), value); }
        assert.ok(collapsed.includes('中文: 翻译：源数据'));
        assert.strictEqual(collapsed.match(/▶/g)?.length, 2);
        assert.strictEqual(collapsed.match(/▼/g)?.length, 1);
        assert.strictEqual(expansionControls(initial.value).length, 0);
        assert.match(collapsed, /200▶/);
        assert.ok(visibleHtml(initial.value).includes('字段名: Item'));
        assert.ok(visibleHtml(initial.value).includes('描述: 顶层说明：保留'));
        assert.ok(visibleHtml(initial.value).includes('备注: 备注：原文'));
        assert.deepStrictEqual(noteTitles(initial.value), []);

        const root = cascadeRootKey(1, 'Item', target), ref = cascadeFieldKey(root, 1, 'ref');
        const next = cascadeFieldKey(cascadeMatchKey(ref, item), 1, 'next');
        const nestedName = cascadeFieldKey(cascadeMatchKey(ref, item), 2, 'nestedName');
        const message = cascadeFieldKey(root, 2, 'message'), name = cascadeFieldKey(root, 3, 'name');
        view.expansion = { line: 4, version: 11, expanded: new Set() };
        const defaultHover = draw(), defaults = expansionControls(defaultHover.value);
        assert.ok(recordText(defaultHover.value).includes('中文: 翻译：源数据'));
        assert.ok(!recordText(defaultHover.value).includes('子层中文'));
        assert.strictEqual(defaults.length, 3);
        for (const key of [ref, message]) {
            assert.ok(defaults.some(control => control.text === '▶' && JSON.stringify(control.args) === JSON.stringify([view.uri, 11, 4, key, true])));
        }
        assert.ok(defaults.some(control => control.text === '▼' && JSON.stringify(control.args) === JSON.stringify([view.uri, 11, 4, name, false])));
        view.expansion = { line: 4, version: 11, expanded: new Set([ref]) };
        const opened = draw(), text = recordText(opened.value), controls = expansionControls(opened.value);
        assert.ok(text.includes('子层值'));
        assert.ok(text.includes('中文: 子层中文'));
        assert.ok(!text.includes('最深层值'));
        const openedRows = groupRows(opened.value);
        const header = openedRows.find(row => row.labelText === 'ref: 源描述：保留')!;
        assert.strictEqual(header.valueText, '200▼: {');
        const children = openedRows.filter(row => row.group === header.children);
        assert.strictEqual(children[0].labelText, 'child');
        assert.strictEqual(children[0].valueText, '子层值,');
        assert.strictEqual(header.prefix?.parent, header.children?.parent, '展开后首子项应紧接父字段的左括号');
        assert.ok(children.some(row => row.labelText === 'next'));
        assert.ok(controls.some(control => control.text === '▼' && JSON.stringify(control.args) === JSON.stringify([view.uri, 11, 4, ref, false])));
        for (const key of [next, message]) {
            assert.ok(controls.some(control => control.text === '▶' && JSON.stringify(control.args) === JSON.stringify([view.uri, 11, 4, key, true])));
        }
        for (const key of [name, nestedName]) {
            assert.ok(controls.some(control => control.text === '▼' && JSON.stringify(control.args) === JSON.stringify([view.uri, 11, 4, key, false])));
        }
        assert.ok(controls.every(control => control.html.startsWith('<a ') && control.html.includes(`command:${relationCommands.toggle}?`)));
        assert.ok(controls.every(control => /title="(?:展开|收起)此字段的关联内容，记住当前选择"/.test(control.html)));
        assert.ok(controls.every(control => control.text === '▶' || control.text === '▼'));
        const trusted = typeof opened.isTrusted === 'object' ? opened.isTrusted.enabledCommands : [];
        assert.ok(trusted?.includes(relationCommands.toggle));
        assert.ok(!trusted?.includes('bad'));

        view.expansion = { ...view.expansion, expanded: new Set([ref, name, nestedName]), collapsed: new Set([name, nestedName]) };
        const manuallyClosed = draw(), closedText = recordText(manuallyClosed.value);
        assert.ok(closedText.includes('子层值'));
        assert.ok(!closedText.includes('翻译：源数据') && !closedText.includes('子层中文'));
        for (const key of [name, nestedName]) {
            assert.ok(expansionControls(manuallyClosed.value).some(control => control.text === '▶' && JSON.stringify(control.args) === JSON.stringify([view.uri, 11, 4, key, true])));
        }
        assert.strictEqual(recordText(draw().value), closedText);

        view.expansion = { ...view.expansion, expanded: new Set([ref, next, message, name]), collapsed: new Set() };
        const all = draw(), expanded = recordText(all.value);
        for (const value of ['最深层值', '错误：源数据', '中文: 翻译：源数据']) { assert.ok(expanded.includes(value), value); }
        assertRecordLayout(all.value);
        // 另一条记录复用同一字段路径；命令键不包含当前 ID 或 Excel 行号。
        view.results![0].id = '999';
        view.results![0].expandedRows![0].id = '999';
        view.results![0].expandedRows![0].row = 99;
        view.results![0].expandedRows![0].fields[1].value = '888';
        view.expansion = { ...view.expansion, collapsed: new Set([name]) };
        const changed = draw();
        assert.ok(recordText(changed.value).includes('最深层值'));
        assert.ok(!recordText(changed.value).includes('翻译：源数据'));
        assert.ok(expansionControls(changed.value).some(control => JSON.stringify(control.args) === JSON.stringify([view.uri, 11, 4, ref, false])));
        assert.ok(expansionControls(changed.value).some(control => JSON.stringify(control.args) === JSON.stringify([view.uri, 11, 4, name, true])));
    });
    test('关联记录加载与错误独立于头部匹配状态，不把失败显示为空记录', () => {
        const parsed = parseRelations('[["ID","Item"],[1,100]]');
        const target = { file: '矿石.xlsm', sheet: '矿石', names: [], keyField: 'OreID' };
        const data: TargetData[] = [{ target, rows: new Map([['100', [{ id: '100', row: 6, values: [] }]]]) }];
        const view: RelationView = { uri: 'file:///project/TestData.json', cells: parsed.cells,
            state: { tableDirectory: path.resolve('策划表'), parsed, rules: addCandidates(emptyRules(), parsed, data, true), data, translations: new Map(), loading: false },
            results: [{ field: 'Item', column: 1, target, id: '100', rows: [], loading: true }] };
        const loading = createFieldHover(['Item'], undefined, undefined, view).value;
        assert.ok(visibleHtml(loading).includes('已匹配: '));
        assert.ok(loading.includes(new vscode.MarkdownString().appendText('正在读取关联记录').value));
        assert.ok(!loading.includes('未找到对应记录'));
        view.results![0].loading = false;
        view.results![0].error = '工作簿暂时不可读';
        const failed = createFieldHover(['Item'], undefined, undefined, view).value;
        assert.ok(visibleHtml(failed).includes('已匹配: '));
        assert.ok(failed.includes(new vscode.MarkdownString().appendText('读取失败: 工作簿暂时不可读').value));
        assert.ok(!failed.includes('未找到对应记录'));
        view.results![0].rows = [{ id: '100', row: 6, values: [['ID', '100'], ['Name', '保留原记录']] }];
        const partial = createFieldHover(['Item'], undefined, undefined, view).value;
        assert.ok(visibleHtml(partial).includes('读取失败: 工作簿暂时不可读'));
        assert.match(recordText(partial), /ID +100/);
        assert.match(recordText(partial), /Name +保留原记录/);
        assert.ok(!partial.includes('未找到对应记录'));
        view.results![0].rows = [];
        view.results![0].error = undefined;
        const missing = createFieldHover(['Item'], undefined, undefined, view).value;
        assert.ok(missing.includes(new vscode.MarkdownString().appendText('未找到对应记录').value));
        for (const value of [loading, failed, missing]) {
            assert.ok(!value.includes(new vscode.MarkdownString().appendText('OreID = 100').value));
        }
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
    test('异行展开刷新不调用 hide/show、不注册临时提示且保留非空选区', async () => {
        const selection = new vscode.Selection(0, 1, 0, 2);
        const editor = { selection, document: { languageId: 'json', uri: vscode.Uri.parse('untitled:other-line'),
            lineAt: () => ({ range: new vscode.Range(0, 0, 0, 8) }) } } as unknown as vscode.TextEditor;
        const commands: string[] = [];
        let providers = 0;
        const disposable = () => ({ dispose() {} });
        const api = { ...vscode,
            window: { activeTextEditor: editor, onDidChangeActiveTextEditor: disposable, onDidChangeTextEditorSelection: disposable },
            workspace: { onDidChangeTextDocument: disposable },
            languages: { registerHoverProvider: () => { providers++; return disposable(); } },
            commands: { executeCommand: async (command: string) => { commands.push(command); } }
        };
        // 隔离模块的命令边界，避免覆盖 VS Code 的只读 API 或真的关闭宿主悬浮框。
        const isolated = { exports: {} as { HoverRefresh: typeof HoverRefresh } };
        runInNewContext(readFileSync(require.resolve('../hoverRefresh'), 'utf8'), {
            module: isolated, exports: isolated.exports,
            require: (name: string) => { assert.strictEqual(name, 'vscode'); return api; }
        });
        const refresh = new isolated.exports.HoverRefresh();
        try {
            await refresh.show(editor, new vscode.MarkdownString('另一行的关联内容'), 1);
            assert.deepStrictEqual(commands, []);
            assert.strictEqual(providers, 0);
            assert.strictEqual(editor.selection, selection);
        } finally { refresh.dispose(); }
    });
    test('顶层备注直接显示全文，续行对齐并保留空行、来源和顶部留白', () => {
        const hover = createFieldHover(['Type'], {
            state: 'ready', source: { file: 'example.xlsm', sheet: '奖励' },
            fields: new Map([['Type', { description: '奖励类型', detail: '第一种\r\n\r\n第二种' }]])
        });
        assert.ok(hover.value.startsWith('&nbsp;\n\n'));
        const visible = visibleHtml(hover.value);
        for (const value of ['Type', '奖励类型', '备注', 'example', '奖励']) {
            assert.ok(visible.includes(value), value);
        }
        assert.ok(visible.includes('第一种') && visible.includes('第二种'));
        assert.deepStrictEqual(noteTitles(hover.value), []);
        assert.deepStrictEqual(recordRows(hover.value).map(row => row.map(cell => cell.text)), [
            ['备注: ', '第一种'], ['', ''], ['', '第二种']
        ]);
        const identical = createFieldHover(['Same', 'Empty'], { state: 'ready', fields: new Map([
            ['Same', { description: '同一说明', detail: '同一说明' }], ['Empty', { description: '无备注', detail: ' \r\n ' }]
        ]) });
        assert.deepStrictEqual(noteTitles(identical.value), []);
        assert.strictEqual(visibleHtml(identical.value).match(/同一说明/g)?.length, 2, '备注与简述相同也应显示全文');
        assert.deepStrictEqual(recordRows(identical.value).map(row => row.map(cell => cell.text)), [['备注: ', '同一说明']]);
        assert.deepStrictEqual(hover.isTrusted, { enabledCommands: [openWorkbookCommand] });
        assert.ok(hover.supportHtml);
    });
    test('缺少表格时保留字段名，表格说明中的 Markdown 作为纯文本', () => {
        assert.ok(createFieldHover(['ID']).value.includes('ID'));
        const detail = '[执行](command:bad) <>& $(sync)';
        const hover = createFieldHover(['ID'], {
            state: 'ready', fields: new Map([['ID', { description: '**标题**', detail }]])
        });
        assert.ok(!hover.value.includes('**标题**'));
        assert.ok(!hover.value.includes('[执行](command:bad)'));
        assert.ok(!hover.value.includes('<>&') && !hover.value.includes('$(sync)'));
        assert.ok(visibleHtml(hover.value).includes(detail), 'HTML、Markdown 与 codicon 语法应作为备注原文显示');
        assert.ok(!hover.isTrusted, '备注原文不能增加可执行命令权限');
    });
    test('注册策划目录选择、解除绑定、索引刷新和重名工作簿选择命令', async () => {
        const commands = await vscode.commands.getCommands(true);
        for (const command of ['selectTableDirectory', 'clearTableDirectory', 'refreshTableIndex', 'selectTableWorkbook', 'openSourceWorkbook', 'syncTables', 'addRelation', 'toggleRelationExpansion']) {
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
