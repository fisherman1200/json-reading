import { createHash } from 'node:crypto';
import { targetKey, type RelationTarget } from './relations';
import type { CascadeRow } from './relationCascade';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validKey = (value: string) => /^[a-f0-9]{64}$/.test(value);

/** 路径只包含字段结构和目标表，不随记录 ID、Excel 行号或当前值变化。 */
export const cascadeRootKey = (column: number, field: string, target: RelationTarget): string =>
    digest(['root', column, field, targetKey(target)]);
export const cascadeFieldKey = (parent: string, index: number, name: string): string =>
    digest(['field', parent, index, name]);
export const cascadeMatchKey = (parent: string, target: RelationTarget): string =>
    digest(['match', parent, targetKey(target)]);

/** 同一结构的多条记录共用展开状态；目标表不同的子分支仍分别记忆。 */
export function cascadeBranchKeys(rows: CascadeRow[], root: string): Set<string> {
    const keys = new Set<string>();
    const visit = (records: CascadeRow[], parent: string) => {
        for (const row of records) {
            row.fields.forEach((field, index) => {
                const key = cascadeFieldKey(parent, index, field.name);
                if (field.message || field.translations?.length || field.children?.length) {
                    keys.add(key);
                }
                for (const match of field.children ?? []) {
                    visit(match.rows, cascadeMatchKey(key, match.target));
                }
            });
        }
    };
    visit(rows, root);
    return keys;
}

interface ExpansionMemento {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): PromiseLike<void>;
}

/** 仅写个人 workspaceState；展开操作串行保存，失败时保留原来的可见状态。 */
export class RelationExpansionState {
    private readonly states = new Map<string, Map<string, boolean>>();
    private writes: Promise<void> = Promise.resolve();

    constructor(private readonly memento: ExpansionMemento) {}

    private storageKey(uri: string) {
        const normalized = process.platform === 'win32' ? uri.toLowerCase() : uri;
        return `relations.expansion.v1.${digest(normalized)}`;
    }

    private read(storageKey: string): Map<string, boolean> {
        let state = this.states.get(storageKey);
        if (!state) {
            const stored = this.memento.get<unknown>(storageKey);
            state = new Map(stored && typeof stored === 'object' && !Array.isArray(stored)
                ? Object.entries(stored).filter((entry): entry is [string, boolean] => validKey(entry[0]) && typeof entry[1] === 'boolean')
                : []);
            this.states.set(storageKey, state);
        }
        return state;
    }

    get(uri: string): ReadonlySet<string> {
        // 返回副本，防止调用方在保存成功前修改缓存。
        return new Set([...this.read(this.storageKey(uri))].filter(([, expanded]) => expanded).map(([key]) => key));
    }

    /** 未设置与明确收起分别保留，让默认展开的 i18n 仍尊重手动选择。 */
    getCollapsed(uri: string): ReadonlySet<string> {
        return new Set([...this.read(this.storageKey(uri))].filter(([, expanded]) => !expanded).map(([key]) => key));
    }

    set(uri: string, key: string, expanded: boolean): Promise<void> {
        if (!validKey(key) || typeof expanded !== 'boolean') { return Promise.reject(new Error('关联展开状态参数无效。')); }
        const storageKey = this.storageKey(uri);
        const operation = this.writes.catch(() => {}).then(async () => {
            const next = new Map(this.read(storageKey));
            next.set(key, expanded);
            await this.memento.update(storageKey, Object.fromEntries(next));
            this.states.set(storageKey, next);
        });
        this.writes = operation;
        return operation;
    }
}
