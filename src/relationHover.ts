import * as vscode from 'vscode';
import * as path from 'node:path';
import { relationCommands, type RelationResult, type RelationView } from './relationController';
import type { CascadeField, CascadeRow } from './relationCascade';
import { fieldKey, targetKey, valuesForRule, type RelationTarget } from './relations';
import { noteHtml } from './hoverNote';
import { cascadeRootKey, cascadeFieldKey, cascadeMatchKey } from './relationExpansion';

const link = (label: string, command: string, args: unknown[], title: string) =>
    `[${label}](command:${command}?${encodeURIComponent(JSON.stringify(args))} "${title}")`;

/** 多个模块共用同一个 MarkdownString，不覆盖其他模块已经允许的命令。 */
export function trustHoverCommands(hover: vscode.MarkdownString, ...commands: string[]) {
    const trusted = typeof hover.isTrusted === 'object' ? hover.isTrusted.enabledCommands : [];
    hover.isTrusted = { enabledCommands: [...new Set([...trusted ?? [], ...commands])] };
}

/** 匹配表结果紧随所属字段描述；一个页签只展示一次，点击可直接打开该工作簿。 */
export function appendFieldRelations(hover: vscode.MarkdownString, fieldName: string, view: RelationView | undefined, openWorkbookCommand: string) {
    if (!view) { return; }
    const cells = view.cells.filter(cell => cell.column > 0 && cell.field === fieldName);
    if (!cells.length) { return; }
    hover.supportThemeIcons = true;
    hover.supportHtml = true;
    const { state } = view;
    const data = new Map(state.data.map(table => [targetKey(table.target), table]));
    const fields = new Set(cells.map(cell => fieldKey(cell.column, cell.field)));
    for (const field of fields) {
        const fieldCells = cells.filter(cell => fieldKey(cell.column, cell.field) === field);
        hover.appendText('    ');
        if (state.loading) {
            hover.appendText('正在读取关联…');
        } else if (state.error) {
            hover.appendText(`关联读取失败: ${state.error}`);
        } else {
            const matches = new Map<string, { target: RelationTarget; keys: string[]; pending: boolean }>();
            for (const [key, candidate] of Object.entries(state.rules.fields[field]?.targets ?? {})) {
                if (candidate.decision === 'rejected') { continue; }
                const table = data.get(targetKey(candidate.target));
                if (!table || !fieldCells.some(cell => valuesForRule(cell, candidate).some(value =>
                    !value.startsWith('i18n_') && !!table.rows.get(value)?.length))) { continue; }
                // 同一页签可有不同主键或条件规则；操作携带全部实际命中的规则键。
                const identity = JSON.stringify([candidate.target.file.replaceAll('\\', '/'), candidate.target.sheet]);
                let match = matches.get(identity);
                if (!match) {
                    match = { target: candidate.target, keys: [], pending: false };
                    matches.set(identity, match);
                }
                match.keys.push(key);
                match.pending ||= candidate.decision === 'pending';
            }
            hover.appendText(matches.size ? '已匹配: ' : '无匹配');
            let position = 0;
            for (const { target, keys, pending } of matches.values()) {
                if (position++) { hover.appendText('；'); }
                const basename = path.posix.basename(target.file.replaceAll('\\', '/'));
                const label = new vscode.MarkdownString().appendText(`${basename} / ${target.sheet}`).value;
                const file = path.resolve(state.tableDirectory, target.file);
                trustHoverCommands(hover, openWorkbookCommand, relationCommands.decide);
                hover.appendMarkdown(link(label, openWorkbookCommand, [file, target.sheet],
                    pending ? '待确认关联，点击打开工作簿并切换到对应页签' : '打开关联工作簿并切换到对应页签'));
                if (pending) {
                    hover.appendMarkdown(' ' + link('<span style="color:#388a34;">$(check)</span>', relationCommands.decide,
                        [view.uri, field, keys, 'accepted'], '确认当前字段与此页签的匹配关联'));
                }
                hover.appendMarkdown(' ' + link('<span style="color:#f14c4c;">$(close)</span>', relationCommands.decide,
                    [view.uri, field, keys, 'rejected'], '排除当前字段与此页签的匹配关联'));
            }
        }
        // 暂时隐藏全搜索按钮，字段搜索命令保留，便于后续恢复入口。
        // if (!state.loading) {
        //     trustHoverCommands(hover, relationCommands.rescan);
        //     hover.appendMarkdown('  ' + link('$(search)', relationCommands.rescan, [view.uri, field],
        //         '仅全搜索当前字段，保留已有规则并补充待确认候选'));
        // }
        trustHoverCommands(hover, relationCommands.clear);
        hover.appendMarkdown('  ' + link('$(trash)', relationCommands.clear, [view.uri], '清空当前 JSON 的全部匹配规则，不影响其他 JSON'));
    }
}

interface RecordPart { text: string; html: string }
interface RecordText { text: string; html: string; parts: RecordPart[] }
interface RecordEntry { label?: RecordText; value: string; children?: RecordEntry[]; branchKey?: string; defaultExpanded?: boolean }

const escapeHtml = (value: string) => value.replace(/[&<>"'`*_[\]\\|~$]/g, character => `&#${character.codePointAt(0)};`);
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** 备注和命令保留为完整片段，后面的视觉换行只拆分可见数据。 */
function recordText(value: string): RecordText {
    const text = value.replace(/\r\n|\r/g, '\n').replaceAll('\t', '    ');
    const parts = Array.from(graphemes.segment(text), ({ segment }) => ({ text: segment, html: escapeHtml(segment) }));
    return { text, html: parts.map(part => part.html).join(''), parts };
}
const atomicText = (text: string, html: string): RecordText => ({ text, html, parts: [{ text, html }] });
const joinText = (...parts: RecordText[]): RecordText => ({ text: parts.map(part => part.text).join(''),
    html: parts.map(part => part.html).join(''), parts: parts.flatMap(part => part.parts) });

function fieldEntry(field: CascadeField, branchKey: string): RecordEntry {
    const description = field.description?.trim(), note = noteHtml(field.detail ?? '');
    let label = recordText(field.name + (description || note ? ': ' + (description ?? '') : ''));
    if (note) { label = joinText(label, atomicText('(备注)', `<span style="display:inline-block;">(${note})</span>`)); }
    const children: RecordEntry[] = [];
    if (field.message) { children.push({ value: field.message }); }
    const total = field.children?.reduce((count, match) => count + match.rows.length, 0) ?? 0;
    let position = 0;
    for (const match of field.children ?? []) {
        if (match.message) { children.push({ value: match.message }); }
        if (!match.rows.length && !match.message) { children.push({ value: '未找到对应记录' }); }
        for (const row of match.rows) {
            const entries = rowEntries(row, cascadeMatchKey(branchKey, match.target));
            if (total > 1) { children.push({ value: `第 ${++position} 条(第 ${row.row} 行)`, children: entries }); }
            else { children.push(...entries); }
        }
    }
    const translations = field.translations ?? [];
    for (const translation of translations) {
        const text = translation.text ?? (translation.error ? `读取失败: ${translation.error}` : '未找到对应 KeyID');
        // 翻译整句置于同一文本流，冒号后只保留一个普通空格。
        children.push({ value: `中文: ${translations.length > 1 ? translation.key + ': ' : ''}${text || '(空)'}` });
    }
    return { label, value: field.value, children, branchKey, defaultExpanded: translations.length > 0 };
}
function rowEntries(row: CascadeRow, parent: string): RecordEntry[] {
    return [...(row.message ? [{ value: row.message }] : []),
        ...row.fields.map((field, index) => fieldEntry(field, cascadeFieldKey(parent, index, field.name)))];
}

/** 只生成扩展自己的命令链接；分支键由字段路径产生，不携带表格原文作为 HTML。 */
function branchControl(view: RelationView | undefined, key: string, expanded: boolean): string {
    const label = expanded ? '▼' : '▶';
    if (!view?.expansion) { return label; }
    const args = [view.uri, view.expansion.version, view.expansion.line, key, !expanded];
    const href = `command:${relationCommands.toggle}?${encodeURIComponent(JSON.stringify(args))}`;
    // 链接属性只转义，不能插入用于可见长文本折行的 wbr。
    return `<a href="${escapeHtml(href)}" title="${expanded ? '收起' : '展开'}此字段的关联内容，记住当前选择">${label}</a>`;
}

/** 以 em 保守估算可见文字宽度；列本身仍由表格对齐，不用空格模拟列。 */
function textWidth(text: string): number {
    return Array.from(text).reduce((width, character) => width + (
        /\p{Mark}|[\u200d\ufe0f]/u.test(character) ? 0 :
        /[\silI'.,:;!|]/.test(character) ? 0.35 :
        /[frt()[\]{}\/\\]/.test(character) ? 0.5 :
        /[mwMW@#%&]/.test(character) ? 1 :
        /[A-Z]/.test(character) ? 0.8 :
        /[a-z]/.test(character) ? 0.65 :
        /[0-9]/.test(character) ? 0.6 : 1.05), 0);
}

/** 显式拆成单行，避免浏览器把一个 td 折成多行后将相邻单元格垂直居中。 */
function textLines(content: RecordText): RecordText[] {
    const lines: RecordText[] = [];
    let line = recordText(''), width = 0;
    for (const part of content.parts) {
        const partWidth = textWidth(part.text);
        if (part.text === '\n' || (width + partWidth > 24 && line.parts.length)) {
            lines.push(line); line = recordText(''); width = 0;
        }
        if (part.text === '\n') { continue; }
        line = joinText(line, { ...part, parts: [part] }); width += partWidth;
    }
    lines.push(line);
    return lines;
}

interface RecordGroup { html: string; width: number; firstBaseline: number }
interface RecordRow { hasLabel: boolean; label?: RecordText; value?: RecordText; children?: RecordGroup; padding: number }

/** 每组只共享字段宽度；各父值的前缀与子树独立，箭头不会被其它字段的长值推远。 */
function recordGroup(entries: RecordEntry[], view: RelationView | undefined, fontSize: number, ending = ''): RecordGroup {
    const rows: RecordRow[] = [];
    let labelWidth = 0;
    for (const [index, entry] of entries.entries()) {
        const tail = index < entries.length - 1 ? ',' : ending;
        // 标签保持为完整局部块；长说明依靠横向滚动，不会被子树插入拆成两段。
        const labels = entry.label ? [{ ...entry.label, html: entry.label.html.replaceAll('\n', '<br>') }] : [];
        const values = textLines(recordText(entry.value || '(空)'));
        for (const label of labels) {
            for (const line of label.text.split('\n')) { labelWidth = Math.max(labelWidth, Math.ceil(textWidth(line) * fontSize + 8)); }
        }
        const last = values.length - 1;
        // 显式收起优先，保留普通关联默认收起、多语言默认展开及已有记忆。
        const expanded = !!entry.children?.length && (!entry.branchKey || (view?.expansion?.collapsed?.has(entry.branchKey)
            ? false : !!view?.expansion?.expanded.has(entry.branchKey) || !!entry.defaultExpanded));
        if (entry.children?.length) {
            const control = entry.branchKey ? branchControl(view, entry.branchKey, expanded) : '';
            const text = (control ? expanded ? '▼' : '▶' : '') + (expanded ? ': {' : '');
            const html = `<span style="display:inline-block;">${control}${expanded ? ':&nbsp;{' : ''}</span>`;
            values[last] = joinText(values[last], atomicText(text, html));
        }
        const children = expanded ? recordGroup(entry.children!, view, fontSize, '}' + tail) : undefined;
        if (!children) { values[last] = joinText(values[last], recordText(tail)); }
        for (let line = 0; line < Math.max(labels.length, values.length); line++) {
            const child = line === last ? children : undefined;
            // 原生 table 的首个文本单元格距表顶 3px；补齐子组首行层数，避免基线阶梯。
            rows.push({ hasLabel: !!entry.label, label: labels[line], value: values[line], children: child,
                padding: child ? Math.max(0, child.firstBaseline - 3) : 0 });
        }
    }
    const width = Math.max(1, ...rows.map(row => (row.hasLabel ? labelWidth : 0)
        + (row.value ? Math.ceil(textWidth(row.value.text) * fontSize + 8) : 0) + (row.children?.width ?? 0) + 12)) + 6;
    const floating = (content: RecordText | undefined, padding: number, fixedWidth?: number) => {
        const spacer = padding ? `<table height="${padding}" width="1"></table>` : '';
        return `<table align="left"${fixedWidth ? ` width="${fixedWidth}"` : ''}><tbody><tr><td>${spacer}${content?.html || '<br>'}</td></tr></tbody></table>`;
    };
    const html = '<table width="' + width + '"><tbody>' + rows.map(row => '<tr><td>'
        + (row.hasLabel ? floating(row.label, row.padding, labelWidth) : '')
        + (row.value ? floating(row.value, row.padding) : '') + (row.children?.html ?? '') + '</td></tr>').join('') + '</tbody></table>';
    return { html, width, firstBaseline: rows.length ? 6 + rows[0].padding : 0 };
}

/** 宽度下限保留局部列对齐，超出悬浮框时由原生横向滚动显示。 */
function recordBlock(entries: RecordEntry[], view: RelationView | undefined): string {
    const uri = view ? vscode.Uri.parse(view.uri) : undefined;
    const document = uri && vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
    const scope = uri ? { uri, languageId: document?.languageId ?? (uri.path.endsWith('.jsonc') ? 'jsonc' : 'json') } : undefined;
    const fontSize = vscode.workspace.getConfiguration('editor', scope).get<number>('fontSize') || 14;
    return recordGroup(entries, view, fontSize).html;
}

/** 头部只展示匹配关系；当前值查到的完整记录在来源和 Git 信息之后展开。 */
export function appendRecordResults(hover: vscode.MarkdownString, fields: string[], view?: RelationView) {
    const groups = new Map<string, RelationResult[]>();
    for (const result of view?.results ?? []) {
        if (result.column === 0 || !fields.includes(result.field)) { continue; }
        const key = JSON.stringify([fieldKey(result.column, result.field), targetKey(result.target)]);
        const group = groups.get(key) ?? [];
        group.push(result);
        groups.set(key, group);
    }
    if (!groups.size) { return; }
    hover.supportHtml = true;
    hover.appendMarkdown('\n\n---\n\n');
    hover.appendText('关联结果: ');
    if (view?.expansion) { trustHoverCommands(hover, relationCommands.toggle); }
    for (const group of groups.values()) {
        for (const result of group) {
            if (result.loading) {
                hover.appendText('\n\n正在读取关联记录…');
                continue;
            }
            if (result.error) { hover.appendText(`\n\n读取失败: ${result.error}`); }
            // 深层读取失败时仍保留已取得的原记录；旧的记录结构也可直接显示。
            const rows: CascadeRow[] = result.expandedRows?.length ? result.expandedRows : result.rows.map(row => ({
                id: row.id, row: row.row, fields: row.values.map(([name, value]) => ({ name, value }))
            }));
            if (!rows.length && !result.error) { hover.appendText('\n\n未找到对应记录'); }
            for (const row of rows) {
                // 同一键可能对应多条配置，保留 Excel 行号便于区分和核对。
                if (rows.length > 1) { hover.appendText(`\n\n(第 ${row.row} 行)`); }
                const root = cascadeRootKey(result.column, result.field, result.target);
                hover.appendMarkdown(`\n\n${recordBlock(rowEntries(row, root), view)}\n\n`);
            }
        }
    }
}

/** i18n 查询结果独立放在悬浮框末尾，不替代字段旁的匹配表状态。 */
export function appendTranslationResults(hover: vscode.MarkdownString, fields: string[], view?: RelationView) {
    if (!view) { return; }
    const translations = new Map<string, { field: string; keys: Set<string> }>();
    for (const cell of view.cells) {
        if (cell.column === 0 || !fields.includes(cell.field)) { continue; }
        const keys = cell.values.filter(value => value.startsWith('i18n_'));
        if (!keys.length) { continue; }
        const key = fieldKey(cell.column, cell.field);
        let group = translations.get(key);
        if (!group) { group = { field: cell.field, keys: new Set() }; translations.set(key, group); }
        keys.forEach(value => group.keys.add(value));
    }
    if (!translations.size) { return; }
    hover.appendMarkdown('\n\n---\n\n');
    const { state } = view;
    let first = true;
    for (const { field, keys } of translations.values()) {
        for (const key of keys) {
            if (!first) { hover.appendMarkdown('\n\n'); }
            first = false;
            const error = state.translationError ?? state.error;
            const text = state.translations.get(key) ?? (state.loading ? '正在读取…'
                : error ? `读取失败: ${error}` : '未找到对应 KeyID');
            hover.appendText(`${fields.length > 1 || translations.size > 1 ? field + ' ' : ''}中文: ${keys.size > 1 ? key + ' ' : ''}${text}`);
        }
    }
}
