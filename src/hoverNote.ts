/** 备注全文只放进原生悬停提示；实体编码保留换行并防止内容成为 HTML、Markdown 或图标。 */
export function noteHtml(detail: string): string {
    if (!detail.trim()) { return ''; }
    const title = detail.replace(/[&<>"'\r\n\t`*_[\]\\|~$]/g, character => `&#${character.codePointAt(0)};`);
    // Hover 仅允许有限的 span 样式；主题链接色与 u 标签均受支持。
    return `<span title="${title}" style="color:var(--vscode-textLink-foreground);"><u>备注</u></span>`;
}
