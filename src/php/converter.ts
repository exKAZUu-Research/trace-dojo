// code-gauge-allow-file fileNcss 1200 -- One converter of every grammar node kind, which share the namespace and scope state.
// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
// oxlint-disable unicorn/prefer-code-point -- PHP strings hold bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import type { Node } from '@willbooster/web-tree-sitter';

import { CompileError } from '../interpreter/diagnostics';
import type {
  Arg,
  ArrayItem,
  CatchClause,
  ClassDecl,
  ClassRef,
  Expr,
  FunctionDecl,
  ListItem,
  MatchArm,
  MethodDeclAst,
  ParamDecl,
  Program,
  PropertyDeclAst,
  ResolvedName,
  Stmt,
  SwitchCase,
  TraitRule,
} from './ast';
import { codePointBytes, enc, lower } from './bytes';
import { exportExpr } from './export';
import { unsupportedMessage } from './unsupported';
import type { TypeDecl, Visibility } from './values';

/** A notice PHP prints when it compiles the program, before running it. */
export interface CompileNotice {
  level: 'Deprecated' | 'Warning';
  message: string;
  row: number;
}

const SUPERGLOBALS = new Set(['_GET', '_POST', '_SERVER', '_ENV', '_COOKIE', '_FILES', '_REQUEST', '_SESSION']);
const BUILTIN_TYPES = new Set([
  'int',
  'float',
  'string',
  'bool',
  'array',
  'callable',
  'iterable',
  'object',
  'mixed',
  'void',
  'null',
  'never',
  'false',
  'true',
]);
const MAGIC_RUNTIME = new Set(['__CLASS__', '__FUNCTION__', '__METHOD__', '__TRAIT__']);

interface LoopContext {
  /** The number of loops and switches enclosing the current statement in its function. */
  depth: number;
}

interface FunctionContext {
  returnType?: TypeDecl;
  isGenerator: boolean;
  labels: Set<string>;
  gotos: { label: string; row: number }[];
  className?: string;
  isMethod: boolean;
}

export class Converter {
  readonly claimedAtomicRows = new Set<number>();
  readonly notices: CompileNotice[] = [];
  private namespace = '';
  private classImports = new Map<string, string>();
  private functionImports = new Map<string, string>();
  private constImports = new Map<string, string>();
  private loop: LoopContext = { depth: 0 };
  private fn: FunctionContext = { isGenerator: false, labels: new Set(), gotos: [], isMethod: false };
  private strictTypes = false;
  private declaredFunctions = new Map<string, number>();
  private anonymousClasses = 0;
  private currentClass?: string;
  /** Whether the statement to convert follows `<?=`, which echoes it. */
  private pendingEcho = false;

  constructor(
    private readonly source: string,
    private readonly atomicRows: ReadonlySet<number>
  ) {}

  convertProgram(root: Node): Program {
    const body: Stmt[] = [];
    let index = 0;
    const children = root.children;
    // Text before the first `<?php` tag is output as is.
    while (index < children.length && children[index].type !== 'php_tag') {
      const child = children[index];
      if (child.type === 'text') body.push({ k: 'inline', text: enc(child.text), row: child.startPosition.row });
      index++;
    }
    let echoTag = false;
    if (index < children.length && children[index].type === 'php_tag') {
      echoTag = children[index].text === '<?=';
      index++;
    }
    const statements = children.slice(index).filter((child) => child.isNamed && child.type !== 'comment');
    let first = true;
    for (const child of statements) {
      if (child.type === 'php_end_tag') continue;
      if (first && echoTag) body.push(...this.echoTagStatement(child));
      else body.push(...this.statement(child, true));
      first = false;
    }
    this.checkGotos(this.fn, body);
    validateReads(body);
    return {
      body,
      strictTypes: this.strictTypes,
      hasGoto: this.fn.gotos.length > 0,
      mainVars: [...collectMainVars(body)],
    };
  }

  // Errors ------------------------------------------------------------------------------------------------------------

  private error(node: Node | number, message: string): never {
    throw new CompileError([{ row: typeof node === 'number' ? node : node.startPosition.row, message }]);
  }

  private unsupported(node: Node, what: string): never {
    this.error(node, unsupportedMessage(what));
  }

  // Names -------------------------------------------------------------------------------------------------------------

  private qualify(name: string): string {
    return this.namespace ? `${this.namespace}\\${name}` : name;
  }

  /** Resolves a class name written in the program to its fully qualified name. */
  private resolveClassName(raw: string): string {
    if (raw.startsWith('\\')) return raw.slice(1);
    if (lower(raw).startsWith('namespace\\')) return this.qualify(raw.slice('namespace\\'.length));
    const parts = raw.split('\\');
    const alias = this.classImports.get(lower(parts[0]));
    if (alias !== undefined) return [alias, ...parts.slice(1)].join('\\');
    return this.qualify(raw);
  }

  private resolveFunctionName(raw: string): ResolvedName {
    if (raw.startsWith('\\')) return { name: raw.slice(1) };
    if (lower(raw).startsWith('namespace\\')) return { name: this.qualify(raw.slice('namespace\\'.length)) };
    if (raw.includes('\\')) return { name: this.resolveClassName(raw) };
    const imported = this.functionImports.get(lower(raw));
    if (imported !== undefined) return { name: imported };
    return this.namespace ? { name: this.qualify(raw), fallback: raw } : { name: raw };
  }

  private resolveConstName(raw: string): ResolvedName {
    if (raw.startsWith('\\')) return { name: raw.slice(1) };
    if (lower(raw).startsWith('namespace\\')) return { name: this.qualify(raw.slice('namespace\\'.length)) };
    if (raw.includes('\\')) return { name: this.resolveClassName(raw) };
    const imported = this.constImports.get(raw);
    if (imported !== undefined) return { name: imported };
    return this.namespace ? { name: this.qualify(raw), fallback: raw } : { name: raw };
  }

  private nameText(node: Node): string {
    return enc(node.text.replaceAll(/\s+/g, ''));
  }

  private classRef(node: Node): ClassRef {
    if (node.type === 'relative_scope') {
      const word = lower(node.text);
      if (word === 'self') return { k: 'self' };
      if (word === 'parent') return { k: 'parent' };
      return { k: 'static' };
    }
    if (node.type === 'name' || node.type === 'qualified_name' || node.type === 'relative_name') {
      const raw = this.nameText(node);
      const word = lower(raw);
      if (word === 'self') return { k: 'self' };
      if (word === 'parent') return { k: 'parent' };
      if (word === 'static') return { k: 'static' };
      return { k: 'named', name: this.resolveClassName(raw) };
    }
    return { k: 'expr', e: this.expr(node) };
  }


  // Statements --------------------------------------------------------------------------------------------------------

  private echoTagStatement(node: Node): Stmt[] {
    if (node.type === 'expression_statement') {
      const expression = node.namedChildren.find((child) => child.type !== 'comment');
      if (expression) return [{ k: 'echo', args: this.sequence(expression), row: node.startPosition.row }];
    }
    return this.statement(node, true);
  }

  private block(node: Node | null | undefined): Stmt[] {
    if (!node) return [];
    if (node.type === 'compound_statement' || node.type === 'colon_block') {
      const statements: Stmt[] = [];
      for (const child of node.namedChildren) {
        if (child.type === 'comment') continue;
        statements.push(...this.statement(child, false));
      }
      return statements;
    }
    return this.statement(node, false);
  }

  private blockOf(nodes: Node[]): Stmt[] {
    const statements: Stmt[] = [];
    for (const node of nodes) {
      if (node.type === 'comment') continue;
      statements.push(...this.block(node));
    }
    return statements;
  }

  // code-gauge-allow functionNcss 160 -- One case per statement kind, each delegating where it grows.
  // code-gauge-allow functionCognitiveComplexity 60 -- One case per statement kind, each delegating where it grows.
  private statement(node: Node, topLevel: boolean): Stmt[] {
    const row = node.startPosition.row;
    if (this.pendingEcho && node.type !== 'comment') {
      this.pendingEcho = false;
      return this.echoTagStatement(node);
    }
    switch (node.type) {
      case 'expression_statement': {
        const expression = node.namedChildren.find((child) => child.type !== 'comment');
        if (!expression) return [{ k: 'nop', row }];
        const e = this.expr(expression);
        if (e.k === 'exit') return [{ k: 'expr', e, onlyCalls: false, row }];
        return [{ k: 'expr', e, onlyCalls: onlyCalls(e), row }];
      }
      case 'echo_statement': {
        const args = node.namedChildren
          .filter((child) => child.type !== 'comment')
          .flatMap((child) => this.sequence(child));
        return [{ k: 'echo', args, row }];
      }
      case 'empty_statement': {
        return [{ k: 'nop', row }];
      }
      case 'compound_statement': {
        return [{ k: 'block', body: this.block(node), row }];
      }
      case 'text_interpolation': {
        const text = this.inlineText(node);
        const statements: Stmt[] = text ? [{ k: 'inline', text, row }] : [];
        return statements;
      }
      case 'if_statement': {
        return [this.ifStatement(node)];
      }
      case 'while_statement': {
        const cond = this.condition(node);
        const body = this.loopBody(() => this.blockOf(node.childrenForFieldName('body')));
        return [{ k: 'while', cond, body, row }];
      }
      case 'do_statement': {
        const body = this.loopBody(() => this.blockOf(node.childrenForFieldName('body')));
        return [{ k: 'do', body, cond: this.condition(node), row }];
      }
      case 'for_statement': {
        const part = (field: string): Expr[] => {
          const child = node.childForFieldName(field);
          return child ? this.sequence(child) : [];
        };
        const init = part('initialize');
        const cond = part('condition');
        const update = part('update');
        const body = this.loopBody(() => this.blockOf(node.childrenForFieldName('body')));
        return [{ k: 'for', init, cond, update, body, row }];
      }
      case 'foreach_statement': {
        return [this.foreachStatement(node)];
      }
      case 'switch_statement': {
        return [this.switchStatement(node)];
      }
      case 'break_statement':
      case 'continue_statement': {
        return [this.breakStatement(node)];
      }
      case 'return_statement': {
        return [this.returnStatement(node)];
      }
      case 'try_statement': {
        return [this.tryStatement(node)];
      }
      case 'global_declaration': {
        const names = node.namedChildren.filter((child) => child.type !== 'comment').map((child) => this.expr(child));
        return [{ k: 'global', names, row }];
      }
      case 'function_static_declaration': {
        const vars = node.namedChildren
          .filter((child) => child.type === 'static_variable_declaration')
          .map((child) => {
            const nameNode = child.childForFieldName('name') as Node;
            const value = child.childForFieldName('value');
            return { name: this.variableName(nameNode), init: value ? this.expr(value) : undefined };
          });
        return [{ k: 'static', vars, row }];
      }
      case 'unset_statement': {
        const targets = node.namedChildren.filter((child) => child.type !== 'comment').map((child) => this.expr(child));
        for (const target of targets) {
          if (target.k === 'var' && target.name === 'this') this.error(node, '$this は unset できません。');
        }
        return [{ k: 'unset', targets, row }];
      }
      case 'function_definition': {
        const decl = this.functionDecl(node, false);
        const key = lower(decl.name);
        if (topLevel) {
          if (this.declaredFunctions.has(key)) {
            this.error(
              node,
              `関数 ${decl.name}() は、すでに宣言されています（Cannot redeclare function ${decl.name}()）。`
            );
          }
          this.declaredFunctions.set(key, row);
        }
        return [{ k: 'func', decl, row }];
      }
      case 'class_declaration':
      case 'interface_declaration':
      case 'trait_declaration': {
        return [{ k: 'class', decl: this.classDecl(node), row }];
      }
      case 'enum_declaration': {
        this.unsupported(node, '列挙型（enum）');
        break;
      }
      case 'const_declaration': {
        const items = node.namedChildren
          .filter((child) => child.type === 'const_element')
          .map((child) => {
            const [nameNode, valueNode] = child.namedChildren.filter((part) => part.type !== 'comment');
            return { name: this.qualify(this.nameText(nameNode)), value: this.expr(valueNode) };
          });
        return [{ k: 'const', items, row }];
      }
      case 'named_label_statement': {
        const name = this.nameText(node.namedChildren[0]);
        if (this.fn.labels.has(name))
          this.error(node, `ラベル「${name}」は、すでに使われています（Label '${name}' already defined）。`);
        this.fn.labels.add(name);
        return [{ k: 'label', name, row }];
      }
      case 'goto_statement': {
        const label = this.nameText(node.namedChildren[0]);
        this.fn.gotos.push({ label, row });
        return [{ k: 'goto', label, row }];
      }
      case 'declare_statement': {
        return this.declareStatement(node, topLevel);
      }
      case 'namespace_definition': {
        return this.namespaceDefinition(node);
      }
      case 'namespace_use_declaration': {
        this.useDeclaration(node);
        return [];
      }
      case 'exit_statement': {
        const argument = node.namedChildren.find((child) => child.type !== 'comment');
        return [
          { k: 'expr', e: { k: 'exit', e: argument ? this.expr(argument) : undefined, row }, onlyCalls: false, row },
        ];
      }
      case 'comment': {
        return [];
      }
      default: {
        if (node.type.endsWith('_expression') || node.isNamed) {
          return [{ k: 'expr', e: this.expr(node), onlyCalls: false, row }];
        }
        this.error(node, '書き方に誤りがあります。');
      }
    }
  }

  private inlineText(node: Node): string {
    const end = node.namedChildren.find((child) => child.type === 'php_end_tag');
    const tag = node.namedChildren.find((child) => child.type === 'php_tag');
    if (!end) return '';
    let text = this.source.slice(end.endIndex, tag ? tag.startIndex : node.endIndex);
    // PHP swallows the single newline that directly follows a closing tag.
    if (text.startsWith('\r\n')) text = text.slice(2);
    else if (text.startsWith('\n')) text = text.slice(1);
    // `<?=` echoes the expression statement that follows it.
    if (tag?.text === '<?=') this.pendingEcho = true;
    return enc(text);
  }

  private condition(node: Node): Expr {
    const condition = node.childForFieldName('condition') as Node;
    return this.parenthesized(condition);
  }

  private parenthesized(node: Node): Expr {
    if (node.type === 'parenthesized_expression') {
      const inner = node.namedChildren.find((child) => child.type !== 'comment') as Node;
      return this.expr(inner);
    }
    return this.expr(node);
  }

  private loopBody<T>(convert: () => T): T {
    const outer = this.loop;
    this.loop = { depth: outer.depth + 1 };
    try {
      return convert();
    } finally {
      this.loop = outer;
    }
  }

  private ifStatement(node: Node): Stmt {
    const row = node.startPosition.row;
    const cond = this.condition(node);
    const consequent = this.blockOf(node.childrenForFieldName('body'));
    const alternate = this.alternatives(node.childrenForFieldName('alternative'));
    return { k: 'if', cond, consequent, alternate, row };
  }

  private alternatives(alternatives: Node[]): Stmt[] | undefined {
    if (alternatives.length === 0) return undefined;
    const [first, ...rest] = alternatives;
    const row = first.startPosition.row;
    if (first.type === 'else_clause') return this.blockOf(first.childrenForFieldName('body'));
    const cond = this.condition(first);
    const consequent = this.blockOf(first.childrenForFieldName('body'));
    return [{ k: 'if', cond, consequent, alternate: this.alternatives(rest), row }];
  }

  private foreachStatement(node: Node): Stmt {
    const row = node.startPosition.row;
    const parts = node.namedChildren.filter(
      (child) => child.type !== 'comment' && !node.childrenForFieldName('body').some((body) => body.id === child.id)
    );
    const subject = this.expr(parts[0]);
    const target = parts[1];
    let key: Expr | undefined;
    let valueNode = target;
    if (target.type === 'pair') {
      const [keyNode, value] = target.namedChildren.filter((child) => child.type !== 'comment');
      key = this.writable(keyNode);
      valueNode = value;
    }
    let byRef = false;
    if (valueNode.type === 'by_ref') {
      byRef = true;
      valueNode = valueNode.namedChildren[0];
    }
    const value = valueNode.type === 'list_literal' ? this.listLiteral(valueNode) : this.writable(valueNode);
    const body = this.loopBody(() => this.blockOf(node.childrenForFieldName('body')));
    return { k: 'foreach', subject, key, value, byRef, body, row };
  }

  private switchStatement(node: Node): Stmt {
    const row = node.startPosition.row;
    const subject = this.condition(node);
    const block = node.childForFieldName('body') as Node;
    let defaults = 0;
    const cases = this.loopBody(() =>
      block.namedChildren
        .filter((child) => child.type === 'case_statement' || child.type === 'default_statement')
        .map((child): SwitchCase => {
          const value = child.childForFieldName('value');
          if (child.type === 'default_statement') {
            defaults++;
            if (defaults > 1)
              this.error(
                child,
                'switch に default が2つあります（Switch statements may only contain one default clause）。'
              );
          }
          const separator = child.children.find((part) => part.type === ':' || part.type === ';');
          if (separator?.type === ';') {
            this.notices.push({
              level: 'Deprecated',
              message: 'Case statements followed by a semicolon (;) are deprecated, use a colon (:) instead',
              row: child.startPosition.row,
            });
          }
          const statements = child.namedChildren.filter((part) => part.id !== value?.id && part.type !== 'comment');
          return {
            test: value ? this.expr(value) : undefined,
            body: statements.flatMap((statement) => this.statement(statement, false)),
            row: child.startPosition.row,
          };
        })
    );
    return { k: 'switch', subject, cases, row };
  }

  private breakStatement(node: Node): Stmt {
    const kind = node.type === 'break_statement' ? 'break' : 'continue';
    const argument = node.namedChildren.find((child) => child.type !== 'comment');
    let depth = 1;
    if (argument) {
      if (argument.type !== 'integer')
        this.error(
          node,
          `'${kind}' の後には正の整数しか書けません（'${kind}' operator with non-integer operand is no longer supported）。`
        );
      depth = Number(parseIntegerLiteral(argument.text));
      if (depth < 1) this.error(node, `'${kind}' operator accepts only positive integers`);
    }
    if (this.loop.depth === 0) {
      this.error(
        node,
        `'${kind}' は、ループか switch の中でしか使えません（'${kind}' not in the 'loop' or 'switch' context）。`
      );
    }
    if (depth > this.loop.depth) {
      this.error(node, `${depth} 段の '${kind}' はできません（Cannot '${kind}' ${depth} levels）。`);
    }
    return { k: kind, depth, row: node.startPosition.row };
  }

  private returnStatement(node: Node): Stmt {
    const argument = node.namedChildren.find((child) => child.type !== 'comment');
    const row = node.startPosition.row;
    const type = this.fn.returnType;
    if (type?.k === 'named' && !type.nullable) {
      if (type.name === 'void' && argument) {
        this.error(node, 'void の関数は値を返せません（A void function must not return a value）。');
      }
      if (type.name === 'never') {
        this.error(node, 'never の関数は return できません（A never-returning function must not return）。');
      }
    }
    if (type && !argument && !(type.k === 'named' && type.name === 'void')) {
      this.error(
        node,
        '戻り値の型を宣言した関数は、値を返してください（A function with return type must return a value）。'
      );
    }
    return { k: 'return', e: argument ? this.expr(argument) : undefined, row };
  }

  private tryStatement(node: Node): Stmt {
    const row = node.startPosition.row;
    const body = this.block(node.childForFieldName('body'));
    const catches: CatchClause[] = [];
    let fin: Stmt[] | undefined;
    for (const child of node.namedChildren) {
      if (child.type === 'catch_clause') {
        const typeList = child.childForFieldName('type') as Node;
        const types = typeList.namedChildren
          .filter((type) => type.type !== 'comment')
          .map((type) =>
            this.resolveClassName(this.nameText(type.type === 'named_type' ? type.namedChildren[0] : type))
          );
        const nameNode = child.childForFieldName('name');
        catches.push({
          types,
          varName: nameNode ? this.variableName(nameNode) : undefined,
          body: this.block(child.childForFieldName('body')),
          row: child.startPosition.row,
        });
      } else if (child.type === 'finally_clause') {
        fin = this.block(child.childForFieldName('body'));
      }
    }
    return { k: 'try', body, catches, fin, row };
  }

  private declareStatement(node: Node, topLevel: boolean): Stmt[] {
    for (const directive of node.namedChildren.filter((child) => child.type === 'declare_directive')) {
      const key = lower(directive.child(0)?.text ?? '');
      const valueNode = directive.namedChildren.find((child) => child.type !== 'comment') as Node;
      if (key === 'strict_types') {
        if (
          !topLevel ||
          node.namedChildren.some((child) => child.type !== 'declare_directive' && child.type !== 'comment')
        ) {
          this.error(
            node,
            'strict_types は、ファイルの最初の文として、ブロックなしで書いてください（strict_types declaration must be the very first statement in the script）。'
          );
        }
        if (valueNode.text !== '0' && valueNode.text !== '1') {
          this.error(
            node,
            'strict_types の値は 0 か 1 です（strict_types declaration must have 0 or 1 as its value）。'
          );
        }
        this.strictTypes = valueNode.text === '1';
      } else if (key !== 'ticks' && key !== 'encoding') {
        this.error(node, `declare の指定「${directive.text}」は使えません。`);
      }
    }
    const body = node.namedChildren.filter((child) => child.type !== 'declare_directive' && child.type !== 'comment');
    return body.flatMap((child) => this.statement(child, topLevel));
  }

  private namespaceDefinition(node: Node): Stmt[] {
    const nameNode = node.childForFieldName('name');
    const body = node.childForFieldName('body');
    const name = nameNode ? this.nameText(nameNode) : '';
    if (lower(name) === 'namespace' || lower(name).startsWith('namespace\\')) {
      this.error(node, `名前空間の名前に「${name}」は使えません。`);
    }
    this.namespace = name;
    this.classImports = new Map();
    this.functionImports = new Map();
    this.constImports = new Map();
    if (!body) return [];
    const statements = this.blockOf([body]).map((statement) => statement);
    this.namespace = '';
    this.classImports = new Map();
    this.functionImports = new Map();
    this.constImports = new Map();
    return statements;
  }

  private useDeclaration(node: Node): void {
    const kindNode = node.childForFieldName('type');
    const kind = kindNode ? lower(kindNode.text) : 'class';
    const group = node.childForFieldName('body');
    const prefix = group
      ? this.nameText(node.namedChildren.find((child) => child.type === 'namespace_name') as Node).replace(/^\\/, '')
      : '';
    const clauses = (group ?? node).namedChildren.filter((child) => child.type === 'namespace_use_clause');
    for (const clause of clauses) {
      const clauseKind = clause.childForFieldName('type');
      const effective = clauseKind ? lower(clauseKind.text) : kind;
      const target = clause.namedChildren.find(
        (child) => child.type === 'name' || child.type === 'qualified_name'
      ) as Node;
      const raw = this.nameText(target).replace(/^\\/, '');
      const full = prefix ? `${prefix}\\${raw}` : raw;
      const aliasNode = clause.childForFieldName('alias');
      const alias = aliasNode ? this.nameText(aliasNode) : (full.split('\\').at(-1) as string);
      if (effective === 'function') this.functionImports.set(lower(alias), full);
      else if (effective === 'const') this.constImports.set(alias, full);
      else {
        if (this.classImports.has(lower(alias))) {
          this.error(
            node,
            `名前「${alias}」は、すでに use で使われています（Cannot use ${full} as ${alias} because the name is already in use）。`
          );
        }
        this.classImports.set(lower(alias), full);
      }
    }
  }

  private checkGotos(context: FunctionContext, body: Stmt[]): void {
    for (const { label, row } of context.gotos) {
      if (!context.labels.has(label))
        this.error(row, `goto の行き先のラベル「${label}」がありません（'goto' to undefined label '${label}'）。`);
      if (labelInsideLoop(body, label, false)) {
        this.error(
          row,
          `goto でループや switch の中には入れません（'goto' into loop or switch statement is disallowed）。`
        );
      }
    }
  }

  // Functions ---------------------------------------------------------------------------------------------------------

  private claimAtomic(node: Node, body: Node | null): boolean {
    const first = node.startPosition.row;
    const last = body ? body.startPosition.row : node.endPosition.row;
    let claimed = false;
    for (let row = first; row <= last; row++) {
      if (this.atomicRows.has(row) && !this.claimedAtomicRows.has(row)) {
        this.claimedAtomicRows.add(row);
        claimed = true;
      }
    }
    return claimed;
  }

  // code-gauge-allow functionCognitiveComplexity 20 -- Function declarations share one shape across their grammar forms.
  private functionDecl(node: Node, isClosure: boolean, className?: string): FunctionDecl {
    const attributes = node.childForFieldName('attributes');
    if (attributes) this.unsupported(attributes, '属性（#[...]）');
    const nameNode = node.childForFieldName('name');
    const rawName = nameNode ? this.nameText(nameNode) : '{closure}';
    const name = isClosure || className !== undefined ? rawName : this.qualify(rawName);
    const returnTypeNode = node.childForFieldName('return_type');
    const returnType = returnTypeNode ? this.typeDecl(returnTypeNode) : undefined;
    const body = node.childForFieldName('body');
    const byRefReturn =
      node.childForFieldName('reference_modifier') !== null ||
      node.children.some((child) => child.type === 'reference_modifier');
    const outerFn = this.fn;
    const outerLoop = this.loop;
    this.fn = {
      returnType,
      isGenerator: false,
      labels: new Set(),
      gotos: [],
      className: className ?? outerFn.className,
      isMethod: className !== undefined,
    };
    this.loop = { depth: 0 };
    try {
      const params = this.params(node.childForFieldName('parameters') as Node, name, className);
      const isAtomic = this.claimAtomic(node, body);
      let statements: Stmt[] = [];
      let arrowBody: Expr | undefined;
      if (node.type === 'arrow_function') {
        arrowBody = this.expr(body as Node);
      } else if (body) {
        statements = this.block(body);
      }
      this.checkGotos(this.fn, statements);
      return {
        name,
        params,
        returnType,
        byRefReturn,
        body: statements,
        arrowBody,
        row: node.startPosition.row,
        endRow: node.endPosition.row,
        isAtomic,
        usesThis: false,
        hasGoto: this.fn.gotos.length > 0,
        namespace: this.namespace,
        className: className ?? outerFn.className,
        isClosure,
      };
    } finally {
      this.fn = outerFn;
      this.loop = outerLoop;
    }
  }

  // code-gauge-allow functionCognitiveComplexity 25 -- Parameters share one shape across their grammar forms.
  private params(node: Node, functionName: string, className?: string): ParamDecl[] {
    const params: ParamDecl[] = [];
    const seen = new Set<string>();
    for (const child of node.namedChildren) {
      if (child.type === 'comment') continue;
      const attributes = child.childForFieldName('attributes');
      if (attributes) this.unsupported(attributes, '属性（#[...]）');
      const nameNode = child.childForFieldName('name') as Node;
      const name = this.variableName(nameNode);
      if (name === 'this') this.error(child, '$this は引数の名前に使えません（Cannot use $this as parameter）。');
      if (seen.has(name))
        this.error(child, `引数の名前 $${name} が重なっています（Redefinition of parameter $${name}）。`);
      seen.add(name);
      const typeNode = child.childForFieldName('type');
      const type = typeNode ? this.typeDecl(typeNode) : undefined;
      const defaultNode = child.childForFieldName('default_value');
      const defaultExpr = defaultNode ? this.expr(defaultNode) : undefined;
      const byRef = child.childForFieldName('reference_modifier') !== null;
      const variadic = child.type === 'variadic_parameter';
      const param: ParamDecl = {
        name,
        type,
        byRef,
        variadic,
        optional: defaultExpr !== undefined || variadic,
        defaultExpr,
        row: child.startPosition.row,
      };
      if (defaultExpr?.k === 'lit' && defaultExpr.v === null && type && !typeAllowsNull(type)) {
        param.implicitNullable = true;
        const displayName = className === undefined ? functionName : `${className}::${functionName}`;
        this.notices.push({
          level: 'Deprecated',
          message: `${displayName}(): Implicitly marking parameter $${name} as nullable is deprecated, the explicit nullable type must be used instead`,
          row: child.startPosition.row,
        });
      }
      if (child.type === 'property_promotion_parameter') {
        if (lower(functionName) !== '__construct' || className === undefined) {
          this.error(
            child,
            'プロパティの昇格は、コンストラクタの引数にしか書けません（Cannot declare promoted property outside a constructor）。'
          );
        }
        const modifiers = child.namedChildren;
        const visibilityNode = modifiers.find((part) => part.type === 'visibility_modifier');
        const visibility = visibilityNode ? (lower(visibilityNode.text.replace(/\(.*$/, '')) as Visibility) : 'public';
        const setVisibility = visibilityNode ? this.setVisibilityOf(visibilityNode) : undefined;
        param.promote = {
          visibility,
          isReadonly: modifiers.some((part) => part.type === 'readonly_modifier'),
          setVisibility,
        };
      }
      params.push(param);
    }
    // A required parameter after optional ones makes them required.
    let lastRequired = -1;
    for (const [index, param] of params.entries()) if (!param.optional) lastRequired = index;
    for (const [index, param] of params.entries()) {
      if (index < lastRequired && param.optional && !param.variadic) {
        const isNullDefault = param.defaultExpr?.k === 'lit' && param.defaultExpr.v === null;
        if (!(isNullDefault && param.type)) {
          const required = params.slice(index + 1).find((later) => !later.optional) as ParamDecl;
          this.notices.push({
            level: 'Deprecated',
            message: `${className === undefined ? functionName : `${className}::${functionName}`}(): Optional parameter $${param.name} declared before required parameter $${required.name} is implicitly treated as a required parameter`,
            row: param.row,
          });
        }
        param.optional = false;
        param.defaultExpr = undefined;
      }
    }
    return params;
  }

  private setVisibilityOf(node: Node): Visibility | undefined {
    const operation = node.namedChildren.find((child) => child.type === 'operation');
    if (!operation) return undefined;
    return lower(node.text.split('(')[0].trim()) as Visibility;
  }

  // code-gauge-allow functionCognitiveComplexity 20 -- One case per type grammar form.
  private typeDecl(node: Node): TypeDecl {
    switch (node.type) {
      case 'primitive_type':
      case 'bottom_type': {
        return { k: 'named', name: lower(node.text) };
      }
      case 'named_type': {
        const inner = node.namedChildren[0];
        return this.typeName(inner);
      }
      case 'name':
      case 'qualified_name':
      case 'relative_name': {
        return this.typeName(node);
      }
      case 'optional_type': {
        const inner = this.typeDecl(node.namedChildren[0]);
        return inner.k === 'named' ? { ...inner, nullable: true } : inner;
      }
      case 'union_type':
      case 'disjunctive_normal_form_type': {
        return {
          k: 'union',
          types: node.namedChildren.filter((child) => child.type !== 'comment').map((child) => this.typeDecl(child)),
        };
      }
      case 'intersection_type': {
        return {
          k: 'inter',
          types: node.namedChildren.filter((child) => child.type !== 'comment').map((child) => this.typeDecl(child)),
        };
      }
      case 'type_list': {
        return { k: 'union', types: node.namedChildren.map((child) => this.typeDecl(child)) };
      }
      default: {
        if (node.namedChildren.length === 1) return this.typeDecl(node.namedChildren[0]);
        return { k: 'union', types: node.namedChildren.map((child) => this.typeDecl(child)) };
      }
    }
  }

  private typeName(node: Node): TypeDecl {
    const raw = this.nameText(node);
    const word = lower(raw);
    if (BUILTIN_TYPES.has(word)) return { k: 'named', name: word };
    if (word === 'self' || word === 'static' || word === 'parent') return { k: 'named', name: word };
    return { k: 'named', name: this.resolveClassName(raw) };
  }

  // Classes -----------------------------------------------------------------------------------------------------------

  // code-gauge-allow functionCognitiveComplexity 40 -- Class members share the class's modifiers and checks.
  // code-gauge-allow functionNcss 90 -- Class members share the class's modifiers and checks.
  classDecl(node: Node, anonymous = false): ClassDecl {
    const attributes = node.childForFieldName('attributes');
    if (attributes) this.unsupported(attributes, '属性（#[...]）');
    const kind: ClassDecl['kind'] =
      node.type === 'interface_declaration' ? 'interface' : node.type === 'trait_declaration' ? 'trait' : 'class';
    const nameNode = node.childForFieldName('name');
    let name: string;
    if (anonymous) {
      this.anonymousClasses++;
      name = `class@anonymous`;
    } else {
      const raw = this.nameText(nameNode as Node);
      const word = lower(raw);
      if (BUILTIN_TYPES.has(word) || ['self', 'parent', 'static'].includes(word)) {
        this.error(
          node,
          `「${raw}」はクラスの名前に使えません（Cannot use '${raw}' as class name as it is reserved）。`
        );
      }
      name = this.qualify(raw);
    }
    const modifiers = node.children;
    const base = node.namedChildren.find((child) => child.type === 'base_clause');
    const baseNames = base
      ? base.namedChildren
          .filter((child) => child.type !== 'comment')
          .map((child) => this.resolveClassName(this.nameText(child)))
      : [];
    const implementsClause = node.namedChildren.find((child) => child.type === 'class_interface_clause');
    let interfaces = implementsClause
      ? implementsClause.namedChildren
          .filter((child) => child.type !== 'comment')
          .map((child) => this.resolveClassName(this.nameText(child)))
      : [];
    let parent: string | undefined;
    if (kind === 'interface') interfaces = baseNames;
    else if (baseNames.length > 0) parent = baseNames[0];
    const decl: ClassDecl = {
      name,
      kind,
      parent,
      interfaces,
      isAbstract: modifiers.some((child) => child.type === 'abstract_modifier'),
      isFinal: modifiers.some((child) => child.type === 'final_modifier'),
      isReadonly: modifiers.some((child) => child.type === 'readonly_modifier'),
      consts: [],
      props: [],
      methods: [],
      traits: [],
      row: node.startPosition.row,
      endRow: node.endPosition.row,
      isAnonymous: anonymous,
    };
    const outerClass = this.currentClass;
    this.currentClass = name;
    try {
      const body = node.childForFieldName('body') as Node;
      const memberNames = new Set<string>();
      for (const member of body.namedChildren) {
        switch (member.type) {
          case 'const_declaration': {
            this.classConsts(member, decl, kind);
            break;
          }
          case 'property_declaration': {
            this.properties(member, decl, kind);
            break;
          }
          case 'method_declaration': {
            const method = this.methodDecl(member, decl);
            const key = lower(method.fn.name);
            if (memberNames.has(key)) {
              this.error(
                member,
                `メソッド ${name}::${method.fn.name}() は、すでに宣言されています（Cannot redeclare ${name}::${method.fn.name}()）。`
              );
            }
            memberNames.add(key);
            decl.methods.push(method);
            break;
          }
          case 'use_declaration': {
            if (kind === 'interface') this.error(member, 'インターフェースではトレイトを使えません。');
            decl.traits.push(this.traitUse(member));
            break;
          }
          case 'comment': {
            break;
          }
          case 'enum_case': {
            this.unsupported(member, '列挙型（enum）');
            break;
          }
          default: {
            this.error(member, '書き方に誤りがあります。');
          }
        }
      }
    } finally {
      this.currentClass = outerClass;
    }
    // Promoted constructor parameters declare properties.
    const constructor = decl.methods.find((method) => lower(method.fn.name) === '__construct');
    if (constructor) {
      for (const param of constructor.fn.params) {
        if (!param.promote) continue;
        if (decl.props.some((prop) => prop.name === param.name)) {
          this.error(
            param.row,
            `プロパティ ${name}::$${param.name} は、すでに宣言されています（Cannot redeclare ${name}::$${param.name}）。`
          );
        }
        if (param.variadic)
          this.error(
            param.row,
            '可変長引数はプロパティに昇格できません（Cannot declare variadic promoted property）。'
          );
        decl.props.push({
          name: param.name,
          visibility: param.promote.visibility,
          setVisibility: param.promote.setVisibility,
          isStatic: false,
          isReadonly: param.promote.isReadonly || decl.isReadonly,
          type: param.type,
          defaultExpr: undefined,
          row: param.row,
          isAbstract: false,
          isFinal: false,
        });
      }
    }
    return decl;
  }

  private memberModifiers(member: Node): {
    visibility?: Visibility;
    setVisibility?: Visibility;
    isStatic: boolean;
    isAbstract: boolean;
    isFinal: boolean;
    isReadonly: boolean;
    isVar: boolean;
  } {
    const children = member.children;
    const visibilityNodes = children.filter((child) => child.type === 'visibility_modifier');
    // `public private(set)` names the read visibility and the write visibility separately.
    const setNode = visibilityNodes.find((child) => this.setVisibilityOf(child) !== undefined);
    const getNode = visibilityNodes.find((child) => child !== setNode);
    return {
      visibility: getNode ? (lower(getNode.text.trim()) as Visibility) : setNode ? 'public' : undefined,
      setVisibility: setNode ? this.setVisibilityOf(setNode) : undefined,
      isStatic: children.some((child) => child.type === 'static_modifier'),
      isAbstract: children.some((child) => child.type === 'abstract_modifier'),
      isFinal: children.some((child) => child.type === 'final_modifier'),
      isReadonly: children.some((child) => child.type === 'readonly_modifier'),
      isVar: children.some((child) => child.type === 'var_modifier'),
    };
  }

  private classConsts(member: Node, decl: ClassDecl, kind: ClassDecl['kind']): void {
    const attributes = member.childForFieldName('attributes');
    if (attributes) this.unsupported(attributes, '属性（#[...]）');
    const modifiers = this.memberModifiers(member);
    const typeNode = member.childForFieldName('type');
    for (const element of member.namedChildren.filter((child) => child.type === 'const_element')) {
      const [nameNode, valueNode] = element.namedChildren.filter((part) => part.type !== 'comment');
      const name = this.nameText(nameNode);
      if (lower(name) === 'class')
        this.error(
          element,
          "class という名前の定数は宣言できません（A class constant must not be called 'class'; it is reserved for class name fetching）。"
        );
      if (decl.consts.some((constant) => constant.name === name)) {
        this.error(
          element,
          `定数 ${decl.name}::${name} は、すでに宣言されています（Cannot redefine class constant ${decl.name}::${name}）。`
        );
      }
      if (kind === 'interface' && modifiers.visibility && modifiers.visibility !== 'public') {
        this.error(element, 'インターフェースの定数は public にしてください。');
      }
      decl.consts.push({
        name,
        value: this.expr(valueNode),
        visibility: modifiers.visibility ?? 'public',
        isFinal: modifiers.isFinal,
        row: element.startPosition.row,
        type: typeNode ? this.typeDecl(typeNode) : undefined,
      });
    }
  }

  // code-gauge-allow functionCognitiveComplexity 25 -- Property declarations check PHP's rules on modifiers and hooks.
  private properties(member: Node, decl: ClassDecl, kind: ClassDecl['kind']): void {
    const attributes = member.childForFieldName('attributes');
    if (attributes) this.unsupported(attributes, '属性（#[...]）');
    if (kind === 'interface' && !member.namedChildren.some((child) => child.type === 'property_hook_list')) {
      this.error(
        member,
        'インターフェースにはプロパティを宣言できません（Interfaces may only include hooked properties）。'
      );
    }
    const modifiers = this.memberModifiers(member);
    const typeNode = member.childForFieldName('type');
    const type = typeNode ? this.typeDecl(typeNode) : undefined;
    const isReadonly = modifiers.isReadonly || decl.isReadonly;
    if (isReadonly && !type && !modifiers.isStatic) {
      this.error(
        member,
        `readonly のプロパティには型が必要です（Readonly property ${decl.name}::$... must have type）。`
      );
    }
    if (isReadonly && modifiers.isStatic)
      this.error(member, 'static のプロパティは readonly にできません（Static property cannot be readonly）。');
    const hookList = member.namedChildren.find((child) => child.type === 'property_hook_list');
    for (const element of member.namedChildren.filter((child) => child.type === 'property_element')) {
      const name = this.variableName(element.childForFieldName('name') as Node);
      if (decl.props.some((prop) => prop.name === name)) {
        this.error(
          element,
          `プロパティ ${decl.name}::$${name} は、すでに宣言されています（Cannot redeclare ${decl.name}::$${name}）。`
        );
      }
      const defaultNode = element.childForFieldName('default_value');
      if (defaultNode && isReadonly) {
        this.error(
          element,
          `readonly のプロパティには初期値を書けません（Readonly property ${decl.name}::$${name} cannot have default value）。`
        );
      }
      const prop: PropertyDeclAst = {
        name,
        visibility: modifiers.visibility ?? 'public',
        setVisibility: modifiers.setVisibility,
        isStatic: modifiers.isStatic,
        isReadonly,
        type,
        defaultExpr: defaultNode ? this.expr(defaultNode) : undefined,
        row: element.startPosition.row,
        isAbstract: modifiers.isAbstract,
        isFinal: modifiers.isFinal,
      };
      if (hookList) this.hooks(hookList, prop, decl.name);
      decl.props.push(prop);
    }
  }

  private hooks(list: Node, prop: PropertyDeclAst, className: string): void {
    const hooks: NonNullable<PropertyDeclAst['hooks']> = {};
    let referencesBacking = false;
    for (const hook of list.namedChildren.filter((child) => child.type === 'property_hook')) {
      const attributes = hook.childForFieldName('attributes');
      if (attributes) this.unsupported(attributes, '属性（#[...]）');
      const kind = lower(hook.namedChildren.find((child) => child.type === 'name')?.text ?? '');
      const body = hook.childForFieldName('body');
      const paramsNode = hook.childForFieldName('parameters');
      const outerFn = this.fn;
      this.fn = { isGenerator: false, labels: new Set(), gotos: [], className, isMethod: true };
      try {
        let params: ParamDecl[] = [];
        if (paramsNode) params = this.params(paramsNode, `$${prop.name}::${kind}`, className);
        if (kind === 'set' && params.length === 0) {
          params = [
            {
              name: 'value',
              type: prop.type,
              byRef: false,
              variadic: false,
              optional: false,
              row: hook.startPosition.row,
            },
          ];
        }
        let statements: Stmt[] = [];
        let arrowBody: Expr | undefined;
        if (body?.type === 'compound_statement') statements = this.block(body);
        else if (body) {
          arrowBody = this.expr(body);
          if (kind === 'set') {
            // A short set hook assigns its expression to the property.
            referencesBacking = true;
            statements = [
              {
                k: 'expr',
                e: {
                  k: 'assign',
                  target: {
                    k: 'prop',
                    obj: { k: 'var', name: 'this', row: body.startPosition.row },
                    name: prop.name,
                    nullsafe: false,
                    row: body.startPosition.row,
                  },
                  value: arrowBody,
                  row: body.startPosition.row,
                },
                onlyCalls: false,
                row: body.startPosition.row,
              },
            ];
            arrowBody = undefined;
          }
        }
        if (body && referencesProperty(body, prop.name)) referencesBacking = true;
        const fn: FunctionDecl = {
          name: `$${prop.name}::${kind}`,
          params,
          body: statements,
          arrowBody,
          byRefReturn: false,
          row: hook.startPosition.row,
          endRow: hook.endPosition.row,
          isAtomic: false,
          usesThis: true,
          hasGoto: false,
          namespace: this.namespace,
          className,
          isClosure: false,
        };
        if (kind === 'get') hooks.get = fn;
        else if (kind === 'set') {
          hooks.set = fn;
          hooks.setParam = params[0]?.name;
        } else
          this.error(
            hook,
            `プロパティフック「${kind}」はありません（Unknown hook "${kind}" for property ${className}::$${prop.name}）。`
          );
      } finally {
        this.fn = outerFn;
      }
    }
    prop.hooks = hooks;
    prop.isVirtual = !referencesBacking;
  }

  private methodDecl(member: Node, decl: ClassDecl): MethodDeclAst {
    const modifiers = this.memberModifiers(member);
    const fn = this.functionDecl(member, false, decl.name);
    const body = member.childForFieldName('body');
    const isAbstract = modifiers.isAbstract || (decl.kind === 'interface' && !body);
    if (decl.kind === 'interface' && body) {
      this.error(
        member,
        `インターフェースのメソッド ${decl.name}::${fn.name}() には本体を書けません（Interface function ${decl.name}::${fn.name}() cannot contain body）。`
      );
    }
    if (modifiers.isAbstract && body) {
      this.error(
        member,
        `abstract のメソッド ${decl.name}::${fn.name}() には本体を書けません（Abstract function ${decl.name}::${fn.name}() cannot contain body）。`
      );
    }
    if (!isAbstract && !body) {
      this.error(
        member,
        `メソッド ${decl.name}::${fn.name}() に本体がありません（Non-abstract method ${decl.name}::${fn.name}() must contain body）。`
      );
    }
    if (modifiers.isAbstract && !decl.isAbstract && decl.kind === 'class' && !decl.isAnonymous) {
      this.error(
        member,
        `abstract のメソッドを持つクラス ${decl.name} は abstract にしてください（Class ${decl.name} declares abstract method ${fn.name}() and must therefore be declared abstract）。`
      );
    }
    if (modifiers.isAbstract && modifiers.visibility === 'private' && decl.kind !== 'trait') {
      this.error(
        member,
        `abstract のメソッドは private にできません（Abstract function ${decl.name}::${fn.name}() cannot be declared private）。`
      );
    }
    fn.isStatic = modifiers.isStatic;
    return {
      fn,
      visibility: modifiers.visibility ?? 'public',
      isStatic: modifiers.isStatic,
      isAbstract,
      isFinal: modifiers.isFinal,
    };
  }

  private traitUse(member: Node): ClassDecl['traits'][number] {
    const names = member.namedChildren
      .filter((child) => child.type === 'name' || child.type === 'qualified_name' || child.type === 'relative_name')
      .map((child) => this.resolveClassName(this.nameText(child)));
    const rules: TraitRule[] = [];
    const list = member.namedChildren.find((child) => child.type === 'use_list');
    for (const clause of list?.namedChildren ?? []) {
      if (clause.type === 'use_instead_of_clause') {
        const [target, ...instead] = clause.namedChildren.filter((child) => child.type !== 'comment');
        const [traitNode, methodNode] = target.namedChildren;
        rules.push({
          k: 'insteadof',
          trait: this.resolveClassName(this.nameText(traitNode)),
          method: this.nameText(methodNode),
          instead: instead.map((child) => this.resolveClassName(this.nameText(child))),
        });
      } else if (clause.type === 'use_as_clause') {
        const parts = clause.namedChildren.filter((child) => child.type !== 'comment');
        const [target, ...rest] = parts;
        let trait: string | undefined;
        let method: string;
        if (target.type === 'class_constant_access_expression') {
          trait = this.resolveClassName(this.nameText(target.namedChildren[0]));
          method = this.nameText(target.namedChildren[1]);
        } else method = this.nameText(target);
        const visibilityNode = rest.find((child) => child.type === 'visibility_modifier');
        const aliasNode = rest.find((child) => child.type === 'name');
        rules.push({
          k: 'as',
          trait,
          method,
          alias: aliasNode ? this.nameText(aliasNode) : undefined,
          visibility: visibilityNode ? (lower(visibilityNode.text) as Visibility) : undefined,
        });
      }
    }
    return { names, rules, row: member.startPosition.row };
  }

  // Expressions -------------------------------------------------------------------------------------------------------

  private sequence(node: Node): Expr[] {
    if (node.type === 'sequence_expression') {
      return node.namedChildren.filter((child) => child.type !== 'comment').flatMap((child) => this.sequence(child));
    }
    return [this.expr(node)];
  }

  private variableName(node: Node): string {
    if (node.type === 'variable_name') {
      const name = enc(node.namedChildren[0]?.text ?? node.text.replace(/^\$/, ''));
      if (SUPERGLOBALS.has(name)) this.unsupported(node, `スーパーグローバル変数 $${name}`);
      if (name === 'argv' || name === 'argc') this.unsupported(node, `コマンドライン引数 $${name}`);
      return name;
    }
    this.error(node, '書き方に誤りがあります。');
  }

  /** Converts an expression that a statement writes to. */
  private writable(node: Node): Expr {
    const e = this.expr(node);
    this.checkWritable(e, node);
    return e;
  }

  private checkWritable(e: Expr, node: Node): void {
    switch (e.k) {
      case 'var': {
        if (e.name === 'this') this.error(node, '$this には代入できません（Cannot re-assign $this）。');
        return;
      }
      case 'varvar':
      case 'idx':
      case 'prop':
      case 'sprop':
      case 'list': {
        return;
      }
      case 'call':
      case 'mcall':
      case 'scall': {
        this.error(node, "関数の戻り値には代入できません（Can't use function return value in write context）。");
        break;
      }
      default: {
        this.error(node, 'この式には代入できません（Cannot use temporary expression in write context）。');
      }
    }
  }

  // code-gauge-allow functionNcss 260 -- One case per expression kind, each delegating where it grows.
  // code-gauge-allow functionCognitiveComplexity 90 -- One case per expression kind, each delegating where it grows.
  expr(node: Node): Expr {
    const row = node.startPosition.row;
    switch (node.type) {
      case 'parenthesized_expression': {
        return this.parenthesized(node);
      }
      case 'integer': {
        return { k: 'lit', v: parseIntegerLiteral(node.text), row };
      }
      case 'float': {
        return { k: 'lit', v: Number.parseFloat(node.text.replaceAll('_', '')), row };
      }
      case 'boolean': {
        return { k: 'lit', v: lower(node.text) === 'true', row };
      }
      case 'null': {
        return { k: 'lit', v: null, row };
      }
      case 'string': {
        return { k: 'lit', v: this.singleQuoted(node), row };
      }
      case 'encapsed_string':
      case 'heredoc': {
        return this.interpolated(node);
      }
      case 'nowdoc': {
        return { k: 'lit', v: this.nowdoc(node), row };
      }
      case 'variable_name': {
        return { k: 'var', name: this.variableName(node), row };
      }
      case 'dynamic_variable_name': {
        const inner = node.namedChildren.find((child) => child.type !== 'comment') as Node;
        if (node.text.startsWith('${') && node.parent?.type === 'encapsed_string' && inner.type === 'name') {
          this.notices.push({
            level: 'Deprecated',
            message: 'Using ${var} in strings is deprecated, use {$var} instead',
            row,
          });
          return { k: 'var', name: enc(inner.text), row };
        }
        if (inner.type === 'name') return { k: 'var', name: enc(inner.text), row };
        return { k: 'varvar', name: this.expr(inner), row };
      }
      case 'name':
      case 'qualified_name':
      case 'relative_name': {
        return this.constant(node);
      }
      case 'array_creation_expression': {
        return { k: 'array', items: this.arrayItems(node), row };
      }
      case 'list_literal': {
        return this.listLiteral(node);
      }
      case 'subscript_expression': {
        const [baseNode, indexNode] = node.namedChildren.filter((child) => child.type !== 'comment');
        if (node.text.trimEnd().endsWith('}'))
          this.error(
            node,
            '文字列の添字に {} は使えません（Array and string offset access syntax with curly braces is no longer supported）。'
          );
        return { k: 'idx', base: this.expr(baseNode), index: indexNode ? this.expr(indexNode) : undefined, row };
      }
      case 'member_access_expression':
      case 'nullsafe_member_access_expression': {
        const obj = this.expr(node.childForFieldName('object') as Node);
        return {
          k: 'prop',
          obj,
          name: this.memberName(node.childForFieldName('name') as Node),
          nullsafe: node.type.startsWith('nullsafe'),
          row,
        };
      }
      case 'member_call_expression':
      case 'nullsafe_member_call_expression': {
        const obj = this.expr(node.childForFieldName('object') as Node);
        const { args, fcc } = this.args(node.childForFieldName('arguments') as Node);
        return {
          k: 'mcall',
          obj,
          name: this.memberName(node.childForFieldName('name') as Node),
          args,
          nullsafe: node.type.startsWith('nullsafe'),
          fcc,
          row: (node.childForFieldName('name') as Node).startPosition.row,
        };
      }
      case 'scoped_property_access_expression': {
        const cls = this.classRef(node.childForFieldName('scope') as Node);
        const nameNode = node.childForFieldName('name') as Node;
        const name = nameNode.type === 'variable_name' ? this.variableName(nameNode) : this.expr(nameNode);
        return { k: 'sprop', cls, name, row };
      }
      case 'scoped_call_expression': {
        const cls = this.classRef(node.childForFieldName('scope') as Node);
        const nameNode = node.childForFieldName('name') as Node;
        const { args, fcc } = this.args(node.childForFieldName('arguments') as Node);
        return { k: 'scall', cls, name: this.memberName(nameNode), args, fcc, row };
      }
      case 'class_constant_access_expression': {
        const [scope, nameNode] = node.namedChildren.filter((child) => child.type !== 'comment');
        return { k: 'cconst', cls: this.classRef(scope), name: this.nameText(nameNode), row };
      }
      case 'function_call_expression': {
        return this.functionCall(node);
      }
      case 'object_creation_expression': {
        return this.objectCreation(node);
      }
      case 'assignment_expression': {
        const left = node.childForFieldName('left') as Node;
        const right = node.childForFieldName('right') as Node;
        const target = left.type === 'list_literal' ? this.listLiteral(left) : this.writable(left);
        if (
          target.k === 'idx' &&
          target.index === undefined &&
          target.base.k === 'var' &&
          target.base.name === 'this'
        ) {
          this.error(node, '$this には代入できません（Cannot use $this as array）。');
        }
        return { k: 'assign', target, value: this.expr(right), row };
      }
      case 'reference_assignment_expression': {
        const target = this.writable(node.childForFieldName('left') as Node);
        const sourceNode = node.childForFieldName('right') as Node;
        const source = this.expr(sourceNode);
        if (source.k === 'new')
          this.error(node, 'new の結果は参照で代入できません（Cannot assign reference to non referenceable value）。');
        return { k: 'assignRef', target, source, row };
      }
      case 'augmented_assignment_expression': {
        const target = this.writable(node.childForFieldName('left') as Node);
        const operator = (node.childForFieldName('operator') as Node).type;
        return {
          k: 'assignOp',
          op: operator.slice(0, -1),
          target,
          value: this.expr(node.childForFieldName('right') as Node),
          row,
        };
      }
      case 'binary_expression': {
        return this.binary(node);
      }
      case 'unary_op_expression': {
        const operator = (node.childForFieldName('operator') ?? node.child(0)) as Node;
        const argument = (node.childForFieldName('argument') ?? node.namedChildren.at(-1)) as Node;
        return { k: 'unary', op: operator.type, e: this.expr(argument), row };
      }
      case 'update_expression': {
        const operator = node.childForFieldName('operator') as Node;
        const argument = node.childForFieldName('argument') as Node;
        return {
          k: 'incdec',
          inc: operator.type === '++',
          prefix: operator.startIndex < argument.startIndex,
          target: this.writable(argument),
          row,
        };
      }
      case 'conditional_expression': {
        const test = this.expr(node.childForFieldName('condition') as Node);
        const body = node.childForFieldName('body');
        const alternative = this.expr(node.childForFieldName('alternative') as Node);
        const conditionNode = node.childForFieldName('condition') as Node;
        if (conditionNode.type === 'conditional_expression' && !conditionNode.text.startsWith('(')) {
          this.error(
            node,
            '括弧のない三項演算子の入れ子は使えません（Unparenthesized `a ? b : c ? d : e` is not supported）。'
          );
        }
        return { k: 'cond', test, consequent: body ? this.expr(body) : undefined, alternate: alternative, row };
      }
      case 'cast_expression': {
        const type = lower((node.childForFieldName('type') as Node).text.replaceAll(/[\s()]/g, ''));
        if (type === 'unset')
          this.error(node, '(unset) のキャストは使えません（The (unset) cast is no longer supported）。');
        if (type === 'real')
          this.error(node, '(real) のキャストは使えません（The (real) cast has been removed, use (float) instead）。');
        if (type === 'binary') {
          return { k: 'cast', type: 'string', e: this.expr(node.childForFieldName('value') as Node), row };
        }
        const normalized = { integer: 'int', double: 'float', boolean: 'bool' }[type] ?? type;
        if (normalized !== type) {
          this.notices.push({
            level: 'Deprecated',
            message: `Non-canonical cast (${type}) is deprecated, use the (${normalized}) cast instead`,
            row,
          });
        }
        return { k: 'cast', type: normalized, e: this.expr(node.childForFieldName('value') as Node), row };
      }
      case 'error_suppression_expression': {
        return { k: 'silence', e: this.expr(node.namedChildren[0]), row };
      }
      case 'clone_expression': {
        const argumentsNode = node.childForFieldName('arguments');
        if (argumentsNode) {
          const { args } = this.args(argumentsNode);
          if (args.length === 0 || args.length > 2 || args.some((arg) => arg.spread || arg.name)) {
            return { k: 'call', fn: { name: 'clone' }, args, fcc: false, row };
          }
          return { k: 'clone', e: args[0].e, with: args[1]?.e, row };
        }
        return { k: 'clone', e: this.expr(node.namedChildren.find((child) => child.type !== 'comment') as Node), row };
      }
      case 'throw_expression': {
        return { k: 'throw', e: this.expr(node.namedChildren[0]), row };
      }
      case 'anonymous_function': {
        return this.closure(node);
      }
      case 'arrow_function': {
        const isStatic = node.childForFieldName('static_modifier') !== null;
        const fn = this.functionDecl(node, true);
        fn.captures = [...collectVariables(fn.arrowBody as Expr, new Set(fn.params.map((param) => param.name)))];
        return { k: 'arrow', fn, isStatic, row };
      }
      case 'match_expression': {
        return this.match(node);
      }
      case 'print_intrinsic': {
        return { k: 'print', e: this.expr(node.namedChildren[0]), row };
      }
      case 'exit_statement': {
        const argument = node.namedChildren.find((child) => child.type !== 'comment');
        return { k: 'exit', e: argument ? this.expr(argument) : undefined, row };
      }
      case 'sequence_expression': {
        this.error(node, '書き方に誤りがあります。');
        break;
      }
      case 'yield_expression': {
        this.unsupported(node, 'ジェネレータ（yield）');
        break;
      }
      case 'include_expression':
      case 'include_once_expression':
      case 'require_expression':
      case 'require_once_expression': {
        this.unsupported(node, 'include・require による別のファイルの読み込み');
        break;
      }
      case 'shell_command_expression': {
        this.unsupported(node, '外部コマンドの実行（`...`）');
        break;
      }
      case 'by_ref': {
        this.error(node, '書き方に誤りがあります。');
        break;
      }
      default: {
        this.error(node, '書き方に誤りがあります。');
      }
    }
  }

  private memberName(node: Node): string | Expr {
    if (node.type === 'name') return this.nameText(node);
    if (node.type === 'variable_name') return this.expr(node);
    return this.expr(node);
  }

  private constant(node: Node): Expr {
    const row = node.startPosition.row;
    const raw = this.nameText(node);
    const word = lower(raw);
    if (word === 'true' || word === 'false') return { k: 'lit', v: word === 'true', row };
    if (word === 'null') return { k: 'lit', v: null, row };
    if (word === 'die' || word === 'exit') return { k: 'exit', row };
    if (raw === '__LINE__') return { k: 'lit', v: BigInt(row + 1), row };
    if (raw === '__FILE__') return { k: 'lit', v: '/main.php', row };
    if (raw === '__DIR__') return { k: 'lit', v: '/', row };
    if (raw === '__NAMESPACE__') return { k: 'lit', v: this.namespace, row };
    if (MAGIC_RUNTIME.has(raw)) return { k: 'magic', name: raw as Extract<Expr, { k: 'magic' }>['name'], row };
    if (raw === '__COMPILER_HALT_OFFSET__') this.unsupported(node, '__halt_compiler');
    return { k: 'const', name: this.resolveConstName(raw), row };
  }

  // code-gauge-allow functionCognitiveComplexity 20 -- Calls to language constructs that the grammar parses as calls.
  private functionCall(node: Node): Expr {
    const row = node.startPosition.row;
    const fnNode = node.childForFieldName('function') as Node;
    const argumentsNode = node.childForFieldName('arguments') as Node;
    if (fnNode.type === 'name') {
      const word = lower(fnNode.text);
      if (word === 'isset' || word === 'empty') {
        const items = argumentsNode.namedChildren
          .filter((child) => child.type === 'argument')
          .map((child) => {
            const inner = child.namedChildren.at(-1) as Node;
            return this.expr(inner);
          });
        if (word === 'empty') {
          if (items.length !== 1) this.error(node, 'empty() には1つの式を書いてください。');
          return { k: 'empty', e: items[0], row };
        }
        if (items.length === 0) this.error(node, 'isset() には式を書いてください。');
        for (const item of items) {
          if (!['var', 'varvar', 'idx', 'prop', 'sprop', 'cconst'].includes(item.k)) {
            this.error(node, 'isset() には変数を書いてください（Cannot use isset() on the result of an expression）。');
          }
        }
        return { k: 'isset', items, row };
      }
      if (word === 'eval') this.unsupported(node, 'eval');
      if (word === 'die' || word === 'exit') {
        const { args } = this.args(argumentsNode);
        return { k: 'exit', e: args[0]?.e, row };
      }
      if (word === '__halt_compiler') this.unsupported(node, '__halt_compiler');
    }
    const { args, fcc } = this.args(argumentsNode);
    if (fnNode.type === 'name' || fnNode.type === 'qualified_name' || fnNode.type === 'relative_name') {
      const name = this.resolveFunctionName(this.nameText(fnNode));
      // PHP passes `assert` the source of its assertion, as code it writes back from the syntax tree.
      if (lower(name.fallback ?? name.name) === 'assert' && args.length === 1 && !args[0].spread && !args[0].name) {
        args.push({ e: { k: 'lit', v: `assert(${exportExpr(args[0].e)})`, row }, spread: false });
      }
      return { k: 'call', fn: name, args, fcc, row };
    }
    return { k: 'call', fn: this.expr(fnNode), args, fcc, row };
  }

  private args(node: Node): { args: Arg[]; fcc: boolean } {
    const args: Arg[] = [];
    let fcc = false;
    let named = false;
    for (const child of node.namedChildren) {
      if (child.type === 'variadic_placeholder') {
        fcc = true;
        continue;
      }
      if (child.type !== 'argument') continue;
      const nameNode = child.childForFieldName('name');
      const valueNode = child.namedChildren.findLast(
        (part) => part.id !== nameNode?.id && part.type !== 'reference_modifier'
      ) as Node;
      if (valueNode.type === 'argument_placeholder')
        this.error(child, '書き方に誤りがあります（syntax error, unexpected token "?"）。');
      if (child.childForFieldName('reference_modifier')) this.error(child, '呼び出しの引数に & は書けません。');
      if (valueNode.type === 'variadic_unpacking') {
        if (named)
          this.error(
            child,
            '名前付き引数の後に ... は書けません（Cannot use argument unpacking after named arguments）。'
          );
        args.push({ e: this.expr(valueNode.namedChildren[0]), spread: true });
        continue;
      }
      if (nameNode) {
        named = true;
        const name = this.nameText(nameNode);
        if (args.some((arg) => arg.name === name))
          this.error(
            child,
            `名前付き引数 $${name} が重なっています（Named parameter $${name} overwrites previous argument）。`
          );
        args.push({ e: this.expr(valueNode), spread: false, name });
      } else {
        if (named)
          this.error(
            child,
            '名前付き引数の後に位置の引数は書けません（Cannot use positional argument after named argument）。'
          );
        if (args.some((arg) => arg.spread)) {
          this.error(
            child,
            '... の後に位置の引数は書けません（Cannot use positional argument after argument unpacking）。'
          );
        }
        args.push({
          e: this.expr(valueNode),
          spread: false,
        });
      }
    }
    if (fcc && args.length > 0)
      this.error(node, '書き方に誤りがあります（Cannot combine partial application and unpacking）。');
    return { args, fcc };
  }

  private objectCreation(node: Node): Expr {
    const row = node.startPosition.row;
    const anonymous = node.namedChildren.find((child) => child.type === 'anonymous_class');
    if (anonymous) {
      const argumentsNode = anonymous.namedChildren.find((child) => child.type === 'arguments');
      const { args } = argumentsNode ? this.args(argumentsNode) : { args: [] };
      return { k: 'newAnon', decl: this.classDecl(anonymous, true), args, row };
    }
    const parts = node.namedChildren.filter((child) => child.type !== 'comment');
    const argumentsNode = parts.find((child) => child.type === 'arguments');
    const classNode = parts.find((child) => child.type !== 'arguments') as Node;
    const { args, fcc } = argumentsNode ? this.args(argumentsNode) : { args: [], fcc: false };
    if (fcc) this.error(node, 'new で第一級 callable は作れません（Cannot create Closure for new expression）。');
    return { k: 'new', cls: this.classRef(classNode), args, row };
  }

  private binary(node: Node): Expr {
    const row = node.startPosition.row;
    const operator = (node.childForFieldName('operator') as Node).type;
    const leftNode = node.childForFieldName('left') as Node;
    const rightNode = node.childForFieldName('right') as Node;
    const l = this.expr(leftNode);
    if (lower(operator) === 'instanceof') {
      const cls =
        rightNode.type === 'name' || rightNode.type === 'qualified_name' || rightNode.type === 'relative_name'
          ? this.classRef(rightNode)
          : { k: 'expr' as const, e: this.expr(rightNode) };
      return { k: 'instanceof', e: l, cls, row };
    }
    const r = this.expr(rightNode);
    if (operator === '|>') return { k: 'pipe', l, r, row };
    return { k: 'bin', op: lower(operator) === '<>' ? '!=' : lower(operator), l, r, row };
  }

  private closure(node: Node): Expr {
    const row = node.startPosition.row;
    const isStatic = node.childForFieldName('static_modifier') !== null;
    const useClause = node.namedChildren.find((child) => child.type === 'anonymous_function_use_clause');
    const uses = (useClause?.namedChildren ?? [])
      .filter((child) => child.type === 'variable_name' || child.type === 'by_ref')
      .map((child) => {
        const byRef = child.type === 'by_ref';
        const variable = byRef ? child.namedChildren[0] : child;
        const name = this.variableName(variable);
        if (name === 'this') this.error(child, '$this は use に書けません（Cannot use $this as lexical variable）。');
        return { name, byRef };
      });
    const fn = this.functionDecl(node, true);
    for (const use of uses) {
      if (fn.params.some((param) => param.name === use.name)) {
        this.error(
          node,
          `use の変数 $${use.name} が引数と重なっています（Cannot use lexical variable $${use.name} as a parameter name）。`
        );
      }
    }
    return { k: 'closure', fn, uses, isStatic, row };
  }

  private match(node: Node): Expr {
    const row = node.startPosition.row;
    const subject = this.condition(node);
    const block = node.childForFieldName('body') as Node;
    const arms: MatchArm[] = [];
    let defaults = 0;
    for (const arm of block.namedChildren) {
      if (arm.type === 'match_conditional_expression') {
        const list = arm.childForFieldName('conditional_expressions') as Node;
        arms.push({
          conditions: list.namedChildren.filter((child) => child.type !== 'comment').map((child) => this.expr(child)),
          body: this.expr(arm.childForFieldName('return_expression') as Node),
          row: arm.startPosition.row,
        });
      } else if (arm.type === 'match_default_expression') {
        defaults++;
        if (defaults > 1)
          this.error(arm, 'match に default が2つあります（Match expressions may only contain one default arm）。');
        arms.push({ body: this.expr(arm.childForFieldName('return_expression') as Node), row: arm.startPosition.row });
      }
    }
    return { k: 'match', subject, arms, row };
  }

  private arrayItems(node: Node): ArrayItem[] {
    const items: ArrayItem[] = [];
    for (const child of node.namedChildren) {
      if (child.type !== 'array_element_initializer') continue;
      const parts = child.namedChildren.filter((part) => part.type !== 'comment');
      if (parts.length === 1 && parts[0].type === 'variadic_unpacking') {
        items.push({ value: this.expr(parts[0].namedChildren[0]), byRef: false, spread: true });
        continue;
      }
      let key: Expr | undefined;
      let valueNode = parts[0];
      if (parts.length === 2) {
        key = this.expr(parts[0]);
        valueNode = parts[1];
      }
      if (valueNode.type === 'by_ref') {
        items.push({ key, value: this.writable(valueNode.namedChildren[0]), byRef: true, spread: false });
      } else items.push({ key, value: this.expr(valueNode), byRef: false, spread: false });
    }
    // A trailing comma is allowed; an empty element between commas is not.
    let expectingElement = true;
    for (const child of node.children) {
      if (child.type === ',') {
        if (expectingElement) this.error(node, '配列の要素が空です（Cannot use empty array elements in arrays）。');
        expectingElement = true;
      } else if (child.type === 'array_element_initializer') expectingElement = false;
    }
    return items;
  }

  private listLiteral(node: Node): Expr {
    const row = node.startPosition.row;
    const items: (ListItem | undefined)[] = [];
    let expectingItem = true;
    let keyed = false;
    let pendingKey: Expr | undefined;
    for (const child of node.children) {
      if (child.type === ',') {
        if (expectingItem) items.push(undefined);
        expectingItem = true;
        continue;
      }
      if (child.type === '=>') continue;
      if (!child.isNamed || child.type === 'comment') continue;
      // A key is followed by `=>`.
      const next = child.nextSibling;
      if (next?.type === '=>') {
        pendingKey = this.expr(child);
        keyed = true;
        continue;
      }
      let byRef = false;
      let target = child;
      if (child.type === 'by_ref') {
        byRef = true;
        target = child.namedChildren[0];
      }
      const converted = target.type === 'list_literal' ? this.listLiteral(target) : this.writable(target);
      items.push({ key: pendingKey, target: converted, byRef });
      pendingKey = undefined;
      expectingItem = false;
    }
    if (items.every((item) => item === undefined))
      this.error(node, '空の list() は使えません（Cannot use empty list）。');
    if (keyed && items.some((item) => item && item.key === undefined)) {
      this.error(
        node,
        'キーのある要素とない要素を混ぜられません（Cannot mix keyed and unkeyed array entries in assignments）。'
      );
    }
    return { k: 'list', items, keyed, row };
  }

  // Strings -----------------------------------------------------------------------------------------------------------

  private singleQuoted(node: Node): string {
    const content = node.namedChildren
      .filter((child) => child.type === 'string_content' || child.type === 'escape_sequence')
      .map((child) => child.text)
      .join('');
    const text = node.text;
    // The grammar keeps escapes in the content; only \\ and \' are escapes in single quotes.
    const raw = text.startsWith("'") || /^[bB]'/.test(text) ? text.slice(text.indexOf("'") + 1, -1) : content;
    return enc(raw.replaceAll(/\\([\\'])/g, '$1'));
  }

  private nowdoc(node: Node): string {
    const body = node.childForFieldName('value');
    const end = node.childForFieldName('end_tag') as Node;
    const indent = end.startPosition.column;
    let raw = body ? this.source.slice(body.startIndex, body.endIndex) : '';
    raw = raw.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
    return enc(this.removeIndent(raw, indent, end));
  }

  private removeIndent(raw: string, indent: number, end: Node): string {
    if (indent === 0) return raw;
    const lines = raw.split('\n');
    return lines
      .map((line) => {
        const leading = /^[ \t]*/.exec(line)?.[0] ?? '';
        if (leading.length < indent && line.trim() !== '') {
          this.error(
            end,
            `ヒアドキュメントの行の字下げが、終わりの印より浅くなっています（Invalid body indentation level (expecting an indentation level of at least ${indent})）。`
          );
        }
        return line.slice(Math.min(indent, leading.length));
      })
      .join('\n');
  }

  /**
   * Converts a double-quoted string or heredoc, reading its literal text from the source between the interpolated
   * expressions, since the grammar leaves line breaks out of its content nodes.
   */
  // code-gauge-allow functionCognitiveComplexity 25 -- Interpolation follows each grammar part of a string.
  private interpolated(node: Node): Expr {
    const row = node.startPosition.row;
    const isHeredoc = node.type === 'heredoc';
    const container = isHeredoc ? node.childForFieldName('value') : node;
    const end = isHeredoc ? (node.childForFieldName('end_tag') as Node) : undefined;
    const indent = end ? end.startPosition.column : 0;
    const parts: (string | Expr)[] = [];
    if (!container) return { k: 'lit', v: '', row };
    const children = container.children;
    let cursor = isHeredoc ? container.startIndex : (children[0]?.endIndex ?? container.startIndex);
    let limit = isHeredoc ? container.endIndex : (children.at(-1)?.startIndex ?? container.endIndex);
    if (isHeredoc) {
      // The body runs from the line after the opening marker to the line break before the closing one.
      if (this.source.startsWith('\r\n', cursor)) cursor += 2;
      else if (this.source[cursor] === '\n') cursor++;
      if (this.source[limit - 1] === '\n') limit -= this.source[limit - 2] === '\r' ? 2 : 1;
    }
    let raw = '';
    let rawAtLineStart = isHeredoc;
    const flush = (): void => {
      if (raw === '') return;
      const text = isHeredoc && indent > 0 ? this.dedent(raw, indent, rawAtLineStart, end as Node) : raw;
      parts.push(decodeLiteral(text, !isHeredoc));
      raw = '';
    };
    let braced = false;
    for (const child of children) {
      if (child.startIndex < cursor || child.endIndex > limit) continue;
      if (child.type === 'string_content' || child.type === 'string_value' || child.type === 'escape_sequence')
        continue;
      if (!child.isNamed && child.type !== '{' && child.type !== '}') continue;
      if (child.type === '{' || child.type === '}') {
        if (child.type === '{') {
          raw += this.source.slice(cursor, child.startIndex);
          braced = true;
        }
        cursor = child.endIndex;
        continue;
      }
      if (child.type === 'comment') continue;
      raw += this.source.slice(cursor, child.startIndex);
      flush();
      parts.push(braced ? this.expr(child) : this.simpleInterpolation(child));
      braced = false;
      cursor = child.endIndex;
      rawAtLineStart = false;
    }
    raw += this.source.slice(cursor, limit);
    flush();
    if (parts.every((part) => typeof part === 'string')) return { k: 'lit', v: parts.join(''), row };
    return { k: 'interp', parts, row };
  }

  /** Converts a variable written in a string without braces, where `$a[key]` names the key `'key'`. */
  private simpleInterpolation(node: Node): Expr {
    if (node.type === 'subscript_expression') {
      const [baseNode, indexNode] = node.namedChildren.filter((child) => child.type !== 'comment');
      const row = node.startPosition.row;
      if (indexNode?.type === 'name') {
        return { k: 'idx', base: this.expr(baseNode), index: { k: 'lit', v: enc(indexNode.text), row }, row };
      }
      if (indexNode?.type === 'integer' || indexNode?.type === 'unary_op_expression') {
        const text = indexNode.text.replaceAll(/\s+/g, '');
        // PHP reads a decimal key without leading zeros as an int and any other digits as a string.
        const value = /^-?(0|[1-9]\d*)$/.test(text) ? BigInt(text) : enc(text);
        return { k: 'idx', base: this.expr(baseNode), index: { k: 'lit', v: value, row }, row };
      }
    }
    return this.expr(node);
  }

  private dedent(raw: string, indent: number, atLineStart: boolean, end: Node): string {
    const lines = raw.split('\n');
    return lines
      .map((line, index) => {
        if (index === 0 && !atLineStart) return line;
        const leading = /^[ \t]*/.exec(line)?.[0] ?? '';
        if (leading.length < indent && line.trim() !== '' && !(index === lines.length - 1 && line === leading)) {
          this.error(
            end,
            `ヒアドキュメントの行の字下げが、終わりの印より浅くなっています（Invalid body indentation level (expecting an indentation level of at least ${indent})）。`
          );
        }
        return line.slice(Math.min(indent, leading.length));
      })
      .join('\n');
  }
}

/** Whether an expression statement only calls functions or creates objects, whose own steps show what it did. */
function onlyCalls(e: Expr): boolean {
  if (e.k === 'assign') return e.target.k !== 'list' && isObjectCreation(e.value);
  return e.k === 'call' || e.k === 'mcall' || e.k === 'scall' || isObjectCreation(e);
}

/** Whether an expression only creates objects (`new`, or an array literal of them), whose constructors' steps show it. */
function isObjectCreation(e: Expr): boolean {
  if (e.k === 'array')
    return e.items.length > 0 && e.items.every((item) => !item.spread && !item.byRef && isObjectCreation(item.value));
  return e.k === 'new' || e.k === 'newAnon';
}

function typeAllowsNull(type: TypeDecl): boolean {
  if (type.k === 'named') return type.nullable === true || type.name === 'null' || type.name === 'mixed';
  if (type.k === 'union') return type.types.some(typeAllowsNull);
  return false;
}

export function parseIntegerLiteral(text: string): bigint | number {
  const clean = text.replaceAll('_', '');
  let value: bigint;
  if (/^0[xX]/.test(clean)) value = BigInt(clean);
  else if (/^0[bB]/.test(clean)) value = BigInt(clean);
  else if (/^0[oO]/.test(clean)) value = BigInt(`0o${clean.slice(2)}`);
  else if (/^0\d/.test(clean)) value = BigInt(`0o${clean.slice(1)}`);
  else value = BigInt(clean);
  if (value > 9_223_372_036_854_775_807n) {
    if (/^0[xXbBoO]|^0\d/.test(clean)) return Number(value);
    return Number.parseFloat(clean);
  }
  return value;
}

const SIMPLE_ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  v: '\v',
  e: '\u001B',
  f: '\f',
  '\\': '\\',
  $: '$',
};

/** Decodes one escape sequence of a double-quoted string or heredoc, as bytes. */
function decodeEscape(text: string, doubleQuoted: boolean): string {
  const body = text.slice(1);
  if (body === '"') return doubleQuoted ? '"' : String.raw`\"`;
  if (body in SIMPLE_ESCAPES) return SIMPLE_ESCAPES[body];
  if (/^[0-7]{1,3}$/.test(body)) return String.fromCharCode(Number.parseInt(body, 8) & 0xff);
  if (/^x[0-9A-Fa-f]{1,2}$/.test(body)) return String.fromCharCode(Number.parseInt(body.slice(1), 16));
  const unicode = /^u\{([0-9A-Fa-f]+)\}$/.exec(body);
  if (unicode) return codePointBytes(Number.parseInt(unicode[1], 16));
  return enc(text);
}

/** Decodes the escapes of a literal part of a double-quoted string or heredoc into bytes. */
function decodeLiteral(raw: string, doubleQuoted: boolean): string {
  let result = '';
  let last = 0;
  for (const match of raw.matchAll(/\\(u\{[0-9A-Fa-f]+\}|x[0-9A-Fa-f]{1,2}|[0-7]{1,3}|[ntrvef\\$"])/g)) {
    result += enc(raw.slice(last, match.index)) + decodeEscape(match[0], doubleQuoted);
    last = match.index + match[0].length;
  }
  return result + enc(raw.slice(last));
}

/** Whether a hook body refers to the property it belongs to through `$this->name`. */
function referencesProperty(node: Node, name: string): boolean {
  if (node.type === 'member_access_expression' || node.type === 'nullsafe_member_access_expression') {
    const object = node.childForFieldName('object');
    const member = node.childForFieldName('name');
    if (
      object?.type === 'variable_name' &&
      object.text === '$this' &&
      member?.type === 'name' &&
      member.text === name
    ) {
      return true;
    }
  }
  return node.namedChildren.some((child) => referencesProperty(child, name));
}

/** The variables an arrow function's body reads, which it captures by value from where it is defined. */
function collectVariables(e: Expr, params: Set<string>, found = new Set<string>()): Set<string> {
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const node = value as { k?: string; name?: unknown; fn?: FunctionDecl; uses?: { name: string }[] };
    if (node.k === 'var' && typeof node.name === 'string') {
      if (!params.has(node.name) && node.name !== 'this') found.add(node.name);
      return;
    }
    if (node.k === 'closure') {
      for (const use of node.uses ?? []) if (!params.has(use.name)) found.add(use.name);
      return;
    }
    if (node.k === 'arrow' && node.fn) {
      for (const name of node.fn.captures ?? []) if (!params.has(name)) found.add(name);
      return;
    }
    for (const [key, child] of Object.entries(node)) if (key !== 'row') visit(child);
  };
  visit(e);
  return found;
}

/** Whether a label sits inside a loop or switch of the statements, which `goto` may not jump into. */
function labelInsideLoop(statements: Stmt[], label: string, inLoop: boolean): boolean {
  for (const statement of statements) {
    if (statement.k === 'label' && statement.name === label) return inLoop;
    for (const [nested, isLoop] of nestedBodies(statement)) {
      if (labelInsideLoop(nested, label, inLoop || isLoop)) return true;
    }
  }
  return false;
}

export function nestedBodies(statement: Stmt): [Stmt[], boolean][] {
  switch (statement.k) {
    case 'if': {
      return statement.alternate
        ? [
            [statement.consequent, false],
            [statement.alternate, false],
          ]
        : [[statement.consequent, false]];
    }
    case 'while':
    case 'do':
    case 'for':
    case 'foreach': {
      return [[statement.body, true]];
    }
    case 'switch': {
      return statement.cases.map((item) => [item.body, true]);
    }
    case 'block': {
      return [[statement.body, false]];
    }
    case 'try': {
      const bodies: [Stmt[], boolean][] = [
        [statement.body, false],
        ...statement.catches.map((item): [Stmt[], boolean] => [item.body, false]),
      ];
      if (statement.fin) bodies.push([statement.fin, false]);
      return bodies;
    }
    default: {
      return [];
    }
  }
}

/** The variables top-level code names, in order of first appearance, skipping function and class bodies. */
function collectMainVars(body: Stmt[]): Set<string> {
  const found = new Set<string>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const node = value as { k?: string; name?: unknown; uses?: { name: string }[]; fn?: FunctionDecl; decl?: unknown };
    if (node.k === 'func' || node.k === 'class' || node.k === 'newAnon') return;
    if (node.k === 'var' && typeof node.name === 'string') {
      if (node.name !== 'this') found.add(node.name);
      return;
    }
    if (node.k === 'closure') {
      for (const use of node.uses ?? []) found.add(use.name);
      return;
    }
    if (node.k === 'arrow') {
      for (const name of node.fn?.captures ?? []) found.add(name);
      return;
    }
    for (const [key, child] of Object.entries(node)) if (key !== 'row') visit(child);
  };
  visit(body);
  return found;
}

/**
 * Rejects `$a[]` where a value is read, which PHP reports before running: it only appends in writes such as
 * assignments, references, foreach targets, and arguments a function may take by reference.
 */
function validateReads(body: Stmt[]): void {
  const visit = (value: unknown, writing: boolean): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, writing);
      return;
    }
    const node = value as Record<string, unknown> & { k?: string; row?: number };
    switch (node.k) {
      case 'idx': {
        if (node.index === undefined && !writing) {
          throw new CompileError([
            { row: node.row ?? 0, message: '[] で読み出すことはできません（Cannot use [] for reading）。' },
          ]);
        }
        visit(node.base, writing);
        visit(node.index, false);
        return;
      }
      case 'assign':
      case 'assignOp': {
        visit(node.target, true);
        visit(node.value, false);
        return;
      }
      case 'assignRef': {
        visit(node.target, true);
        visit(node.source, true);
        return;
      }
      case 'incdec': {
        visit(node.target, true);
        return;
      }
      case 'foreach': {
        visit(node.subject, Boolean(node.byRef));
        visit(node.key, true);
        visit(node.value, true);
        visit(node.body, false);
        return;
      }
      case 'list': {
        for (const item of (node.items as ({ key?: unknown; target: unknown } | undefined)[]) ?? []) {
          if (!item) continue;
          visit(item.key, false);
          visit(item.target, true);
        }
        return;
      }
      case 'call':
      case 'mcall':
      case 'scall':
      case 'new': {
        for (const [key, child] of Object.entries(node)) {
          if (key === 'args') for (const arg of child as { e: unknown }[]) visit(arg.e, true);
          else if (key !== 'row') visit(child, false);
        }
        return;
      }
      case 'array': {
        for (const item of node.items as { key?: unknown; value: unknown; byRef: boolean }[]) {
          visit(item.key, false);
          visit(item.value, item.byRef);
        }
        return;
      }
      case 'unset': {
        for (const target of node.targets as { k: string; index?: unknown; row: number }[]) {
          if (target.k === 'idx' && target.index === undefined) {
            throw new CompileError([
              { row: target.row, message: '[] で unset することはできません（Cannot use [] for unsetting）。' },
            ]);
          }
          visit(target, true);
        }
        return;
      }
      default: {
        for (const [key, child] of Object.entries(node)) {
          if (key !== 'row') visit(child, false);
        }
      }
    }
  };
  visit(body, false);
}
