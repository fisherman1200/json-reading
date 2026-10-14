/* 离线生成项目共享匹配表：只接受代码分析提出的明确关联，不按相同 ID 猜测。 */
const fs = require('node:fs');
const path = require('node:path');
const { targetKey, ruleKey, fieldKey } = require('../out/relations');
const { normalizeRules } = require('../out/relationStore');

const args = process.argv.slice(2);
const root = path.resolve(args[0] || 'D:/cn');
const inventoryFile = args[1] || '.vscode-test/client-config-inventory.json';
const output = args[2] || '.vscode-test/client-relations.generated.json';
const proposalFiles = args.slice(3);
if (!proposalFiles.length) { throw new Error('至少指定一份经过代码分析的关联提案。'); }
const inventory = JSON.parse(fs.readFileSync(inventoryFile, 'utf8'));
const canonical = name => name.replace(/\.json$/i, '').replace(/(?:Data|Type)$/i, '').toLowerCase();
const configs = new Map(inventory.configs.map(c => [canonical(c.name), c]));
const byName = new Map();
for (const target of inventory.catalogue) {
    for (const name of target.names) {
        const key = canonical(name), list = byName.get(key) || [];
        list.push(target); byName.set(key, list);
    }
}
const actualField = (names, wanted) => names.find(name => name === wanted) ??
    (names.filter(name => name.toLowerCase() === wanted.toLowerCase()).length === 1
        ? names.find(name => name.toLowerCase() === wanted.toLowerCase()) : undefined);
const result = { version: 1, files: {} };
let totalFields = 0, i18nFields = 0;
const unsupported = [];
for (const config of inventory.configs) {
    const key = `assets/resources/ClientConfig/${config.file}`;
    const fields = {};
    result.files[key] = { fields };
    if (!Array.isArray(config.header) || config.header.some(item => typeof item !== 'string')) { unsupported.push(config.file); continue; }
    const rows = JSON.parse(fs.readFileSync(path.join(root, key), 'utf8').replace(/^\uFEFF/, ''));
    for (let column = 1; column < config.header.length; column++) {
        fields[fieldKey(column, config.header[column])] = { scanned: true, targets: {} };
        totalFields++;
        if (rows.slice(1).some(row => Array.isArray(row) && /\bi18n_\w+/.test(JSON.stringify(row[column]) || ''))) { i18nFields++; }
    }
}
const omitted = [], seen = new Set();
for (const proposalFile of proposalFiles) {
    const raw = JSON.parse(fs.readFileSync(proposalFile, 'utf8'));
    const proposals = Array.isArray(raw) ? raw : raw.proposals;
    if (!Array.isArray(proposals)) { throw new Error(`提案格式不正确：${proposalFile}`); }
    for (const proposal of proposals) {
        const skip = reason => omitted.push({ source: proposal.source, field: proposal.field, target: proposal.target, reason });
        const source = configs.get(canonical(proposal.source));
        if (!source?.header) { skip('来源不是当前客户端表格 JSON'); continue; }
        const field = actualField(source.header, proposal.field);
        const column = source.header.indexOf(field);
        if (column < 1) { skip('字段不存在或为首列 ID'); continue; }
        const matches = byName.get(canonical(proposal.target)) || [];
        if (matches.length !== 1) { skip(matches.length ? '目标工作簿/页签不唯一' : '目标没有注册工作簿'); continue; }
        const match = matches[0];
        const keyField = actualField(Object.values(match.header), proposal.keyField || 'ID');
        if (!keyField) { skip('目标查询字段不存在'); continue; }
        if (canonical(source.name) === canonical(proposal.target) && field.toLowerCase() === keyField.toLowerCase()) {
            skip('同一表使用自身查询键回查，不构成关联'); continue;
        }
        const target = { file: match.file, sheet: match.sheet, names: match.names };
        if (keyField.toLowerCase() !== 'id') { target.keyField = keyField; }
        const rule = { target, decision: 'accepted' };
        if (proposal.when) {
            const conditionField = actualField(source.header, proposal.when.field);
            if (!conditionField || !Array.isArray(proposal.when.values) || !proposal.when.values.length) { skip('分流条件无法对应来源字段'); continue; }
            rule.when = { field: conditionField, values: proposal.when.values };
        }
        if (proposal.extract) { rule.extract = proposal.extract; }
        const sourcePath = `assets/resources/ClientConfig/${source.file}`;
        const fieldId = fieldKey(column, field);
        const key = ruleKey(target, rule.when, rule.extract);
        const identity = JSON.stringify([sourcePath, fieldId, key]);
        if (seen.has(identity)) { continue; }
        seen.add(identity);
        result.files[sourcePath].fields[fieldId].targets[key] = rule;
    }
}
// 已有逐项提取时，去掉同条件下只取数组某一项的重复建议，避免 Hover 重复展示。
for (const file of Object.values(result.files)) {
    for (const field of Object.values(file.fields)) {
        for (const [key, candidate] of Object.entries(field.targets)) {
            if (candidate.extract?.arrayIndex === undefined || candidate.extract.separator === undefined) { continue; }
            const { arrayIndex, ...extract } = candidate.extract;
            const broadKey = ruleKey(candidate.target, candidate.when, extract);
            if (field.targets[broadKey]) { delete field.targets[key]; }
        }
    }
}
// 旧数值碰撞产生的 pending 全部替换；已有用户明确确认/排除则保留，不需要来源标签。
const existingPath = path.join(root, 'extensions/json_reading/relations.json');
let preserved = 0;
if (fs.existsSync(existingPath)) {
    const existing = JSON.parse(fs.readFileSync(existingPath, 'utf8').replace(/^\uFEFF/, ''));
    if (existing?.version !== 1 || !existing.files || typeof existing.files !== 'object' || Array.isArray(existing.files)) {
        throw new Error('现有匹配表结构或版本无效，请先修复；不会覆盖工程文件。');
    }
    for (const [file, rules] of Object.entries(existing.files || {})) {
        if (!result.files[file]) { result.files[file] = rules; continue; }
        for (const [field, rule] of Object.entries(normalizeRules(rules).fields)) {
            if (!result.files[file].fields[field]) { continue; }
            const explicit = Object.values(rule.targets).filter(candidate => candidate.decision !== 'pending');
            const targets = result.files[file].fields[field].targets;
            for (const candidate of explicit) {
                // 旧的整字段确认/排除覆盖该目标的新条件建议，避免变换规则键后绕过用户决定。
                if (!candidate.when && !candidate.extract) {
                    for (const [key, generated] of Object.entries(targets)) {
                        if (targetKey(generated.target) === targetKey(candidate.target)) { delete targets[key]; }
                    }
                }
            }
            for (const candidate of explicit) {
                targets[ruleKey(candidate.target, candidate.when, candidate.extract)] = candidate;
                preserved++;
            }
        }
    }
}
let mappedFields = 0, rules = 0, conditions = 0, extractions = 0, targetKeys = 0, matchedJson = 0;
for (const [file, value] of Object.entries(result.files)) {
    const normalized = normalizeRules(value);
    result.files[file] = normalized;
    let count = 0;
    for (const rule of Object.values(normalized.fields)) {
        const targets = Object.values(rule.targets);
        if (targets.length) { mappedFields++; count++; }
        for (const target of targets) {
            rules++; if (target.when) { conditions++; } if (target.extract) { extractions++; } if (target.target.keyField) { targetKeys++; }
        }
    }
    if (count) { matchedJson++; }
}
function sorted(value) {
    if (Array.isArray(value)) { return value.map(sorted); }
    if (value && typeof value === 'object') { return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, value]) => [key, sorted(value)])); }
    return value;
}
fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
fs.writeFileSync(output, JSON.stringify(sorted(result), null, 2) + '\n');
const summary = { json: inventory.configs.length, tableJson: inventory.configs.length - unsupported.length, unsupported,
    totalFields, i18nFields, matchedJson, mappedFields, rules, conditions, extractions, targetKeys, preserved, omitted };
fs.writeFileSync(output + '.summary.json', JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ ...summary, omitted: omitted.length }, null, 2));
