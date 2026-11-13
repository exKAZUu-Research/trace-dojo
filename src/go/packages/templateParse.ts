// oxlint-disable unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255, which charCodeAt reads as raw bytes.
import { quote } from '../quote';
import { Complex, type Value } from '../values';
import { parseComplex, parseFloat, parseInt, parseUint, unquoteChar, unquoteLiteral } from './strconv';
import { errorText } from './support';
import {
  DEFAULT_LEFT_DELIM,
  DEFAULT_RIGHT_DELIM,
  type Item,
  ITEM_ASSIGN,
  ITEM_BLOCK,
  ITEM_BOOL,
  ITEM_BREAK,
  ITEM_CHAR,
  ITEM_CHAR_CONSTANT,
  ITEM_COMMENT,
  ITEM_COMPLEX,
  ITEM_CONTINUE,
  ITEM_DECLARE,
  ITEM_DEFINE,
  ITEM_DOT,
  ITEM_ELSE,
  ITEM_END,
  ITEM_EOF,
  ITEM_ERROR,
  ITEM_FIELD,
  ITEM_IDENTIFIER,
  ITEM_IF,
  ITEM_LEFT_DELIM,
  ITEM_LEFT_PAREN,
  ITEM_NIL,
  ITEM_NUMBER,
  ITEM_PIPE,
  ITEM_RANGE,
  ITEM_RAW_STRING,
  ITEM_RIGHT_DELIM,
  ITEM_RIGHT_PAREN,
  ITEM_SPACE,
  ITEM_STRING,
  ITEM_TEMPLATE,
  ITEM_TEXT,
  ITEM_VARIABLE,
  ITEM_WITH,
  itemString,
  Lexer,
  sprintf,
} from './templateLex';

// Nodes (text/template/parse/node.go) -----------------------------------------------------------------------------

interface NodeBase {
  pos: number;
  tr: Tree | undefined;
}

export interface ListNode extends NodeBase {
  type: 'list';
  nodes: Node[];
}
export interface TextNode extends NodeBase {
  type: 'text';
  text: string;
}
export interface CommentNode extends NodeBase {
  type: 'comment';
  text: string;
}
export interface PipeNode extends NodeBase {
  type: 'pipe';
  line: number;
  isAssign: boolean;
  decl: VariableNode[];
  cmds: CommandNode[];
}
export interface ActionNode extends NodeBase {
  type: 'action';
  pipe: PipeNode;
}
export interface CommandNode extends NodeBase {
  type: 'command';
  args: Node[];
}
export interface IdentifierNode extends NodeBase {
  type: 'identifier';
  ident: string;
}
export interface VariableNode extends NodeBase {
  type: 'variable';
  ident: string[];
}
export interface DotNode extends NodeBase {
  type: 'dot';
}
export interface NilNode extends NodeBase {
  type: 'nil';
}
export interface FieldNode extends NodeBase {
  type: 'field';
  ident: string[];
}
export interface ChainNode extends NodeBase {
  type: 'chain';
  node: Node;
  field: string[];
}
export interface BoolNode extends NodeBase {
  type: 'bool';
  value: boolean;
}
export interface NumberNode extends NodeBase {
  type: 'number';
  isInt: boolean;
  isUint: boolean;
  isFloat: boolean;
  isComplex: boolean;
  int64: bigint;
  uint64: bigint;
  float64: number;
  complex128: Complex;
  text: string;
}
export interface StringNode extends NodeBase {
  type: 'string';
  quoted: string;
  text: string;
}
interface EndNode extends NodeBase {
  type: 'end';
}
interface ElseNode extends NodeBase {
  type: 'else';
}
export interface BranchNode extends NodeBase {
  type: 'if' | 'range' | 'with';
  pipe: PipeNode;
  list: ListNode;
  elseList: ListNode | undefined;
}
export interface BreakNode extends NodeBase {
  type: 'break' | 'continue';
}
export interface TemplateNode extends NodeBase {
  type: 'template';
  name: string;
  pipe: PipeNode | undefined;
}

export type Node =
  | ListNode
  | TextNode
  | CommentNode
  | PipeNode
  | ActionNode
  | CommandNode
  | IdentifierNode
  | VariableNode
  | DotNode
  | NilNode
  | FieldNode
  | ChainNode
  | BoolNode
  | NumberNode
  | StringNode
  | EndNode
  | ElseNode
  | BranchNode
  | BreakNode
  | TemplateNode;

/** `Node.String`, which error messages show as the context of a failure. */
// code-gauge-allow functionCognitiveComplexity 30 -- One case per node type, as node.go's writeTo methods are.
export function nodeString(node: Node): string {
  const tr = node.tr as Tree;
  switch (node.type) {
    case 'list': {
      return node.nodes.map(nodeString).join('');
    }
    case 'text': {
      return node.text;
    }
    case 'comment': {
      return tr.leftDelim + node.text + tr.rightDelim;
    }
    case 'pipe': {
      let text = '';
      if (node.decl.length > 0) {
        text = node.decl.map(nodeString).join(', ') + (node.isAssign ? ' = ' : ' := ');
      }
      return text + node.cmds.map(nodeString).join(' | ');
    }
    case 'action': {
      return tr.leftDelim + nodeString(node.pipe) + tr.rightDelim;
    }
    case 'command': {
      return node.args.map((arg) => (arg.type === 'pipe' ? `(${nodeString(arg)})` : nodeString(arg))).join(' ');
    }
    case 'identifier': {
      return node.ident;
    }
    case 'variable': {
      return node.ident.join('.');
    }
    case 'dot': {
      return '.';
    }
    case 'nil': {
      return 'nil';
    }
    case 'field': {
      return node.ident.map((id) => `.${id}`).join('');
    }
    case 'chain': {
      const base = node.node.type === 'pipe' ? `(${nodeString(node.node)})` : nodeString(node.node);
      return base + node.field.map((field) => `.${field}`).join('');
    }
    case 'bool': {
      return node.value ? 'true' : 'false';
    }
    case 'number': {
      return node.text;
    }
    case 'string': {
      return node.quoted;
    }
    case 'end':
    case 'else':
    case 'break':
    case 'continue': {
      return tr.leftDelim + node.type + tr.rightDelim;
    }
    case 'if':
    case 'range':
    case 'with': {
      let text = `${tr.leftDelim}${node.type} ${nodeString(node.pipe)}${tr.rightDelim}${nodeString(node.list)}`;
      if (node.elseList) text += `${tr.leftDelim}else${tr.rightDelim}${nodeString(node.elseList)}`;
      return `${text}${tr.leftDelim}end${tr.rightDelim}`;
    }
    case 'template': {
      const pipe = node.pipe ? ` ${nodeString(node.pipe)}` : '';
      return `${tr.leftDelim}template ${quote(node.name)}${pipe}${tr.rightDelim}`;
    }
  }
}

// Parsing (text/template/parse/parse.go) --------------------------------------------------------------------------

/** A parse failure, carrying the message of the error Go's parser returns. */
export class TemplateParseError {
  constructor(readonly message: string) {}
}

const MAX_STACK_DEPTH = 10_000;

export type HasFunction = (name: string) => boolean;

/** `parse.Tree`: the parsed form of one template, which the parser fills while it runs. */
export class Tree {
  parseName = '';
  root: ListNode | undefined;
  text = '';
  leftDelim = '';
  rightDelim = '';
  private hasFunctionOf: HasFunction | undefined;
  private lex: Lexer | undefined;
  private readonly token: Item[] = [];
  private peekCount = 0;
  private vars: string[] = [];
  private treeSet: Map<string, Tree> | undefined;
  private actionLine = 0;
  private rangeDepth = 0;
  private stackDepth = 0;

  constructor(public name: string) {}

  /** `Tree.Parse`, which adds the trees it parses to `treeSet`. */
  parse(
    text: string,
    leftDelim: string,
    rightDelim: string,
    treeSet: Map<string, Tree>,
    hasFunction: HasFunction
  ): void {
    this.parseName = this.name;
    this.leftDelim = leftDelim || DEFAULT_LEFT_DELIM;
    this.rightDelim = rightDelim || DEFAULT_RIGHT_DELIM;
    const lexer = new Lexer(text, this.leftDelim, this.rightDelim);
    try {
      this.startParse(hasFunction, lexer, treeSet);
      this.text = text;
      this.parseTemplate();
      this.add();
    } finally {
      this.stopParse();
    }
  }

  /** `Tree.ErrorContext`: the position of a node as `name:line:column`, and the node's text. */
  errorContext(node: Node): [location: string, context: string] {
    const { pos } = node;
    const tree = node.tr ?? this;
    const text = tree.text.slice(0, pos);
    const lastNewline = text.lastIndexOf('\n');
    const byteNum = lastNewline === -1 ? pos : pos - (lastNewline + 1);
    const lineNum = text.split('\n').length;
    return [sprintf('%s:%d:%d', tree.parseName, lineNum, byteNum), nodeString(node)];
  }

  private nextToken(): Item {
    if (this.peekCount > 0) this.peekCount--;
    else this.token[0] = (this.lex as Lexer).nextItem();
    return this.token[this.peekCount];
  }

  private backup(): void {
    this.peekCount++;
  }

  private backup2(t1: Item): void {
    this.token[1] = t1;
    this.peekCount = 2;
  }

  private backup3(t2: Item, t1: Item): void {
    this.token[1] = t1;
    this.token[2] = t2;
    this.peekCount = 3;
  }

  private peek(): Item {
    if (this.peekCount > 0) return this.token[this.peekCount - 1];
    this.peekCount = 1;
    this.token[0] = (this.lex as Lexer).nextItem();
    return this.token[0];
  }

  private nextNonSpace(): Item {
    let token: Item;
    do token = this.nextToken();
    while (token.typ === ITEM_SPACE);
    return token;
  }

  private peekNonSpace(): Item {
    const token = this.nextNonSpace();
    this.backup();
    return token;
  }

  private errorf(format: string, ...args: (string | number)[]): never {
    this.root = undefined;
    const prefixed = sprintf('template: %s:%d: %s', this.parseName, this.token[0].line, format);
    throw new TemplateParseError(sprintf(prefixed, ...args));
  }

  private error(error: Value): never {
    return this.errorf('%s', errorText(error));
  }

  private expect(expected: number, context: string): Item {
    const token = this.nextNonSpace();
    if (token.typ !== expected) this.unexpected(token, context);
    return token;
  }

  private expectOneOf(expected1: number, expected2: number, context: string): Item {
    const token = this.nextNonSpace();
    if (token.typ !== expected1 && token.typ !== expected2) this.unexpected(token, context);
    return token;
  }

  private unexpected(token: Item, context: string): never {
    if (token.typ === ITEM_ERROR) {
      let extra = '';
      if (this.actionLine !== 0 && this.actionLine !== token.line) {
        extra = sprintf(' in action started at %s:%d', this.parseName, this.actionLine);
        if (token.val.endsWith(' action')) extra = extra.slice(' in action'.length);
      }
      this.errorf('%s%s', itemString(token), extra);
    }
    return this.errorf('unexpected %s in %s', itemString(token), context);
  }

  private startParse(hasFunction: HasFunction, lex: Lexer, treeSet: Map<string, Tree>): void {
    this.root = undefined;
    this.lex = lex;
    this.vars = ['$'];
    this.hasFunctionOf = hasFunction;
    this.treeSet = treeSet;
    this.stackDepth = 0;
    lex.options = { emitComment: false, breakOK: !hasFunction('break'), continueOK: !hasFunction('continue') };
  }

  private stopParse(): void {
    this.lex = undefined;
    this.vars = [];
    this.hasFunctionOf = undefined;
    this.treeSet = undefined;
  }

  private add(): void {
    const treeSet = this.treeSet as Map<string, Tree>;
    const tree = treeSet.get(this.name);
    if (!tree || isEmptyTree(tree.root)) {
      treeSet.set(this.name, this);
      return;
    }
    if (!isEmptyTree(this.root)) this.errorf('template: multiple definition of template %q', this.name);
  }

  /** A tree for a `define` or `block` that the parser of this tree finds, sharing its lexer. */
  private nested(name: string): Tree {
    const tree = new Tree(name);
    tree.text = this.text;
    tree.leftDelim = this.leftDelim;
    tree.rightDelim = this.rightDelim;
    tree.parseName = this.parseName;
    tree.startParse(this.hasFunctionOf as HasFunction, this.lex as Lexer, this.treeSet as Map<string, Tree>);
    return tree;
  }

  private parseTemplate(): void {
    this.root = this.newList(this.peek().pos);
    while (this.peek().typ !== ITEM_EOF) {
      if (this.peek().typ === ITEM_LEFT_DELIM) {
        const delim = this.nextToken();
        if (this.nextNonSpace().typ === ITEM_DEFINE) {
          const definition = this.nested('definition');
          definition.parseDefinition();
          continue;
        }
        this.backup2(delim);
      }
      const node = this.textOrAction();
      if (node.type === 'end' || node.type === 'else') this.errorf('unexpected %s', nodeString(node));
      this.root.nodes.push(node);
    }
  }

  private parseDefinition(): void {
    const context = 'define clause';
    const name = this.expectOneOf(ITEM_STRING, ITEM_RAW_STRING, context);
    const [unquoted, error] = unquoteLiteral(name.val);
    if (error !== undefined) this.error(error);
    this.name = unquoted;
    this.expect(ITEM_RIGHT_DELIM, context);
    const [root, end] = this.itemList();
    this.root = root;
    if (end.type !== 'end') this.errorf('unexpected %s in %s', nodeString(end), context);
    this.add();
    this.stopParse();
  }

  private itemList(): [ListNode, Node] {
    const list = this.newList(this.peekNonSpace().pos);
    while (this.peekNonSpace().typ !== ITEM_EOF) {
      const node = this.textOrAction();
      if (node.type === 'end' || node.type === 'else') return [list, node];
      list.nodes.push(node);
    }
    return this.errorf('unexpected EOF');
  }

  private textOrAction(): Node {
    const token = this.nextNonSpace();
    switch (token.typ) {
      case ITEM_TEXT: {
        return { type: 'text', tr: this, pos: token.pos, text: token.val };
      }
      case ITEM_LEFT_DELIM: {
        this.actionLine = token.line;
        try {
          return this.action();
        } finally {
          this.actionLine = 0;
        }
      }
      case ITEM_COMMENT: {
        return { type: 'comment', tr: this, pos: token.pos, text: token.val };
      }
      default: {
        return this.unexpected(token, 'input');
      }
    }
  }

  private action(): Node {
    const token = this.nextNonSpace();
    switch (token.typ) {
      case ITEM_BLOCK: {
        return this.blockControl();
      }
      case ITEM_BREAK:
      case ITEM_CONTINUE: {
        return this.loopControl(token);
      }
      case ITEM_ELSE: {
        return this.elseControl();
      }
      case ITEM_END: {
        return { type: 'end', tr: this, pos: this.expect(ITEM_RIGHT_DELIM, 'end').pos };
      }
      case ITEM_IF:
      case ITEM_RANGE:
      case ITEM_WITH: {
        return this.branchControl(token.typ === ITEM_IF ? 'if' : token.typ === ITEM_RANGE ? 'range' : 'with');
      }
      case ITEM_TEMPLATE: {
        return this.templateControl();
      }
    }
    this.backup();
    const peeked = this.peek();
    return { type: 'action', tr: this, pos: peeked.pos, pipe: this.pipeline('command', ITEM_RIGHT_DELIM) };
  }

  private loopControl(keyword: Item): Node {
    const name = keyword.typ === ITEM_BREAK ? 'break' : 'continue';
    const token = this.nextNonSpace();
    if (token.typ !== ITEM_RIGHT_DELIM) this.unexpected(token, `{{${name}}}`);
    if (this.rangeDepth === 0) this.errorf(`{{${name}}} outside {{range}}`);
    return { type: name, tr: this, pos: keyword.pos };
  }

  // code-gauge-allow functionCognitiveComplexity 30 -- A transcription of Go's Tree.pipeline, whose declarations loop back with goto.
  private pipeline(context: string, end: number): PipeNode {
    const token = this.peekNonSpace();
    const pipe: PipeNode = {
      type: 'pipe',
      tr: this,
      pos: token.pos,
      line: token.line,
      isAssign: false,
      decl: [],
      cmds: [],
    };
    for (let declare = true; declare;) {
      declare = false;
      const v = this.peekNonSpace();
      if (v.typ !== ITEM_VARIABLE) break;
      this.nextToken();
      const tokenAfterVariable = this.peek();
      const next = this.peekNonSpace();
      if (next.typ === ITEM_ASSIGN || next.typ === ITEM_DECLARE) {
        pipe.isAssign = next.typ === ITEM_ASSIGN;
        this.nextNonSpace();
        pipe.decl.push(this.newVariable(v.pos, v.val));
        this.vars.push(v.val);
      } else if (next.typ === ITEM_CHAR && next.val === ',') {
        this.nextNonSpace();
        pipe.decl.push(this.newVariable(v.pos, v.val));
        this.vars.push(v.val);
        if (context === 'range' && pipe.decl.length < 2) {
          const after = this.peekNonSpace().typ;
          if (after === ITEM_VARIABLE || after === ITEM_RIGHT_DELIM || after === ITEM_RIGHT_PAREN) {
            declare = true;
            continue;
          }
          this.errorf('range can only initialize variables');
        }
        this.errorf('too many declarations in %s', context);
      } else if (tokenAfterVariable.typ === ITEM_SPACE) {
        this.backup3(v, tokenAfterVariable);
      } else {
        this.backup2(v);
      }
    }
    for (;;) {
      const next = this.nextNonSpace();
      switch (next.typ) {
        case end: {
          this.checkPipeline(pipe, context);
          return pipe;
        }
        case ITEM_BOOL:
        case ITEM_CHAR_CONSTANT:
        case ITEM_COMPLEX:
        case ITEM_DOT:
        case ITEM_FIELD:
        case ITEM_IDENTIFIER:
        case ITEM_NUMBER:
        case ITEM_NIL:
        case ITEM_RAW_STRING:
        case ITEM_STRING:
        case ITEM_VARIABLE:
        case ITEM_LEFT_PAREN: {
          this.backup();
          pipe.cmds.push(this.command());
          break;
        }
        default: {
          this.unexpected(next, context);
        }
      }
    }
  }

  private checkPipeline(pipe: PipeNode, context: string): void {
    if (pipe.cmds.length === 0) this.errorf('missing value for %s', context);
    for (const [index, command] of pipe.cmds.slice(1).entries()) {
      if (['bool', 'dot', 'nil', 'number', 'string'].includes(command.args[0].type)) {
        this.errorf('non executable command in pipeline stage %d', index + 2);
      }
    }
  }

  private parseControl(context: string): [PipeNode, ListNode, ListNode | undefined] {
    const varCount = this.vars.length;
    try {
      const pipe = this.pipeline(context, ITEM_RIGHT_DELIM);
      if (context === 'range') this.rangeDepth++;
      let [list, next] = this.itemList();
      if (context === 'range') this.rangeDepth--;
      let elseList: ListNode | undefined;
      if (next.type === 'else') {
        if (context === 'if' && this.peek().typ === ITEM_IF) {
          this.nextToken();
          elseList = this.newList(next.pos);
          elseList.nodes.push(this.branchControl('if'));
        } else if (context === 'with' && this.peek().typ === ITEM_WITH) {
          this.nextToken();
          elseList = this.newList(next.pos);
          elseList.nodes.push(this.branchControl('with'));
        } else {
          [elseList, next] = this.itemList();
          if (next.type !== 'end') this.errorf('expected end; found %s', nodeString(next));
        }
      }
      return [pipe, list, elseList];
    } finally {
      this.vars = this.vars.slice(0, varCount);
    }
  }

  private branchControl(context: 'if' | 'range' | 'with'): BranchNode {
    const [pipe, list, elseList] = this.parseControl(context);
    return { type: context, tr: this, pos: pipe.pos, pipe, list, elseList };
  }

  private elseControl(): Node {
    const peeked = this.peekNonSpace();
    if (peeked.typ === ITEM_IF || peeked.typ === ITEM_WITH) return { type: 'else', tr: this, pos: peeked.pos };
    const token = this.expect(ITEM_RIGHT_DELIM, 'else');
    return { type: 'else', tr: this, pos: token.pos };
  }

  private blockControl(): Node {
    const context = 'block clause';
    const token = this.nextNonSpace();
    const name = this.parseTemplateName(token, context);
    const pipe = this.pipeline(context, ITEM_RIGHT_DELIM);
    const block = this.nested(name);
    const [root, end] = block.itemList();
    block.root = root;
    if (end.type !== 'end') this.errorf('unexpected %s in %s', nodeString(end), context);
    block.add();
    block.stopParse();
    return { type: 'template', tr: this, pos: token.pos, name, pipe };
  }

  private templateControl(): Node {
    const context = 'template clause';
    const token = this.nextNonSpace();
    const name = this.parseTemplateName(token, context);
    let pipe: PipeNode | undefined;
    if (this.nextNonSpace().typ !== ITEM_RIGHT_DELIM) {
      this.backup();
      pipe = this.pipeline(context, ITEM_RIGHT_DELIM);
    }
    return { type: 'template', tr: this, pos: token.pos, name, pipe };
  }

  private parseTemplateName(token: Item, context: string): string {
    if (token.typ !== ITEM_STRING && token.typ !== ITEM_RAW_STRING) this.unexpected(token, context);
    const [name, error] = unquoteLiteral(token.val);
    if (error !== undefined) this.error(error);
    return name;
  }

  private command(): CommandNode {
    const command: CommandNode = { type: 'command', tr: this, pos: this.peekNonSpace().pos, args: [] };
    for (;;) {
      this.peekNonSpace();
      const operand = this.operand();
      if (operand) command.args.push(operand);
      const token = this.nextToken();
      if (token.typ === ITEM_SPACE) continue;
      if (token.typ === ITEM_RIGHT_DELIM || token.typ === ITEM_RIGHT_PAREN) this.backup();
      else if (token.typ !== ITEM_PIPE) this.unexpected(token, 'operand');
      break;
    }
    if (command.args.length === 0) this.errorf('empty command');
    return command;
  }

  private operand(): Node | undefined {
    const node = this.term();
    if (!node) return undefined;
    if (this.peek().typ !== ITEM_FIELD) return node;
    const chain: ChainNode = { type: 'chain', tr: this, pos: this.peek().pos, node, field: [] };
    while (this.peek().typ === ITEM_FIELD) chain.field.push(this.nextToken().val.slice(1));
    switch (node.type) {
      case 'field': {
        return { type: 'field', tr: this, pos: chain.pos, ident: nodeString(chain).slice(1).split('.') };
      }
      case 'variable': {
        return this.newVariable(chain.pos, nodeString(chain));
      }
      case 'bool':
      case 'string':
      case 'number':
      case 'nil':
      case 'dot': {
        return this.errorf('unexpected . after term %q', nodeString(node));
      }
      default: {
        return chain;
      }
    }
  }

  private term(): Node | undefined {
    const token = this.nextNonSpace();
    switch (token.typ) {
      case ITEM_IDENTIFIER: {
        if (!(this.hasFunctionOf as HasFunction)(token.val)) this.errorf('function %q not defined', token.val);
        return { type: 'identifier', tr: this, pos: token.pos, ident: token.val };
      }
      case ITEM_DOT: {
        return { type: 'dot', tr: this, pos: token.pos };
      }
      case ITEM_NIL: {
        return { type: 'nil', tr: this, pos: token.pos };
      }
      case ITEM_VARIABLE: {
        return this.useVar(token.pos, token.val);
      }
      case ITEM_FIELD: {
        return { type: 'field', tr: this, pos: token.pos, ident: token.val.slice(1).split('.') };
      }
      case ITEM_BOOL: {
        return { type: 'bool', tr: this, pos: token.pos, value: token.val === 'true' };
      }
      case ITEM_CHAR_CONSTANT:
      case ITEM_COMPLEX:
      case ITEM_NUMBER: {
        const [number, error] = this.newNumber(token.pos, token.val, token.typ);
        if (error !== undefined) this.errorf('%s', error);
        return number;
      }
      case ITEM_LEFT_PAREN: {
        if (this.stackDepth >= MAX_STACK_DEPTH) this.errorf('max expression depth exceeded');
        this.stackDepth++;
        try {
          return this.pipeline('parenthesized pipeline', ITEM_RIGHT_PAREN);
        } finally {
          this.stackDepth--;
        }
      }
      case ITEM_STRING:
      case ITEM_RAW_STRING: {
        const [text, error] = unquoteLiteral(token.val);
        if (error !== undefined) this.error(error);
        return { type: 'string', tr: this, pos: token.pos, quoted: token.val, text };
      }
    }
    this.backup();
    return undefined;
  }

  private useVar(pos: number, name: string): Node {
    const variable = this.newVariable(pos, name);
    if (!this.vars.includes(variable.ident[0])) this.errorf('undefined variable %q', variable.ident[0]);
    return variable;
  }

  private newList(pos: number): ListNode {
    return { type: 'list', tr: this, pos, nodes: [] };
  }

  private newVariable(pos: number, ident: string): VariableNode {
    return { type: 'variable', tr: this, pos, ident: ident.split('.') };
  }

  /** `Tree.newNumber`, whose error is the message of the error Go returns. */
  // code-gauge-allow functionCognitiveComplexity 30 -- A transcription of Go's newNumber.
  private newNumber(pos: number, text: string, typ: number): [NumberNode, string | undefined] {
    const node: NumberNode = {
      type: 'number',
      tr: this,
      pos,
      isInt: false,
      isUint: false,
      isFloat: false,
      isComplex: false,
      int64: 0n,
      uint64: 0n,
      float64: 0,
      complex128: new Complex(0, 0),
      text,
    };
    if (typ === ITEM_CHAR_CONSTANT) {
      const [rune, , tail, error] = unquoteChar(text.slice(1), text.charCodeAt(0));
      if (error !== undefined) return [node, errorText(error)];
      if (tail !== "'") return [node, sprintf('malformed character constant: %s', text)];
      node.int64 = BigInt(rune);
      node.isInt = true;
      node.uint64 = BigInt(rune);
      node.isUint = true;
      node.float64 = rune;
      node.isFloat = true;
      return [node, undefined];
    }
    if (typ === ITEM_COMPLEX) {
      const [value, error] = parseComplex(text, 128);
      if (error !== undefined) return [node, errorText(error)];
      node.isComplex = true;
      node.complex128 = value;
      simplifyComplex(node);
      return [node, undefined];
    }
    if (text.endsWith('i')) {
      const [imaginary, error] = parseFloat(text.slice(0, -1), 64);
      if (error === undefined) {
        node.isComplex = true;
        node.complex128 = new Complex(0, imaginary);
        simplifyComplex(node);
        return [node, undefined];
      }
    }
    const [u, uintError] = parseUint(text, 0, 64, 'ParseUint');
    if (uintError === undefined) {
      node.isUint = true;
      node.uint64 = u;
    }
    const [i, intError] = parseInt(text, 0, 64, 'ParseInt');
    if (intError === undefined) {
      node.isInt = true;
      node.int64 = i;
      if (i === 0n) {
        node.isUint = true;
        node.uint64 = u;
      }
    }
    if (node.isInt) {
      node.isFloat = true;
      node.float64 = Number(node.int64);
    } else if (node.isUint) {
      node.isFloat = true;
      node.float64 = Number(node.uint64);
    } else {
      const [f, floatError] = parseFloat(text, 64);
      if (floatError === undefined) {
        if (!/[.eEpP]/.test(text)) return [node, sprintf('integer overflow: %q', text)];
        node.isFloat = true;
        node.float64 = f;
        setIntegerForms(node, f);
      }
    }
    if (!node.isInt && !node.isUint && !node.isFloat) return [node, sprintf('illegal number syntax: %q', text)];
    return [node, undefined];
  }
}

/** `Parse`: the trees of a template's text, by name. */
export function parseTrees(
  name: string,
  text: string,
  leftDelim: string,
  rightDelim: string,
  hasFunction: HasFunction
): Map<string, Tree> {
  const treeSet = new Map<string, Tree>();
  const tree = new Tree(name);
  tree.text = text;
  tree.parse(text, leftDelim, rightDelim, treeSet, hasFunction);
  return treeSet;
}

function simplifyComplex(node: NumberNode): void {
  node.isFloat = node.complex128.im === 0;
  if (node.isFloat) {
    node.float64 = node.complex128.re;
    setIntegerForms(node, node.float64);
  }
}

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const UINT64_MAX = 2n ** 64n - 1n;

/**
 * Sets the integer forms of a float that `int64(f)` and `uint64(f)` convert back exactly; out-of-range conversions
 * saturate as they do on arm64.
 */
// code-gauge-allow functionCognitiveComplexity 16 -- The saturating conversions of arm64, one per bound.
function setIntegerForms(node: NumberNode, f: number): void {
  const truncated = Number.isNaN(f) ? 0n : Number.isFinite(f) ? BigInt(Math.trunc(f)) : f > 0 ? UINT64_MAX : INT64_MIN;
  const asInt = truncated < INT64_MIN ? INT64_MIN : truncated > INT64_MAX ? INT64_MAX : truncated;
  const asUint = truncated < 0n ? 0n : truncated > UINT64_MAX ? UINT64_MAX : truncated;
  if (!node.isInt && Number(asInt) === f) {
    node.isInt = true;
    node.int64 = asInt;
  }
  if (!node.isUint && Number(asUint) === f) {
    node.isUint = true;
    node.uint64 = asUint;
  }
}

/** `IsEmptyTree`: whether a tree holds only space and comments. */
export function isEmptyTree(node: Node | undefined): boolean {
  if (!node) return true;
  switch (node.type) {
    case 'comment': {
      return true;
    }
    case 'list': {
      return node.nodes.every((child) => isEmptyTree(child));
    }
    case 'text': {
      return /^[\t\n\v\f\r ]*$/.test(node.text);
    }
    default: {
      return false;
    }
  }
}
