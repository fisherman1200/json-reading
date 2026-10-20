import { fieldKey, type RelationDocument, type RelationRules, type RelationTarget, type TargetRule } from './relations';
import type { FieldDescription } from './tableIndex';

export interface SidebarEntry {
    id: string;
    kind: 'field' | 'target' | 'group' | 'message';
    label: string;
    description?: string;
    tooltip?: string;
    icon: string;
    color?: string;
    contextValue?: string;
    field?: string;
    keys?: string[];
    target?: RelationTarget;
    children?: SidebarEntry[];
}

const decisionLabel = { pending: '待确认', accepted: '已确认', rejected: '已排除' } as const;
const sourceKey = (target: RelationTarget) => JSON.stringify([target.file.replace(/\\/g, '/'), target.sheet]);

function ruleDescription(candidate: TargetRule): string {
    const parts = [`${decisionLabel[candidate.decision]}; 键: ${candidate.target.keyField || 'ID'}`];
    if (candidate.when) { parts.push(`条件: ${candidate.when.field} = ${candidate.when.values.map(String).join(' / ')}`); }
    else { parts.push('条件: 无条件'); }
    if (candidate.extract) {
        const extract = candidate.extract;
        if (extract.arrayIndex !== undefined) { parts.push(`数组位置: ${extract.arrayIndex}（从 0 开始）`); }
        if (extract.listSeparator !== undefined) { parts.push(`列表分隔符: ${JSON.stringify(extract.listSeparator)}`); }
        if (extract.separator !== undefined) { parts.push(`值分隔符: ${JSON.stringify(extract.separator)}，取第 ${extract.index} 项（从 0 开始）`); }
    }
    return parts.join('\n');
}

/** 一个目标页签可有多种查询键和条件；侧栏动作通过完整规则键集合操作。 */
function targetEntries(field: string, candidates: [string, TargetRule][], rejected: boolean): SidebarEntry[] {
    const groups = new Map<string, [string, TargetRule][]>();
    for (const entry of candidates) {
        const key = sourceKey(entry[1].target), group = groups.get(key) ?? [];
        group.push(entry);
        groups.set(key, group);
    }
    return [...groups].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([source, group]) => {
        group.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
        const first = group[0][1].target, file = first.file.replace(/\\/g, '/');
        const pending = group.filter(([, candidate]) => candidate.decision === 'pending').length;
        const accepted = group.filter(([, candidate]) => candidate.decision === 'accepted').length;
        const status = rejected ? 'rejected' : pending ? 'pending' : 'accepted';
        const description = rejected ? `已排除 ${group.length} 条规则`
            : [pending ? `待确认 ${pending} 条规则` : '', accepted ? `已确认 ${accepted} 条规则` : ''].filter(Boolean).join('，');
        return {
            id: `target:${JSON.stringify([field, status, source])}`,
            kind: 'target',
            label: `${file.slice(file.lastIndexOf('/') + 1)} / ${first.sheet}`,
            description,
            tooltip: `${file} / ${first.sheet}\n${description}\n\n${group.map(([, candidate], index) => `${index + 1}. ${ruleDescription(candidate)}`).join('\n\n')}`,
            icon: rejected ? 'circle-slash' : pending ? 'link' : 'check',
            contextValue: rejected ? 'jsonReadingTargetRejected' : pending ? 'jsonReadingTargetPending' : 'jsonReadingTargetAccepted',
            field,
            keys: group.map(([key]) => key),
            // 这里表示物理页签；每种查询键继续保留在 keys 对应的原规则中。
            target: { file, sheet: first.sheet, names: [...new Set(group.flatMap(([, candidate]) => candidate.target.names))].sort() }
        };
    });
}

/** 仅组织当前 JSON 的字段和持久规则，不依赖当前行的值是否命中目标记录。 */
export function buildRelationEntries(parsed: RelationDocument, rules: RelationRules, descriptions?: ReadonlyMap<string, FieldDescription>): SidebarEntry[] {
    const fields = new Map<string, { name: string; column: number }>();
    for (const cell of parsed.cells) {
        if (cell.column === 0) { continue; }
        fields.set(fieldKey(cell.column, cell.field), { name: cell.field, column: cell.column });
    }
    return [...fields].sort(([, a], [, b]) => a.column - b.column).map(([field, { name, column }]) => {
        const rulesForField = rules.fields[field], candidates = Object.entries(rulesForField?.targets ?? {});
        const active = targetEntries(field, candidates.filter(([, candidate]) => candidate.decision !== 'rejected'), false);
        const excluded = targetEntries(field, candidates.filter(([, candidate]) => candidate.decision === 'rejected'), true);
        const metadata = descriptions?.get(name);
        const brief = Array.from(metadata?.description.replace(/\s+/g, ' ').trim() ?? '');
        const summary = brief.length > 60 ? brief.slice(0, 60).join('') + '…' : brief.join('');
        const children: SidebarEntry[] = [...active];
        if (!active.length) {
            const label = excluded.length ? '暂无启用的关联'
                : rulesForField?.scanned ? '暂无关联，可点击加号选择目标 JSON' : '尚未添加关联，可点击加号选择目标 JSON';
            children.push({ id: `message:${field}`, kind: 'message', label, icon: 'info', field });
        }
        if (excluded.length) {
            children.push({
                id: `excluded:${field}`, kind: 'group', label: `已排除 (${excluded.length})`,
                description: '可恢复', icon: 'circle-slash', field, children: excluded
            });
        }
        return {
            id: `field:${field}`, kind: 'field', label: name,
            description: [summary, `关联 ${active.length}`, excluded.length ? `已排除 ${excluded.length}` : ''].filter(Boolean).join(' · '),
            tooltip: [`字段: ${name}`, `列: ${column + 1}`,
                metadata?.description ? `描述: ${metadata.description}` : '',
                metadata?.detail ? `备注: ${metadata.detail}` : '',
                `关联目标: ${active.length}`, `已排除目标: ${excluded.length}`].filter(Boolean).join('\n'),
            icon: 'symbol-field', contextValue: 'jsonReadingField', field, children
        };
    });
}
