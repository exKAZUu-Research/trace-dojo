// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import type { Node } from '@willbooster/web-tree-sitter';

import { CompileError } from '../interpreter/diagnostics';
import type { ExecutionBudget } from '../interpreter/limits';
import type {
  Arg,
  ArrayItem,
  CatchClause,
  Expr,
  ListItem,
  MatchArm,
  Program,
  ResolvedName,
  Stmt,
  SwitchCase,
} from './ast';
import {
  collectScopeVars,
  collectVariables,
  hasNullsafeReceiver,
  hasReferenceItem,
  invalidRead,
  isWritableFetchBase,
  onlyCalls,
} from './astAnalysis';
import { oneArgumentBuiltinOpcodes, simpleSprintfFormat, simpleSprintfParts } from './builtinCompiler';
import { enc, lower } from './bytes';
import { type Constant, constantTruth, constantTypeName, foldedConstant, scalarString } from './constantDefaults';
import { formatFloat, isNumericString, NAN_BOOL_WARNING, NAN_STRING_WARNING, normalizeKeyString } from './conversions';
import {
  type CompileNotice,
  isReservedClassName,
  MAGIC_RUNTIME,
  PHP_NUMBER,
  relativeClassName,
  reservedIdentifierToken,
  semanticChildren,
  unexpectedTextToken,
} from './converterBase';
import { DeclarationConverter } from './declarationConverter';
import { exportExpr, UnexportableSyntax } from './export';
import { decodeLiteral, decodeSingleQuoted, parseIntegerLiteral } from './literals';
import { builtinLiteralKey } from './native';
import { compiledOperandRow, operandAstRow, recordOperandRows } from './opcodeRows';

export type { CompileNotice } from './converterBase';

const EQUALITY_OPERATORS = new Set(['==', '!=', '===', '!==', '<>', '<=>']);
const ORDER_OPERATORS = new Set(['<', '<=', '>', '>=']);
const COMMUTATIVE_OPCODES = new Set(['*', '&', '|', '^', '==', '!=', '===', '!==']);
const CALL_EXPRESSIONS = new Set([
  'function_call_expression',
  'member_call_expression',
  'nullsafe_member_call_expression',
  'scoped_call_expression',
  'exit_expression',
]);
const VARIABLE_OPCODE_RESULTS = new Set<Expr['k']>(['call', 'mcall', 'scall', 'new', 'newAnon', 'assignRef']);

export class Converter extends DeclarationConverter {
  private declaredSymbols = new Map<string, Map<string, string>>();
  private readonly staticNames = new WeakMap<object, Set<string>>();
  private readonly body: Stmt[] = [];
  private namespaceStyle?: 'bracketed' | 'unbracketed';

  constructor(
    source: string,
    atomicRows: ReadonlySet<number>,
    private readonly ignoredPrefix: number,
    protected override readonly preserveSyntax = false,
    budget?: ExecutionBudget
  ) {
    super(source, atomicRows, budget);
  }

  convertProgram(root: Node): Program {
    try {
      this.compileTopLevel(root);
    } catch (error) {
      if (error instanceof CompileError) this.checkReadContexts();
      throw error;
    }
    this.checkReadContexts();
    this.checkGotos(this.fn, this.body);
    return {
      ...this.compiledPrefix(),
      mainVars: [...collectScopeVars(this.body)],
    };
  }

  private compileTopLevel(root: Node): void {
    const firstTag = root.namedChildren.find((child) => child.type === 'php_tag');
    const text = this.source.slice(this.ignoredPrefix, firstTag?.startIndex ?? this.source.length);
    if (text !== '') {
      this.body.push({ k: 'inline', text: enc(text), row: this.ignoredPrefix === 0 ? 0 : 1 });
    }
    for (const child of root.namedChildren) {
      if (!['text', 'php_tag', 'php_end_tag', 'comment'].includes(child.type)) {
        this.appendTopLevel(child, true);
      }
    }
  }

  private appendTopLevel(node: Node, fileScope = false): void {
    if (node.type === 'compound_statement' && !this.preserveSyntax) {
      for (const child of semanticChildren(node)) this.appendTopLevel(child, fileScope);
      return;
    }
    this.body.push(...this.statement(node, true));
    if (
      fileScope &&
      this.namespaceStyle === 'bracketed' &&
      node.type !== 'namespace_definition' &&
      !this.namespaceTrivia(node)
    ) {
      this.error(namespaceDiagnosticRow(node), 'No code may exist outside of namespace {}');
    }
  }

  private checkReadContexts(): void {
    const failure = invalidRead(this.body);
    if (!failure) return;
    this.body.length = failure.index;
    throw failure.error;
  }

  compiledPrefix(): Program {
    return {
      body: this.body,
      strictTypes: this.strictTypes,
      hasGoto: this.fn.gotos.length > 0,
      mainVars: [],
    };
  }

  // Errors ------------------------------------------------------------------------------------------------------------

  protected block(node: Node | null | undefined): Stmt[] {
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

  private statement(node: Node, topLevel: boolean): Stmt[] {
    const row = node.startPosition.row;
    switch (node.type) {
      case 'expression_statement': {
        const expression = node.namedChildren.find((child) => child.type !== 'comment');
        if (!expression) return [{ k: 'nop', row }];
        const e = this.expr(expression);
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
        const body = this.loopBody(() => this.controlBody(node));
        return [{ k: 'while', cond, body, row }];
      }
      case 'do_statement': {
        const body = this.loopBody(() => this.controlBody(node));
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
        const body = this.loopBody(() => this.controlBody(node));
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
        if (names.some((name) => name.k === 'var' && name.name === 'this')) {
          this.error(node, '$this は global にできません（Cannot use $this as global variable）。');
        }
        return [{ k: 'global', names, row }];
      }
      case 'function_static_declaration': {
        const vars = node.namedChildren
          .filter((child) => child.type === 'static_variable_declaration')
          .map((child) => {
            const nameNode = child.childForFieldName('name') as Node;
            const name = this.variableName(nameNode);
            if (name === 'this') this.error(nameNode, 'Cannot use $this as static variable');
            const value = child.childForFieldName('value');
            const init = value ? this.initializerExpr(value, 'static') : undefined;
            return {
              name,
              init,
              preview: init && this.fn.isClosure ? this.compiledValue(init, true) : undefined,
            };
          });
        let names = this.staticNames.get(this.fn);
        if (!names) {
          names = new Set();
          this.staticNames.set(this.fn, names);
        }
        for (const variable of vars) {
          if (names.has(variable.name)) this.error(node, `Duplicate declaration of static variable $${variable.name}`);
          names.add(variable.name);
        }
        return [{ k: 'static', vars, row }];
      }
      case 'unset_statement': {
        const targets = node.namedChildren
          .filter((child) => child.type !== 'comment')
          .map((child) => this.writable(child));
        for (const target of targets) {
          if (target.k === 'var' && target.name === 'this') this.error(node, '$this は unset できません。');
        }
        return [{ k: 'unset', targets, row }];
      }
      case 'function_definition': {
        const nameNode = node.childForFieldName('name') as Node;
        const name =
          lower(nameNode.text) === 'readonly' ? this.nameText(nameNode) : this.declaredIdentifier(nameNode, '"("');
        if (this.namespace === '' && lower(name) === '__autoload')
          this.error(node, '__autoload() is no longer supported, use spl_autoload_register() instead');
        this.declareSymbol(node, 'function', name);
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
        this.declareSymbol(node, 'class', this.nameText(node.childForFieldName('name') as Node));
        return [{ k: 'class', decl: this.classDecl(node, false, topLevel), row }];
      }
      case 'enum_declaration': {
        this.checkUnscopedModifiers(node);
        if (this.currentClass !== undefined) this.error(node, 'Class declarations may not be nested');
        this.unsupported(node, '列挙型（enum）');
        break;
      }
      case 'const_declaration': {
        this.checkUnscopedModifiers(node);
        if (!topLevel || isPlainBlockChild(node)) this.error(node, 'syntax error, unexpected token "const"');
        let declarationRow: number | undefined;
        let opcodeRow: number | undefined;
        const items = node.namedChildren
          .filter((child) => child.type === 'const_element')
          .map((child) => {
            const [nameNode, valueNode] = child.namedChildren.filter((part) => part.type !== 'comment');
            const name = this.declaredIdentifier(nameNode);
            const word = lower(name);
            if (['null', 'true', 'false'].includes(word)) this.error(nameNode, `Cannot redeclare constant '${name}'`);
            if (
              MAGIC_RUNTIME.has(word.toUpperCase()) ||
              ['__line__', '__file__', '__dir__', '__namespace__', '__property__'].includes(word)
            )
              this.error(nameNode, `syntax error, unexpected token "${name}", expecting identifier`);
            this.declareSymbol(nameNode, 'const', name);
            declarationRow ??= nameNode.startPosition.row;
            const value = this.constantExpr(valueNode, true);
            opcodeRow = this.constantCompileRow(value, opcodeRow ?? declarationRow);
            return { name: this.qualify(name), value, opcodeRow };
          });
        return [{ k: 'const', items, row: declarationRow ?? row }];
      }
      case 'named_label_statement': {
        const name = this.nameText(semanticChildren(node)[0]);
        if (this.fn.labels.has(name))
          this.error(node, `ラベル「${name}」は、すでに使われています（Label '${name}' already defined）。`);
        this.fn.labels.add(name);
        return [{ k: 'label', name, row }];
      }
      case 'goto_statement': {
        const label = this.nameText(semanticChildren(node)[0]);
        this.fn.gotos.push({ label, row, offset: node.startIndex });
        return [{ k: 'goto', label, row, offset: node.startIndex }];
      }
      case 'declare_statement': {
        return this.declareStatement(node, topLevel);
      }
      case 'namespace_definition': {
        return this.namespaceDefinition(node);
      }
      case 'namespace_use_declaration': {
        if (!topLevel || isPlainBlockChild(node)) this.error(node, 'syntax error, unexpected token "use"');
        this.useDeclaration(node);
        return [];
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
    const limit = tag ? tag.startIndex : (node.nextSibling?.startIndex ?? this.source.length);
    let text = this.source.slice(end.endIndex, limit);
    // PHP swallows the single newline that directly follows a closing tag.
    if (text.startsWith('\r\n')) text = text.slice(2);
    else if (text.startsWith('\n') || text.startsWith('\r')) text = text.slice(1);
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

  private loopBody<T>(convert: () => T, isSwitch = false): T {
    const outer = this.loop;
    this.loop = { depth: outer.depth + 1, switches: [...outer.switches, isSwitch] };
    try {
      return convert();
    } finally {
      this.loop = outer;
    }
  }

  private ifStatement(node: Node): Stmt {
    const row = node.startPosition.row;
    const cond = this.condition(node);
    const consequent = this.controlBody(node);
    const alternate = this.alternatives(node.childrenForFieldName('alternative'));
    return { k: 'if', cond, consequent, alternate, row };
  }

  private alternatives(clauses: Node[]): Stmt[] | undefined {
    const [clause, ...rest] = clauses;
    if (!clause) return undefined;
    const body = this.controlBody(clause);
    if (clause.type === 'else_clause') {
      const nested = body[0];
      if (this.preserveSyntax && nested?.k === 'if' && clause.childForFieldName('body')?.type === 'if_statement')
        nested.continuation = 'else if';
      return body;
    }
    return [
      {
        k: 'if',
        cond: this.condition(clause),
        consequent: body,
        alternate: this.alternatives(rest),
        continuation: this.preserveSyntax ? 'elseif' : undefined,
        row: clause.startPosition.row,
      },
    ];
  }

  private controlBody(node: Node): Stmt[] {
    return this.blockOf(node.childrenForFieldName('body'));
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
      valueNode = semanticChildren(valueNode)[0];
    }
    const value = ['list_literal', 'array_creation_expression'].includes(valueNode.type)
      ? this.listLiteral(valueNode)
      : this.writable(valueNode);
    const body = this.loopBody(() => this.controlBody(node));
    return { k: 'foreach', subject, subjectEndRow: parts[0].endPosition.row, key, value, byRef, body, row };
  }

  // code-gauge-allow functionCognitiveComplexity 24 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
  private switchStatement(node: Node): Stmt {
    const row = node.startPosition.row;
    const subject = this.condition(node);
    const block = node.childForFieldName('body') as Node;
    for (const child of block.namedChildren) {
      if (child.type === 'case_statement' || child.type === 'default_statement') break;
      if (child.type === 'comment') continue;
      if (child.type === 'text_interpolation' && this.inlineText(child) === '') continue;
      this.error(child, 'syntax error, unexpected text before switch case');
    }
    let defaults = 0;
    const cases = this.loopBody(
      () =>
        block.namedChildren
          .filter((child) => ['case_statement', 'default_statement'].includes(child.type))
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
            if (!child.children.some((part) => part.type === ':')) {
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
          }),
      true
    );
    return { k: 'switch', subject, cases, row };
  }

  private breakStatement(node: Node): Stmt {
    const kind = node.type === 'break_statement' ? 'break' : 'continue';
    const argument = node.namedChildren.find((child) => child.type !== 'comment');
    let depth = 1;
    if (argument) {
      const level = unparenthesizedNode(argument);
      if (level.type !== 'integer')
        this.error(
          node,
          `'${kind}' の後には正の整数しか書けません（'${kind}' operator with non-integer operand is no longer supported）。`
        );
      depth = Number(parseIntegerLiteral(level.text));
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
    if (kind === 'continue' && this.loop.switches.at(-depth)) this.warnContinueInSwitch(node, depth);
    return {
      k: kind,
      depth,
      explicitDepth: this.preserveSyntax && argument ? true : undefined,
      row: node.startPosition.row,
    };
  }

  private warnContinueInSwitch(node: Node, depth: number): void {
    const levels = depth > 1 ? ` ${depth}` : '';
    const hasOuterTarget = this.loop.switches.length > depth;
    this.notices.push({
      level: 'Warning',
      message: `"continue${levels}" targeting switch is equivalent to "break${levels}"${hasOuterTarget ? `. Did you mean to use "continue ${depth + 1}"?` : ''}`,
      row: node.startPosition.row,
    });
  }

  private returnStatement(node: Node): Stmt {
    const argument = node.namedChildren.find((child) => child.type !== 'comment');
    const row = node.startPosition.row;
    const type = this.fn.returnType;
    if (type?.k === 'named' && !type.nullable) {
      if (argument) this.checkVoidReturn(argument);
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
    const expression = argument ? this.expr(argument) : undefined;
    if (argument && expression) this.checkReferenceReturn(argument, expression);
    return { k: 'return', e: expression, row };
  }

  // code-gauge-allow functionCognitiveComplexity 18 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
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
          .map((type) => {
            const name = type.type === 'named_type' ? semanticChildren(type)[0] : type;
            const raw = this.nameText(name);
            if (relativeClassName(raw)) this.error(type, 'Bad class name in the catch statement');
            return this.namedClass(name);
          });
        const nameNode = child.childForFieldName('name');
        const varName = nameNode ? this.variableName(nameNode) : undefined;
        if (varName === 'this') this.error(nameNode as Node, 'Cannot re-assign $this');
        catches.push({
          types,
          varName,
          body: this.block(child.childForFieldName('body')),
          row: child.startPosition.row,
        });
      } else if (child.type === 'finally_clause') {
        fin = this.block(child.childForFieldName('body'));
      }
    }
    return { k: 'try', body, catches, fin, row };
  }

  // code-gauge-allow functionCognitiveComplexity 29 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
  private declareStatement(node: Node, topLevel: boolean): Stmt[] {
    for (const directive of node.namedChildren.filter((child) => child.type === 'declare_directive')) {
      const name = (directive.childForFieldName('name') as Node).text;
      const key = lower(name);
      const valueNode = directive.childForFieldName('value') as Node;
      const value = this.expr(valueNode);
      if (!directiveLiteral(valueNode, value))
        this.error(
          valueNode,
          key === 'encoding' ? 'Encoding must be a literal' : `declare(${name}) value must be a literal`
        );
      if (key === 'strict_types') {
        if (
          !topLevel ||
          isPlainBlockChild(node) ||
          (node.parent?.type === 'program' && this.hasLeadingText(node.parent)) ||
          node.parent?.namedChildren.some(
            (child) =>
              child.endIndex <= node.startIndex &&
              !this.ignoredText(child) &&
              !['php_tag', 'comment', 'declare_statement'].includes(child.type)
          ) ||
          node.namedChildren.some((child) => child.type !== 'declare_directive' && child.type !== 'comment')
        ) {
          this.error(
            node,
            'strict_types は、ファイルの最初の文として、ブロックなしで書いてください（strict_types declaration must be the very first statement in the script）。'
          );
        }
        if (value.k !== 'lit' || (value.v !== 0n && value.v !== 1n)) {
          this.error(
            node,
            'strict_types の値は 0 か 1 です（strict_types declaration must have 0 or 1 as its value）。'
          );
        }
        this.strictTypes = value.v === 1n;
      } else if (key === 'encoding') {
        if (
          !topLevel ||
          isPlainBlockChild(node) ||
          (node.parent?.type === 'program' && this.hasLeadingText(node.parent)) ||
          node.parent?.namedChildren.some(
            (child) =>
              child.endIndex <= node.startIndex &&
              !this.ignoredText(child) &&
              !['php_tag', 'comment', 'declare_statement'].includes(child.type)
          )
        )
          this.error(node, 'Encoding declaration pragma must be the very first statement in the script');
        this.notices.push({
          level: 'Warning',
          message: 'declare(encoding=...) ignored because Zend multibyte feature is turned off by settings',
          row: node.startPosition.row,
        });
      } else if (key !== 'ticks') {
        this.notices.push({
          level: 'Warning',
          message: `Unsupported declare '${name}'`,
          row: directive.startPosition.row,
        });
      }
    }
    const body = node.namedChildren.filter((child) => child.type !== 'declare_directive' && child.type !== 'comment');
    return this.blockOf(body);
  }

  private selectNamespaceStyle(node: Node, root: Node, body: Node | null): void {
    const style = body ? 'bracketed' : 'unbracketed';
    if (this.namespaceStyle && this.namespaceStyle !== style)
      this.error(
        namespaceDiagnosticRow(node),
        'Cannot mix bracketed namespace declarations with unbracketed namespace declarations'
      );
    if (
      !this.namespaceStyle &&
      (this.hasLeadingText(root) ||
        root.namedChildren.some(
          (child) =>
            child.endIndex <= node.startIndex && child.type !== 'declare_statement' && !this.namespaceTrivia(child)
        ))
    )
      this.error(
        namespaceDiagnosticRow(node),
        'Namespace declaration statement has to be the very first statement or after any declare call in the script'
      );
    this.namespaceStyle = style;
  }

  private hasLeadingText(root: Node): boolean {
    const firstTag = root.namedChildren.find((child) => child.type === 'php_tag');
    return firstTag !== undefined && firstTag.startIndex > this.ignoredPrefix;
  }

  private namespaceTrivia(node: Node): boolean {
    if (this.ignoredText(node)) return true;
    if (['php_tag', 'php_end_tag', 'comment', 'empty_statement'].includes(node.type)) return true;
    return node.type === 'text_interpolation' && this.inlineText(node) === '';
  }

  private ignoredText(node: Node): boolean {
    return node.type === 'text' && node.endIndex <= this.ignoredPrefix;
  }

  private namespaceDefinition(node: Node): Stmt[] {
    if (node.parent?.type !== 'program')
      this.error(namespaceDiagnosticRow(node), 'Namespace declarations cannot be nested');
    const nameNode = node.childForFieldName('name');
    const body = node.childForFieldName('body');
    this.selectNamespaceStyle(node, node.parent, body);
    const name = nameNode ? this.nameText(nameNode) : '';
    if (name.startsWith('\\'))
      this.error(nameNode as Node, `syntax error, unexpected fully qualified name "${name}", expecting "{"`);
    if (lower(name) === 'namespace' || lower(name).startsWith('namespace\\')) {
      this.error(node, `名前空間の名前に「${name}」は使えません。`);
    }
    this.namespace = name;
    this.classImports = new Map();
    this.functionImports = new Map();
    this.constImports = new Map();
    this.declaredSymbols = new Map();
    if (!body) return [];
    for (const child of body.namedChildren) this.appendTopLevel(child);
    this.namespace = '';
    this.classImports = new Map();
    this.functionImports = new Map();
    this.constImports = new Map();
    this.declaredSymbols = new Map();
    return [];
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
      const expected = group
        ? `identifier or namespaced name${kind === 'class' && !clauseKind ? ' or "function" or "const"' : ''}`
        : '';
      const raw = this.declaredIdentifier(target, expected).replace(/^\\/, '');
      const full = prefix ? `${prefix}\\${raw}` : raw;
      const aliasNode = clause.childForFieldName('alias');
      if (this.namespace === '' && !aliasNode && !full.includes('\\')) {
        this.notices.push({
          level: 'Warning',
          message: `The use statement with non-compound name '${full}' has no effect`,
          row: clause.startPosition.row,
        });
      }
      const alias = aliasNode ? this.declaredIdentifier(aliasNode) : (full.split('\\').at(-1) as string);
      if (effective === 'class' && isReservedClassName(alias))
        this.error(clause, `Cannot use ${full} as ${alias} because '${alias}' is a special class name`);
      const imports = this.importsFor(effective);
      const key = effective === 'const' ? alias : lower(alias);
      const declared = this.declaredSymbols.get(effective)?.get(key);
      const same = declared && (effective === 'const' ? declared === full : lower(declared) === lower(full));
      if (imports.has(key) || (declared && !same)) {
        this.error(
          node,
          `Cannot use ${effective === 'class' ? '' : `${effective} `}${full} as ${alias} because the name is already in use`
        );
      }
      imports.set(key, full);
    }
  }

  private importsFor(kind: string): Map<string, string> {
    return kind === 'function' ? this.functionImports : kind === 'const' ? this.constImports : this.classImports;
  }

  private declareSymbol(node: Node, kind: string, name: string): void {
    const key = kind === 'const' ? name : lower(name);
    const full = this.qualify(name);
    const imported = this.importsFor(kind).get(key);
    if (imported && (kind === 'const' ? imported !== full : lower(imported) !== lower(full))) {
      this.error(
        node,
        `Cannot redeclare ${kind} ${full}${kind === 'function' ? '()' : ''} (previously declared as local import)`
      );
    }
    let symbols = this.declaredSymbols.get(kind);
    if (!symbols) {
      symbols = new Map();
      this.declaredSymbols.set(kind, symbols);
    }
    symbols.set(key, full);
  }

  private sequence(node: Node): Expr[] {
    if (node.type === 'sequence_expression') {
      return node.namedChildren.filter((child) => child.type !== 'comment').flatMap((child) => this.sequence(child));
    }
    return [this.expr(node)];
  }

  /** Converts an expression that a statement writes to. */
  private writable(node: Node): Expr {
    const e = this.expr(node);
    this.checkWritable(e, node);
    return e;
  }

  private checkWritable(e: Expr, node: Node, acquireReference = false): void {
    if (hasNullsafeReceiver(e)) {
      this.error(
        node,
        acquireReference ? 'Cannot take reference of a nullsafe chain' : "Can't use nullsafe operator in write context"
      );
    }
    switch (e.k) {
      case 'var': {
        if (e.name === 'this') this.error(node, '$this には代入できません（Cannot re-assign $this）。');
        if (e.name === 'GLOBALS') {
          this.error(
            node,
            acquireReference
              ? 'Cannot acquire reference to $GLOBALS'
              : '$GLOBALS can only be modified using the $GLOBALS[$name] = $value syntax'
          );
        }
        return;
      }
      case 'idx': {
        if (e.base.k === 'var' && e.base.name === 'GLOBALS' && e.index === undefined)
          this.error(node, 'Cannot append to $GLOBALS');
        this.checkWriteBase(e.base, node);
        return;
      }
      case 'prop': {
        this.checkWriteBase(e.obj, node);
        return;
      }
      case 'varvar':
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

  private checkWriteBase(base: Expr, node: Node): void {
    if (base.k === 'idx' || base.k === 'prop') {
      this.checkWritable(base, node);
      return;
    }
    if (base.k === 'clone' || (base.k === 'call' && this.builtinWriteResult(base)))
      this.error(node, 'Cannot use result of built-in function in write context');
    if (isWritableFetchBase(base)) return;
    this.error(node, 'この式には代入できません（Cannot use temporary expression in write context）。');
  }

  private builtinWriteResult(call: Extract<Expr, { k: 'call' }>): boolean {
    const { fn, args, fcc } = call;
    if ('k' in fn || fcc || fn.fallback || args.some((arg) => arg.spread || arg.name !== undefined)) return false;
    const name = lower(fn.name);
    if (oneArgumentBuiltinOpcodes.has(name)) return args.length === 1;
    if (name === 'get_class') return args.length <= 1;
    if (name === 'get_called_class') return args.length === 0;
    if (name === 'func_num_args' || name === 'func_get_args') return this.fn.isFunction === true && args.length === 0;
    if (name === 'array_key_exists') return args.length === 2;
    if (name === 'sprintf') return simpleSprintfFormat(args) !== undefined;
    if (name === 'defined') {
      const value = args[0]?.e;
      return args.length === 1 && value?.k === 'lit' && (typeof value.v !== 'string' || !/[\\:]/.test(value.v));
    }
    if (name === 'in_array') return this.builtinInArray(args);
    return false;
  }

  private builtinInArray(args: Arg[]): boolean {
    if (args.length !== 2 && args.length !== 3) return false;
    const haystack = args[1].e;
    if (haystack.k !== 'array') return false;
    const values = this.compiledValue(haystack);
    if (!(values instanceof Map)) return false;
    const strict = args[2]?.e;
    if (strict && strict.k !== 'lit' && strict.k !== 'const') return false;
    const flag = strict ? this.compiledValue(strict) : false;
    if (flag === undefined) return false;
    return constantTruth(flag)
      ? [...values.values()].every((value) => typeof value === 'string' || typeof value === 'bigint')
      : [...values.values()].every((value) => typeof value === 'string' && !isNumericString(value));
  }

  expr(node: Node): Expr {
    const initializer = this.initializerContext?.kind;
    if ((initializer === 'static' || initializer === 'array') && CALL_EXPRESSIONS.has(node.type))
      return this.compileRuntimeCall(node);
    const row = node.startPosition.row;
    switch (node.type) {
      case 'parenthesized_expression': {
        const expression = this.parenthesized(node);
        if (this.preserveSyntax && expression.k === 'arrow') expression.parenthesized = true;
        return expression;
      }
      case 'integer': {
        return { k: 'lit', v: parseIntegerLiteral(node.text), row };
      }
      case 'float': {
        return { k: 'lit', v: Number.parseFloat(node.text.replaceAll('_', '')), row };
      }
      case 'boolean':
      case 'null': {
        return this.constant(node);
      }
      case 'string': {
        return { k: 'lit', v: this.singleQuoted(node), row };
      }
      case 'encapsed_string':
      case 'heredoc': {
        return this.interpolated(node);
      }
      case 'nowdoc': {
        return recordOperandRows({ k: 'lit', v: this.nowdoc(node), row }, row + 1);
      }
      case 'variable_name': {
        return this.variable(this.variableName(node), row);
      }
      case 'dynamic_variable_name': {
        return this.dynamicVariable(node);
      }
      case 'name':
      case 'qualified_name':
      case 'relative_name': {
        return this.constant(node);
      }
      case 'array_creation_expression': {
        const items = this.compileArrayItems(node);
        this.checkConstantArrayOperands(node, items);
        const arrayRow = items.length === 0 ? node.endPosition.row : row;
        return {
          k: 'array',
          items,
          row: arrayRow,
          initializerRow: this.constantInitializer ? arrayFoldRow(node) : undefined,
          mixedStorage: items.some(({ key }) => key !== undefined && this.hasStringArrayKey(key)),
        };
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
        const base = this.expr(baseNode);
        const index = indexNode ? this.expr(indexNode) : undefined;
        return { k: 'idx', base, index, row: index ? compiledOperandRow(index) : row };
      }
      case 'member_access_expression':
      case 'nullsafe_member_access_expression': {
        const obj = this.expr(node.childForFieldName('object') as Node);
        const nameNode = node.childForFieldName('name') as Node;
        const name = this.propertyName(nameNode);
        return {
          k: 'prop',
          obj,
          name,
          nullsafe: node.type.startsWith('nullsafe'),
          row: this.memberOperandRow(name, nameNode),
        };
      }
      case 'member_call_expression':
      case 'nullsafe_member_call_expression': {
        const obj = this.expr(node.childForFieldName('object') as Node);
        const nameNode = node.childForFieldName('name') as Node;
        const name = this.methodName(nameNode);
        const { args, fcc } = this.args(node.childForFieldName('arguments') as Node);
        const nullsafe = node.type.startsWith('nullsafe');
        if (fcc && (nullsafe || hasNullsafeReceiver(obj)))
          this.error(node, 'Cannot combine nullsafe operator with Closure creation');
        return {
          k: 'mcall',
          obj,
          name,
          args,
          nullsafe,
          fcc,
          row: this.memberOperandRow(name, nameNode),
        };
      }
      case 'scoped_property_access_expression': {
        const cls = this.classRef(node.childForFieldName('scope') as Node);
        const nameNode = node.childForFieldName('name') as Node;
        const operand = nameNode.type === 'dynamic_variable_name' ? semanticChildren(nameNode)[0] : nameNode;
        const name =
          nameNode.type === 'variable_name'
            ? this.variableName(nameNode)
            : this.compileStringName(this.expr(operand), operand);
        return { k: 'sprop', cls, name, row: this.memberOperandRow(name, operand) };
      }
      case 'scoped_call_expression': {
        const cls = this.classRef(node.childForFieldName('scope') as Node);
        const nameNode = node.childForFieldName('name') as Node;
        const name = this.methodName(nameNode);
        const { args, fcc } = this.args(node.childForFieldName('arguments') as Node);
        return { k: 'scall', cls, name, args, fcc, row: this.memberOperandRow(name, nameNode) };
      }
      case 'class_constant_access_expression': {
        return this.classConstantExpression(node, row);
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
        const value = this.expr(right);
        if (target.k === 'list' && hasReferenceItem(target)) {
          if (value.k === 'idx' || value.k === 'prop') this.checkWritable(value, right, true);
          else if (!isWritableFetchBase(value))
            this.error(
              node,
              '参照で分割代入できるのは変数だけです（Cannot assign reference to non referenceable value）。'
            );
        }
        return { k: 'assign', target, value, row };
      }
      case 'reference_assignment_expression': {
        const target = this.writable(node.childForFieldName('left') as Node);
        const sourceNode = node.childForFieldName('right') as Node;
        const source = this.expr(sourceNode);
        if (!['call', 'mcall', 'scall', 'new'].includes(source.k)) this.checkWritable(source, sourceNode, true);
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
        const e = this.expr(argument);
        return { k: 'unary', op: operator.type, e, row: compiledOperandRow(e) };
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
        const condition = node.childForFieldName('condition') as Node;
        const body = node.childForFieldName('body');
        if (condition.type === 'conditional_expression') {
          const innerBody = condition.childForFieldName('body');
          if (innerBody && body)
            this.error(
              node,
              'Unparenthesized `a ? b : c ? d : e` is not supported. Use either `(a ? b : c) ? d : e` or `a ? b : (c ? d : e)`'
            );
          if (innerBody)
            this.error(
              node,
              'Unparenthesized `a ? b : c ?: d` is not supported. Use either `(a ? b : c) ?: d` or `a ? b : (c ?: d)`'
            );
          if (body)
            this.error(
              node,
              'Unparenthesized `a ?: b ? c : d` is not supported. Use either `(a ?: b) ? c : d` or `a ?: (b ? c : d)`'
            );
        }
        return {
          k: 'cond',
          test: this.expr(condition),
          consequent: body ? this.expr(body) : undefined,
          alternate: this.expr(node.childForFieldName('alternative') as Node),
          row,
        };
      }
      case 'cast_expression': {
        const { type } = castType(node);
        if (type === 'unset')
          this.error(node, '(unset) のキャストは使えません（The (unset) cast is no longer supported）。');
        if (type === 'real')
          this.error(node, '(real) のキャストは使えません（The (real) cast has been removed, use (float) instead）。');
        return { k: 'cast', type, e: this.expr(node.childForFieldName('value') as Node), row };
      }
      case 'error_suppression_expression': {
        return { k: 'silence', e: this.expr(semanticChildren(node)[0]), row };
      }
      case 'clone_expression': {
        const argumentsNode = node.childForFieldName('arguments');
        if (argumentsNode) {
          const { args, fcc } = this.args(argumentsNode);
          return { k: 'call', fn: { name: 'clone' }, args, fcc, row };
        }
        return { k: 'clone', e: this.expr(node.namedChildren.find((child) => child.type !== 'comment') as Node), row };
      }
      case 'throw_expression': {
        return { k: 'throw', e: this.expr(semanticChildren(node)[0]), row };
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
        return { k: 'print', e: this.expr(semanticChildren(node)[0]), row };
      }
      case 'exit_expression': {
        return { k: 'call', fn: { name: 'exit' }, args: [], fcc: false, row };
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

  private compileRuntimeCall(node: Node): Expr {
    const initializer = this.initializerContext;
    this.initializerContext = undefined;
    try {
      return this.expr(node);
    } finally {
      this.initializerContext = initializer;
    }
  }

  private methodName(node: Node): string | Expr {
    const name = this.memberName(node);
    if (typeof name !== 'string') {
      const literal = this.compiledValue(name, name.k === 'array');
      if (literal !== undefined && typeof literal !== 'string') {
        const row = name.k === 'array' ? arrayFoldRow(unparenthesizedNode(node)) : compiledOperandRow(name);
        this.error(row, 'Method name must be a string');
      }
    }
    return name;
  }

  private memberName(node: Node): string | Expr {
    let preceding = node.previousSibling;
    while (preceding?.type === 'comment') preceding = preceding.previousSibling;
    if (node.type === 'name' && preceding?.type !== '{') return this.nameText(node);
    return this.expr(node);
  }

  private variable(name: string, row: number): Expr {
    if (name === 'this') this.fn.usesThis = true;
    return { k: 'var', name, row };
  }

  private propertyName(node: Node): string | Expr {
    const name = this.memberName(node);
    return typeof name === 'string' ? name : this.compileStringName(name, node);
  }

  private compileStringName(name: Expr, node: Node): Expr {
    if (this.preserveSyntax) return name;
    const literal = this.compiledValue(name, name.k === 'array');
    if (literal instanceof Map) {
      const row = arrayFoldRow(unparenthesizedNode(node));
      this.notices.push({ level: 'Warning', message: 'Array to string conversion', row });
      return { k: 'lit', v: 'Array', row };
    }
    if (typeof literal === 'number' && Number.isNaN(literal)) {
      const row = compiledOperandRow(name);
      this.notices.push({ level: 'Warning', message: NAN_STRING_WARNING, row });
      return { k: 'lit', v: 'NAN', row };
    }
    return name;
  }

  private memberOperandRow(name: string | Expr, node: Node): number {
    return typeof name === 'string' ? node.startPosition.row : compiledOperandRow(name);
  }

  private dynamicVariable(node: Node): Expr {
    const inner = semanticChildren(node)[0];
    const name = this.compileStringName(this.expr(inner), inner);
    const row = compiledOperandRow(name);
    const constant = foldedConstant(name, {
      compiler: true,
      preserveNamedConstants: true,
      budget: this.compileBudget,
    });
    if (typeof constant !== 'string') return { k: 'varvar', name, row };
    if (this.preserveSyntax)
      return { k: 'varvar', name: { k: 'lit', v: constant, row: node.startPosition.row }, row: node.startPosition.row };
    this.checkVariableAvailability(node, constant);
    return this.variable(constant, row);
  }

  private dynamicInterpolation(node: Node, previousRow?: number): Expr {
    const inner = semanticChildren(node)[0];
    const label = /^\$\{([A-Z_a-z\u0080-\uFFFF][\w\u0080-\uFFFF]*)([[}])/.exec(node.text);
    const row = inner.startPosition.row;
    const part = this.notices.length;
    let expression: Expr;
    if (label?.[2] === '[') {
      const [base, index] = semanticChildren(inner);
      if (inner.type !== 'subscript_expression' || base?.text !== label[1])
        this.error(node, 'syntax error, unexpected token, expecting "}"');
      const key = index ? this.expr(index) : undefined;
      expression = {
        k: 'idx',
        base: this.variable(enc(label[1]), row),
        index: key,
        row: key ? compiledOperandRow(key) : row,
      };
    } else if (label) {
      expression = this.variable(enc(label[1]), row);
    } else {
      const name = this.compileStringName(this.expr(inner), inner);
      expression = { k: 'varvar', name, row: compiledOperandRow(name) };
    }
    this.notices.splice(part, 0, {
      level: 'Deprecated',
      message: label
        ? 'Using ${var} in strings is deprecated, use {$var} instead'
        : 'Using ${expr} (variable variables) in strings is deprecated, use {${expr}} instead',
      row: previousRow ?? (expression.k === 'varvar' ? operandAstRow(expression.name) : row),
    });
    return expression;
  }

  // code-gauge-allow functionCognitiveComplexity 19 -- Classifies literal, named and magic constants in order.
  private constant(node: Node): Expr {
    const row = node.startPosition.row;
    const raw = this.nameText(node);
    if (node.type === 'name' && lower(raw) === 'default') this.error(node, 'syntax error, unexpected token "default"');
    const magic = raw.toUpperCase();
    if (this.preserveSyntax) {
      const name = magic.startsWith('__') && reservedIdentifierToken(raw) === magic ? magic : raw;
      return { k: 'const', name: { name }, row };
    }
    const name = this.resolveConstName(raw);
    const literal = builtinLiteralKey(name.fallback ?? name.name);
    if (literal) return { k: 'lit', v: literal === 'NULL' ? null : literal === 'TRUE', row };
    if (magic === '__LINE__') return { k: 'lit', v: BigInt(row + 1), row };
    if (magic === '__FILE__') return { k: 'lit', v: '/main.php', row };
    if (magic === '__DIR__') return { k: 'lit', v: '/', row };
    if (magic === '__PROPERTY__')
      return { k: 'lit', v: this.initializerContext?.propertyName ?? this.fn.propertyName ?? '', row };
    if (magic === '__NAMESPACE__') return { k: 'lit', v: this.namespace, row };
    if (MAGIC_RUNTIME.has(magic)) {
      const token = magic as Extract<Expr, { k: 'magic' }>['name'];
      const value = this.compiledMagic(token);
      return value === undefined ? { k: 'magic', name: token, row } : { k: 'lit', v: value, row };
    }
    if (magic === '__COMPILER_HALT_OFFSET__') this.unsupported(node, '__halt_compiler');
    return { k: 'const', name, row };
  }

  // code-gauge-allow functionCognitiveComplexity 23 -- Keeps the ordered PHP cases together because each branch shares the same dispatch state.
  private classConstantExpression(node: Node, row: number): Expr {
    const [scope, nameNode] = node.namedChildren.filter((child) => child.type !== 'comment');
    const nameExpression = node.childForFieldName('name_expression');
    if (this.preserveSyntax) {
      const name = nameExpression ? this.expr(nameExpression) : this.nameText(nameNode);
      const className = typeof name === 'string' && lower(name) === 'class';
      const cls = this.classRef(scope, false, className ? 'name' : 'constant');
      return { k: 'cconst', cls, name: className ? 'class' : name, row };
    }
    if (nameExpression) return this.bracedClassConstant(scope, nameExpression);
    const name = this.nameText(nameNode);
    const className = lower(name) === 'class' ? (this.constantInitializer ? 'initializer' : true) : undefined;
    const cls = this.classRef(scope, !className && this.constantInitializer, className ? 'name' : 'constant');
    if (!className || cls.k !== 'expr')
      return { k: 'cconst', cls, name, className, scopeRow: scope.startPosition.row, row: nameNode.startPosition.row };
    const literal = parserScalar(cls.e);
    if (literal === undefined) {
      const type = this.compiledType(cls.e);
      if (type !== undefined) this.error(scope, `Cannot use "::class" on ${type}`);
      return { k: 'cconst', cls, name, className, row };
    }
    if (typeof literal !== 'string') this.error(scope, 'Illegal class name');
    const word = lower(literal);
    if (word === 'self' || word === 'parent' || word === 'static') {
      this.checkClassScope(scope, word);
      return { k: 'cconst', cls: { k: word }, name, className, row };
    }
    return { k: 'lit', v: literal.startsWith('\\') ? literal.slice(1) : literal, row };
  }

  private bracedClassConstant(scope: Node, nameExpression: Node): Expr {
    const name = this.expr(nameExpression);
    const literal = this.compiledValue(name, true);
    let cls = this.classRef(
      scope,
      this.constantInitializer || typeof literal !== 'string',
      typeof literal === 'string' ? 'constant' : 'reference'
    );
    if (cls.k === 'expr') {
      const literal = parserScalar(cls.e);
      if (typeof literal === 'string') cls = { k: 'named', name: literal };
    }
    const foldedNonString =
      literal !== undefined &&
      typeof literal !== 'string' &&
      (name.k !== 'lit' || (typeof name.v !== 'number' && typeof name.v !== 'bigint'));
    return {
      k: 'cconst',
      cls,
      name: typeof literal === 'string' ? literal : name,
      scopeRow: scope.startPosition.row,
      row: foldedNonString ? scope.startPosition.row : this.memberOperandRow(name, nameExpression),
    };
  }

  // code-gauge-allow functionCognitiveComplexity 20 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
  private functionCall(node: Node): Expr {
    const row = node.startPosition.row;
    const fnNode = node.childForFieldName('function') as Node;
    const argumentsNode = node.childForFieldName('arguments') as Node;
    if (fnNode.type === 'name') {
      const word = lower(fnNode.text);
      if (word === 'isset' || word === 'empty') return this.quietCheck(node, argumentsNode, word, row);
      if (word === 'eval') this.unsupported(node, 'eval');
      if (word === 'die' || word === 'exit') {
        const { args, fcc } = this.args(argumentsNode);
        return { k: 'call', fn: { name: 'exit' }, args, fcc, row: node.endPosition.row };
      }
      if (word === '__halt_compiler') this.unsupported(node, '__halt_compiler');
    }
    const { args, fcc } = this.args(argumentsNode);
    if (fnNode.type === 'name' || fnNode.type === 'qualified_name' || fnNode.type === 'relative_name') {
      const raw = this.nameText(fnNode);
      if (this.preserveSyntax) return { k: 'call', fn: { name: raw }, args, fcc, row };
      const name = this.resolveFunctionName(raw);
      this.compileBuiltinArguments(name, args, fcc);
      if (lower(name.fallback ?? name.name) === 'assert') {
        this.addAssertionDescription(argumentsNode, args, row);
      }
      return { k: 'call', fn: name, args, fcc, row };
    }
    return {
      k: 'call',
      fn: this.foldCallableOperand(this.expr(fnNode)),
      args,
      fcc,
      initRow: row,
      row: argumentsNode.startPosition.row,
    };
  }

  private compileBuiltinArguments(name: ResolvedName, args: Arg[], fcc: boolean): void {
    if (name.fallback) return;
    const builtin = lower(name.name);
    if (builtin === 'sprintf' && !fcc) this.compileSimpleSprintf(args);
    if ((builtin === 'call_user_func' || builtin === 'call_user_func_array') && args[0])
      args[0].e = this.foldCallableOperand(args[0].e, true);
  }

  private compileSimpleSprintf(args: Arg[]): void {
    const first = args[0];
    const format = first && this.compiledValue(first.e);
    if (typeof format !== 'string' || simpleSprintfFormat(args, format) === undefined) return;
    first.e = { k: 'lit', v: format, row: first.e.row };
    const row = compiledOperandRow(args.at(-1)!.e);
    let index = 1;
    for (const [, specifier] of simpleSprintfParts(format)) {
      if (specifier === '%') continue;
      const arg = args[index++];
      if (specifier !== 's') continue;
      arg.e = this.compileStringOperand(arg.e, row);
    }
  }

  private foldCallableOperand(expression: Expr, forwarding = false): Expr {
    if (this.preserveSyntax || expression.k === 'lit') return expression;
    const value = forwarding
      ? foldedConstant(expression, {
          compiler: true,
          preserveNamedConstants: true,
          preserveClassConstants: true,
          budget: this.compileBudget,
        })
      : this.compiledValue(expression);
    return typeof value === 'string' ? { k: 'lit', v: value, row: expression.row } : expression;
  }

  private quietCheck(node: Node, argumentsNode: Node, word: 'isset' | 'empty', row: number): Expr {
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
      if (!['var', 'varvar', 'idx', 'prop', 'sprop'].includes(item.k)) {
        this.error(
          node,
          'Cannot use isset() on the result of an expression (you can use "null !== expression" instead)'
        );
      }
    }
    return { k: 'isset', items, row };
  }

  private addAssertionDescription(argumentsNode: Node, args: Arg[], row: number): void {
    if (args.length !== 1 || args[0].spread || (args[0].name && args[0].name !== 'assertion')) return;
    const argument = argumentsNode.namedChildren.find((child) => child.type === 'argument');
    const expression = argument?.namedChildren.findLast((child) => child.type !== 'comment');
    if (!expression) return;
    const label = args[0].name ? 'assertion: ' : '';
    const name = args[0].name ? 'description' : undefined;
    const value = `assert(${label}${this.renderAssertionExpression(expression)})`;
    args.push({ e: { k: 'lit', v: value, row }, spread: false, name });
  }

  private renderAssertionExpression(node: Node): string {
    // Use separate converter state so skipped operands cannot add notices or declarations to the program.
    const syntax = new Converter(this.source, new Set(), this.ignoredPrefix, true, this.compileBudget);
    try {
      return exportExpr(syntax.expr(node));
    } catch (error) {
      if (!(error instanceof CompileError || error instanceof UnexportableSyntax)) throw error;
      return enc(node.text);
    }
  }

  protected override resolveClassName(raw: string): string {
    return this.preserveSyntax ? raw : super.resolveClassName(raw);
  }

  // code-gauge-allow functionCognitiveComplexity 29 -- One case per grammar node kind, each converted where PHP gives it its own meaning.
  // code-gauge-allow functionNcss 36 -- One case per grammar node kind, each converted where PHP gives it its own meaning.
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
        args.push({ e: this.expr(semanticChildren(valueNode)[0]), spread: true });
        continue;
      }
      if (nameNode) {
        named = true;
        const name = this.nameText(nameNode);
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
    const anonymous = node.namedChildren.find((child) => child.type === 'anonymous_class');
    if (anonymous) {
      const argumentsNode = anonymous.namedChildren.find((child) => child.type === 'arguments');
      const { args } = argumentsNode ? this.args(argumentsNode) : { args: [] };
      return { k: 'newAnon', decl: this.classDecl(anonymous, true), args, row: anonymous.startPosition.row };
    }
    const parts = node.namedChildren.filter((child) => child.type !== 'comment');
    const argumentsNode = parts.find((child) => child.type === 'arguments');
    const classNode = parts.find((child) => child.type !== 'arguments') as Node;
    const { args, fcc } = argumentsNode ? this.args(argumentsNode) : { args: [], fcc: false };
    if (fcc) this.error(node, 'new で第一級 callable は作れません（Cannot create Closure for new expression）。');
    const cls = this.classRef(classNode, this.constantInitializer);
    return {
      k: 'new',
      cls,
      args,
      row: cls.k === 'expr' ? compiledOperandRow(cls.e) : classNode.startPosition.row,
    };
  }

  private binary(node: Node): Expr {
    const row = node.startPosition.row;
    const token = node.childForFieldName('operator') as Node;
    const op = lower(token.type);
    const leftNode = node.childForFieldName('left') as Node;
    const rightNode = node.childForFieldName('right') as Node;
    this.validateBinarySyntax(node, token, leftNode, rightNode);
    const l = this.expr(leftNode);
    if (op === 'instanceof') return this.instanceOf(l, rightNode, row);
    if (!this.preserveSyntax && (op === '&&' || op === 'and' || op === '||' || op === 'or')) {
      return this.shortCircuit(op, l, rightNode, row);
    }
    const r = this.expr(rightNode);
    if (op === '|>') {
      if (rightNode.type === 'arrow_function')
        this.error(rightNode, 'Arrow functions on the right hand side of |> must be parenthesized');
      return { k: 'pipe', l, r, row };
    }
    const expression: Extract<Expr, { k: 'bin' }> = { k: 'bin', op: op === '<>' ? '!=' : op, l, r, row };
    if (this.initializerContext?.kind === 'array') expression.opcodeRow = this.resultOpcodeRow(r, rightNode);
    const compiled =
      this.preserveSyntax || this.initializerContext?.kind === 'deferred' ? expression : this.compileBinary(expression);
    return op === '.' && directiveLiteral(node, expression)
      ? recordOperandRows(compiled, followingTokenRow(node))
      : compiled;
  }

  private validateBinarySyntax(node: Node, token: Node, left: Node, right: Node): void {
    if (token.type === '.' && /[0-9]/.test(this.source[token.endIndex] ?? ''))
      this.rejectFractionAfterExpression(token, node);
    const invalid = chainedComparison(token, left, right);
    if (invalid) this.error(invalid, `syntax error, unexpected token "${invalid.text}"`);
  }

  private rejectFractionAfterExpression(token: Node, expression: Node): never {
    const spelling = PHP_NUMBER.exec(this.source.slice(token.startIndex))?.[0] ?? '.';
    let context = expression.parent;
    while (context?.type.endsWith('_expression') && context.type !== 'parenthesized_expression')
      context = context.parent;
    const expected =
      context?.type === 'echo_statement'
        ? ', expecting "," or ";"'
        : context?.type === 'return_statement'
          ? ', expecting ";"'
          : context?.type === 'argument'
            ? ', expecting ")"'
            : '';
    this.error(token, `syntax error, unexpected ${unexpectedTextToken('floating-point number', spelling)}${expected}`);
  }

  private instanceOf(l: Expr, right: Node, row: number): Expr {
    if (!this.preserveSyntax && this.compiledType(l) !== undefined) return { k: 'lit', v: false, row };
    const cls = this.classRef(right);
    return { k: 'instanceof', e: l, cls, row: compiledOperandRow(cls.k === 'expr' ? cls.e : l) };
  }

  private compileBinary(expression: Extract<Expr, { k: 'bin' }>): Expr {
    const { l, r, op, row } = expression;
    if (op === 'xor') {
      const left = this.compiledValue(l);
      const right = this.compiledValue(r);
      if (left !== undefined && right !== undefined) {
        const v = this.compileTruth(left, r.row) !== this.compileTruth(right, r.row);
        return { k: 'lit', v, row };
      }
    }
    if (op === '.') expression.foldedString = this.compileConcatenation(expression);
    if (COMMUTATIVE_OPCODES.has(op)) {
      const rightRank = this.operandRank(r);
      if (rightRank > 0 && this.operandRank(l) < rightRank) expression.swapOperands = true;
    }
    return expression;
  }

  private compileConcatenation(expression: Extract<Expr, { k: 'bin' }>): string | undefined {
    const row = this.initializerContext?.row ?? compiledOperandRow(expression.r);
    const left = this.compileStringOperand(expression.l, row);
    const right = this.compileStringOperand(expression.r, row);
    if (left.k === 'lit' && right.k === 'lit') {
      const folded = this.compiledValue({ ...expression, l: left, r: right });
      if (typeof folded === 'string') return folded;
    }
    expression.l = left;
    expression.r = right;
    return undefined;
  }

  private compileStringOperand(operand: Expr, row: number): Expr {
    if (operand.k === 'lit' && typeof operand.v === 'string') return operand;
    const value = this.compiledValue(operand);
    if (value === undefined || value instanceof Map) return operand;
    if (Number.isNaN(value)) this.notices.push({ level: 'Warning', message: NAN_STRING_WARNING, row });
    return recordOperandRows(
      { k: 'lit', v: scalarString(value), row: operand.row },
      operandAstRow(operand),
      compiledOperandRow(operand)
    );
  }

  private operandRank(operand: Expr): number {
    // Zend specializes commutative opcodes in descending CV, VAR, TMP, CONST order.
    if (operand.k === 'var' && operand.name !== 'this' && operand.name !== 'GLOBALS') return 3;
    if (VARIABLE_OPCODE_RESULTS.has(operand.k)) return 2;
    return this.compiledValue(operand) === undefined ? 1 : 0;
  }

  private shortCircuit(op: string, l: Expr, right: Node, row: number): Expr {
    const value = this.compiledValue(l);
    const deferred = this.initializerContext?.kind === 'deferred';
    if (value === undefined || (deferred && Number.isNaN(value))) return { k: 'bin', op, l, r: this.expr(right), row };
    const isAnd = op === '&&' || op === 'and';
    const condition = this.compileTruth(value, l.row);
    if (condition !== isAnd) {
      const v = this.initializerContext === undefined ? this.compileTruth(value, l.row) : condition;
      return { k: 'lit', v, row };
    }
    const r = this.expr(right);
    const result = this.compiledValue(r);
    if (result !== undefined && (!deferred || !Number.isNaN(result)))
      return { k: 'lit', v: this.compileTruth(result, r.row), row };
    return { k: 'bin', op, l: { k: 'lit', v: condition, row: l.row }, r, row };
  }

  private compileTruth(value: Constant, row: number): boolean {
    if (typeof value === 'number' && Number.isNaN(value))
      this.notices.push({ level: 'Warning', message: NAN_BOOL_WARNING, row: this.initializerContext?.row ?? row });
    return constantTruth(value);
  }

  private closure(node: Node): Expr {
    const row = node.startPosition.row;
    const isStatic = node.childForFieldName('static_modifier') !== null;
    const useClause = node.namedChildren.find((child) => child.type === 'anonymous_function_use_clause');
    const uses = (useClause?.namedChildren ?? [])
      .filter((child) => child.type === 'variable_name' || child.type === 'by_ref')
      .map((child) => {
        const byRef = child.type === 'by_ref';
        const variable = byRef ? semanticChildren(child)[0] : child;
        const name = this.variableName(variable);
        if (name === 'this' || name === 'GLOBALS') this.error(child, `Cannot use $${name} as lexical variable`);
        return { name, byRef, row: variable.startPosition.row };
      });
    const fn = this.functionDecl(node, true);
    if (new Set(uses.map((use) => use.name)).size !== uses.length)
      this.error(node, 'Cannot use a variable twice in a closure use clause');
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
    const conditions = arms.flatMap((arm) => arm.conditions ?? []);
    const jumpTable =
      conditions.length >= 2 &&
      conditions.every((condition) => {
        const value = this.compiledValue(condition);
        return typeof value === 'bigint' || typeof value === 'string';
      });
    return { k: 'match', subject, arms, jumpTable, row };
  }

  private compileArrayItems(node: Node): ArrayItem[] {
    if (this.initializerContext) return this.arrayItems(node);
    this.initializerContext = { kind: 'array', row: arrayFoldRow(node) };
    try {
      return this.arrayItems(node);
    } finally {
      this.initializerContext = undefined;
    }
  }

  private hasStringArrayKey(key: Expr): boolean {
    const value = this.compiledValue(key, true);
    return typeof value === 'string' && typeof normalizeKeyString(value) === 'string';
  }

  // code-gauge-allow functionCognitiveComplexity 18 -- Checks folded keys and values in source order and keeps deferred failures at runtime.
  private checkConstantArrayOperands(node: Node, items: ArrayItem[]): void {
    if (this.preserveSyntax || !items.some((item) => item.spread || item.key)) return;
    let invalid: string | undefined;
    for (const item of items) {
      if (item.byRef) return;
      const key = item.key ? this.compiledValue(item.key) : null;
      const value = this.compiledValue(item.value);
      if (key === undefined || value === undefined) return;
      if (invalid !== undefined) continue;
      if (key instanceof Map) invalid = 'Illegal offset type';
      else if (item.spread && !(value instanceof Map))
        invalid = `Only arrays and Traversables can be unpacked, ${constantTypeName(value)} given`;
    }
    if (invalid !== undefined) this.error(node, invalid);
  }

  private arrayItems(node: Node): ArrayItem[] {
    const items: ArrayItem[] = [];
    for (const child of node.namedChildren) {
      if (child.type !== 'array_element_initializer') continue;
      const parts = child.namedChildren.filter((part) => part.type !== 'comment');
      if (parts.length === 1 && parts[0].type === 'variadic_unpacking') {
        items.push({ value: this.expr(semanticChildren(parts[0])[0]), byRef: false, spread: true });
        continue;
      }
      items.push(this.arrayItem(parts));
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

  private arrayItem(parts: Node[]): ArrayItem {
    const start = this.notices.length;
    const key = parts.length === 2 ? this.expr(parts[0]) : undefined;
    const keyNotices = this.notices.length;
    const valueNode = parts.at(-1)!;
    const byRef = valueNode.type === 'by_ref';
    const value = byRef ? this.writable(semanticChildren(valueNode)[0]) : this.expr(valueNode);
    if (keyNotices > start) this.orderArrayFoldNotices(start, keyNotices);
    const keyOpcodeRow = key && !this.constantInitializer ? this.resultOpcodeRow(value, valueNode) : undefined;
    return { key, keyOpcodeRow, value, byRef, spread: false };
  }

  // code-gauge-allow functionNcss 36 -- Dispatches by the PHP expression that produced the current compiler row.
  private resultOpcodeRow(value: Expr, node: Node): number {
    node = unparenthesizedNode(node);
    if (node.type === 'heredoc' || node.type === 'nowdoc') return node.startPosition.row + 1;
    switch (value.k) {
      case 'arrow': {
        return followingTokenRow(node);
      }
      case 'closure': {
        return node.endPosition.row;
      }
      case 'bin': {
        return this.binaryOpcodeRow(value, node);
      }
      case 'lit': {
        if (node.type === 'binary_expression' && !directiveLiteral(node, value)) return this.arrayValueFoldRow(node);
        break;
      }
      case 'array': {
        return this.arrayOpcodeRow(value, node);
      }
      case 'const':
      case 'unary':
      case 'idx': {
        if (this.compiledValue(value, true) !== undefined) return this.arrayValueFoldRow(node);
        break;
      }
      case 'cond': {
        return this.conditionalOpcodeRow(value, node);
      }
      case 'assign': {
        if (value.target.k === 'list') return listAssignmentRow(value.target, compiledOperandRow(value.value));
        if (value.target.k !== 'var') return compiledOperandRow(value.value);
        break;
      }
      case 'assignRef': {
        return compiledOperandRow(value.source);
      }
      case 'assignOp': {
        return compiledOperandRow(value.op === '??' ? value.target : value.value);
      }
    }
    return compiledOperandRow(value);
  }

  private arrayOpcodeRow(value: Extract<Expr, { k: 'array' }>, node: Node): number {
    if (this.compiledValue(value, true) !== undefined) return this.arrayValueFoldRow(node);
    const item = value.items.at(-1);
    const element = node.namedChildren.findLast((child) => child.type === 'array_element_initializer');
    const child = element && semanticChildren(element).at(-1);
    if (!item || !child) return compiledOperandRow(value);
    const operand = item.spread || item.byRef ? semanticChildren(child)[0] : child;
    return operand ? this.resultOpcodeRow(item.value, operand) : compiledOperandRow(value);
  }

  private conditionalOpcodeRow(value: Extract<Expr, { k: 'cond' }>, node: Node): number {
    const test = this.compiledValue(value.test);
    if (test === undefined) return compiledOperandRow(value);
    const selected = constantTruth(test) ? (value.consequent ?? value.test) : value.alternate;
    const branch = selected === value.alternate ? 'alternative' : selected === value.test ? 'condition' : 'body';
    return this.resultOpcodeRow(selected, node.childForFieldName(branch) ?? node);
  }

  private binaryOpcodeRow(value: Extract<Expr, { k: 'bin' }>, node: Node): number {
    if (value.op === '??') {
      const left = this.compiledValue(value.l);
      const branch = left === undefined || left === null ? 'right' : 'left';
      const selected = branch === 'right' ? value.r : value.l;
      return this.resultOpcodeRow(selected, node.childForFieldName(branch) ?? node);
    }
    if (this.compiledValue(value, true) === undefined) return value.opcodeRow ?? compiledOperandRow(value);
    if (value.op !== '.') return this.arrayValueFoldRow(node);
    if (directiveLiteral(node, value)) return followingTokenRow(node);
    return this.arrayValueFoldRow(node);
  }

  private arrayValueFoldRow(node: Node): number {
    return this.initializerContext?.row ?? node.startPosition.row;
  }

  private orderArrayFoldNotices(start: number, keyEnd: number): void {
    const keyNotices = this.notices.slice(start, keyEnd);
    const folded = keyNotices.filter(isArrayFoldNotice);
    if (folded.length === 0) return;
    this.notices.splice(start, keyEnd - start, ...keyNotices.filter((notice) => !isArrayFoldNotice(notice)));
    this.notices.push(...folded);
  }

  // code-gauge-allow functionCognitiveComplexity 29 -- One case per grammar node kind, each converted where PHP gives it its own meaning.
  // code-gauge-allow functionNcss 40 -- One case per grammar node kind, each converted where PHP gives it its own meaning.
  private listLiteral(node: Node): Expr {
    const row = node.startPosition.row;
    const items: (ListItem | undefined)[] = [];
    let expectingItem = true;
    let pendingKey: Expr | undefined;
    const children = node.children
      .flatMap((child) => (child.type === 'array_element_initializer' ? child.children : [child]))
      .filter((child) => child.type !== 'comment');
    for (const [index, child] of children.entries()) {
      if (child.type === ',') {
        if (expectingItem) items.push(undefined);
        expectingItem = true;
        continue;
      }
      if (child.type === '=>') continue;
      if (!child.isNamed) continue;
      if (children[index + 1]?.type === '=>') {
        pendingKey = this.expr(child);
        continue;
      }
      let byRef = false;
      let target = child;
      if (child.type === 'by_ref') {
        byRef = true;
        target = semanticChildren(child)[0];
      }
      const converted = ['list_literal', 'array_creation_expression'].includes(target.type)
        ? this.listLiteral(target)
        : this.writable(target);
      items.push({ key: pendingKey, target: converted, byRef });
      pendingKey = undefined;
      expectingItem = false;
    }
    if (items.every((item) => item === undefined))
      this.error(node, '空の list() は使えません（Cannot use empty list）。');
    const keyed = items.find((item) => item !== undefined)?.key !== undefined;
    for (const item of items) {
      if (!item) {
        if (keyed) this.error(node, 'Cannot use empty array entries in keyed array assignment');
        continue;
      }
      if ((item.key !== undefined) !== keyed)
        this.error(
          node,
          'キーのある要素とない要素を混ぜられません（Cannot mix keyed and unkeyed array entries in assignments）。'
        );
    }
    const listRow = items[0] ? row : (children.find((child) => child.type === ',')?.startPosition.row ?? row);
    return { k: 'list', items, keyed, row: listRow };
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
    return decodeSingleQuoted(raw);
  }

  private nowdoc(node: Node): string {
    const end = node.childForFieldName('end_tag') as Node;
    const [start, limit] = this.multilineBody(node, end);
    return enc(
      this.dedent(this.source.slice(start, limit), end.startPosition.column, true, () => node.startPosition.row + 1)
    );
  }

  private multilineBody(node: Node, end: Node): [start: number, limit: number] {
    const start = this.source.indexOf('\n', node.startIndex) + 1;
    const closingLine = this.source.lastIndexOf('\n', end.startIndex - 1) + 1;
    const lineBreakWidth = this.source[closingLine - 2] === '\r' ? 2 : 1;
    const limit = Math.max(start, closingLine - lineBreakWidth);
    this.checkIndentKinds(
      this.source.slice(start, limit),
      this.source.slice(closingLine, end.startIndex),
      node.startPosition.row + 1
    );
    return [start, limit];
  }

  private checkIndentKinds(raw: string, closing: string, firstRow: number): void {
    if (/ /.test(closing) && /\t/.test(closing))
      this.error(firstRow, 'Invalid indentation - tabs and spaces cannot be mixed');
    const kind = closing[0];
    if (!kind) return;
    for (const [index, line] of raw.split('\n').entries()) {
      const leading = /^[ \t]*/.exec(line)?.[0] ?? '';
      if (leading.slice(0, closing.length).includes(kind === ' ' ? '\t' : ' '))
        this.error(firstRow + index, 'Invalid indentation - tabs and spaces cannot be mixed');
    }
  }

  /**
   * Converts a double-quoted string or heredoc, reading its literal text from the source between the interpolated
   * expressions, since the grammar leaves line breaks out of its content nodes.
   */
  private interpolated(node: Node): Expr {
    const row = node.startPosition.row;
    const isHeredoc = node.type === 'heredoc';
    const container = isHeredoc ? node.childForFieldName('value') : node;
    const end = isHeredoc ? (node.childForFieldName('end_tag') as Node) : undefined;
    const indent = end ? end.startPosition.column : 0;
    const parts: (string | Expr)[] = [];
    const children = container?.children ?? [];
    const [start, limit] = end
      ? this.multilineBody(node, end)
      : [this.source.indexOf('"', node.startIndex) + 1, node.endIndex - 1];
    let cursor = start;
    let raw = '';
    let rawStart = cursor;
    let rawAtLineStart = isHeredoc;
    let rawRow = row + Number(isHeredoc);
    let firstRow: number | undefined;
    let lastRow: number | undefined;
    const flush = (): void => {
      if (raw === '') return;
      const text = isHeredoc
        ? this.dedent(
            raw,
            indent,
            rawAtLineStart,
            () => row + this.source.slice(node.startIndex, rawStart).split('\n').length - 1
          )
        : raw;
      const escapeRow = (offset: number): number => {
        const before = this.source.slice(node.startIndex, rawStart) + text.slice(0, offset);
        return row + before.split('\n').length - 1;
      };
      parts.push(decodeLiteral(text, !isHeredoc, (message, offset) => this.error(escapeRow(offset), message)));
      firstRow ??= rawRow;
      lastRow = rawRow;
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
        } else {
          rawRow = child.endPosition.row;
        }
        cursor = child.endIndex;
        continue;
      }
      if (child.type === 'comment') continue;
      raw += this.source.slice(cursor, child.startIndex);
      flush();
      const part = braced ? this.expr(child) : this.simpleInterpolation(child, lastRow);
      firstRow ??= operandAstRow(part);
      lastRow = compiledOperandRow(part);
      if (braced && !['var', 'varvar', 'idx', 'prop', 'sprop', 'mcall', 'scall', 'call'].includes(part.k))
        this.error(child, 'Invalid expression in string interpolation');
      parts.push(part);
      braced = false;
      cursor = child.endIndex;
      rawStart = cursor;
      rawRow = child.endPosition.row;
      rawAtLineStart = false;
    }
    raw += this.source.slice(cursor, limit);
    flush();
    if (parts.every((part) => typeof part === 'string'))
      return recordOperandRows({ k: 'lit', v: parts.join(''), row }, isHeredoc ? (firstRow ?? rawRow) : row);
    return recordOperandRows({ k: 'interp', parts, row }, firstRow ?? row, lastRow ?? row);
  }

  /** Converts a variable written in a string without braces, where `$a[key]` names the key `'key'`. */
  private simpleInterpolation(node: Node, previousRow?: number): Expr {
    if (node.type === 'dynamic_variable_name' && node.text.startsWith('${'))
      return this.dynamicInterpolation(node, previousRow);
    if (node.type === 'subscript_expression') {
      const [baseNode, indexNode] = node.namedChildren.filter((child) => child.type !== 'comment');
      const row = node.startPosition.row;
      const subscript = this.source.slice(baseNode.endIndex, node.endIndex);
      if (/[ \t\r\n]/.test(subscript)) this.error(node, 'Invalid whitespace in simple string interpolation');
      if (indexNode?.type === 'name') {
        return { k: 'idx', base: this.expr(baseNode), index: { k: 'lit', v: enc(indexNode.text), row }, row };
      }
      if (indexNode?.type === 'integer' || indexNode?.type === 'unary_op_expression') {
        const value = normalizeKeyString(enc(indexNode.text));
        return { k: 'idx', base: this.expr(baseNode), index: { k: 'lit', v: value, row }, row };
      }
    }
    return this.expr(node);
  }

  private dedent(raw: string, indent: number, atLineStart: boolean, firstRow: () => number): string {
    if (indent === 0) return raw;
    const lines = raw.split('\n');
    return lines
      .map((line, index) => {
        if (index === 0 && !atLineStart) return line;
        const leading = /^[ \t]*/.exec(line)?.[0] ?? '';
        if (leading.length < indent && /[^ \t\r]/.test(line)) {
          this.error(
            firstRow() + index,
            `ヒアドキュメントの行の字下げが、終わりの印より浅くなっています（Invalid body indentation level (expecting an indentation level of at least ${indent})）。`
          );
        }
        return line.slice(Math.min(indent, leading.length));
      })
      .join('\n');
  }
}

function isArrayFoldNotice({ message }: CompileNotice): boolean {
  return message === NAN_STRING_WARNING || message === NAN_BOOL_WARNING;
}

function isPlainBlockChild(node: Node): boolean {
  return node.parent?.type === 'compound_statement' && node.parent.parent?.type !== 'namespace_definition';
}

function chainedComparison(operator: Node, left: Node, right: Node): Node | undefined {
  const group = EQUALITY_OPERATORS.has(operator.type) ? EQUALITY_OPERATORS : ORDER_OPERATORS;
  if (!group.has(operator.type)) return;
  const leftOperator = left.type === 'binary_expression' ? left.childForFieldName('operator') : undefined;
  if (leftOperator && group.has(leftOperator.type)) return operator;
  const rightOperator = right.type === 'binary_expression' ? right.childForFieldName('operator') : undefined;
  if (rightOperator && group.has(rightOperator.type)) return rightOperator;
}

function directiveLiteral(node: Node, value: Expr): boolean {
  node = unparenthesizedNode(node);
  if (value.k === 'lit')
    return (
      ['integer', 'float', 'string', 'encapsed_string', 'heredoc', 'nowdoc'].includes(node.type) &&
      (typeof value.v === 'string' || typeof value.v === 'bigint' || typeof value.v === 'number')
    );
  return (
    node.type === 'binary_expression' &&
    value.k === 'bin' &&
    value.op === '.' &&
    directiveLiteral(node.childForFieldName('left') as Node, value.l) &&
    directiveLiteral(node.childForFieldName('right') as Node, value.r)
  );
}

function unparenthesizedNode(node: Node): Node {
  while (node.type === 'parenthesized_expression') {
    const inner = semanticChildren(node)[0];
    if (!inner) break;
    node = inner;
  }
  return node;
}

function listAssignmentRow(target: Extract<Expr, { k: 'list' }>, row: number): number {
  for (const item of target.items) {
    if (!item) continue;
    if (item.key) row = compiledOperandRow(item.key);
    if (item.target.k === 'list') row = listAssignmentRow(item.target, row);
    else if (!item.byRef && (item.target.k === 'var' || item.target.k === 'varvar')) row = item.target.row;
  }
  return row;
}

export function castType(node: Node): { spelling: string; type: string } {
  const spelling = lower(node.childForFieldName('type')?.text.replaceAll(/[\s()]/g, '') ?? '');
  const type = { integer: 'int', double: 'float', boolean: 'bool', binary: 'string' }[spelling] ?? spelling;
  return { spelling, type };
}

function followingTokenRow(node: Node): number {
  for (let current: Node | null = node; current; current = current.parent) {
    let sibling = current.nextSibling;
    while (sibling?.type === 'comment') sibling = sibling.nextSibling;
    if (sibling) return sibling.startPosition.row;
  }
  return node.endPosition.row;
}

function namespaceDiagnosticRow(statement: Node): number {
  const named = statement.childForFieldName('name');
  if (named) return named.startPosition.row;
  const operand = statement.childForFieldName('condition');
  if (operand) return unparenthesizedNode(operand).startPosition.row;
  if (statement.type === 'namespace_definition')
    return statement.childForFieldName('body')?.startPosition.row ?? statement.startPosition.row;
  if (statement.type === 'echo_statement' || statement.type === 'return_statement')
    return semanticChildren(statement)[0]?.startPosition.row ?? statement.startPosition.row;
  return statement.startPosition.row;
}

function arrayFoldRow(node: Node): number {
  let value = node;
  for (;;) {
    if (value.type === 'array_creation_expression') {
      const first = value.namedChildren.find((child) => child.type === 'array_element_initializer');
      const inner = first?.namedChildren.findLast((child) => child.type !== 'comment');
      if (!inner) return value.endPosition.row;
      value = inner;
    } else if (value.type === 'binary_expression' && parserConcatenation(value)) {
      return followingTokenRow(value);
    } else if (
      [
        'variadic_unpacking',
        'parenthesized_expression',
        'by_ref',
        'binary_expression',
        'conditional_expression',
        'subscript_expression',
        'unary_op_expression',
      ].includes(value.type)
    ) {
      const inner = value.namedChildren.find((child) => child.type !== 'comment');
      if (!inner) return value.startPosition.row;
      value = inner;
    } else return value.startPosition.row;
  }
}

function parserConcatenation(node: Node): boolean {
  const value = unparenthesizedNode(node);
  if (value.type === 'binary_expression') {
    if (value.childForFieldName('operator')?.type !== '.') return false;
    const left = value.childForFieldName('left');
    const right = value.childForFieldName('right');
    return !!left && !!right && parserConcatenation(left) && parserConcatenation(right);
  }
  if (value.type === 'integer' || value.type === 'float' || value.type === 'string' || value.type === 'nowdoc')
    return true;
  return (
    (value.type === 'encapsed_string' || value.type === 'heredoc_body') &&
    value.namedChildren.every((child) => child.type === 'string_content' || child.type === 'escape_sequence')
  );
}

function parserScalar(expression: Expr): string | bigint | number | undefined {
  if (expression.k === 'lit')
    return typeof expression.v === 'string' || typeof expression.v === 'bigint' || typeof expression.v === 'number'
      ? expression.v
      : undefined;
  if (expression.k === 'interp' && expression.parts.every((part) => typeof part === 'string'))
    return expression.parts.join('');
  if (expression.k !== 'bin' || expression.op !== '.') return undefined;
  const left = parserScalar(expression.l);
  const right = parserScalar(expression.r);
  if (left === undefined || right === undefined) return undefined;
  return `${typeof left === 'number' ? formatFloat(left) : left}${typeof right === 'number' ? formatFloat(right) : right}`;
}
