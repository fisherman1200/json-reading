#!/usr/bin/env node
/*
 * 离线读取客户端 TypeScript，通过配置类型与实际查询参数生成关联建议。
 * 不修改被分析工程，不按数值碰撞或字段名猜测关联。建议文件供生成器审核后合并。
 * node scripts/analyze-client-relations.cjs <project> <inventory.json> <output.json>
 */
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const project = path.resolve(process.argv[2] || 'D:/cn');
const inventoryPath = path.resolve(process.argv[3] || '.vscode-test/client-config-inventory.json');
const output = path.resolve(process.argv[4] || '.vscode-test/code-relations-proposals.json');
const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
const configs = new Map(inventory.configs.filter(c => Array.isArray(c.header)).map(c => [c.name, c]));
const configNames = new Map([...configs.keys()].map(name => [name.toLowerCase(), name]));
const scriptsRoot = path.join(project, 'assets/scripts');
const sourceFiles = [];
function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (entry.isFile() && /\.tsx?$/.test(file)) sourceFiles.push(file);
    }
}
walk(scriptsRoot);
console.log(`Analyzing ${sourceFiles.length} TypeScript files…`);
const options = { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10, allowSyntheticDefaultImports: true,
    experimentalDecorators: true, strict: false, skipLibCheck: true, noEmit: true,
    types: [], baseUrl: project, paths: { 'db://assets/*': ['assets/*'] } };
const program = ts.createProgram(sourceFiles, options);
const checker = program.getTypeChecker();
const files = program.getSourceFiles().filter(f => f.fileName.replaceAll('\\', '/').startsWith(scriptsRoot.replaceAll('\\', '/')) && !f.isDeclarationFile);
const calls = [];
const functionNodes = [];
const assignments = new Map();
const proposals = new Map();
const unresolved = [];
const summaries = new Map();
const primaryKeys = new Map();
const aliases = new Map();
const comparisons = [];
// 本脚本服务当前客户端；下列已人工审查的谓词需要领域规则补充，不作无条件推断。
const reviewedExclusions = new Set([
    'EventConfig/eventTypeIcon/MinePlusGlobalConfig', // isTreasureEvent 隐藏了 eventType 条件。
    'EventConfig/rewardId/ItemConfig', // parseInt 不能表达此列复合奖励的完整语义。
    'ActivityRoundTaskRewardConfig/itemId/BoxConfig', // 有 isBox 判别，由人工规则补齐。
    'ActivitySubConfig/itemID/ResourceJumpConfig', // getOne 只是 good_id 查询失败后的回退。
    'ZonesConfig/Ticket/ResourceJumpConfig',
    'ItemConfig/quality/TreasureDispatchConfig', // 只适用于藏宝图 itemType，不适用全部道具。
]);
let queryCalls = 0;

function canonical(name) {
    if (!name) return;
    const base = name.replace(/(?:Data|Type)$/, '');
    return configNames.get(base.toLowerCase()) || configNames.get(name.toLowerCase());
}
function sym(node) { try { return checker.getSymbolAtLocation(node); } catch { return undefined; } }
function type(node) { try { return checker.getTypeAtLocation(node); } catch { return undefined; } }
function unique(items) { return [...new Map(items.map(i => [JSON.stringify(i), i])).values()]; }
function configTypes(t, depth = 0) {
    if (!t || depth > 3) return [];
    const own = canonical(t.aliasSymbol?.name) || canonical(t.symbol?.name);
    if (own) return [own];
    return unique((t.types || []).flatMap(x => configTypes(x, depth + 1)));
}
function enclosingFunction(node) {
    for (let p = node.parent; p; p = p.parent) if (ts.isFunctionLike(p)) return p;
}
function ownerFunction(node, origin) {
    for (let p = node.parent; p; p = p.parent) if (ts.isFunctionLike(p) && p.pos === origin.owner) return p;
}
function declarationConfig(node) {
    for (let p = node; p && !ts.isSourceFile(p); p = p.parent) {
        if ((ts.isTypeAliasDeclaration(p) || ts.isInterfaceDeclaration(p)) && p.name) return canonical(p.name.text);
    }
}
function reference(node) {
    const sf = node.getSourceFile();
    return { file: path.relative(project, sf.fileName).replaceAll('\\', '/'), line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, code: node.getText().slice(0, 500) };
}
function literal(node) {
    if (!node) return;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) return -Number(node.operand.text);
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return checker.getConstantValue(node);
    if (ts.isIdentifier(node)) {
        const d = sym(node)?.valueDeclaration;
        if (d && ts.isVariableDeclaration(d) && (d.parent.flags & ts.NodeFlags.Const) && d.initializer && d.initializer !== node && (ts.isStringLiteralLike(d.initializer) || ts.isNumericLiteral(d.initializer))) return literal(d.initializer);
    }
}
function rowFields(node, field) {
    const names = configTypes(type(node));
    return names.filter(name => configs.get(name)?.header?.includes(field)).map(source => ({ source, field, ...rowCondition(node, source) }));
}
function rowCondition(node, source, depth = 0) {
    if (!node || depth > 5) return {};
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) return rowCondition(node.expression, source, depth + 1);
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
        const declaration = sym(ts.isPropertyAccessExpression(node) ? node.name : node)?.valueDeclaration;
        if (declaration?.initializer) return rowCondition(declaration.initializer, source, depth + 1);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'getOne' && targetConfig(node.expression.expression) === source) {
        const value = literal(node.arguments[0]);
        if (value !== undefined) return { when: { field: primaryKeys.get(source) || configs.get(source)?.header[0] || 'ID', values: [value] } };
    }
    return {};
}
function paramOrigin(declaration) {
    const fn = declaration.parent;
    if (!ts.isFunctionLike(fn)) return [];
    return [{ parameter: fn.parameters.indexOf(declaration), owner: fn.pos }];
}

// 仅追踪无算术变换的字段传递；字符串拆分必须明确分隔符和索引。
function origins(node, seen = new Set(), depth = 0) {
    if (!node || depth > 18 || seen.has(node)) return [];
    seen = new Set(seen); seen.add(node);
    const recurse = value => origins(value, seen, depth + 1);
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node)) return recurse(node.expression);
    if (ts.isPrefixUnaryExpression(node)) return node.operator === ts.SyntaxKind.PlusToken ? recurse(node.operand) : [];
    if (ts.isPropertyAccessExpression(node)) {
        const field = node.name.text;
        const direct = rowFields(node.expression, field);
        const property = sym(node.name);
        for (const declaration of direct.length ? [] : property?.declarations || []) {
            const source = declarationConfig(declaration);
            if (source && configs.get(source)?.header?.includes(field)) direct.push({ source, field });
        }
        if (direct.length) return unique(direct);
        const declared = property?.valueDeclaration;
        const writes = assignments.get(property);
        if (declared?.initializer) return writes?.length ? [] : recurse(declared.initializer);
        if (writes?.length === 1) return recurse(writes[0]);
        return [];
    }
    if (ts.isElementAccessExpression(node)) {
        const text = literal(node.argumentExpression);
        if (typeof text === 'string') {
            const fields = rowFields(node.expression, text);
            if (fields.length) return fields;
        }
        const base = recurse(node.expression);
        return base.flatMap(origin => {
            if (origin.split !== undefined) {
                if (!Number.isInteger(text) || text < 0) return [];
                const { split, ...rest } = origin;
                return [{ ...rest, extract: { ...rest.extract, separator: split, index: text } }];
            }
            if (Number.isInteger(text) && text >= 0) {
                if (origin.extract?.arrayIndex !== undefined) return [];
                return [{ ...origin, extract: { ...origin.extract, arrayIndex: text } }];
            }
            return [origin];
        });
    }
    if (ts.isIdentifier(node)) {
        const symbol = sym(node);
        const declaration = symbol?.valueDeclaration;
        if (!declaration) return [];
        if (ts.isParameter(declaration)) {
            const fn = declaration.parent;
            if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isCallExpression(fn.parent) && ts.isPropertyAccessExpression(fn.parent.expression)) {
                const call = fn.parent;
                if (['forEach', 'map', 'filter', 'find', 'some', 'every'].includes(call.expression.name.text) && fn.parameters[0] === declaration) {
                    return recurse(call.expression.expression);
                }
            }
            return assignments.get(symbol)?.length ? [] : paramOrigin(declaration);
        }
        if (ts.isBindingElement(declaration)) {
            const binding = declaration.parent;
            const holder = binding.parent;
            const field = declaration.propertyName?.getText() || declaration.name.getText();
            if (holder.initializer && ts.isObjectBindingPattern(binding)) {
                const direct = rowFields(holder.initializer, field);
                if (direct.length) return direct;
            }
            if (holder.initializer && ts.isArrayBindingPattern(binding)) {
                const ix = binding.elements.indexOf(declaration);
                return recurse(holder.initializer).flatMap(origin => {
                    if (origin.split === undefined) return origin.extract?.arrayIndex === undefined ? [{ ...origin, extract: { ...origin.extract, arrayIndex: ix } }] : [];
                    const { split, ...rest } = origin;
                    return [{ ...rest, extract: { ...rest.extract, separator: split, index: ix } }];
                });
            }
        }
        if (ts.isVariableDeclaration(declaration)) {
            if (declaration.initializer) return assignments.get(symbol)?.length ? [] : recurse(declaration.initializer);
            const list = declaration.parent;
            if (ts.isVariableDeclarationList(list) && ts.isForOfStatement(list.parent)) return recurse(list.parent.expression);
        }
        if (declaration.initializer) return recurse(declaration.initializer);
        const writes = assignments.get(symbol);
        if (writes?.length === 1) return recurse(writes[0]);
        return [];
    }
    if (ts.isCallExpression(node)) {
        if (ts.isIdentifier(node.expression) && ['Number', 'String', 'parseInt', 'parseFloat'].includes(node.expression.text)) return recurse(node.arguments[0]);
        if (ts.isPropertyAccessExpression(node.expression)) {
            const method = node.expression.name.text;
            if (method === 'split') {
                const separator = literal(node.arguments[0]);
                if (typeof separator !== 'string' || !separator) return [];
                return recurse(node.expression.expression).filter(o => !o.extract?.separator && o.split === undefined).map(o => ({ ...o, split: separator }));
            }
            if (['trim', 'toString'].includes(method)) return recurse(node.expression.expression);
            if (method === 'getField') {
                const source = targetConfig(node.expression.expression);
                const field = literal(node.arguments[1]);
                if (source && typeof field === 'string' && configs.get(source)?.header?.includes(field)) {
                    const value = literal(node.arguments[0]);
                    return [{ source, field, ...(value === undefined ? {} : { when: { field: primaryKeys.get(source) || configs.get(source)?.header[0] || 'ID', values: [value] } }) }];
                }
            }
        }
        return [];
    }
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) return recurse(node.left);
    if (ts.isConditionalExpression(node)) return unique([...recurse(node.whenTrue), ...recurse(node.whenFalse)]);
    return [];
}

function targetConfig(node) {
    const name = ts.isPropertyAccessExpression(node) ? node.name.text : ts.isIdentifier(node) ? node.text : undefined;
    const direct = aliases.get(name) || canonical(name);
    if (direct) return direct;
    const t = type(node);
    const args = [...(t?.typeArguments || []), ...(t?.aliasTypeArguments || [])];
    const names = unique(args.flatMap(a => configTypes(a)));
    if (names.length === 1) return names[0];
    const inferred = canonical(t?.symbol?.name);
    return inferred;
}

// 这些方法的实现均以传入 ID 索引 _cfgs，不把 getByType 等非主键查询混入。
const itemMethods = new Set(['getItemInfo', 'isItem', 'getItemType', 'getItemDetailType', 'getItemQuality', 'getItemName']);
function directSink(call) {
    if (!ts.isPropertyAccessExpression(call.expression) || !call.arguments.length) return;
    const method = call.expression.name.text;
    if (!['getOne', 'getField', ...itemMethods].includes(method)) return;
    const target = targetConfig(call.expression.expression);
    if (!target || (itemMethods.has(method) && target !== 'ItemConfig')) return;
    return { target, argument: 0 };
}
function fnDeclaration(call) {
    try { return checker.getResolvedSignature(call)?.declaration; } catch { return; }
}
function unsafeWrapperBranch(node, fn) {
    // 参数分流尚未投影到调用点时，不能把多个分支展开成无条件关联。
    for (let child = node, p = node.parent; p && p !== fn; child = p, p = p.parent) {
        const test = ts.isIfStatement(p) ? p.expression : ts.isSwitchStatement(p) ? p.expression : undefined;
        if (!test) continue;
        let usesParam = false;
        const visit = n => {
            if (ts.isIdentifier(n)) {
                const d = sym(n)?.valueDeclaration;
                if (d && ts.isParameter(d) && d.parent === fn) usesParam = true;
            }
            ts.forEachChild(n, visit);
        };
        // `if (!id) return` 之类早退没有包裹查询，因而不会误挡正常包装函数。
        if (ts.isBinaryExpression(test) || ts.isSwitchStatement(p)) visit(test);
        if (usesParam) return true;
    }
    return false;
}
function conditions(node, source) {
    const result = [];
    function conditionOrigins(expression) {
        const found = [];
        const visit = n => {
            if (ts.isPropertyAccessExpression(n) || ts.isIdentifier(n)) found.push(...origins(n).filter(o => o.source === source));
            ts.forEachChild(n, visit);
        };
        visit(expression);
        return found;
    }
    for (let child = node, parent = node.parent; parent && !ts.isFunctionLike(parent); child = parent, parent = parent.parent) {
        if (ts.isIfStatement(parent) && conditionOrigins(parent.expression).length) {
            const supported = ts.isBinaryExpression(parent.expression) && [ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken].includes(parent.expression.operatorToken.kind);
            if (child === parent.elseStatement || !supported) return undefined;
        }
        if (ts.isIfStatement(parent) && child === parent.thenStatement && ts.isBinaryExpression(parent.expression)) {
            const binary = parent.expression;
            if (![ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken].includes(binary.operatorToken.kind)) continue;
            let value = literal(binary.right), candidates = origins(binary.left);
            if (value === undefined) { value = literal(binary.left); candidates = origins(binary.right); }
            if (value === undefined) continue;
            for (const origin of candidates) if (origin.source === source && !origin.extract) result.push({ field: origin.field, values: [value] });
        }
        if (ts.isCaseClause(parent) && ts.isCaseBlock(parent.parent) && ts.isSwitchStatement(parent.parent.parent)) {
            const value = literal(parent.expression);
            if (value === undefined) continue;
            for (const origin of origins(parent.parent.parent.expression)) if (origin.source === source && !origin.extract) result.push({ field: origin.field, values: [value] });
        }
        if (ts.isDefaultClause(parent) && ts.isCaseBlock(parent.parent) && ts.isSwitchStatement(parent.parent.parent) && conditionOrigins(parent.parent.parent.expression).length) return undefined;
    }
    // 当前 schema 只表达单个判别字段；多条件不能擅自放宽。
    return unique(result);
}
function add(origin, target, node, extra = {}) {
    if (!origin.source || origin.split !== undefined) return;
    const config = configs.get(origin.source);
    if (!config || config.header.indexOf(origin.field) < 1) return;
    if (reviewedExclusions.has(`${origin.source}/${origin.field}/${target}`)) return;
    const contextualGuards = conditions(node, origin.source);
    if (!contextualGuards) return;
    const guards = unique([...(origin.when ? [origin.when] : []), ...contextualGuards]);
    if (/Global|Constant/i.test(origin.source) && !guards.some(g => g.field === config.header[0])) return;
    if (guards.length > 1) return;
    const proposal = { source: origin.source, field: origin.field, target, ...extra };
    if (!proposal.keyField && primaryKeys.has(target)) proposal.keyField = primaryKeys.get(target);
    if (origin.extract) proposal.extract = origin.extract;
    if (guards.length) proposal.when = guards[0];
    const key = JSON.stringify(proposal);
    if (!proposals.has(key)) proposals.set(key, { ...proposal, references: [] });
    const refs = proposals.get(key).references;
    if (refs.length < 4) refs.push(reference(node));
}

for (const sf of files) {
    const visit = node => {
        if (ts.isCallExpression(node)) calls.push(node);
        if (ts.isBinaryExpression(node) && [ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken].includes(node.operatorToken.kind)) comparisons.push(node);
        if (ts.isPropertyAssignment(node) && ts.isArrayLiteralExpression(node.initializer)) {
            const elements = node.initializer.elements;
            if (elements.length >= 2 && ts.isStringLiteralLike(elements[1])) {
                const target = canonical(elements[1].text);
                if (target && /^(ConfigData|ConfigArrayData)(<|$)/.test(elements[0].getText())) {
                    aliases.set(node.name.getText().replace(/['"]/g, ''), target);
                    if (elements[2] && ts.isStringLiteralLike(elements[2]) && configs.get(target)?.header.includes(elements[2].text)) primaryKeys.set(target, elements[2].text);
                }
            }
        }
        if (ts.isFunctionLike(node) && node.body) functionNodes.push(node);
        if (ts.isClassDeclaration(node) && ts.canHaveDecorators(node)) {
            for (const decorator of ts.getDecorators(node) || []) {
                const expression = decorator.expression;
                if (!ts.isCallExpression(expression) || expression.expression.getText() !== 'extendsConfigDelegate') continue;
                const args = expression.arguments;
                if (args.length < 3 || !/^(ConfigData|ConfigArrayData)(<|$)/.test(args[1].getText()) || !ts.isStringLiteralLike(args[2])) continue;
                for (const member of node.members) {
                    const target = canonical(member.name?.getText());
                    if (target && configs.get(target)?.header.includes(args[2].text)) primaryKeys.set(target, args[2].text);
                }
            }
        }
        if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
            const symbol = sym(ts.isPropertyAccessExpression(node.left) ? node.left.name : node.left);
            if (symbol) { if (!assignments.has(symbol)) assignments.set(symbol, []); assignments.get(symbol).push(node.operatorToken.kind === ts.SyntaxKind.EqualsToken ? node.right : undefined); }
        }
        if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) {
            const symbol = sym(ts.isPropertyAccessExpression(node.operand) ? node.operand.name : node.operand);
            if (symbol) { if (!assignments.has(symbol)) assignments.set(symbol, []); assignments.get(symbol).push(undefined); }
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
}
console.log(`Loaded ${files.length} sources, ${calls.length} calls. Collecting direct references…`);

for (const call of calls) {
    const sink = directSink(call);
    if (!sink) continue;
    queryCalls++;
    const input = origins(call.arguments[sink.argument]);
    for (const origin of input) {
        if (origin.source) add(origin, sink.target, call);
        else if (origin.parameter !== undefined && origin.split === undefined) {
            const fn = ownerFunction(call, origin);
            if (!fn || fn.pos !== origin.owner || unsafeWrapperBranch(call, fn)) continue;
            if (!summaries.has(fn)) summaries.set(fn, []);
            summaries.get(fn).push({ parameter: origin.parameter, target: sink.target, extract: origin.extract });
        }
    }
    if (!input.some(i => i.source || i.parameter !== undefined)) unresolved.push({ target: sink.target, ...reference(call) });
}

// 包装函数逐层传播：数值参数进入确定的配置查询，调用点有确定配置字段类型。
let wrapperHits = 0;
for (let pass = 0; pass < 3; pass++) {
    let added = 0;
    for (const call of calls) {
        const definition = fnDeclaration(call);
        const sinks = summaries.get(definition);
        if (!sinks?.length) continue;
        for (const sink of [...sinks]) {
            if (!call.arguments[sink.parameter]) continue;
            for (const origin of origins(call.arguments[sink.parameter])) {
                if (origin.split !== undefined || (origin.extract && sink.extract)) continue;
                const transformed = { ...origin, ...(sink.extract ? { extract: sink.extract } : {}) };
                if (origin.source) {
                    const before = proposals.size; add(transformed, sink.target, call); if (proposals.size !== before) wrapperHits++;
                } else if (origin.parameter !== undefined) {
                    const fn = ownerFunction(call, origin);
                    if (!fn || fn.pos !== origin.owner || fn === definition || unsafeWrapperBranch(call, fn)) continue;
                    const next = { parameter: origin.parameter, target: sink.target, extract: transformed.extract };
                    const existing = summaries.get(fn) || [];
                    if (!existing.some(s => JSON.stringify(s) === JSON.stringify(next))) { existing.push(next); summaries.set(fn, existing); added++; }
                }
            }
        }
    }
    console.log(`Wrapper pass ${pass + 1}: ${added} new summaries, ${proposals.size} relation proposals.`);
    if (!added) break;
}

// 数组 find/filter 的显式比较支持非主键：目标行.Key === 来源行.Field。
function fullCollection(node, target, depth = 0) {
    if (!node || depth > 5) return false;
    if (ts.isIdentifier(node)) {
        const symbol = sym(node), declaration = symbol?.valueDeclaration;
        return !assignments.get(symbol)?.length && declaration?.initializer ? fullCollection(declaration.initializer, target, depth + 1) : false;
    }
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
    if (['getArray', 'getAll'].includes(node.expression.name.text)) return targetConfig(node.expression.expression) === target;
    if (node.expression.getText() === 'Object.values') return fullCollection(node.arguments[0], target, depth + 1);
    return false;
}
for (const comparison of comparisons) {
    const callback = enclosingFunction(comparison);
    if (!callback || !ts.isCallExpression(callback.parent) || !ts.isPropertyAccessExpression(callback.parent.expression)) continue;
    if (!['find', 'filter', 'some'].includes(callback.parent.expression.name.text)) continue;
    const predicate = ts.isBlock(callback.body) && callback.body.statements.length === 1 && ts.isReturnStatement(callback.body.statements[0]) ? callback.body.statements[0].expression : callback.body;
    if (predicate !== comparison) continue; // 多列 AND/OR 查询不能简化成单列关系。
    const parameter = callback.parameters[0];
    if (!parameter) continue;
    for (const [targetNode, sourceNode] of [[comparison.left, comparison.right], [comparison.right, comparison.left]]) {
        if (!ts.isPropertyAccessExpression(targetNode) || sym(targetNode.expression)?.valueDeclaration !== parameter) continue;
        const targets = rowFields(targetNode.expression, targetNode.name.text);
        for (const target of targets) for (const origin of origins(sourceNode)) {
            if (!fullCollection(callback.parent.expression.expression, target.source)) continue;
            if (origin.source === target.source && origin.field === target.field) continue;
            add(origin, target.source, comparison, { keyField: target.field });
        }
    }
}

const sorted = [...proposals.values()].sort((a, b) => a.source.localeCompare(b.source) || a.field.localeCompare(b.field) || a.target.localeCompare(b.target));
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(sorted, null, 2) + '\n');
const stats = { files: files.length, calls: calls.length, queryCalls, wrapperSummaries: summaries.size, wrapperHits, proposals: sorted.length,
    sources: new Set(sorted.map(p => p.source)).size, fields: new Set(sorted.map(p => p.source + '/' + p.field)).size,
    targetConfigs: new Set(sorted.map(p => p.target)).size, withExtraction: sorted.filter(p => p.extract).length,
    withCondition: sorted.filter(p => p.when).length, unresolvedCalls: unresolved.length };
fs.writeFileSync(output.replace(/\.json$/i, '.audit.json'), JSON.stringify({ stats, unresolved }, null, 2) + '\n');
console.log(JSON.stringify(stats, null, 2));
