import type { Node } from '@willbooster/web-tree-sitter';

import { CompileError } from '../interpreter/diagnostics';
import type {
  BlockDef,
  Body,
  Call,
  Expr,
  HashItem,
  InClause,
  LocalRef,
  MethodDef,
  MultiTarget,
  Params,
  ParamTarget,
  Pattern,
  Program,
  Rescue,
  StepKind,
  Stmt,
  StrPart,
  Target,
  Use,
} from './ast';
import { decodeDoubleQuoted, decodeSingleQuoted } from './escapes';
import { translate } from './libRegexp';
import { regexpCaptureNames, regexpHasNumberedBackref } from './regexpCaptureNames';
import { UnsupportedFeatureError } from './runtime';

/** The local variables of one scope; a block's scope sees its parents' variables. */
class LocalScope {
  readonly names: string[] = [];
  private readonly set = new Set<string>();
  readonly implicitNames = new Set<string>();
  numberedUsed = false;
  innerNumberedUsed = false;

  constructor(
    readonly kind: 'top' | 'method' | 'class' | 'block' | 'end',
    readonly parent?: LocalScope
  ) {}

  enclosingBlock(): LocalScope | undefined {
    let parent = this.parent;
    while (parent?.kind === 'end') parent = parent.parent;
    return parent?.kind === 'block' ? parent : undefined;
  }

  private self(): LocalScope {
    return this;
  }

  /** How many block scopes out the variable is, or -1 when no visible scope declares it. */
  depthOf(name: string): number {
    let depth = 0;
    for (
      let scope: LocalScope | undefined = this.self();
      scope;
      scope = scope.kind === 'block' || scope.kind === 'end' ? scope.parent : undefined
    ) {
      if (scope.set.has(name)) return depth;
      depth++;
    }
    return -1;
  }

  forwardingDepth(name: string): number {
    let depth = 0;
    for (
      let scope: LocalScope | undefined = this.self();
      scope;
      scope = scope.kind === 'block' || scope.kind === 'end' ? scope.parent : undefined
    ) {
      if (scope.kind === 'method' && scope.set.has(name)) return depth;
      depth++;
    }
    return -1;
  }

  implicitDeclaration(name: string): boolean {
    for (
      let scope: LocalScope | undefined = this.self();
      scope;
      scope = scope.kind === 'block' || scope.kind === 'end' ? scope.parent : undefined
    ) {
      if (scope.set.has(name)) return scope.implicitNames.has(name);
    }
    return false;
  }

  declare(name: string): number {
    const depth = this.depthOf(name);
    if (depth >= 0) return depth;
    if (this.kind === 'end') {
      return this.parent!.declare(name) + 1;
    }
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
  /** The numbered parameters (`_1`) or `it` a block without parameters uses, which become its parameters. */
  implicit?: Set<string>;
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
    this.collectHeredocs(root);
    const children = namedChildren(root);
    const data = children.find((child) => child.type === 'uninterpreted');
    const beginBody: Body = [];
    const restBody: Body = [];
    for (const child of children) {
      if (child.type === 'uninterpreted') continue;
      if (child.type === 'begin_block') beginBody.push(...this.body(namedChildren(child), 0));
      else restBody.push(...this.body([child], 0));
    }
    const body = [...beginBody, ...restBody];
    return {
      body,
      locals: this.ctx.scope.names,
      data: data ? data.text.replace(/^\n/, '') : undefined,
      dataFile: data ? this.source : undefined,
    };
  }

  /** The bodies of the heredocs, in the order their openings appear, which the tree places after their lines. */
  private readonly heredocBodies: Node[] = [];
  private heredocIndex = 0;

  private collectHeredocs(root: Node): void {
    for (const node of root.descendantsOfType('heredoc_body')) if (node) this.heredocBodies.push(node);
  }

  // Statements --------------------------------------------------------------------------------------------------------

  /**
   * Converts a sequence of statements whose value is used as `use` says: only the last statement's value can be.
   */
  private body(nodes: Node[], use: Use): Body {
    const statements = nodes.filter(
      (node) => node.type !== 'comment' && node.type !== 'empty_statement' && node.type !== 'heredoc_body'
    );
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
          from: from ? this.valueExpr(from) : undefined,
          to: to ? this.valueExpr(to) : undefined,
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
          cond: this.valueExpr(required(node.childForFieldName('condition'))),
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
        const cond = this.valueExpr(required(node.childForFieldName('condition')));
        return node.type === 'if_modifier'
          ? { k: 'if', cond, consequent: body }
          : { k: 'if', cond, consequent: [], alternative: body };
      }
      case 'while':
      case 'until': {
        const cond = this.valueExpr(required(node.childForFieldName('condition')));
        const body = this.loopBody(() => this.bodyOf(node.childForFieldName('body'), 0));
        return { k: 'while', cond, body, until: node.type === 'until', doWhile: false };
      }
      case 'while_modifier':
      case 'until_modifier': {
        const bodyNode = required(node.childForFieldName('body'));
        const doWhile = bodyNode.type === 'begin';
        const flattenBegin = doWhile && !namedChildren(bodyNode).some((c) => RESCUE_CLAUSES.has(c.type));
        const body = this.loopBody(() =>
          flattenBegin ? this.body(namedChildren(bodyNode), 0) : [this.statement(bodyNode, 0)]
        );
        const cond = this.valueExpr(required(node.childForFieldName('condition')));
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
        const { args, blockArg } = list ? this.argumentList(list) : { args: [], blockArg: undefined };
        if (list && blockArg) this.fail(list, 'yield にブロック引数を渡せません。');
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
        return { k: 'splat', e: this.valueExpr(onlyNamedChild(node)) };
      }
      case 'regex': {
        return this.regex(node);
      }
      case 'singleton_class': {
        return {
          k: 'sclass',
          target: this.expr(required(node.childForFieldName('value'))),
          body: this.classBody(node),
          row: node.startPosition.row,
        };
      }
      case 'alias': {
        const names = [node.childForFieldName('name'), node.childForFieldName('alias')].map((part) => required(part));
        if (names.some((part) => part.type === 'global_variable')) this.unsupported(node, 'グローバル変数の別名');
        const [newName, oldName] = names.map((part) => methodNameOf(part));
        return { k: 'alias', newName, oldName };
      }
      case 'undef': {
        return {
          k: 'undef',
          names: namedChildren(node)
            .filter((c) => c.type !== 'comment')
            .map((c) => methodNameOf(c)),
        };
      }
      case 'redo': {
        if (!this.ctx.inLoop && !this.ctx.inBlock) this.fail(node, 'redo は、ループかブロックの中でしか使えません。');
        return { k: 'redo' };
      }
      case 'case_match': {
        return this.caseMatch(node, use);
      }
      case 'match_pattern':
      case 'test_pattern': {
        return {
          k: 'matchPattern',
          value: this.expr(required(node.childForFieldName('value'))),
          pattern: this.pattern(required(node.childForFieldName('pattern'))),
          raise: node.type === 'match_pattern',
        };
      }
      case 'character': {
        return { k: 'str', parts: [this.decode(node, node.text.slice(1))] };
      }
      case 'chained_string': {
        return {
          k: 'str',
          parts: namedChildren(node).flatMap((part) => (this.string(part) as { parts: StrPart[] }).parts),
        };
      }
      case 'string_array':
      case 'symbol_array': {
        const interpolates = /^%[WI]/.test(node.text);
        const delimiter = node.text[2];
        const items = namedChildren(node)
          .filter((child) => child.type !== 'comment')
          .map((child): Expr => {
            const parts: StrPart[] = interpolates
              ? this.stringParts(child)
              : [decodePercentLiteral(child.text, delimiter, true)];
            return node.type === 'symbol_array' ? { k: 'dsym', parts } : { k: 'str', parts };
          });
        return { k: 'array', items };
      }
      case 'delimited_symbol': {
        return {
          k: 'dsym',
          parts: node.text.startsWith(":'") ? [decodeSingleQuoted(node.text.slice(2, -1))] : this.stringParts(node),
        };
      }
      case 'rational': {
        return this.rational(node);
      }
      case 'heredoc_beginning': {
        return this.heredoc(node);
      }
      case 'file': {
        return { k: 'str', parts: ['main.rb'] };
      }
      case 'line': {
        return { k: 'int', v: BigInt(node.startPosition.row + 1) };
      }
      case 'encoding': {
        return { k: 'encoding' };
      }
      case 'end_block': {
        const outer = this.ctx;
        const scope = new LocalScope('end', outer.scope);
        this.ctx = { ...outer, scope, inBlock: true, inLoop: false };
        try {
          const block: BlockDef = {
            params: undefined,
            locals: scope.names,
            body: this.body(namedChildren(node), 0),
            row: node.startPosition.row,
            isLambdaLiteral: false,
          };
          return { k: 'atExit', block };
        } finally {
          this.ctx = outer;
        }
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
    const depth = this.ctx.scope.depthOf(name);
    if (this.ctx.scope.kind === 'end') {
      const resolved = this.endImplicitIdentifier(node, name, depth);
      if (resolved) return resolved;
    }
    if (/^_[1-9]$/.test(name) && this.ctx.inBlock && this.ctx.scope.kind !== 'end') {
      this.checkNumberedUse(node, this.ctx.scope, depth);
    }
    if (name === 'it' && depth > 0 && this.ctx.implicit && this.ctx.scope.implicitDeclaration(name)) {
      this.ctx.implicit.add(name);
      this.ctx.scope.declareOwn(name);
      this.ctx.scope.implicitNames.add(name);
      return { k: 'lvar', name, depth: 0 };
    }
    if (depth >= 0) return { k: 'lvar', name, depth };
    if (this.ctx.implicit && (name === 'it' || /^_[1-9]$/.test(name))) {
      this.ctx.implicit.add(name);
      this.ctx.scope.declareOwn(name);
      this.ctx.scope.implicitNames.add(name);
      return { k: 'lvar', name, depth: 0 };
    }
    if (name === '__FILE__') return { k: 'str', parts: ['main.rb'] };
    if (name === '__LINE__') return { k: 'int', v: BigInt(node.startPosition.row + 1) };
    if (name === '__ENCODING__') return { k: 'encoding' };
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

  private endImplicitIdentifier(node: Node, name: string, depth: number): Expr | undefined {
    if (name !== 'it' && !/^_[1-9]$/.test(name)) return undefined;
    let block = this.ctx.scope.parent;
    let endDepth = 1;
    while (block?.kind === 'end') {
      block = block.parent;
      endDepth++;
    }
    if (!this.ctx.implicit) {
      if (depth < 0 && block?.kind === 'block') this.fail(node, '明示的な引数と暗黙の引数は一緒に使えません。');
      return undefined;
    }
    if (block?.kind !== 'block') return undefined;
    const blockDepth = block.depthOf(name);
    if (/^_[1-9]$/.test(name)) this.checkNumberedUse(node, block, blockDepth);
    if (name === 'it' && blockDepth > 0 && block.implicitDeclaration(name)) {
      block.declareOwn(name);
      block.implicitNames.add(name);
      this.ctx.implicit.add(name);
      return { k: 'lvar', name, depth: endDepth };
    }
    if (blockDepth >= 0) return { k: 'lvar', name, depth: endDepth + blockDepth };
    this.ctx.implicit.add(name);
    block.declareOwn(name);
    block.implicitNames.add(name);
    return { k: 'lvar', name, depth: endDepth };
  }

  private checkNumberedUse(node: Node, scope: LocalScope, depth: number): void {
    if (scope.innerNumberedUsed) this.fail(node, '内側のブロックで番号付き引数が既に使われています。');
    for (let parent = scope.enclosingBlock(); parent; parent = parent.enclosingBlock())
      if (parent.numberedUsed) this.fail(node, '外側のブロックで番号付き引数が既に使われています。');
    if (this.ctx.implicit === undefined && depth < 0) this.fail(node, '明示的な引数と番号付き引数は一緒に使えません。');
    scope.numberedUsed = true;
  }

  private scopeResolution(node: Node): Expr {
    const scope = node.childForFieldName('scope');
    const name = required(node.childForFieldName('name'));
    if (name.type !== 'constant') {
      return {
        k: 'call',
        recv: scope ? this.valueExpr(scope) : undefined,
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
      ? { k: 'const', scope: this.valueExpr(scope), name: name.text, row: node.startPosition.row }
      : { k: 'const', top: true, name: name.text, row: node.startPosition.row };
  }

  private integerValue(node: Node): bigint {
    const text = node.text.replaceAll('_', '').toLowerCase();
    if (/^0[0-9]+$/.test(text) && /[89]/.test(text.slice(1))) this.fail(node, '8 または 9 は8進数には使えません。');
    if (/^0[0-7]+$/.test(text)) return BigInt(`0o${text.slice(1)}`);
    if (text.startsWith('0d')) return BigInt(text.slice(2));
    return BigInt(text);
  }

  private floatValue(node: Node): number {
    return Number(node.text.replaceAll('_', ''));
  }

  private string(node: Node): Expr {
    const text = node.text;
    if (text.startsWith('%q')) {
      return {
        k: 'str',
        parts: [
          decodePercentLiteral(
            namedChildren(node)
              .map((child) => child.text)
              .join(''),
            text[2],
            false
          ),
        ],
      };
    }
    if (text.startsWith("'")) {
      const content = namedChildren(node)
        .map((child) => child.text)
        .join('');
      return { k: 'str', parts: [decodeSingleQuoted(content)] };
    }
    return { k: 'str', parts: this.stringParts(node) };
  }

  private regex(node: Node): Expr {
    const text = node.text;
    const flags = /[a-z]*$/.exec(text)?.[0] ?? '';
    if (/[^imxo]/.test(flags)) this.unsupported(node, `正規表現のオプション（${flags}）`);
    if (flags.includes('o')) this.unsupported(node, '正規表現の o オプション');
    const parts: StrPart[] = [];
    let literal = '';
    for (const child of namedChildren(node)) {
      if (child.type === 'string_content' || child.type === 'escape_sequence') literal += child.text;
      else if (child.type === 'interpolation') {
        if (literal) parts.push(literal.replaceAll('\r\n', '\n'));
        literal = '';
        const statements = this.body(namedChildren(child), 1);
        parts.push(statements.length === 1 ? statements[0].e : { k: 'seq', body: statements });
      }
    }
    if (literal) parts.push(literal.replaceAll('\r\n', '\n'));
    if (parts.every((part) => typeof part === 'string')) {
      const source = parts.join('');
      if (
        regexpCaptureNames(source, flags.includes('x')).length > 0 &&
        regexpHasNumberedBackref(source, flags.includes('x'))
      )
        this.fail(node, '名前付きキャプチャと番号付き後方参照は一緒に使えません。');
      try {
        new RegExp(translate(source, flags.includes('x'), flags.includes('m')), 'u');
      } catch (error) {
        if (!(error instanceof UnsupportedFeatureError)) this.fail(node, '正規表現の書き方に誤りがあります。');
      }
    }
    return { k: 'regex', parts, flags };
  }

  // code-gauge-allow duplicateLines 18 -- The similar lines handle different Ruby methods or values.
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
      if (pairs.length > 0) this.fail(node, 'Hash の要素の後に配列の要素は書けません。');
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
        items.push({ splat: this.anonymousOr(node, FORWARD_KEYWORDS) });
        continue;
      }
      if (node.type === 'forward_argument') {
        items.push({ splat: this.anonymousOr(node, FORWARD_KEYWORDS) });
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
      const parts = keyNode.text.startsWith("'")
        ? [decodeSingleQuoted(keyNode.text.slice(1, -1))]
        : this.stringParts(keyNode);
      key = { k: 'dsym', parts };
    } else {
      key = this.valueExpr(keyNode);
    }
    if (valueNode) return { key, value: this.valueExpr(valueNode) };
    // `{x:}` takes the value of the variable or method of that name.
    return { key, value: this.identifier(keyNode, 1) };
  }

  /** An argument, which may be a splat (`*a`) where a list of values is expected. */
  private argument(node: Node): Expr {
    if (node.type === 'splat_argument') return { k: 'splat', e: this.anonymousOr(node, FORWARD_REST) };
    // Ruby reads `p(5 in Integer)` as a call whose argument list ends before `in`.
    if (node.type === 'test_pattern')
      this.fail(node, 'in のパターンマッチを引数や要素に書くときは、( ) で囲んでください。');
    return this.valueExpr(node);
  }

  /** The value an argument such as `*a` passes, or for a bare `*`, `**`, or `&`, what the method received there. */
  private anonymousOr(node: Node, name: string): Expr {
    const value = namedChildren(node).find((child) => child.type !== 'comment');
    if (value) return this.valueExpr(value);
    const depth = this.ctx.scope.forwardingDepth(name);
    if (depth < 0) this.fail(node, `名前のない ${name} 引数を受け取っていないので、${name} だけでは渡せません。`);
    return { k: 'lvar', name, depth };
  }

  private argumentList(node: Node): { args: Expr[]; blockArg?: Expr } {
    return this.argumentListFrom(namedChildren(node));
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
    const value = this.valueExpr(node);
    return multiple ? value : value;
  }

  /** Converts an expression whose value is used, rejecting one that has none as Ruby does. */
  private valueExpr(node: Node): Expr {
    const value = this.expr(node);
    this.checkValue(node, value);
    return value;
  }

  /**
   * Rejects a value that leaves the expression or has none, such as `x = return` or `p((5 => x))`, as Ruby's "void
   * value expression" does.
   */
  private checkValue(node: Node, value: Expr): void {
    const kind = voidKindOf(value);
    if (kind) this.fail(node, `${kind}は値として使えません。`);
  }

  private operatorAssignment(node: Node): Expr {
    const left = required(node.childForFieldName('left'));
    const operator = required(node.childForFieldName('operator')).text;
    const target = this.target(left);
    const value = this.valueExpr(required(node.childForFieldName('right')));
    return { k: 'opasgn', target, op: operator.slice(0, -1), value, row: node.startPosition.row };
  }

  private multiTarget(node: Node): MultiTarget {
    const items: Target[] = [];
    let splat: number | undefined;
    for (const child of namedChildren(node)) {
      if (child.type === 'comment') continue;
      if (child.type === 'rest_assignment') {
        if (splat !== undefined) this.fail(child, '* の代入先は1つしか書けません。');
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
        this.checkReservedBinding(node, name);
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
          ? { k: 'const', scope: this.valueExpr(scope), name, row: node.startPosition.row }
          : { k: 'const', top: true, name, row: node.startPosition.row };
      }
      case 'element_reference': {
        const object = required(node.childForFieldName('object'));
        const recv = this.valueExpr(object);
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
          recv: this.valueExpr(receiver),
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
    const recv = receiverNode ? this.valueExpr(receiverNode) : undefined;
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
      fcall: !recv,
      vcall: false,
      used: use,
      row: node.startPosition.row,
    };
    return call;
  }

  private elementReference(node: Node, use: Use): Expr {
    const object = required(node.childForFieldName('object'));
    const rest = namedChildren(node).filter((child) => child.id !== object.id && child.type !== 'comment');
    const recv = this.valueExpr(object);
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
    let blockArg: Expr | undefined;
    for (const child of nodes) {
      if (child.type === 'comment') continue;
      if (blockArg) this.fail(child, '& 引数の後に引数は書けません。');
      switch (child.type) {
        case 'pair':
        case 'hash_splat_argument': {
          pairs.push(child);
          break;
        }
        case 'block_argument': {
          blockArg = this.anonymousOr(child, FORWARD_BLOCK);
          break;
        }
        case 'forward_argument': {
          if (this.ctx.scope.forwardingDepth(FORWARD_ALL) < 0)
            this.fail(child, '引数を転送する ... は、... を受け取るメソッドの中でしか使えません。');
          if (pairs.length > 0) this.fail(child, 'キーワード引数の後に位置引数は書けません。');
          const reference = (name: string): Expr => ({ k: 'lvar', name, depth: this.ctx.scope.forwardingDepth(name) });
          args.push({ k: 'splat', e: reference(FORWARD_REST) });
          pairs.push(child);
          blockArg = reference(FORWARD_BLOCK);
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

  private binary(node: Node): Expr {
    const operator = required(node.childForFieldName('operator')).text;
    const leftNode = required(node.childForFieldName('left'));
    const rightNode = required(node.childForFieldName('right'));
    const left = this.valueExpr(leftNode);
    // Ruby checks only the left operand of `&&` and `||` for a value.
    const right = LOGICAL_OPERATORS.has(operator) ? this.expr(rightNode) : this.valueExpr(rightNode);
    if (
      operator === '=~' &&
      leftNode.type === 'regex' &&
      left.k === 'regex' &&
      left.parts.every((part) => typeof part === 'string')
    ) {
      const names = regexpCaptureNames(left.parts.join(''), left.flags.includes('x')).map((name) => {
        this.checkReservedBinding(leftNode, name);
        return { k: 'lvar' as const, name, depth: this.ctx.scope.declare(name) };
      });
      if (names.length > 0) return { k: 'matchWrite', match: this.operatorCall(node, left, operator, [right]), names };
    }
    switch (operator) {
      case '&&':
      case 'and': {
        return { k: 'and', l: left, r: right };
      }
      case '||':
      case 'or': {
        return { k: 'or', l: left, r: right };
      }
      case '!~': {
        return { k: 'not', e: this.operatorCall(node, left, '=~', [right]), row: node.startPosition.row };
      }
    }
    if (operator === '!=') {
      return this.operatorCall(node, left, '!=', [right]);
    }
    return this.operatorCall(node, left, operator, [right]);
  }

  private operatorCall(node: Node, recv: Expr, name: string, args: Expr[]): Expr {
    return this.plainCall(node, recv, name, args, 1);
  }

  /** A call with a receiver, written without `&.`. */
  private plainCall(node: Node, recv: Expr, name: string, args: Expr[], used: Use): Call {
    return {
      k: 'call',
      recv,
      name,
      args,
      safe: false,
      fcall: false,
      vcall: false,
      used,
      row: node.startPosition.row,
    };
  }

  // code-gauge-allow functionCognitiveComplexity 19 -- One case per kind of syntax node.
  private unary(node: Node): Expr {
    const operator = required(node.childForFieldName('operator')).text;
    const operandNode = required(node.childForFieldName('operand'));
    if (operator === 'defined?') return { k: 'defined', e: this.expr(operandNode) };
    if ((operator === '-' || operator === '+') && (operandNode.type === 'integer' || operandNode.type === 'float')) {
      const operand = this.valueExpr(operandNode);
      const sign = operator === '-' && !/^\s/.test(this.source.slice(node.startIndex + 1, operandNode.startIndex));
      if (sign || operator === '+') {
        if (operator === '+') return operand;
        if (operand.k === 'int') return { k: 'int', v: -operand.v };
        if (operand.k === 'float') return { k: 'float', v: -operand.v };
      }
    }
    const operand = this.valueExpr(operandNode);
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
    const cond = this.valueExpr(required(node.childForFieldName('condition')));
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
    const iter = this.valueExpr(onlyNamedChild(inNode));
    const body = this.loopBody(() => this.bodyOf(node.childForFieldName('body'), 0));
    return { k: 'for', target, iter, body, row: node.startPosition.row };
  }

  private caseNode(node: Node, use: Use): Expr {
    const valueNode = node.childForFieldName('value');
    const subject = valueNode ? this.valueExpr(valueNode) : undefined;
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
    if (whens.length === 0) this.fail(node, 'case には when か in の節が1つ以上必要です。');
    return { k: 'case', subject, whens, else: elseBody };
  }

  private jump(node: Node, kind: 'break' | 'next'): Expr {
    if (!this.ctx.inLoop && !this.ctx.inBlock) this.fail(node, `${kind} は、ループかブロックの中でしか使えません。`);
    return { k: kind, value: this.jumpValue(node), inBlock: !this.ctx.inLoop };
  }

  private jumpValue(node: Node): Expr | undefined {
    const list = namedChildren(node).find((child) => child.type === 'argument_list');
    if (!list) return undefined;
    const { args, blockArg } = this.argumentList(list);
    if (blockArg) this.fail(list, `${node.type} にブロック引数を渡せません。`);
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
    return { k: 'def', def: this.methodDef(node), singleton: this.expr(objectNode) };
  }

  private methodDef(node: Node): MethodDef {
    const nameNode = required(node.childForFieldName('name'));
    const name = nameNode.text;
    this.checkReservedBinding(nameNode, name);
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
      this.checkReservedBinding(child, name);
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
          params.optional.push({ name, value: this.valueExpr(required(child.childForFieldName('value'))) });
          break;
        }
        case 'splat_parameter': {
          advance(child, 2);
          if (params.rest !== undefined) this.fail(child, '* の引数は1つしか書けません。');
          const nameNode = child.childForFieldName('name');
          params.rest = declare(child, nameNode ? nameNode.text : FORWARD_REST);
          break;
        }
        case 'hash_splat_parameter': {
          advance(child, 5);
          if (params.noKeywords) this.fail(child, '引数の並び順に誤りがあります。');
          if (params.keywordRest !== undefined) this.fail(child, '** の引数は1つしか書けません。');
          const nameNode = child.childForFieldName('name');
          params.keywordRest = declare(child, nameNode ? nameNode.text : FORWARD_KEYWORDS);
          break;
        }
        case 'keyword_parameter': {
          advance(child, 4);
          const name = declare(child, required(child.childForFieldName('name')).text);
          const valueNode = child.childForFieldName('value');
          params.keywords.push({ name, value: valueNode ? this.valueExpr(valueNode) : undefined });
          break;
        }
        case 'block_parameter': {
          advance(child, 6);
          if (params.block !== undefined) this.fail(child, '& の引数は1つしか書けません。');
          const nameNode = child.childForFieldName('name');
          params.block = declare(child, nameNode ? nameNode.text : FORWARD_BLOCK);
          break;
        }
        case 'destructured_parameter': {
          advance(child, params.rest !== undefined || params.optional.length > 0 ? 3 : 0);
          const target = this.destructuredParameter(child, declare);
          (params.rest === undefined && params.optional.length === 0 ? params.required : params.post).push(target);
          break;
        }
        case 'forward_parameter': {
          if (this.ctx.inBlock) this.fail(child, 'ブロックの引数には ... を書けません。');
          params.rest = declare(child, FORWARD_REST);
          params.keywordRest = declare(child, FORWARD_KEYWORDS);
          params.block = declare(child, FORWARD_BLOCK);
          declare(child, FORWARD_ALL);
          break;
        }
        case 'hash_splat_nil': {
          advance(child, 5);
          if (params.keywordRest !== undefined || params.noKeywords || params.keywords.length > 0)
            this.fail(child, '引数の並び順に誤りがあります。');
          params.noKeywords = true;
          break;
        }
        default: {
          this.unsupportedNode(child);
        }
      }
    }
    const lastToken = node.children.at(-2);
    if (isBlock && lastToken?.type === ',') params.trailingComma = true;
    for (const child of namedChildren(node)) if (blockLocals.has(child.id)) declare(child, child.text);
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
        if (splat !== undefined) this.fail(child, '* の引数は1つしか書けません。');
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
    const parametersNode = node.childForFieldName('parameters');
    this.ctx = { ...outer, scope, inBlock: true, inLoop: false, implicit: parametersNode ? undefined : new Set() };
    try {
      let params: Params | undefined;
      if (parametersNode) {
        params = this.params(parametersNode, !isLambdaLiteral);
      }
      let bodyNode = node.childForFieldName('body');
      if (isLambdaLiteral && bodyNode && (bodyNode.type === 'block' || bodyNode.type === 'do_block')) {
        bodyNode = bodyNode.childForFieldName('body');
      }
      const body = this.rescueBody(bodyNode, 2);
      const implicit = this.ctx.implicit;
      if (implicit?.has('it') && [...implicit].some((name) => /^_[1-9]$/.test(name)))
        this.fail(node, 'it と番号付き引数は一緒に使えません。');
      if (implicit && implicit.size > 0) params = implicitParams(implicit);
      return { params, locals: scope.names, body, row: node.startPosition.row, isLambdaLiteral };
    } finally {
      if (scope.numberedUsed || scope.innerNumberedUsed)
        for (
          let parent: LocalScope | undefined =
            outer.scope.kind === 'block' ? outer.scope : outer.scope.enclosingBlock();
          parent;
          parent = parent.enclosingBlock()
        )
          parent.innerNumberedUsed = true;
      this.ctx = outer;
    }
  }

  private classNode(node: Node): Expr {
    if (this.ctx.inDef) this.fail(node, 'メソッドの中ではクラスを定義できません。');
    const nameNode = required(node.childForFieldName('name'));
    const path = this.constantPath(nameNode);
    const superclassNode = node.childForFieldName('superclass');
    const superclass = superclassNode ? this.valueExpr(onlyNamedChild(superclassNode)) : undefined;
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
    return scope ? { scope: this.valueExpr(scope), name } : { top: true, name };
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

  // Pattern matching --------------------------------------------------------------------------------------------------

  private caseMatch(node: Node, use: Use): Expr {
    const valueNode = required(node.childForFieldName('value'));
    const { subject, testedBy } = this.caseMatchSubject(node, valueNode);
    const clauses: InClause[] = [];
    let elseBody: Body | undefined;
    for (const child of namedChildren(node)) {
      if (child.id === testedBy?.id) continue;
      if (child.type === 'in_clause') {
        const guardNode = child.childForFieldName('guard');
        const pattern = this.pattern(required(child.childForFieldName('pattern')));
        const guard = guardNode
          ? {
              cond: this.expr(required(guardNode.childForFieldName('condition'))),
              unless: guardNode.type === 'unless_guard',
            }
          : undefined;
        clauses.push({
          pattern,
          guard,
          body: this.bodyOf(child.childForFieldName('body'), use),
          row: child.startPosition.row,
        });
      } else if (child.type === 'else') {
        elseBody = this.bodyOf(child, use);
      }
    }
    return { k: 'caseIn', subject, clauses, else: elseBody, row: node.startPosition.row };
  }

  /**
   * The subject of a `case`/`in`. Ruby reads `case x in pat` on one line as `case (x in pat)`, whose subject is whether
   * `x` matches, so an `in` on the subject's line belongs to the subject and the clauses start at the next `in`.
   */
  private caseMatchSubject(node: Node, valueNode: Node): { subject: Expr; testedBy?: Node } {
    const subject = this.valueExpr(valueNode);
    const inClauses = namedChildren(node).filter((child) => child.type === 'in_clause');
    const first = inClauses.at(0);
    if (!first || /[\n;]/.test(this.source.slice(valueNode.endIndex, first.startIndex))) return { subject };
    if (first.childForFieldName('guard') || first.childForFieldName('body') || inClauses.length === 1) {
      this.fail(
        first,
        'case の値に続けて同じ行に in を書くと、値を in で調べる式になります。in の前で改行してください。'
      );
    }
    const pattern = this.pattern(required(first.childForFieldName('pattern')));
    return { subject: { k: 'matchPattern', value: subject, pattern, raise: false }, testedBy: first };
  }

  private bindTarget(node: Node): LocalRef | undefined {
    const name = node.text;
    this.checkReservedBinding(node, name);
    if (this.alternativeDepth > 0 && !name.startsWith('_')) this.fail(node, '選択パターンでは変数を束縛できません。');
    if (name === '_') {
      this.ctx.scope.declare(name);
      return undefined;
    }
    if (!name.startsWith('_') && this.patternBindings.has(name))
      this.fail(node, `パターンの変数「${name}」が重複しています。`);
    this.patternBindings.add(name);
    return { k: 'lvar', name, depth: this.ctx.scope.declare(name) };
  }

  private checkReservedBinding(node: Node, name: string): void {
    if (/^_[1-9]$/.test(name)) this.fail(node, `${name} は番号付き引数のため予約されています。`);
  }

  private readonly patternBindings = new Set<string>();
  private patternDepth = 0;
  private alternativeDepth = 0;

  private pinExpr(node: Node): Expr {
    const depth = this.patternDepth;
    const alternativeDepth = this.alternativeDepth;
    const bindings = [...this.patternBindings];
    this.patternDepth = 0;
    this.alternativeDepth = 0;
    try {
      return this.expr(node);
    } finally {
      this.patternDepth = depth;
      this.alternativeDepth = alternativeDepth;
      this.patternBindings.clear();
      for (const name of bindings) this.patternBindings.add(name);
    }
  }

  private pattern(node: Node): Pattern {
    if (this.patternDepth++ === 0) this.patternBindings.clear();
    try {
      return this.patternInner(node);
    } finally {
      this.patternDepth--;
    }
  }

  private patternInner(node: Node): Pattern {
    switch (node.type) {
      case 'identifier': {
        return { k: 'bind', target: this.bindTarget(node) };
      }
      case 'as_pattern': {
        const pattern = this.pattern(required(node.childForFieldName('value')));
        const target = this.bindTarget(required(node.childForFieldName('name')));
        return target ? { k: 'as', pattern, target } : pattern;
      }
      case 'alternative_pattern': {
        this.alternativeDepth++;
        try {
          return {
            k: 'alt',
            options: namedChildren(node)
              .filter((c) => c.type !== 'comment')
              .map((c) => this.pattern(c)),
          };
        } finally {
          this.alternativeDepth--;
        }
      }
      case 'parenthesized_pattern': {
        return this.pattern(onlyNamedChild(node));
      }
      case 'variable_reference_pattern': {
        const name = required(node.childForFieldName('name'));
        if (name.type === 'identifier' && this.ctx.scope.depthOf(name.text) < 0)
          this.fail(name, `変数「${name.text}」は定義されていません。`);
        return { k: 'pin', e: this.pinExpr(name) };
      }
      case 'expression_reference_pattern': {
        return { k: 'pin', e: this.pinExpr(required(node.childForFieldName('value'))) };
      }
      case 'array_pattern': {
        return this.arrayPattern(node);
      }
      case 'find_pattern': {
        return this.findPattern(node);
      }
      case 'hash_pattern': {
        return this.hashPattern(node);
      }
      default: {
        return { k: 'value', e: this.expr(node) };
      }
    }
  }

  private patternClass(node: Node): Expr | undefined {
    const cls = node.childForFieldName('class');
    return cls ? this.expr(cls) : undefined;
  }

  private arrayPattern(node: Node): Pattern {
    const cls = this.patternClass(node);
    const pre: Pattern[] = [];
    const post: Pattern[] = [];
    let rest: { target: LocalRef | undefined } | undefined;
    for (const child of namedChildren(node)) {
      if (child.type === 'comment' || child.id === node.childForFieldName('class')?.id) continue;
      if (child.type === 'splat_parameter') {
        const name = child.childForFieldName('name');
        rest = { target: name ? this.bindTarget(name) : undefined };
        continue;
      }
      (rest ? post : pre).push(this.pattern(child));
    }
    return { k: 'array', cls, pre, rest, post };
  }

  private findPattern(node: Node): Pattern {
    const cls = this.patternClass(node);
    const parts = namedChildren(node).filter(
      (child) => child.type !== 'comment' && child.id !== node.childForFieldName('class')?.id
    );
    const splatTarget = (child: Node): LocalRef | undefined => {
      const name = child.childForFieldName('name');
      return name ? this.bindTarget(name) : undefined;
    };
    return {
      k: 'find',
      cls,
      before: splatTarget(parts[0]),
      middle: parts.slice(1, -1).map((child) => this.pattern(child)),
      after: splatTarget(parts.at(-1) as Node),
    };
  }

  // code-gauge-allow functionCognitiveComplexity 16 -- One case per kind of syntax node.
  private hashPattern(node: Node): Pattern {
    const cls = this.patternClass(node);
    const pairs: { key: string; pattern?: Pattern; target?: LocalRef }[] = [];
    let rest: LocalRef | 'nil' | 'any' | undefined;
    for (const child of namedChildren(node)) {
      if (child.type === 'comment' || child.id === node.childForFieldName('class')?.id) continue;
      if (child.type === 'hash_splat_nil') {
        rest = 'nil';
        continue;
      }
      if (child.type === 'hash_splat_parameter') {
        const name = child.childForFieldName('name');
        rest = name ? (this.bindTarget(name) ?? 'any') : 'any';
        continue;
      }
      const keyNode = required(child.childForFieldName('key'));
      const key = keyNode.type === 'hash_key_symbol' ? keyNode.text : keyNode.text.replaceAll(/^["']|["']:?$/g, '');
      const valueNode = child.childForFieldName('value');
      if (valueNode) pairs.push({ key, pattern: this.pattern(valueNode) });
      else pairs.push({ key, target: this.bindTarget(keyNode) });
    }
    return { k: 'hash', cls, pairs, rest };
  }

  // Other literals ----------------------------------------------------------------------------------------------------

  private rational(node: Node): Expr {
    const number = onlyNamedChild(node);
    const text = number.text.replaceAll('_', '');
    if (number.type === 'integer') return { k: 'rational', numerator: this.integerValue(number), denominator: 1n };
    if (!/^\d+\.\d+$/.test(text)) this.fail(node, '有理数のリテラルの書き方に誤りがあります。');
    const [whole, fraction] = text.split('.');
    return { k: 'rational', numerator: BigInt(whole + fraction), denominator: 10n ** BigInt(fraction.length) };
  }

  /** A heredoc's text, from the body the tree placed after its line; `<<~` removes the common indentation. */
  // code-gauge-allow functionCognitiveComplexity 24 -- One case per kind of syntax node.
  // code-gauge-allow functionNcss 34 -- One case per kind of syntax node.
  private heredoc(node: Node): Expr {
    const body = this.heredocBodies[this.heredocIndex++];
    if (!body) this.fail(node, 'ヒアドキュメントの終わりがありません。');
    if (!namedChildren(body).some((child) => child.type === 'heredoc_end' && child.text.length > 0))
      this.fail(node, 'ヒアドキュメントの終わりがありません。');
    const opening = node.text;
    const raw = /^<<[-~]?(['`])/.exec(opening)?.[1];
    if (raw === '`') this.unsupported(node, '外部コマンドの実行（`...`）');
    const pieces: (string | Node)[] = [];
    for (const child of namedChildren(body)) {
      if (child.type === 'heredoc_content' || child.type === 'escape_sequence') {
        const last = pieces.at(-1);
        if (typeof last === 'string') pieces[pieces.length - 1] = last + child.text;
        else pieces.push(child.text);
      } else if (child.type === 'interpolation') {
        pieces.push(child);
      }
    }
    if (typeof pieces[0] === 'string') pieces[0] = pieces[0].replace(/^\n/, '');
    // The indentation before an indented terminator (`<<-` and `<<~`) is not part of the text.
    const last = pieces.at(-1);
    if (typeof last === 'string') pieces[pieces.length - 1] = last.replace(/(^|\n)[ \t]+$/, '$1');
    if (opening.startsWith('<<~')) dedent(pieces);
    const parts: StrPart[] = [];
    for (const piece of pieces) {
      if (typeof piece === 'string') parts.push(raw === "'" ? piece : this.decode(node, piece));
      else {
        const statements = this.body(namedChildren(piece), 1);
        parts.push(statements.length === 1 ? statements[0].e : { k: 'seq', body: statements });
      }
    }
    return { k: 'str', parts };
  }

  // Errors ------------------------------------------------------------------------------------------------------------

  private fail(node: Node, message: string): never {
    throw new CompileError([{ row: node.startPosition.row, message }]);
  }

  private unsupported(node: Node, feature: string): never {
    this.fail(node, `${feature}${/[!-~]$/.test(feature) ? ' ' : ''}は、この採点環境では使えません。`);
  }
}

function decodePercentLiteral(value: string, opening: string, words: boolean): string {
  const closing = ({ '(': ')', '[': ']', '{': '}', '<': '>' } as Record<string, string>)[opening] ?? opening;
  return value.replaceAll(/\\(.)/gs, (whole, escaped: string) =>
    escaped === opening || escaped === closing || escaped === '\\' || (words && /[ \t\r\n\f\v]/.test(escaped))
      ? escaped
      : whole
  );
}

// Anonymous parameters (`*`, `**`, `&`, `...`) live under names no variable can take, so the trace leaves them out.
const FORWARD_REST = '*';
const FORWARD_KEYWORDS = '**';
const FORWARD_BLOCK = '&';
const FORWARD_ALL = '...';

/** The parameters of a block that uses numbered parameters or `it`: `_1` alone binds as `|x|` does. */
function implicitParams(names: Set<string>): Params {
  const params: Params = { required: [], optional: [], post: [], keywords: [], trailingComma: false, implicit: true };
  if (names.has('it')) {
    params.required.push('it');
    return params;
  }
  const highest = Math.max(...[...names].map((name) => Number(name.slice(1))));
  for (let index = 1; index <= highest; index++) params.required.push(`_${index}`);
  return params;
}

function methodNameOf(node: Node): string {
  return node.type === 'simple_symbol' ? node.text.slice(1) : node.text;
}

/** Removes the indentation that every line of a `<<~` heredoc shares, from the starts of its lines. */
// code-gauge-allow functionCognitiveComplexity 23 -- One case per kind of syntax node.
function dedent(pieces: (string | Node)[]): void {
  const source = pieces.map((piece) => (typeof piece === 'string' ? piece : '\uFFFC')).join('');
  let indent = Number.POSITIVE_INFINITY;
  for (const line of source.split('\n')) {
    const blanks = /^[ \t]*/.exec(line)?.[0].length ?? 0;
    if (blanks < line.length) indent = Math.min(indent, blanks);
  }
  if (!Number.isFinite(indent) || indent === 0) return;
  let atLineStart = true;
  for (const [position, piece] of pieces.entries()) {
    if (typeof piece !== 'string') {
      atLineStart = false;
      continue;
    }
    pieces[position] = piece
      .split('\n')
      .map((line, index) => (index > 0 || atLineStart ? line.replace(new RegExp(`^[ \\t]{0,${indent}}`), '') : line))
      .join('\n');
    atLineStart = piece.endsWith('\n');
  }
}

/** How a statement records its step, from what it does. */
// code-gauge-allow functionNcss 35 -- One case per kind of syntax node.
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
    case 'module':
    case 'sclass':
    case 'alias':
    case 'undef':
    case 'redo':
    case 'caseIn':
    case 'atExit': {
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

/** Whether an expression uses only literals and operators on them. */
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
    case 'matchWrite': {
      return [e.match];
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

const LOGICAL_OPERATORS = new Set(['&&', '||', 'and', 'or']);

/** What makes a value void in Ruby's sense (`return`, `=>`, ...), named for the error, or `undefined` for a value. */
function voidKindOf(value: Expr): string | undefined {
  switch (value.k) {
    case 'return':
    case 'break':
    case 'next':
    case 'retry':
    case 'redo': {
      return `${value.k} `;
    }
    case 'matchPattern': {
      return value.raise ? '=> のパターンマッチ' : undefined;
    }
    case 'seq': {
      const last = value.body.at(-1);
      return last ? voidKindOf(last.e) : undefined;
    }
    case 'begin': {
      const ensured = value.ensure?.at(-1);
      if (ensured) {
        const kind = voidKindOf(ensured.e);
        if (kind) return kind;
      }
      // A `rescue` clause gives the expression a value even when its body has none.
      if (value.rescues.length > 0) return undefined;
      const last = value.body.at(-1);
      return last ? voidKindOf(last.e) : undefined;
    }
    case 'rescueMod': {
      return voidKindOf(value.body);
    }
    default: {
      return undefined;
    }
  }
}

const BODY_CONTAINERS = new Set(['then', 'else', 'do', 'body_statement', 'block_body', 'begin', 'ensure']);
const RESCUE_CLAUSES = new Set(['rescue', 'else', 'ensure']);

const UNSUPPORTED_NODES: Record<string, string> = {
  complex: '虚数のリテラル（2i）',
  subshell: '外部コマンドの実行（`...`）',
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
