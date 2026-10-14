import * as vscode from 'vscode';
import * as path from 'node:path';
import { relationCommands, type RelationView } from './relationController';
import { fieldKey, targetKey, valuesForRule, type RelationTarget } from './relations';

const link = (label: string, command: string, args: unknown[], title: string) =>
    `[${label}](command:${command}?${encodeURIComponent(JSON.stringify(args))} "${title}")`;

/** 多个模块共用同一个 MarkdownString，不覆盖其他模块已经允许的命令。 */
export function trustHoverCommands(hover: vscode.MarkdownString, ...commands: string[]) {
    const trusted = typeof hover.isTrusted === 'object' ? hover.isTrusted.enabledCommands : [];
    hover.isTrusted = { enabledCommands: [...new Set([...trusted ?? [], ...commands])] };
}

/** 关联结果紧随所属字段描述；一个页签只展示一次，点击可直接打开该工作簿。 */
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
        const values = fieldCells.flatMap(cell => cell.values);
        const translations = new Set(values.filter(value => value.startsWith('i18n_')));
        for (const value of translations) {
            const error = state.translationError ?? state.error;
            const text = state.translations.get(value) ?? (state.loading ? '正在读取…'
                : error ? `读取失败：${error}` : '未找到对应 KeyID');
            hover.appendText(`    中文：${translations.size > 1 ? value + ' ' : ''}${text}`);
        }

        // 纯翻译字段只显示中文查询结果，不把成功翻译描述成没有 XLSM 匹配。
        if (!translations.size || values.some(value => !value.startsWith('i18n_'))) {
            hover.appendText('    ');
            if (state.loading) {
                hover.appendText('正在读取关联…');
            } else if (state.error) {
                hover.appendText(`关联读取失败：${state.error}`);
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
                hover.appendText(matches.size ? '已匹配：' : '无匹配');
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
