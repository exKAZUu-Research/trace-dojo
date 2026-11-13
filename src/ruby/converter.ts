// code-gauge-allow-file fileNcss 848 -- The converter module keeps one concern's cases together.
import type { Node } from '@willbooster/web-tree-sitter';

import { CompileError } from '../interpreter/diagnostics';
import type {
  BlockDef,
  Body,
  Call,
  Expr,
  HashItem,
  MethodDef,
  MultiTarget,
  Params,
  ParamTarget,
  Program,
  Rescue,
  StepKind,
  Stmt,
  StrPart,
  Target,
  Use,
} from './ast';
import { decodeDoubleQuoted, decodeSingleQuoted } from './escapes';

/** The local variables of one scope; a block's scope sees its parents' variables. */
class LocalScope {
  readonly names: string[] = [];
  private readonly set = new Set<string>();

  constructor(
    readonly kind: 'top' | 'method' | 'class' | 'block',
    readonly parent?: LocalScope
  ) {}

  private self(): LocalScope {
    return this;
  }

  /** How many block scopes out the variable is, or -1 when no visible scope declares it. */
  depthOf(name: string): number {
    let depth = 0;
    for (
      let scope: LocalScope | undefined = this.self();
      scope;
      scope = scope.kind === 'block' ? scope.parent : undefined
    ) {
      if (scope.set.has(name)) return depth;
      depth++;
    }
    return -1;
  }

  declare(name: string): number {
    const depth = this.depthOf(name);
    if (depth >= 0) return depth;
    this.declareOwn(name);
    return 0;
  }

  /** Declares a variable of this scope even when an outer scope has one, as block parameters shadow them. */
  declareOwn(name: string): void {
    if (this.set.has(name)) return;
    this.set.add(name);
    this.names.push(name);
  }
}

/** What the converter knows about where it is, for the checks Ruby makes before running. */
interface Context {
  scope: LocalScope;
  /** Whether `yield` may appear: inside a method, including its blocks. */
  inDef: boolean;
  /** Whether `break` and `next` have a loop or block to leave. */
  inLoop: boolean;
  inBlock: boolean;
  inRescue: boolean;
  inClassBody: boolean;
  /** Whether a block's body is a lambda literal, where `return` and `break` leave the lambda. */
}

const ASSIGNABLE_KEYWORDS: Record<string, string> = {
  self: 'self',
  nil: 'nil',
  true: 'true',
  false: 'false',
};

/** Converts tree-sitter-ruby's tree into the interpreter's AST, checking what Ruby rejects before running. */
export class Converter {
  private ctx: Context;

  constructor(
    private readonly source: string,
    private readonly atomicRows: ReadonlySet<number>
  ) {
    this.ctx = {
      scope: new LocalScope('top'),
      inDef: false,
      inLoop: false,
      inBlock: false,
      inRescue: false,
      inClassBody: false,
    };
  }

  /** The rows of the `# atomic` annotations that a method definition claimed. */
  readonly claimedAtomicRows = new Set<number>();

  convertProgram(root: Node): Program {
    const body = this.body(namedChildren(root), 0);
    return { body, locals: this.ctx.scope.names };
  }

  // Statements --------------------------------------------------------------------------------------------------------

  /**
   * Converts a sequence of statements whose value is used as `use` says: only the last statement's value can be.
   */
  private body(nodes: Node[], use: Use): Body {
    const statements = nodes.filter((node) => node.type !== 'comment' && node.type !== 'empty_statement');
    return statements.map((node, index) => this.statement(node, index === statements.length - 1 ? use : 0));
  }

  private statement(node: Node, use: Use): Stmt {
    const e = this.expr(node, use);
    let step = stepKindOf(e);
    if (e.k === 'call' && e.fcall && DECLARATION_METHODS.has(e.name)) step = 'none';
    if (this.ctx.inClassBody && !this.ctx.inDef && !this.ctx.inBlock) step = classBodyStepKind(e, step);
    return { e, row: node.startPosition.row, use, step };
  }

  /** Converts a node holding statements, such as `then`, `else`, `do`, or `body_statement`, into a body. */
  private bodyOf(node: Node | null | undefined, use: Use): Body {
    if (!node) return [];
    if (BODY_CONTAINERS.has(node.type)) return this.body(namedChildren(node), use);
    return [this.statement(node, use)];
  }

  /**
   * Converts a `body_statement` or `begin`, whose `rescue`, `else`, and `ensure` clauses wrap the statements before
   * them.
   */
  private rescueBody(node: Node | null | undefined, use: Use): Body {
    if (!node) return [];
    if (!BODY_CONTAINERS.has(node.type)) return [this.statement(node, use)];
    const children = namedChildren(node).filter((child) => child.type !== 'comment');
    const clauses = children.filter((child) => ['rescue', 'else', 'ensure'].includes(child.type));
    if (clauses.length === 0) return this.body(children, use);
    const main = children.filter((child) => !clauses.includes(child));
    const elseNode = clauses.find((child) => child.type === 'else');
    const ensureNode = clauses.find((child) => child.type === 'ensure');
    const rescueNodes = clauses.filter((child) => child.type === 'rescue');
    if (elseNode && rescueNodes.length === 0) this.fail(elseNode, 'rescue のない begin では else を使えません。');
    const body = this.body(main, rescueNodes.length > 0 || elseNode ? (elseNode ? 0 : use) : use);
    const rescues = rescueNodes.map((rescue) => this.rescueClause(rescue, use));
    const elseBody = elseNode ? this.body(namedChildren(elseNode), use) : undefined;
    const ensureBody = ensureNode ? this.body(namedChildren(ensureNode), 0) : undefined;
    const e: Expr = { k: 'begin', body, rescues, else: elseBody, ensure: ensureBody };
    return [{ e, row: node.startPosition.row, use, step: 'none' }];
  }

  private rescueClause(node: Node, use: Use): Rescue {
    const exceptions = node.childForFieldName('exceptions');
    const classes = exceptions ? namedChildren(exceptions).map((child) => this.argument(child)) : [];
    const variableNode = node.childForFieldName('variable');
    const variableTarget = variableNode ? namedChildren(variableNode)[0] : undefined;
    const variable = variableTarget ? this.target(variableTarget) : undefined;
    const outer = this.ctx.inRescue;
    this.ctx.inRescue = true;
    try {
      const body = this.bodyOf(node.childForFieldName('body'), use);
      return { classes, variable, body, row: node.startPosition.row };
    } finally {
      this.ctx.inRescue = outer;
    }
  }

  // Expressions -------------------------------------------------------------------------------------------------------

  private expr(node: Node, use: Use = 1): Expr {
    switch (node.type) {
      case 'integer': {
        return { k: 'int', v: this.integerValue(node) };
      }
      case 'float': {
        return { k: 'float', v: this.floatValue(node) };
      }
      case 'nil':
      case 'true':
      case 'false':
      case 'self': {
        return { k: node.type };
      }
      case 'string': {
        return this.string(node);
      }
      case 'simple_symbol': {
        return { k: 'sym', name: node.text.slice(1) };
      }
      case 'array': {
        return { k: 'array', items: this.arrayItems(namedChildren(node)) };
      }
      case 'hash': {
        return { k: 'hash', items: this.hashItems(namedChildren(node)), braces: true };
      }
      case 'range': {
        const from = node.childForFieldName('begin');
        const to = node.childForFieldName('end');
        return {
          k: 'range',
          from: from ? this.value(from) : undefined,
          to: to ? this.value(to) : undefined,
          exclusive: node.childForFieldName('operator')?.text === '...',
        };
      }
      case 'identifier': {
        return this.identifier(node, use);
      }
      case 'constant': {
        return { k: 'const', name: node.text, row: node.startPosition.row };
      }
      case 'instance_variable': {
        return { k: 'ivar', name: node.text };
      }
      case 'class_variable': {
        return { k: 'cvar', name: node.text };
      }
      case 'global_variable': {
        return { k: 'gvar', name: node.text };
      }
      case 'scope_resolution': {
        return this.scopeResolution(node);
      }
      case 'parenthesized_statements': {
        const body = this.body(namedChildren(node), use);
        if (body.length === 0) return { k: 'nil' };
        if (body.length === 1 && body[0].step !== 'assign') return body[0].e;
        return { k: 'seq', body };
      }
      case 'assignment': {
        return this.assignment(node);
      }
      case 'operator_assignment': {
        return this.operatorAssignment(node);
      }
      case 'call': {
        return this.call(node, use);
      }
      case 'element_reference': {
        return this.elementReference(node, use);
      }
      case 'binary': {
        return this.binary(node);
      }
      case 'unary': {
        return this.unary(node);
      }
      case 'conditional': {
        return {
          k: 'if',
          cond: this.value(required(node.childForFieldName('condition'))),
          consequent: [this.statement(required(node.childForFieldName('consequence')), use)],
          alternative: [this.statement(required(node.childForFieldName('alternative')), use)],
        };
      }
      case 'if':
      case 'unless':
      case 'elsif': {
        return this.ifNode(node, use);
      }
      case 'if_modifier':
      case 'unless_modifier': {
        const body = [this.statement(required(node.childForFieldName('body')), use)];
        const cond = this.value(required(node.childForFieldName('condition')));
        return node.type === 'if_modifier'
          ? { k: 'if', cond, consequent: body }
          : { k: 'if', cond, consequent: [], alternative: body };
      }
      case 'while':
      case 'until': {
        const cond = this.value(required(node.childForFieldName('condition')));
        const body = this.loopBody(() => this.bodyOf(node.childForFieldName('body'), 0));
        return { k: 'while', cond, body, until: node.type === 'until', doWhile: false };
      }
      case 'while_modifier':
      case 'until_modifier': {
        const bodyNode = required(node.childForFieldName('body'));
        const cond = this.value(required(node.childForFieldName('condition')));
        const doWhile = bodyNode.type === 'begin' && !namedChildren(bodyNode).some((c) => RESCUE_CLAUSES.has(c.type));
        const body = this.loopBody(() =>
          doWhile ? this.body(namedChildren(bodyNode), 0) : [this.statement(bodyNode, 0)]
        );
        return { k: 'while', cond, body, until: node.type === 'until_modifier', doWhile };
      }
      case 'for': {
        return this.forNode(node);
      }
      case 'case': {
        return this.caseNode(node, use);
      }
      case 'break':
      case 'next': {
        return this.jump(node, node.type);
      }
      case 'return': {
        if (this.ctx.inClassBody && !this.ctx.inDef && !this.ctx.inBlock) {
          this.fail(node, 'クラス・モジュールの本体では return を使えません。');
        }
        return { k: 'return', value: this.jumpValue(node) };
      }
      case 'retry': {
        if (!this.ctx.inRescue) this.fail(node, 'retry は、rescue の中でしか使えません。');
        return { k: 'retry' };
      }
      case 'yield': {
        if (!this.ctx.inDef) this.fail(node, 'yield は、メソッドの中でしか使えません。');
        const list = namedChildren(node).find((child) => child.type === 'argument_list');
        const { args } = list ? this.argumentList(list) : { args: [] };
        return { k: 'yield', args, used: use, row: node.startPosition.row };
      }
      case 'super': {
        return { k: 'super', used: use, row: node.startPosition.row };
      }
      case 'begin': {
        return this.beginNode(node, use);
      }
      case 'rescue_modifier': {
        return {
          k: 'rescueMod',
          body: this.expr(required(node.childForFieldName('body'))),
          handler: this.expr(required(node.childForFieldName('handler'))),
        };
      }
      case 'method': {
        return this.methodNode(node);
      }
      case 'singleton_method': {
        return this.singletonMethod(node);
      }
      case 'class': {
        return this.classNode(node);
      }
      case 'module': {
        return this.moduleNode(node);
      }
      case 'lambda': {
        return { k: 'lambda', block: this.block(node, true) };
      }
      case 'splat_argument': {
        return { k: 'splat', e: this.value(onlyNamedChild(node)) };
      }
      default: {
        return this.unsupportedNode(node);
      }
    }
  }

  private unsupportedNode(node: Node): never {
    const feature = UNSUPPORTED_NODES[node.type];
    if (feature) this.unsupported(node, feature);
    this.fail(node, '書き方に誤りがあります。');
  }

  private identifier(node: Node, use: Use): Expr {
    const name = node.text;
    if (name === '__FILE__' || name === '__LINE__' || name === '__ENCODING__')
      this.unsupported(node, `${name}（ソースファイルの情報）`);
    const depth = this.ctx.scope.depthOf(name);
    if (depth >= 0) return { k: 'lvar', name, depth };
    if (this.ctx.inBlock && (name === 'it' || /^_[1-9]$/.test(name))) {
      this.unsupported(node, name === 'it' ? 'ブロックの it' : '番号指定パラメータ（_1 など）');
    }
    return {
      k: 'call',
      name,
      args: [],
      safe: false,
      fcall: true,
      vcall: true,
      used: use,
      row: node.startPosition.row,
    };
  }

  private scopeResolution(node: Node): Expr {
    const scope = node.childForFieldName('scope');
    const name = required(node.childForFieldName('name'));
    if (name.type !== 'constant') {
      return {
        k: 'call',
        recv: scope ? this.value(scope) : undefined,
        name: name.text,
        args: [],
        safe: false,
        fcall: false,
        vcall: false,
        used: 1,
        row: node.startPosition.row,
      };
    }
    return scope
      ? { k: 'const', scope: this.value(scope), name: name.text, row: node.startPosition.row }
      : { k: 'const', top: true, name: name.text, row: node.startPosition.row };
  }

  private integerValue(node: Node): bigint {
    const text = node.text.replaceAll('_', '');
    if (/^0[xXbBoOdD0-9]/.test(text) && text !== '0') {
      this.unsupported(node, '10進数以外の整数のリテラル（0x・0b・0o など）');
    }
    return BigInt(text);
  }

  private floatValue(node: Node): number {
    const text = node.text.replaceAll('_', '');
    if (/[eE]/.test(text)) this.unsupported(node, '指数表記の小数のリテラル（1e3 など）');
    return Number(text);
  }

  private string(node: Node): Expr {
    const text = node.text;
    if (text.startsWith('%')) this.unsupported(node, '% 記法の文字列（%q() など）');
    if (text.startsWith("'")) {
      const content = namedChildren(node)
        .map((child) => child.text)
        .join('');
      return { k: 'str', parts: [decodeSingleQuoted(content)] };
    }
    return { k: 'str', parts: this.stringParts(node) };
  }

  // code-gauge-allow functionCognitiveComplexity 17 -- One case per kind of syntax node.
  private stringParts(node: Node): StrPart[] {
    const parts: StrPart[] = [];
    let literal = '';
    for (const child of namedChildren(node)) {
      if (child.type === 'string_content') {
        literal += child.text;
      } else if (child.type === 'escape_sequence') {
        literal += child.text;
      } else if (child.type === 'interpolation') {
        if (literal) {
          const decoded = this.decode(node, literal);
          parts.push(decoded.bytes ? { text: decoded.text, bytes: decoded.bytes } : decoded.text);
        }
        literal = '';
        const statements = this.body(namedChildren(child), 1);
        parts.push(
          statements.length === 1
            ? statements[0].e
            : statements.length === 0
              ? { k: 'nil' }
              : { k: 'seq', body: statements }
        );
      } else if (child.type !== 'comment') {
        this.unsupportedNode(child);
      }
    }
    if (literal) {
      const decoded = this.decode(node, literal);
      parts.push(decoded.bytes ? { text: decoded.text, bytes: decoded.bytes } : decoded.text);
    }
    return parts;
  }

  private decode(node: Node, text: string): { text: string; binary: boolean; bytes?: number[] } {
    const decoded = decodeDoubleQuoted(text);
    if (decoded === undefined) this.fail(node, '文字列のエスケープの書き方に誤りがあります。');
    return decoded;
  }

  private arrayItems(nodes: Node[]): Expr[] {
    const items: Expr[] = [];
    const pairs: Node[] = [];
    for (const node of nodes) {
      if (node.type === 'comment') continue;
      if (node.type === 'pair' || node.type === 'hash_splat_argument') {
        pairs.push(node);
        continue;
      }
      items.push(this.argument(node));
    }
    if (pairs.length > 0) items.push({ k: 'hash', items: this.hashItems(pairs), braces: false });
    return items;
  }

  private hashItems(nodes: Node[]): HashItem[] {
    const items: HashItem[] = [];
    for (const node of nodes) {
      if (node.type === 'comment') continue;
      if (node.type === 'hash_splat_argument') {
        items.push({ splat: this.value(onlyNamedChild(node)) });
        continue;
      }
      if (node.type !== 'pair') this.unsupportedNode(node);
      items.push(this.pair(node));
    }
    return items;
  }

  private pair(node: Node): { key: Expr; value: Expr } {
    const keyNode = required(node.childForFieldName('key'));
    const valueNode = node.childForFieldName('value');
    const usesArrow = node.children.some((child) => child?.type === '=>');
    let key: Expr;
    if (keyNode.type === 'hash_key_symbol') {
      key = { k: 'sym', name: keyNode.text };
    } else if (!usesArrow) {
      this.unsupported(keyNode, '文字列で書いたシンボルのキー（"a b": 1）');
    } else {
      key = this.value(keyNode);
    }
    if (valueNode) return { key, value: this.value(valueNode) };
    // `{x:}` takes the value of the variable or method of that name.
    return { key, value: this.identifier(keyNode, 1) };
  }

  /** An argument, which may be a splat (`*a`) where a list of values is expected. */
  private argument(node: Node): Expr {
    if (node.type === 'splat_argument') return { k: 'splat', e: this.value(onlyNamedChild(node)) };
    return this.value(node);
  }

  private argumentList(node: Node): { args: Expr[]; blockArg?: Expr } {
    const args: Expr[] = [];
    const pairs: Node[] = [];
    let blockArg: Expr | undefined;
    for (const child of namedChildren(node)) {
      switch (child.type) {
        case 'comment': {
          break;
        }
        case 'pair':
        case 'hash_splat_argument': {
          pairs.push(child);
          break;
        }
        case 'block_argument': {
          const value = namedChildren(child)[0];
          if (!value) this.unsupported(child, '名前のない & 引数の受け渡し');
          blockArg = this.value(value);
          break;
        }
        case 'forward_argument': {
          this.unsupported(child, '引数の転送（...）');
          break;
        }
        default: {
          if (pairs.length > 0) this.fail(child, 'キーワード引数の後に位置引数は書けません。');
          args.push(this.argument(child));
        }
      }
    }
    if (pairs.length > 0) args.push({ k: 'hash', items: this.hashItems(pairs), braces: false });
    return { args, blockArg };
  }

  // Assignments -------------------------------------------------------------------------------------------------------

  private assignment(node: Node): Expr {
    const left = required(node.childForFieldName('left'));
    const right = required(node.childForFieldName('right'));
    if (left.type === 'left_assignment_list') {
      const targets = this.multiTarget(left);
      return { k: 'asgn', target: targets, value: this.assignedValue(right, true), row: node.startPosition.row };
    }
    const target = this.target(left);
    return { k: 'asgn', target, value: this.assignedValue(right, false), row: node.startPosition.row };
  }

  private assignedValue(node: Node, multiple: boolean): Expr {
    if (node.type === 'right_assignment_list') {
      return { k: 'array', items: namedChildren(node).map((child) => this.argument(child)) };
    }
    if (node.type === 'splat_argument') return { k: 'array', items: [this.argument(node)] };
    const value = this.expr(node);
    this.checkValue(node, value);
    return multiple ? value : value;
  }

  /** Rejects a value that leaves the expression, such as `x = return`, as Ruby's "void value expression" does. */
  private checkValue(node: Node, value: Expr): void {
    if (value.k === 'return' || value.k === 'break' || value.k === 'next' || value.k === 'retry') {
      this.fail(node, `${value.k} は値として使えません。`);
    }
  }

  private value(node: Node): Expr {
    const value = this.expr(node);
    this.checkValue(node, value);
    return value;
  }

  private operatorAssignment(node: Node): Expr {
    const left = required(node.childForFieldName('left'));
    const operator = required(node.childForFieldName('operator')).text;
    const target = this.target(left);
    const value = this.value(required(node.childForFieldName('right')));
    return { k: 'opasgn', target, op: operator.slice(0, -1), value, row: node.startPosition.row };
  }

  private multiTarget(node: Node): MultiTarget {
    const items: Target[] = [];
    let splat: number | undefined;
    for (const child of namedChildren(node)) {
      if (child.type === 'comment') continue;
      if (child.type === 'rest_assignment') {
        splat = items.length;
        const inner = namedChildren(child)[0];
        items.push(inner ? this.target(inner) : { k: 'mlhs', items: [] });
        continue;
      }
      items.push(this.target(child));
    }
    return { k: 'mlhs', items, splat };
  }

  // code-gauge-allow functionNcss 40 -- One case per kind of syntax node.
  private target(node: Node): Target {
    switch (node.type) {
      case 'identifier': {
        const name = node.text;
        return { k: 'lvar', name, depth: this.ctx.scope.declare(name) };
      }
      case 'instance_variable': {
        return { k: 'ivar', name: node.text };
      }
      case 'class_variable': {
        return { k: 'cvar', name: node.text };
      }
      case 'global_variable': {
        return { k: 'gvar', name: node.text };
      }
      case 'constant': {
        this.checkConstantAssignment(node);
        return { k: 'const', name: node.text, row: node.startPosition.row };
      }
      case 'scope_resolution': {
        this.checkConstantAssignment(node);
        const scope = node.childForFieldName('scope');
        const name = required(node.childForFieldName('name')).text;
        return scope
          ? { k: 'const', scope: this.value(scope), name, row: node.startPosition.row }
          : { k: 'const', top: true, name, row: node.startPosition.row };
      }
      case 'element_reference': {
        const object = required(node.childForFieldName('object'));
        const recv = this.value(object);
        const args = namedChildren(node)
          .filter((child) => child.id !== object.id && child.type !== 'comment')
          .map((child) => this.argument(child));
        return { k: 'index', recv, args, row: node.startPosition.row };
      }
      case 'call': {
        const receiver = node.childForFieldName('receiver');
        const method = node.childForFieldName('method');
        if (!receiver || !method || node.childForFieldName('arguments') || node.childForFieldName('block')) break;
        const operator = node.childForFieldName('operator')?.text;
        return {
          k: 'attr',
          recv: this.value(receiver),
          name: method.text,
          safe: operator === '&.',
          row: node.startPosition.row,
        };
      }
      case 'left_assignment_list':
      case 'destructured_left_assignment': {
        return this.multiTarget(node);
      }
      case 'self':
      case 'nil':
      case 'true':
      case 'false': {
        this.fail(node, `${ASSIGNABLE_KEYWORDS[node.type]} には代入できません。`);
        break;
      }
    }
    this.fail(node, 'この式には代入できません。');
  }

  private checkConstantAssignment(node: Node): void {
    if (this.ctx.inDef) this.fail(node, 'メソッドの中では定数に代入できません。');
  }

  // Calls -------------------------------------------------------------------------------------------------------------

  private call(node: Node, use: Use): Expr {
    const receiverNode = node.childForFieldName('receiver');
    const methodNode = node.childForFieldName('method');
    const argumentsNode = node.childForFieldName('arguments');
    const blockNode = node.childForFieldName('block');
    const operator = node.childForFieldName('operator')?.text;
    const recv = receiverNode ? this.value(receiverNode) : undefined;
    const { args, blockArg } = argumentsNode ? this.argumentList(argumentsNode) : { args: [], blockArg: undefined };
    if (methodNode?.type === 'super') {
      const block = blockNode ? this.block(blockNode, false) : undefined;
      if (block && blockArg) this.fail(node, 'ブロックと & 引数を同時に渡すことはできません。');
      return { k: 'super', args, blockArg, block, used: use, row: node.startPosition.row };
    }
    const name = methodNode ? methodNode.text : 'call';
    const block = blockNode ? this.block(blockNode, false) : undefined;
    if (block && blockArg) this.fail(node, 'ブロックと & 引数を同時に渡すことはできません。');
    const call: Call = {
      k: 'call',
      recv,
      name,
      args,
      blockArg,
      block,
      safe: operator === '&.',
      fcall: !recv || recv.k === 'self',
      vcall: false,
      used: use,
      row: node.startPosition.row,
    };
    return call;
  }

  private elementReference(node: Node, use: Use): Expr {
    const object = required(node.childForFieldName('object'));
    const rest = namedChildren(node).filter((child) => child.id !== object.id && child.type !== 'comment');
    const recv = this.value(object);
    const { args, blockArg } = this.argumentListFrom(rest);
    return {
      k: 'call',
      recv,
      name: '[]',
      args,
      blockArg,
      safe: false,
      fcall: false,
      vcall: false,
      used: use,
      row: node.startPosition.row,
    };
  }

  private argumentListFrom(nodes: Node[]): { args: Expr[]; blockArg?: Expr } {
    const args: Expr[] = [];
    const pairs: Node[] = [];
    for (const child of nodes) {
      if (child.type === 'pair' || child.type === 'hash_splat_argument') pairs.push(child);
      else if (child.type === 'block_argument') this.unsupported(child, '[] への & 引数');
      else {
        if (pairs.length > 0) this.fail(child, 'キーワード引数の後に位置引数は書けません。');
        args.push(this.argument(child));
      }
    }
    if (pairs.length > 0) args.push({ k: 'hash', items: this.hashItems(pairs), braces: false });
    return { args };
  }

  private binary(node: Node): Expr {
    const operator = required(node.childForFieldName('operator')).text;
    const leftNode = required(node.childForFieldName('left'));
    const rightNode = required(node.childForFieldName('right'));
    const left = this.value(leftNode);
    const right = this.value(rightNode);
    switch (operator) {
      case '&&':
      case 'and': {
        return { k: 'and', l: left, r: right };
      }
      case '||':
      case 'or': {
        return { k: 'or', l: left, r: right };
      }
      case '=~':
      case '!~': {
        this.unsupported(node, `正規表現のマッチ（${operator}）`);
      }
    }
    if (operator === '!=') {
      return this.operatorCall(node, left, '!=', [right]);
    }
    return this.operatorCall(node, left, operator, [right]);
  }

  private operatorCall(node: Node, recv: Expr, name: string, args: Expr[]): Expr {
    return {
      k: 'call',
      recv,
      name,
      args,
      safe: false,
      fcall: false,
      vcall: false,
      used: 1,
      row: node.startPosition.row,
    };
  }

  // code-gauge-allow functionCognitiveComplexity 19 -- One case per kind of syntax node.
  private unary(node: Node): Expr {
    const operator = required(node.childForFieldName('operator')).text;
    const operandNode = required(node.childForFieldName('operand'));
    if (operator === 'defined?') this.unsupported(node, 'defined?');
    if ((operator === '-' || operator === '+') && (operandNode.type === 'integer' || operandNode.type === 'float')) {
      const operand = this.value(operandNode);
      const sign = operator === '-' && !/^\s/.test(this.source.slice(node.startIndex + 1, operandNode.startIndex));
      if (sign || operator === '+') {
        if (operator === '+') return operand;
        if (operand.k === 'int') return { k: 'int', v: -operand.v };
        if (operand.k === 'float') return { k: 'float', v: -operand.v };
      }
    }
    const operand = this.value(operandNode);
    switch (operator) {
      case '!':
      case 'not': {
        return { k: 'not', e: operand, row: node.startPosition.row };
      }
      case '-': {
        return this.operatorCall(node, operand, '-@', []);
      }
      case '+': {
        return this.operatorCall(node, operand, '+@', []);
      }
      case '~': {
        return this.operatorCall(node, operand, '~', []);
      }
    }
    this.unsupportedNode(node);
  }

  // Control structures ------------------------------------------------------------------------------------------------

  private ifNode(node: Node, use: Use): Expr {
    const cond = this.value(required(node.childForFieldName('condition')));
    const consequence = this.bodyOf(node.childForFieldName('consequence'), use);
    const alternativeNode = node.childForFieldName('alternative');
    let alternative: Body | undefined;
    if (alternativeNode?.type === 'elsif') {
      alternative = [
        { e: this.ifNode(alternativeNode, use), row: alternativeNode.startPosition.row, use, step: 'none' },
      ];
    } else if (alternativeNode) {
      alternative = this.bodyOf(alternativeNode, use);
    }
    if (node.type === 'unless') return { k: 'if', cond, consequent: alternative ?? [], alternative: consequence };
    return { k: 'if', cond, consequent: consequence, alternative };
  }

  private loopBody<T>(convert: () => T): T {
    const outer = this.ctx.inLoop;
    const outerBlock = this.ctx.inBlock;
    this.ctx.inLoop = true;
    try {
      return convert();
    } finally {
      this.ctx.inLoop = outer;
      this.ctx.inBlock = outerBlock;
    }
  }

  private forNode(node: Node): Expr {
    const patternNode = required(node.childForFieldName('pattern'));
    const target = this.target(patternNode);
    const inNode = required(node.childForFieldName('value'));
    const iter = this.value(onlyNamedChild(inNode));
    const body = this.loopBody(() => this.bodyOf(node.childForFieldName('body'), 0));
    return { k: 'for', target, iter, body, row: node.startPosition.row };
  }

  private caseNode(node: Node, use: Use): Expr {
    const valueNode = node.childForFieldName('value');
    const subject = valueNode ? this.value(valueNode) : undefined;
    const whens: { conds: Expr[]; body: Body; row: number }[] = [];
    let elseBody: Body | undefined;
    for (const child of namedChildren(node)) {
      if (child.type === 'when') {
        const conds = child.children
          .filter((part): part is Node => part?.type === 'pattern')
          .map((pattern) => this.argument(onlyNamedChild(pattern)));
        whens.push({ conds, body: this.bodyOf(child.childForFieldName('body'), use), row: child.startPosition.row });
      } else if (child.type === 'else') {
        elseBody = this.bodyOf(child, use);
      }
    }
    return { k: 'case', subject, whens, else: elseBody };
  }

  private jump(node: Node, kind: 'break' | 'next'): Expr {
    if (!this.ctx.inLoop && !this.ctx.inBlock) this.fail(node, `${kind} は、ループかブロックの中でしか使えません。`);
    return { k: kind, value: this.jumpValue(node), inBlock: !this.ctx.inLoop };
  }

  private jumpValue(node: Node): Expr | undefined {
    const list = namedChildren(node).find((child) => child.type === 'argument_list');
    if (!list) return undefined;
    const { args } = this.argumentList(list);
    if (args.length === 1 && args[0].k !== 'splat') return args[0];
    return { k: 'array', items: args };
  }

  private beginNode(node: Node, use: Use): Expr {
    const statements = this.rescueBody(node, use);
    if (statements.length === 1 && statements[0].e.k === 'begin') return statements[0].e;
    return { k: 'seq', body: statements };
  }

  // Definitions -------------------------------------------------------------------------------------------------------

  private methodNode(node: Node): Expr {
    return { k: 'def', def: this.methodDef(node) };
  }

  private singletonMethod(node: Node): Expr {
    const objectNode = required(node.childForFieldName('object'));
    if (objectNode.type !== 'self' && objectNode.type !== 'constant') {
      this.unsupported(objectNode, 'オブジェクトの特異メソッドの定義（def obj.m）');
    }
    return { k: 'def', def: this.methodDef(node), singleton: this.value(objectNode) };
  }

  private methodDef(node: Node): MethodDef {
    const nameNode = required(node.childForFieldName('name'));
    const name = nameNode.text;
    if (name === 'method_missing' || name === 'respond_to_missing?') {
      this.unsupported(nameNode, `${name} の定義`);
    }
    const row = node.startPosition.row;
    const outer = this.ctx;
    const scope = new LocalScope('method');
    this.ctx = { scope, inDef: true, inLoop: false, inBlock: false, inRescue: false, inClassBody: false };
    try {
      const parametersNode = node.childForFieldName('parameters');
      const params = this.params(parametersNode, false);
      const bodyNode = node.childForFieldName('body');
      const isEndless = bodyNode !== null && !BODY_CONTAINERS.has(bodyNode.type);
      const body = isEndless ? [this.statement(bodyNode, 2)] : this.rescueBody(bodyNode, 2);
      return { name, params, body, locals: scope.names, row, isAtomic: this.claimAtomic(node, parametersNode) };
    } finally {
      this.ctx = outer;
    }
  }

  /** Whether an `# atomic` annotation ends one of the rows of the method's header, which it then claims. */
  private claimAtomic(node: Node, parametersNode: Node | null): boolean {
    const headerEnd = (parametersNode ?? required(node.childForFieldName('name'))).endPosition.row;
    for (let row = node.startPosition.row; row <= headerEnd; row++) {
      if (this.atomicRows.has(row)) {
        this.claimedAtomicRows.add(row);
        return true;
      }
    }
    return false;
  }

  private params(node: Node | null, isBlock: boolean): Params {
    const params: Params = { required: [], optional: [], post: [], keywords: [], trailingComma: false };
    if (!node) return params;
    const seen = new Set<string>();
    const declare = (child: Node, name: string): string => {
      if (seen.has(name) && name !== '_' && !name.startsWith('_')) {
        this.fail(child, `引数の名前「${name}」が重複しています。`);
      }
      seen.add(name);
      this.ctx.scope.declareOwn(name);
      return name;
    };
    const blockLocals = new Set<number>();
    let phase = 0;
    const advance = (child: Node, next: number): void => {
      if (next < phase) this.fail(child, '引数の並び順に誤りがあります。');
      phase = next;
    };
    for (let index = 0; index < node.childCount; index++)
      if (node.fieldNameForChild(index) === 'locals') blockLocals.add(required(node.child(index)).id);
    for (const child of namedChildren(node)) {
      if (blockLocals.has(child.id)) continue;
      switch (child.type) {
        case 'comment': {
          break;
        }
        case 'identifier': {
          advance(child, params.rest !== undefined || params.optional.length > 0 ? 3 : 0);
          const target: ParamTarget = declare(child, child.text);
          (params.rest === undefined && params.optional.length === 0 ? params.required : params.post).push(target);
          break;
        }
        case 'optional_parameter': {
          advance(child, 1);
          const name = declare(child, required(child.childForFieldName('name')).text);
          params.optional.push({ name, value: this.value(required(child.childForFieldName('value'))) });
          break;
        }
        case 'splat_parameter': {
          advance(child, 2);
          if (params.rest !== undefined) this.fail(child, '* の引数は1つしか書けません。');
          const nameNode = child.childForFieldName('name');
          params.rest = nameNode ? declare(child, nameNode.text) : '';
          break;
        }
        case 'hash_splat_parameter': {
          advance(child, 5);
          if (params.keywordRest !== undefined) this.fail(child, '** の引数は1つしか書けません。');
          const nameNode = child.childForFieldName('name');
          params.keywordRest = nameNode ? declare(child, nameNode.text) : '';
          break;
        }
        case 'keyword_parameter': {
          advance(child, 4);
          const name = declare(child, required(child.childForFieldName('name')).text);
          const valueNode = child.childForFieldName('value');
          params.keywords.push({ name, value: valueNode ? this.value(valueNode) : undefined });
          break;
        }
        case 'block_parameter': {
          advance(child, 6);
          if (params.block !== undefined) this.fail(child, '& の引数は1つしか書けません。');
          const nameNode = child.childForFieldName('name');
          if (!nameNode) this.unsupported(child, '名前のない & 引数');
          params.block = declare(child, nameNode.text);
          break;
        }
        case 'destructured_parameter': {
          advance(child, params.rest !== undefined || params.optional.length > 0 ? 3 : 0);
          const target = this.destructuredParameter(child, declare);
          (params.rest === undefined && params.optional.length === 0 ? params.required : params.post).push(target);
          break;
        }
        case 'forward_parameter': {
          this.unsupported(child, '引数の転送（...）');
          break;
        }
        case 'hash_splat_nil': {
          this.unsupported(child, '**nil');
          break;
        }
        default: {
          this.unsupportedNode(child);
        }
      }
    }
    const lastToken = node.children.at(-2);
    if (isBlock && lastToken?.type === ',') params.trailingComma = true;
    return params;
  }

  /** The targets of a parameter written as `(a, (b, *c))`, which destructures one argument. */
  private destructuredParameter(node: Node, declare: (child: Node, name: string) => string): MultiTarget {
    const items: Target[] = [];
    let splat: number | undefined;
    for (const child of namedChildren(node)) {
      if (child.type === 'comment') continue;
      if (child.type === 'identifier') {
        items.push({ k: 'lvar', name: declare(child, child.text), depth: 0 });
      } else if (child.type === 'splat_parameter') {
        splat = items.length;
        const nameNode = child.childForFieldName('name');
        items.push(nameNode ? { k: 'lvar', name: declare(child, nameNode.text), depth: 0 } : { k: 'mlhs', items: [] });
      } else if (child.type === 'destructured_parameter') {
        items.push(this.destructuredParameter(child, declare));
      } else {
        this.unsupportedNode(child);
      }
    }
    return { k: 'mlhs', items, splat };
  }

  private block(node: Node, isLambdaLiteral: boolean): BlockDef {
    const outer = this.ctx;
    const scope = new LocalScope('block', outer.scope);
    this.ctx = { ...outer, scope, inBlock: true, inLoop: false };
    try {
      const parametersNode = node.childForFieldName('parameters');
      let params: Params | undefined;
      if (parametersNode) {
        params = this.params(parametersNode, !isLambdaLiteral);
        this.declareBlockLocals(parametersNode, scope);
      }
      let bodyNode = node.childForFieldName('body');
      if (isLambdaLiteral && bodyNode && (bodyNode.type === 'block' || bodyNode.type === 'do_block')) {
        bodyNode = bodyNode.childForFieldName('body');
      }
      const body = this.rescueBody(bodyNode, 2);
      return { params, locals: scope.names, body, row: node.startPosition.row, isLambdaLiteral };
    } finally {
      this.ctx = outer;
    }
  }

  private declareBlockLocals(parametersNode: Node, scope: LocalScope): void {
    for (let index = 0; index < parametersNode.childCount; index++) {
      if (parametersNode.fieldNameForChild(index) !== 'locals') continue;
      const local = parametersNode.child(index);
      if (local) scope.declareOwn(local.text);
    }
  }

  private classNode(node: Node): Expr {
    if (this.ctx.inDef) this.fail(node, 'メソッドの中ではクラスを定義できません。');
    const nameNode = required(node.childForFieldName('name'));
    const path = this.constantPath(nameNode);
    const superclassNode = node.childForFieldName('superclass');
    const superclass = superclassNode ? this.value(onlyNamedChild(superclassNode)) : undefined;
    const body = this.classBody(node);
    return { k: 'class', ...path, superclass, body, row: node.startPosition.row };
  }

  private moduleNode(node: Node): Expr {
    if (this.ctx.inDef) this.fail(node, 'メソッドの中ではモジュールを定義できません。');
    const path = this.constantPath(required(node.childForFieldName('name')));
    return { k: 'module', ...path, body: this.classBody(node), row: node.startPosition.row };
  }

  private constantPath(node: Node): { scope?: Expr; top?: boolean; name: string } {
    if (node.type === 'constant') return { name: node.text };
    if (node.type !== 'scope_resolution') this.fail(node, 'クラス・モジュールの名前は大文字で始めてください。');
    const scope = node.childForFieldName('scope');
    const name = required(node.childForFieldName('name')).text;
    return scope ? { scope: this.value(scope), name } : { top: true, name };
  }

  private classBody(node: Node): Body {
    const outer = this.ctx;
    this.ctx = {
      scope: new LocalScope('class'),
      inDef: false,
      inLoop: false,
      inBlock: false,
      inRescue: false,
      inClassBody: true,
    };
    try {
      return this.rescueBody(node.childForFieldName('body'), 0);
    } finally {
      this.ctx = outer;
    }
  }

  // Errors ------------------------------------------------------------------------------------------------------------

  private fail(node: Node, message: string): never {
    throw new CompileError([{ row: node.startPosition.row, message }]);
  }

  private unsupported(node: Node, feature: string): never {
    this.fail(node, `${feature}${/[!-~]$/.test(feature) ? ' ' : ''}は、この採点環境では使えません。`);
  }
}

/** How a statement records its step, from what it does. */
function stepKindOf(e: Expr): StepKind {
  switch (e.k) {
    case 'asgn':
    case 'opasgn': {
      if (e.target.k === 'const' && e.k === 'asgn' && isLiteral(e.value)) return 'constant';
      return 'assign';
    }
    case 'call':
    case 'super':
    case 'yield': {
      return 'call';
    }
    case 'if':
    case 'while':
    case 'for':
    case 'case':
    case 'break':
    case 'next':
    case 'return':
    case 'retry':
    case 'begin':
    case 'seq':
    case 'def':
    case 'class':
    case 'module': {
      return 'none';
    }
    default: {
      if (containsAssignment(e)) return 'assign';
      return containsCall(e) ? 'expr' : 'value';
    }
  }
}

/**
 * How a statement of a class body records its step: declarations such as `attr_accessor` and `include` record none,
 * and neither does storing a literal, as Java's static fields with constant initializers do.
 */
function classBodyStepKind(e: Expr, step: StepKind): StepKind {
  if (step === 'call' || step === 'expr' || step === 'value') return 'none';
  if (step === 'assign' && e.k === 'asgn' && isLiteral(e.value)) return 'constant';
  return step;
}

/** Whether an expression is made of literals and operators over them, which nothing a program does can change. */
function isLiteral(e: Expr): boolean {
  switch (e.k) {
    case 'nil':
    case 'true':
    case 'false':
    case 'int':
    case 'float':
    case 'sym': {
      return true;
    }
    case 'str': {
      return e.parts.every((part) => typeof part === 'string' || ('text' in part && 'bytes' in part));
    }
    case 'array': {
      return e.items.every((item) => isLiteral(item));
    }
    case 'hash': {
      return e.items.every((item) => 'key' in item && isLiteral(item.key) && isLiteral(item.value));
    }
    case 'range': {
      return (!e.from || isLiteral(e.from)) && (!e.to || isLiteral(e.to));
    }
    case 'call': {
      return OPERATORS.has(e.name) && !!e.recv && isLiteral(e.recv) && e.args.every((arg) => isLiteral(arg));
    }
    default: {
      return false;
    }
  }
}

/** Methods that declare rather than compute, which record no step, as Java's declarations and imports do not. */
const DECLARATION_METHODS = new Set([
  'include',
  'extend',
  'prepend',
  'private',
  'public',
  'protected',
  'module_function',
  'attr_accessor',
  'attr_reader',
  'attr_writer',
  'attr',
  'private_constant',
  'private_class_method',
  'public_class_method',
  'require',
  'require_relative',
]);

const OPERATORS = new Set(['+', '-', '*', '/', '%', '**', '-@', '+@', '<<', '>>', '&', '|', '^', '~']);

function containsAssignment(e: Expr): boolean {
  return someChild(e, (child) => child.k === 'asgn' || child.k === 'opasgn' || containsAssignment(child));
}

function containsCall(e: Expr): boolean {
  return someChild(
    e,
    (child) =>
      (child.k === 'call' && !OPERATORS.has(child.name) && !COMPARISONS.has(child.name)) ||
      child.k === 'yield' ||
      child.k === 'super' ||
      containsCall(child)
  );
}

const COMPARISONS = new Set(['==', '!=', '<', '<=', '>', '>=', '<=>', '===', '[]']);

/** Whether a direct sub-expression satisfies `test`, looking into the statements of nested bodies. */
function someChild(e: Expr, test: (child: Expr) => boolean): boolean {
  for (const child of childrenOf(e)) if (test(child)) return true;
  return false;
}

function childrenOf(e: Expr): Expr[] {
  switch (e.k) {
    case 'str':
    case 'dsym': {
      return e.parts.filter((part): part is Expr => typeof part !== 'string');
    }
    case 'array': {
      return e.items;
    }
    case 'hash': {
      return e.items.flatMap((item) => ('splat' in item ? [item.splat] : [item.key, item.value]));
    }
    case 'range': {
      return [e.from, e.to].filter((part): part is Expr => part !== undefined);
    }
    case 'splat': {
      return [e.e];
    }
    case 'call': {
      return [...(e.recv ? [e.recv] : []), ...e.args];
    }
    case 'and':
    case 'or': {
      return [e.l, e.r];
    }
    case 'not': {
      return [e.e];
    }
    case 'if': {
      return [e.cond, ...[...e.consequent, ...(e.alternative ?? [])].map((statement) => statement.e)];
    }
    case 'seq': {
      return e.body.map((statement) => statement.e);
    }
    case 'rescueMod': {
      return [e.body, e.handler];
    }
    default: {
      return [];
    }
  }
}

const BODY_CONTAINERS = new Set(['then', 'else', 'do', 'body_statement', 'block_body', 'begin', 'ensure']);
const RESCUE_CLAUSES = new Set(['rescue', 'else', 'ensure']);

const UNSUPPORTED_NODES: Record<string, string> = {
  rational: '有理数のリテラル（3r）',
  complex: '虚数のリテラル（2i）',
  character: '文字のリテラル（?a）',
  chained_string: '隣り合う文字列の連結（"a" "b"）',
  heredoc_beginning: 'ヒアドキュメント（<<~EOS）',
  string_array: '% 記法の配列（%w[]）',
  symbol_array: '% 記法の配列（%i[]）',
  delimited_symbol: '文字列で書いたシンボル（:"a b"）',
  regex: '正規表現',
  subshell: '外部コマンドの実行（`...`）',
  file: '__FILE__',
  line: '__LINE__',
  encoding: '__ENCODING__',
  redo: 'redo',
  case_match: 'パターンマッチ（case/in）',
  match_pattern: 'パターンマッチ（=>）',
  test_pattern: 'パターンマッチ（in）',
  singleton_class: '特異クラス（class << self）',
  alias: 'alias',
  undef: 'undef',
  begin_block: 'BEGIN',
  end_block: 'END',
  uninterpreted: '__END__',
  forward_argument: '引数の転送（...）',
};

function namedChildren(node: Node): Node[] {
  return node.namedChildren.filter((child): child is Node => child !== null);
}

function onlyNamedChild(node: Node): Node {
  const child = namedChildren(node).find((candidate) => candidate.type !== 'comment');
  if (!child) throw new CompileError([{ row: node.startPosition.row, message: '書き方に誤りがあります。' }]);
  return child;
}

function required(node: Node | null): Node {
  if (!node) throw new Error('A required node is missing');
  return node;
}
