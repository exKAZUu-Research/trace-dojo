import type {
  Arg,
  ClassDecl,
  ClassMemberSyntax,
  ClassRef,
  Expr,
  FunctionDecl,
  ParamDecl,
  PropertyHookSyntax,
  Stmt,
  TraitRule,
} from './ast';
import { formatFloat, formatFloatRepr } from './conversions';
import type { TypeDecl } from './values';

export class UnexportableSyntax extends Error {}

/** The priority and operand priorities of each binary operator, as PHP's `zend_ast_export` writes code. */
const BINARY: Record<string, [number, number, number]> = {
  '+': [200, 200, 201],
  '-': [200, 200, 201],
  '*': [210, 210, 211],
  '/': [210, 210, 211],
  '%': [210, 210, 211],
  '<<': [190, 190, 191],
  '>>': [190, 190, 191],
  '.': [185, 185, 186],
  '|': [140, 140, 141],
  '&': [160, 160, 161],
  '^': [150, 150, 151],
  '===': [170, 171, 171],
  '!==': [170, 171, 171],
  '==': [170, 171, 171],
  '!=': [170, 171, 171],
  '<': [180, 181, 181],
  '<=': [180, 181, 181],
  '>': [180, 181, 181],
  '>=': [180, 181, 181],
  '<=>': [180, 181, 181],
  '**': [250, 251, 250],
  xor: [40, 40, 41],
  '&&': [130, 130, 131],
  and: [130, 130, 131],
  '||': [120, 120, 121],
  or: [120, 120, 121],
  '??': [110, 111, 110],
};

type OperatorExpression = Extract<
  Expr,
  {
    k:
      | 'bin'
      | 'pipe'
      | 'throw'
      | 'print'
      | 'silence'
      | 'unary'
      | 'cond'
      | 'instanceof'
      | 'cast'
      | 'assign'
      | 'assignOp'
      | 'assignRef'
      | 'incdec';
  }
>;

/** Writes an expression back as PHP code, as the message of a failed `assert` shows it. */
// code-gauge-allow functionNcss 59 -- Keeps the ordered PHP cases together because each branch shares the same dispatch state.
export function exportExpr(e: Expr, priority = 0, depth = 0): string {
  const render = (expression: Expr, precedence = 0): string => exportExpr(expression, precedence, depth);
  const wrap = (own: number, text: string): string => (priority > own ? `(${text})` : text);
  switch (e.k) {
    case 'lit': {
      return exportLiteral(e.v);
    }
    case 'var': {
      return `$${e.name}`;
    }
    case 'varvar': {
      return `$${exportVariableName(e.name, depth)}`;
    }
    case 'interp': {
      return `"${e.parts.map((part, index) => exportEncapsedPart(part, e.parts[index + 1], depth)).join('')}"`;
    }
    case 'arrow': {
      const text = exportFunctionExpression(e, depth);
      return e.parenthesized ? `(${text})` : text;
    }
    case 'closure': {
      return wrap(240, exportFunctionExpression(e, depth));
    }
    case 'bin':
    case 'pipe':
    case 'throw':
    case 'print':
    case 'silence':
    case 'unary':
    case 'cond':
    case 'instanceof':
    case 'cast':
    case 'assign':
    case 'assignOp':
    case 'assignRef':
    case 'incdec': {
      return exportOperator(e, priority, depth);
    }
    case 'call':
    case 'mcall':
    case 'scall':
    case 'prop':
    case 'sprop': {
      return exportAccess(e, depth);
    }
    case 'idx': {
      return `${render(e.base, 260)}[${e.index ? render(e.index) : ''}]`;
    }
    case 'const': {
      return e.name.fallback ?? e.name.name;
    }
    case 'cconst': {
      return `${exportClass(e.cls, depth)}::${typeof e.name === 'string' ? e.name : exportConstantName(e.name, depth)}`;
    }
    case 'array':
    case 'list': {
      return exportArray(e, depth);
    }
    case 'new':
    case 'newAnon': {
      return exportNew(e, depth);
    }
    case 'isset': {
      return exportIsset(e.items, render, wrap);
    }
    case 'empty': {
      return `empty(${render(e.e)})`;
    }
    case 'clone': {
      return `\\clone(${render(e.e)})`;
    }
    case 'match': {
      return exportMatch(e, depth);
    }
    default: {
      throw new UnexportableSyntax();
    }
  }
}

function exportNew(expression: Extract<Expr, { k: 'new' | 'newAnon' }>, depth: number): string {
  const args = exportArgs(expression.args, depth);
  if (expression.k === 'new') return `new ${exportClass(expression.cls, depth)}(${args})`;
  const header = expression.args.length > 0 ? `class(${args})` : 'class';
  return `new ${exportClassDeclaration(expression.decl, header, depth)}`;
}

// code-gauge-allow functionCognitiveComplexity 21 -- Keeps the ordered PHP cases together because each branch shares the same dispatch state.
function exportAccess(e: Extract<Expr, { k: 'call' | 'mcall' | 'scall' | 'prop' | 'sprop' }>, depth: number): string {
  const render = (expression: Expr, precedence = 0): string => exportExpr(expression, precedence, depth);
  switch (e.k) {
    case 'call': {
      const name = 'k' in e.fn ? render(e.fn, 260) : e.fn.name;
      return `${name}(${e.fcc ? '...' : exportArgs(e.args, depth)})`;
    }
    case 'mcall': {
      return `${render(e.obj, 260)}${e.nullsafe ? '?->' : '->'}${typeof e.name === 'string' ? e.name : exportVariableName(e.name, depth)}(${e.fcc ? '...' : exportArgs(e.args, depth)})`;
    }
    case 'scall': {
      return `${exportClass(e.cls, depth)}::${typeof e.name === 'string' ? e.name : exportVariableName(e.name, depth)}(${e.fcc ? '...' : exportArgs(e.args, depth)})`;
    }
    case 'prop': {
      return `${render(e.obj, 260)}${e.nullsafe ? '?->' : '->'}${typeof e.name === 'string' ? e.name : exportVariableName(e.name, depth)}`;
    }
    case 'sprop': {
      return `${exportClass(e.cls, depth)}::$${typeof e.name === 'string' ? e.name : render(e.name)}`;
    }
  }
}

function exportOperator(e: OperatorExpression, priority: number, depth: number): string {
  const render = (expression: Expr, precedence = 0): string => exportExpr(expression, precedence, depth);
  const wrap = (own: number, text: string): string => (priority > own ? `(${text})` : text);
  switch (e.k) {
    case 'bin': {
      return exportBinary(e, render, wrap);
    }
    case 'pipe': {
      return wrap(183, `${render(e.l, 183)} |> ${render(e.r, 184)}`);
    }
    case 'throw': {
      return `throw ${render(e.e)}`;
    }
    case 'print': {
      return wrap(60, `print ${render(e.e, 61)}`);
    }
    case 'silence': {
      return wrap(240, `@${render(e.e, 241)}`);
    }
    case 'unary': {
      return wrap(240, `${e.op}${render(e.e, 241)}`);
    }
    case 'cond': {
      const middle = e.consequent ? ` ? ${render(e.consequent, 101)} : ` : ' ?: ';
      return wrap(100, `${render(e.test, 100)}${middle}${render(e.alternate, 101)}`);
    }
    case 'instanceof': {
      return `${render(e.e, 0)} instanceof ${exportClass(e.cls, depth)}`;
    }
    case 'cast': {
      return wrap(240, `(${e.type})${render(e.e, 241)}`);
    }
    case 'assign':
    case 'assignOp':
    case 'assignRef': {
      return wrap(90, exportAssignment(e, depth));
    }
    case 'incdec': {
      const op = e.inc ? '++' : '--';
      return wrap(240, e.prefix ? `${op}${render(e.target, 241)}` : `${render(e.target, 241)}${op}`);
    }
  }
}

function exportArray(e: Extract<Expr, { k: 'array' | 'list' }>, depth: number): string {
  const renderItem = (value: Expr, key: Expr | undefined, byRef: boolean): string => {
    const text = `${byRef ? '&' : ''}${exportExpr(value, 80, depth)}`;
    return key ? `${exportExpr(key, 80, depth)} => ${text}` : text;
  };
  const items =
    e.k === 'array'
      ? e.items.map(({ value, key, byRef, spread }) =>
          spread ? `...${exportExpr(value, 0, depth)}` : renderItem(value, key, byRef)
        )
      : e.items.map((item) => (item ? renderItem(item.target, item.key, item.byRef) : ''));
  return `[${items.join(', ')}]`;
}

const SIMPLE_IDENT = /^[A-Za-z_\u007F-\u00FF][A-Za-z_0-9\u007F-\u00FF]*$/;

function exportIsset(
  items: Expr[],
  render: (expression: Expr, precedence?: number) => string,
  wrap: (own: number, text: string) => string
): string {
  const text = items.map((item) => `isset(${render(item)})`).join(' && ');
  return items.length > 1 ? wrap(130, text) : text;
}

function exportBinary(
  e: Extract<Expr, { k: 'bin' }>,
  render: (expression: Expr, precedence?: number) => string,
  wrap: (own: number, text: string) => string
): string {
  const folded = e.op === '.' ? tryFoldConcat(e) : undefined;
  if (folded !== undefined) return exportLiteral(folded);
  const [own, left, right] = BINARY[e.op] ?? [200, 200, 201];
  const op = e.op === 'and' ? '&&' : e.op === 'or' ? '||' : e.op;
  return wrap(own, `${render(e.l, left)} ${op} ${render(e.r, right)}`);
}

function tryFoldConcat(expr: Expr): string | undefined {
  if (expr.k === 'lit') {
    if (typeof expr.v === 'string') return expr.v;
    if (typeof expr.v === 'bigint') return expr.v.toString();
    if (typeof expr.v === 'number') return formatFloat(expr.v);
    return undefined;
  }
  if (expr.k !== 'bin' || expr.op !== '.') return undefined;
  const left = tryFoldConcat(expr.l);
  const right = left === undefined ? undefined : tryFoldConcat(expr.r);
  return left !== undefined && right !== undefined ? left + right : undefined;
}

/** Exports a dynamic class-constant name as PHP's `zend_ast_export_name` does: a string raw, anything else unbraced. */
function exportConstantName(name: Expr, depth: number): string {
  return name.k === 'lit' && typeof name.v === 'string' ? name.v : exportExpr(name, 0, depth);
}

function exportVariableName(name: Expr, depth: number): string {
  if (name.k === 'var' || name.k === 'varvar') return exportExpr(name, 0, depth);
  if (name.k === 'lit' && typeof name.v === 'string') return SIMPLE_IDENT.test(name.v) ? name.v : `{${name.v}}`;
  return `{${exportExpr(name, 0, depth)}}`;
}

const DOUBLE_QUOTED_ESCAPES: Record<string, string> = {
  '\r': 'r',
  '\n': 'n',
  '\t': 't',
  '\v': 'v',
  '\f': 'f',
  '\u001B': 'e',
  '"': '"',
  '\\': '\\',
  $: '$',
};

function exportEncapsedPart(part: string | Expr, next: string | Expr | undefined, depth: number): string {
  if (typeof part === 'string') return exportDoubleQuoted(part);
  const text = exportExpr(part, 0, depth);
  const simpleVar =
    part.k === 'var' ||
    (part.k === 'varvar' && part.name.k === 'lit' && typeof part.name.v === 'string' && SIMPLE_IDENT.test(part.name.v));
  if (!simpleVar) return `{${text}}`;
  return typeof next === 'string' && needsInterpolationBraces(next) ? `{${text}}` : text;
}

function needsInterpolationBraces(next: string): boolean {
  const code = next.codePointAt(0);
  if (code === undefined) return false;
  return code >= 0x7f || /^[A-Za-z0-9_[]/.test(next);
}

function exportDoubleQuoted(value: string): string {
  let result = '';
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    const escaped = DOUBLE_QUOTED_ESCAPES[character];
    if (escaped !== undefined) {
      result += `\\${escaped}`;
    } else {
      const code = character.codePointAt(0) as number;
      result += code < 0x20 ? `\\${code.toString(8).padStart(3, '0')}` : character;
    }
  }
  return result;
}

function hasControlByte(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    if ((value.codePointAt(index) as number) < 0x20) return true;
  }
  return false;
}

function exportFunctionExpression(expression: Extract<Expr, { k: 'arrow' | 'closure' }>, depth: number): string {
  const { fn, isStatic } = expression;
  const prefix = isStatic ? 'static ' : '';
  const reference = fn.byRefReturn ? '&' : '';
  const params = exportParameters(fn, depth);
  const type = exportReturnType(fn);
  if (expression.k === 'arrow' && fn.arrowBody) {
    return `${prefix}fn${reference}(${params})${type} => ${exportExpr(fn.arrowBody, 0, depth)}`;
  }
  if (expression.k === 'arrow') throw new UnexportableSyntax();
  const captures = expression.uses.map(({ name, byRef }) => `${byRef ? '&' : ''}$${name}`).join(', ');
  return `${prefix}function ${reference}(${params})${captures ? ` use(${captures})` : ''}${type} ${exportBlock(fn.body, depth)}`;
}

function exportParameters(fn: FunctionDecl, depth: number): string {
  return fn.params.map((param) => exportParameter(param, depth)).join(', ');
}

function exportReturnType(fn: FunctionDecl): string {
  return fn.returnType ? `: ${exportType(fn.returnType)}` : '';
}

function exportType(type: TypeDecl): string {
  if (type.k === 'named') {
    const name = type.syntaxName ?? type.name;
    return type.nullable ? `?${name}` : name;
  }
  return type.types.map(exportType).join(type.k === 'union' ? '|' : '&');
}

function exportParameter(param: ParamDecl, depth: number): string {
  const type = param.type ? `${exportType(param.type)} ` : '';
  const reference = param.byRef ? '&' : '';
  const variadic = param.variadic ? '...' : '';
  const fallback = param.defaultExpr ? ` = ${exportExpr(param.defaultExpr, 0, depth)}` : '';
  const promote = param.promote;
  const modifiers = promote
    ? `${promote.visibility} ${promote.setVisibility ? `${promote.setVisibility}(set) ` : ''}${promote.isFinal ? 'final ' : ''}`
    : '';
  const hooks = promote?.hooks?.syntax;
  const suffix = hooks ? exportPropertyHooks(hooks, depth) : '';
  return `${modifiers}${type}${reference}${variadic}$${param.name}${fallback}${suffix}`;
}

function exportBlock(statements: Stmt[], depth: number): string {
  return `{\n${exportStatements(statements, depth + 1)}${indent(depth)}}`;
}

function indent(depth: number): string {
  return '    '.repeat(depth);
}

function exportStatements(statements: Stmt[], depth: number): string {
  let text = '';
  for (const statement of statements) {
    if (statement.k === 'block') text += exportStatements(statement.body, depth);
    else if (statement.k !== 'nop') text += `${indent(depth)}${exportStatement(statement, depth)}\n`;
  }
  return text;
}

// code-gauge-allow functionNcss 56 -- Keeps the ordered PHP cases together because each branch shares the same dispatch state.
// code-gauge-allow functionCognitiveComplexity 25 -- Keeps the ordered PHP cases together because each branch shares the same dispatch state.
function exportStatement(statement: Stmt, depth: number): string {
  const render = (expr: Expr): string => exportExpr(expr, 0, depth);
  const separate = (lines: string[]): string => lines.join(`\n${indent(depth)}`);
  switch (statement.k) {
    case 'return': {
      return statement.e ? `return ${render(statement.e)};` : 'return;';
    }
    case 'expr': {
      return `${render(statement.e)};`;
    }
    case 'echo': {
      return separate(statement.args.map((argument) => `echo ${render(argument)};`));
    }
    case 'inline': {
      return `echo ${exportLiteral(statement.text)};`;
    }
    case 'if': {
      return exportIf(statement, depth);
    }
    case 'while': {
      return `while (${render(statement.cond)}) ${exportBlock(statement.body, depth)}`;
    }
    case 'do': {
      return `do ${exportBlock(statement.body, depth)} while (${render(statement.cond)});`;
    }
    case 'for': {
      const init = exportExpressionList(statement.init, depth);
      const cond = statement.cond.length > 0 ? ` ${exportExpressionList(statement.cond, depth)}` : '';
      const update = statement.update.length > 0 ? ` ${exportExpressionList(statement.update, depth)}` : '';
      return `for (${init};${cond};${update}) ${exportBlock(statement.body, depth)}`;
    }
    case 'foreach': {
      const key = statement.key ? `${render(statement.key)} => ` : '';
      const value = `${statement.byRef ? '&' : ''}${render(statement.value)}`;
      return `foreach (${render(statement.subject)} as ${key}${value}) ${exportBlock(statement.body, depth)}`;
    }
    case 'switch': {
      return exportSwitch(statement, depth);
    }
    case 'try': {
      return exportTry(statement, depth);
    }
    case 'break':
    case 'continue': {
      return `${statement.k}${statement.explicitDepth || statement.depth !== 1 ? ` ${statement.depth}` : ''};`;
    }
    case 'goto': {
      return `goto ${statement.label};`;
    }
    case 'label': {
      return `${statement.name}:`;
    }
    case 'global': {
      return separate(statement.names.map((name) => `global ${render(name)};`));
    }
    case 'static': {
      return separate(statement.vars.map(({ name, init }) => `static $${name}${init ? ` = ${render(init)}` : ''};`));
    }
    case 'unset': {
      return separate(statement.targets.map((target) => `unset(${render(target)});`));
    }
    case 'func': {
      const { decl } = statement;
      const reference = decl.byRefReturn ? '&' : '';
      return `function ${reference}${decl.name}(${exportParameters(decl, depth)})${exportReturnType(decl)} ${exportBlock(decl.body, depth)}\n`;
    }
    case 'class': {
      const decl = statement.decl;
      const modifiers = `${decl.isAbstract ? 'abstract ' : ''}${decl.isFinal ? 'final ' : ''}${decl.isReadonly ? 'readonly ' : ''}`;
      return `${exportClassDeclaration(decl, `${modifiers}${decl.kind} ${decl.name}`, depth)}\n`;
    }
    case 'const': {
      return `const ${statement.items.map(({ name, value }) => `${name} = ${render(value)}`).join(', ')};`;
    }
    default: {
      throw new UnexportableSyntax();
    }
  }
}

function exportIf(statement: Extract<Stmt, { k: 'if' }>, depth: number): string {
  const name = statement.continuation ?? 'if';
  const branch = `${name} (${exportExpr(statement.cond, 0, depth)}) ${exportBlock(statement.consequent, depth)}`;
  if (!statement.alternate) return branch;
  const [nested] = statement.alternate;
  if (nested?.k === 'if' && nested.continuation) return `${branch} ${exportIf(nested, depth)}`;
  return `${branch} else ${exportBlock(statement.alternate, depth)}`;
}

function exportSwitch(statement: Extract<Stmt, { k: 'switch' }>, depth: number): string {
  const cases = statement.cases.map(({ test, body }) => {
    const label = test ? `case ${exportExpr(test, 0, depth + 1)}` : 'default';
    return `${indent(depth + 1)}${label}:\n${exportStatements(body, depth + 2)}`;
  });
  return `switch (${exportExpr(statement.subject, 0, depth)}) {\n${cases.join('')}${indent(depth)}}`;
}

function exportTry(statement: Extract<Stmt, { k: 'try' }>, depth: number): string {
  const clauses = statement.catches.map(({ types, varName, body }) => {
    const target = types.join('|') + (varName ? ` $${varName}` : '');
    return ` catch (${target}) ${exportBlock(body, depth)}`;
  });
  const cleanup = statement.fin ? ` finally ${exportBlock(statement.fin, depth)}` : '';
  return `try ${exportBlock(statement.body, depth)}${clauses.join('')}${cleanup}`;
}

function exportExpressionList(expressions: Expr[], depth: number): string {
  return expressions.map((expression) => exportExpr(expression, 0, depth)).join(', ');
}

function exportAssignment(e: Extract<Expr, { k: 'assign' | 'assignOp' | 'assignRef' }>, depth: number): string {
  const target = exportExpr(e.target, 91, depth);
  if (e.k === 'assignRef') return `${target} =& ${exportExpr(e.source, 90, depth)}`;
  const operator = e.k === 'assignOp' ? `${e.op}=` : '=';
  return `${target} ${operator} ${exportExpr(e.value, 90, depth)}`;
}

function exportMatch(e: Extract<Expr, { k: 'match' }>, depth: number): string {
  const arms = e.arms.map(({ conditions, body }) => {
    const label = conditions ? exportExpressionList(conditions, depth + 1) : 'default';
    return `${indent(depth + 1)}${label} => ${exportExpr(body)},\n`;
  });
  return `match (${exportExpr(e.subject, 0, depth)}) {\n${arms.join('')}${indent(depth)}}`;
}

function exportArgs(args: Arg[], depth: number): string {
  return args
    .map((arg) => `${arg.name ? `${arg.name}: ` : ''}${arg.spread ? '...' : ''}${exportExpr(arg.e, 0, depth)}`)
    .join(', ');
}

function exportClassDeclaration(decl: ClassDecl, header: string, depth: number): string {
  const parent = decl.parent ? ` extends ${decl.parent}` : '';
  const interfaces = decl.interfaces.length > 0 ? ` implements ${decl.interfaces.join(', ')}` : '';
  const members = decl.syntaxMembers;
  if (!members) throw new UnexportableSyntax();
  const body = members.map((member) => `${indent(depth + 1)}${exportClassMember(member, decl.kind, depth + 1)}\n`);
  return `${header}${parent}${interfaces} {\n${body.join('')}${indent(depth)}}`;
}

// code-gauge-allow functionCognitiveComplexity 16 -- Keeps the ordered PHP cases together because each branch shares the same dispatch state.
function exportClassMember(member: ClassMemberSyntax, kind: ClassDecl['kind'], depth: number): string {
  switch (member.k) {
    case 'const': {
      const { visibility, type } = member.items[0];
      const typeText = type ? `${exportType(type)} ` : '';
      const items = member.items.map(({ name, value }) => `${name} = ${exportExpr(value, 0, depth)}`);
      return `${visibility} const ${typeText}${items.join(', ')};`;
    }
    case 'property': {
      return exportPropertyDeclaration(member, depth);
    }
    case 'method': {
      const { fn, visibility, isStatic, isFinal, isAbstract } = member.method;
      const modifiers = `${visibility} ${isStatic ? 'static ' : ''}${isAbstract && kind !== 'interface' ? 'abstract ' : ''}${isFinal ? 'final ' : ''}`;
      const reference = fn.byRefReturn ? '&' : '';
      const body = member.method.syntaxHasBody ? ` ${exportBlock(fn.body, depth)}` : ';';
      return `${modifiers}function ${reference}${fn.name}(${exportParameters(fn, depth)})${exportReturnType(fn)}${body}\n`;
    }
    case 'use': {
      const header = `use ${member.trait.names.join(', ')}`;
      if (!member.hasBlock) return `${header};`;
      const rules = member.trait.rules.map((rule) => `${indent(depth + 1)}${exportTraitRule(rule)};\n`);
      return `${header} {\n${rules.join('')}${indent(depth)}}`;
    }
  }
}

function exportPropertyDeclaration(member: Extract<ClassMemberSyntax, { k: 'property' }>, depth: number): string {
  const { visibility, setVisibility, isStatic, type, hooks } = member.items[0];
  const setter = setVisibility ? `${setVisibility}(set) ` : '';
  const modifiers = `${visibility} ${setter}${isStatic ? 'static ' : ''}${member.explicitReadonly ? 'readonly ' : ''}`;
  const typeText = type ? `${exportType(type)} ` : '';
  const items = member.items.map(({ name, defaultExpr }) =>
    defaultExpr ? `$${name} = ${exportExpr(defaultExpr, 0, depth + 1)}` : `$${name}`
  );
  const suffix = hooks?.syntax ? exportPropertyHooks(hooks.syntax, depth) : ';';
  return `${modifiers}${typeText}${items.join(', ')}${suffix}`;
}

function exportPropertyHooks(hooks: PropertyHookSyntax[], depth: number): string {
  const lines = hooks.map(({ name, body, expression, isFinal, byRefReturn }) => {
    const prefix = `${indent(depth + 1)}${byRefReturn ? 'private(set) ' : ''}${isFinal ? 'final ' : ''}${name}`;
    if (expression) return `${prefix} => ${exportExpr(expression, 0, depth + 1)};\n`;
    return body ? `${prefix} ${exportBlock(body, depth + 1)}\n` : `${prefix};\n`;
  });
  return ` {\n${lines.join('')}${indent(depth)}}`;
}

function exportTraitRule(rule: TraitRule): string {
  const method = rule.trait ? `${rule.trait}::${rule.method}` : rule.method;
  if (rule.k === 'insteadof') return `${method} insteadof ${rule.instead.join(', ')}`;
  const modifier = rule.isFinal ? ' final' : rule.visibility ? ` ${rule.visibility}` : '';
  const alias = rule.alias ? ` ${rule.alias}` : '';
  return `${method} as${modifier}${alias}`;
}

function exportClass(cls: ClassRef, depth: number): string {
  switch (cls.k) {
    case 'named': {
      return cls.name;
    }
    case 'expr': {
      return exportExpr(cls.e, 260, depth);
    }
    default: {
      return cls.k;
    }
  }
}

function exportLiteral(value: null | boolean | bigint | number | string): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return formatFloatRepr(value, 'E', true);
  if (hasControlByte(value)) return `"${exportDoubleQuoted(value)}"`;
  return `'${value.replaceAll(/['\\]/g, String.raw`\$&`)}'`;
}
