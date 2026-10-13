import { parseTree, type ParseError } from 'jsonc-parser';

/** Maps source lines to the header fields owning values on those lines. */
export function collectFieldHints(text: string, jsonc = false): Map<number, string[]> {
    const errors: ParseError[] = [];
    const root = parseTree(text, errors, { allowTrailingComma: jsonc, disallowComments: !jsonc });
    const hints = new Map<number, string[]>();
    // Never guess column positions while the document is syntactically incomplete.
    if (errors.length || root?.type !== 'array') {
        return hints;
    }
    const [header, ...rows] = root.children ?? [];
    if (header?.type !== 'array' || !header.children?.length ||
        header.children.some(field => field.type !== 'string')) {
        return hints;
    }
    const fields = header.children.map(field => String(field.value));
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\n') {
            starts.push(i + 1);
        }
    }
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
            if (index >= fields.length) {
                break;
            }
            const field = fields[index];
            // Include nested arrays/objects and their delimiters in the owning column.
            const end = lineAt(value.offset + value.length - 1);
            for (let line = lineAt(value.offset); line <= end; line++) {
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
