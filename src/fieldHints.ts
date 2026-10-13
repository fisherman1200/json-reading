import { parseTree, type ParseError } from 'jsonc-parser';

/**
 * 将表格型 JSON 转换为“源码行号 → 字段名列表”，行号从 0 开始。
 * 外层数组的第一个数组是表头，后续记录按列索引匹配，不依赖缩进格式。
 * 此模块不依赖 VS Code，可直接用 Node.js 测试。
 * @param text 完整文档文本。
 * @param jsonc 是否允许注释和尾随逗号。
 */
export function collectFieldHints(text: string, jsonc = false): Map<number, string[]> {
    const errors: ParseError[] = [];
    // 使用语法树保留每个值的源码偏移量；JSON.parse 只有值，无法定位原文行号。
    const root = parseTree(text, errors, { allowTrailingComma: jsonc, disallowComments: !jsonc });
    const hints = new Map<number, string[]>();
    // 输入过程中语法可能暂时不完整，此时返回空映射，不使用容错解析结果猜测字段。
    if (errors.length || root?.type !== 'array') {
        return hints;
    }
    // 只识别首个元素为非空字符串数组的表格，普通对象或混合类型表头不处理。
    const [header, ...rows] = root.children ?? [];
    if (header?.type !== 'array' || !header.children?.length ||
        header.children.some(field => field.type !== 'string')) {
        return hints;
    }
    const fields = header.children.map(field => String(field.value));
    // 记录各行起点的 UTF-16 偏移，与解析器和 VS Code 的字符位置单位一致。
    // CRLF 中的 LF 同样标记下一行起点，所以 Windows 换行不会导致行号偏移。
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\n') {
            starts.push(i + 1);
        }
    }
    // 二分查找“不大于 offset 的最后一个行起点”，避免为每个值重复扫描全文。
    const lineAt = (offset: number) => {
        let low = 0;
        let high = starts.length;
        while (low + 1 < high) {
            const middle = (low + high) >>> 1;
            if (starts[middle] <= offset) {
                low = middle;
            } else {
                high = middle;
            }
        }
        return low;
    };
    for (const row of rows) {
        if (row.type !== 'array') {
            continue;
        }
        for (const [index, value] of (row.children ?? []).entries()) {
            // 超出表头的列没有可对应的名称；短记录则自然只处理已有值。
            if (index >= fields.length) {
                break;
            }
            const field = fields[index];
            // 嵌套值的整个源码范围都属于当前列，包括内部元素和起止括号。
            // offset + length 是右开边界，减 1 后才是该值最后一个字符的位置。
            const end = lineAt(value.offset + value.length - 1);
            for (let line = lineAt(value.offset); line <= end; line++) {
                // 紧凑 JSON 可能一行有多个字段或多条记录：保留字段顺序并去重。
                const names = hints.get(line) ?? [];
                if (!names.includes(field)) {
                    names.push(field);
                }
                hints.set(line, names);
            }
        }
    }
    return hints;
}
