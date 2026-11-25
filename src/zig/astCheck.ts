// code-gauge-allow-file fileNcss -- The syntax checks share scope, diagnostics, and the compilation budget.
import type { SourceDiagnostic } from '../interpreter/diagnostics';
import { ExecutionBudget } from '../interpreter/limits';
import { isDiscardName } from './ast';
import type {
  Block,
  Capture,
  Container,
  ContainerField,
  ContainerMember,
  Expression,
  FunctionDeclaration,
  Label,
  NamedSpan,
  SourceFile,
  Span,
  Statement,
  TestDeclaration,
} from './ast';
import { primitiveType } from './types';

/**
 * Checks what Zig's AstGen checks in every function, whether or not the program calls it: unused locals, parameters,
 * and captures, variables never mutated, pointless discards, shadowing, undeclared names, misplaced jumps and labels,
 * and code after a statement that never completes.
 */
export function checkSource(
  file: SourceFile,
  predeclared: readonly string[],
  budget = new ExecutionBudget()
): { errors: SourceDiagnostic[]; fatal: boolean } {
  const checker = new AstChecker(budget);
  const environment: NamespaceScope = {
    kind: 'namespace',
    names: new Set(predeclared),
    parent: undefined,
  };
  checker.checkContainer(file, environment, undefined);
  return { errors: checker.errors, fatal: checker.fatal };
}

/**
 * Thrown by an error that stops AstGen's work on a function, as Zig's does: the rest of the function, and the unused
 * locals of the scopes still open, are not checked.
 */
const FATAL = Symbol('fatal');

type Category = 'local constant' | 'local variable' | 'function parameter' | 'capture';

const CATEGORY_NAMES: Record<Category, string> = {
  'local constant': 'ローカル定数',
  'local variable': 'ローカル変数',
  'function parameter': '引数',
  capture: '受け取った値',
};

interface LocalBinding {
  kind: 'local';
  name: string;
  category: Category;
  span: Span;
  used: boolean;
  /** Where `_ = name;` discards the local, which Zig reports when the local is also used. */
  discardSpan: Span | undefined;
  usedAsLvalue: boolean;
}

interface NamespaceScope {
  kind: 'namespace';
  names: Set<string>;
  parent: Scope | undefined;
}

interface BlockScope {
  kind: 'block';
  locals: Map<string, LocalBinding>;
  parent: Scope | undefined;
}

interface LabelScope {
  kind: 'label';
  label: Label;
  /** What the label names, for its messages: a block, a loop, or a switch. */
  target: 'block' | 'while' | 'for' | 'switch';
  used: boolean;
  /** Whether `continue` may target it. */
  isLoop: boolean;
  parent: Scope | undefined;
}

/** An unlabeled loop, which a bare `break` or `continue` leaves. */
interface LoopScope {
  kind: 'loop';
  parent: Scope | undefined;
}

/** A defer's body, out of which no jump may leave. */
interface DeferScope {
  kind: 'defer';
  parent: Scope | undefined;
}

/** A function's body, which `return` and `try` need. */
interface FunctionScope {
  kind: 'function';
  parent: Scope | undefined;
}

/** Code that runs at compile time, where another `comptime` is redundant, or a `nosuspend` block. */
interface MarkerScope {
  kind: 'comptime' | 'nosuspend';
  span: Span;
  parent: Scope | undefined;
}

type Scope = NamespaceScope | BlockScope | LabelScope | LoopScope | DeferScope | FunctionScope | MarkerScope;

/** How an expression's value is used: read, referred to by address (which counts as mutating a `var`), or discarded. */
type Use = 'value' | 'ref' | 'discard';

class AstChecker {
  readonly errors: SourceDiagnostic[] = [];
  /** Whether an error other than an unused or never-mutated local, a pointless discard, or unreachable code arose. */
  fatal = false;
  private scope: Scope | undefined;
  /** Whether the statement being checked is the first of a function's or a branch's body. */
  private hintable = false;
  /** The blocks that are the bodies of conditional branches and loops. */
  private readonly branchBodies = new WeakSet<Expression>();
  private functionDepth = 0;

  constructor(private readonly budget: ExecutionBudget) {}

  private error(span: Span, message: string): void {
    this.errors.push({ row: span.row, message });
    this.fatal = true;
    if (this.functionDepth > 0) throw FATAL;
  }

  /** An error after which Zig still analyzes types, so that the compiler reports both. */
  private minorError(span: Span, message: string): void {
    this.errors.push({ row: span.row, message });
  }

  // Containers ------------------------------------------------------------------------------------------------------

  // code-gauge-allow functionCognitiveComplexity -- Mirrors one AstGen check over the constructs it covers.
  // code-gauge-allow functionNcss -- Checks declarations and fields in their shared container scope.
  checkContainer(
    body: {
      members: readonly ContainerMember[];
      fields: readonly ContainerField[];
      tests: readonly TestDeclaration[];
      comptimeBlocks: readonly Block[];
    },
    parent: Scope | undefined,
    container: Container | undefined
  ): void {
    const { members, fields } = body;
    const names = new Set<string>();
    const seen = new Map<string, Span>();
    for (const member of members) {
      const local = this.outerLocal(member.name);
      if (local)
        this.error(member, `宣言「${member.name}」は、外側の${CATEGORY_NAMES[local.category]}と同じ名前です。`);
      // Zig points at the first of the declarations that share a name.
      const first = seen.get(member.name);
      if (first) this.error(first, `名前「${member.name}」が、同じ型の中で2回宣言されています。`);
      seen.set(member.name, member);
      names.add(member.name);
      if (
        !member.quotedName &&
        (primitiveType(member.name) !== undefined || member.name === 'true' || member.name === 'false')
      ) {
        this.error(
          member,
          `「${member.name}」は組み込みの名前なので、宣言には使えません（@"${member.name}" と書いてください）。`
        );
      }
    }
    const fieldSpans = new Map<string, Span>();
    for (const field of fields) {
      if (field.name === undefined) continue;
      const other = fieldSpans.get(field.name) ?? seen.get(field.name);
      if (other) {
        const first = other.row <= field.row ? other : field;
        this.error(first, `名前「${field.name}」が、同じ型の中で2回宣言されています。`);
      }
      fieldSpans.set(field.name, field);
    }
    const namespace: NamespaceScope = { kind: 'namespace', names, parent };
    const outer = this.scope;
    this.scope = namespace;
    try {
      this.withComptime(container ?? { row: 0, col: 0, endRow: 0 }, () => this.checkFields(fields, container));
      for (const member of members) {
        if (member.kind === 'fn') this.checkFunction(member);
        else this.withComptime(member, () => this.checkContainerVariable(member));
      }
      for (const block of body.comptimeBlocks)
        this.checkBody(block, () => this.withComptime(block, () => this.expression(block, 'value')));
      for (const test of body.tests) {
        if (test.decl && !names.has(test.decl.name)) this.reference(test.decl.name, test.decl, 'value');
        this.checkBody(test.body, () => this.blockStatements(test.body.statements), true);
      }
    } finally {
      this.scope = outer;
    }
  }

  /** The local of an enclosing function that a declaration in a type inside it would shadow. */
  private outerLocal(name: string): LocalBinding | undefined {
    for (let scope = this.scope; scope; scope = scope.parent) {
      this.budget.spend();
      if (scope.kind !== 'block') continue;
      const local = scope.locals.get(name);
      if (local) return local;
    }
    return undefined;
  }

  // code-gauge-allow functionCognitiveComplexity -- Mirrors one AstGen check over the constructs it covers.
  private checkFields(fields: readonly ContainerField[], container: Container | undefined): void {
    if (container?.containerKind === 'enum') {
      this.checkEnumFields(fields, container);
      return;
    }
    if (container?.containerKind === 'opaque' && fields.length > 0)
      this.error(fields[0], 'opaque 型にはフィールドを書けません。');
    for (const field of fields) {
      if (field.type) this.expression(field.type, 'value');
      if (field.value) this.expression(field.value, 'value');
      if (field.alignment) this.expression(field.alignment, 'value');
      if (field.isComptime && !field.value) this.error(field, 'comptime のフィールドには初期値を書いてください。');
      if (container?.containerKind === 'struct' && !field.type && field.name !== undefined) {
        this.error(field, '構造体のフィールドには型を書いてください。');
      }
    }
  }

  // code-gauge-allow functionCognitiveComplexity -- Mirrors one AstGen check over the constructs it covers.
  private checkEnumFields(fields: readonly ContainerField[], container: Container): void {
    for (const [index, field] of fields.entries()) {
      if (field.type) this.error(field, 'enum のフィールドには型を書けません。');
      if (isDiscardName(field) && index !== fields.length - 1) {
        this.error(field, '「_」は enum の最後のフィールドにだけ書けます。');
      }
      if (isDiscardName(field) && field.value) this.error(field, '「_」には値を書けません。');
      if (field.value && !container.argument) {
        this.error(field, '値を指定する enum には、enum(u8) のように整数の型を書いてください。');
      }
      if (isDiscardName(field) && !container.argument) {
        this.error(field, '「_」で終わる enum には、enum(u8) のように整数の型を書いてください。');
      }
      if (field.value) this.expression(field.value, 'value');
    }
  }

  private checkContainerVariable(declaration: Extract<ContainerMember, { kind: 'var' }>): void {
    if (!declaration.value) {
      this.error(declaration, '変数は初期化してください（値が決まらないときは = undefined と書きます）。');
    }
    if (declaration.type) this.expression(declaration.type, 'value');
    if (declaration.value) this.expression(declaration.value, 'value');
    if (!declaration.type && declaration.value?.kind === 'undefined') {
      this.error(declaration, 'undefined で初期化する変数には、型を書いてください。');
    }
  }

  /** Checks the body of a test or a `comptime` declaration, which AstGen checks as it checks a function's. */
  private checkBody(span: Span, check: () => void, isFunction = false): void {
    const outer = this.scope;
    if (isFunction) this.scope = { kind: 'function', parent: outer };
    this.functionDepth++;
    try {
      this.withBlock(check);
    } catch (error) {
      if (error !== FATAL) throw error;
    } finally {
      this.functionDepth--;
      this.scope = outer;
    }
    void span;
  }

  /** A type, which Zig evaluates at compile time wherever it stands. */
  private typeExpression(expression: Expression): void {
    this.withComptime(expression, () => this.expression(expression, 'value'));
  }

  private withComptime<T>(span: Span, run: () => T): T {
    return this.withScope({ kind: 'comptime', span, parent: this.scope }, run);
  }

  /** Whether code runs at compile time: in a `comptime` block or expression, or outside any function. */
  private inComptime(): boolean {
    for (let scope = this.scope; scope; scope = scope.parent) {
      this.budget.spend();
      if (scope.kind === 'comptime') return true;
      if (scope.kind === 'function') return false;
      if (scope.kind === 'namespace') return true;
    }
    return true;
  }

  private nosuspendScope(): MarkerScope | undefined {
    for (let scope = this.scope; scope; scope = scope.parent) {
      this.budget.spend();
      if (scope.kind === 'nosuspend') return scope;
      if (scope.kind === 'function' || scope.kind === 'namespace') return undefined;
    }
    return undefined;
  }

  private checkFunction(fn: FunctionDeclaration): void {
    const outer = this.scope;
    this.scope = { kind: 'function', parent: outer };
    const params: BlockScope = { kind: 'block', locals: new Map(), parent: this.scope };
    this.functionDepth++;
    try {
      // Each parameter is in scope for the types of the later ones and the return type.
      this.scope = params;
      for (const param of fn.params) {
        if (param.type) this.typeExpression(param.type);
        if (!isDiscardName(param)) this.declare(param.name, 'function parameter', param);
        if (param.isComptime && param.isNoalias) this.error(param, 'comptime と noalias は一緒に書けません。');
      }
      for (const attribute of [fn.alignment, fn.addressSpace, fn.callingConvention])
        if (attribute) this.expression(attribute, 'value');
      this.typeExpression(fn.returnType);
      this.blockStatements(fn.body.statements, true);
      this.checkUsed(params);
    } catch (error) {
      if (error !== FATAL) throw error;
    } finally {
      this.functionDepth--;
      this.scope = outer;
    }
  }

  // Bindings --------------------------------------------------------------------------------------------------------

  private declare(name: string, category: Category, span: NamedSpan): LocalBinding {
    this.budget.spend();
    const what = CATEGORY_NAMES[category];
    if (!span.quotedName && primitiveType(name) !== undefined) {
      this.error(span, `「${name}」は組み込みの型の名前なので、${what}の名前には使えません。`);
    }
    for (let scope = this.scope; scope; scope = scope.parent) {
      this.budget.spend();
      if (scope.kind === 'block') {
        const outer = scope.locals.get(name);
        if (outer) {
          this.error(span, `${what}「${name}」は、外側の${CATEGORY_NAMES[outer.category]}と同じ名前です。`);
          break;
        }
      } else if (scope.kind === 'namespace' && scope.names.has(name)) {
        this.error(span, `${what}「${name}」は、宣言「${name}」と同じ名前です。`);
        break;
      }
    }
    const binding: LocalBinding = {
      kind: 'local',
      name,
      category,
      span,
      used: false,
      discardSpan: undefined,
      usedAsLvalue: false,
    };
    const block = this.scope as BlockScope;
    block.locals.set(name, binding);
    return binding;
  }

  private checkUsed(block: BlockScope): void {
    for (const local of block.locals.values()) {
      const what = CATEGORY_NAMES[local.category];
      if (!local.used && !local.discardSpan) {
        this.minorError(local.span, `${what}「${local.name}」を使っていません。`);
      } else if (local.used && local.discardSpan) {
        this.minorError(
          local.discardSpan,
          `${what}「${local.name}」を使っているので、_ = ${local.name}; は要りません。`
        );
      }
      if (local.category === 'local variable' && (local.used || local.discardSpan) && !local.usedAsLvalue) {
        this.minorError(
          local.span,
          `変数「${local.name}」は変更していないので、var ではなく const で宣言してください。`
        );
      }
    }
  }

  private withBlock<T>(run: (block: BlockScope) => T): T {
    const outer = this.scope;
    const block: BlockScope = { kind: 'block', locals: new Map(), parent: outer };
    this.scope = block;
    try {
      const result = run(block);
      this.checkUsed(block);
      return result;
    } finally {
      this.scope = outer;
    }
  }

  private withScope<T>(scope: Scope, run: () => T): T {
    const outer = this.scope;
    this.scope = scope;
    try {
      return run();
    } finally {
      this.scope = outer;
    }
  }

  // code-gauge-allow functionCognitiveComplexity -- Mirrors one AstGen check over the constructs it covers.
  private reference(name: string, span: NamedSpan, use: Use): void {
    if (isDiscardName({ name, quotedName: span.quotedName })) {
      this.error(span, '「_」は、値を捨てる代入（_ = x;）の左辺にだけ書けます。');
      return;
    }
    let crossedNamespace = false;
    for (let scope = this.scope; scope; scope = scope.parent) {
      this.budget.spend();
      if (scope.kind === 'block') {
        const local = scope.locals.get(name);
        if (!local) continue;
        if (crossedNamespace && local.category === 'local variable') {
          this.error(span, `変数「${name}」は、型の中の関数からは使えません。`);
        }
        if (use === 'discard') local.discardSpan ??= span;
        else local.used = true;
        if (use === 'ref') local.usedAsLvalue = true;
        return;
      }
      if (scope.kind === 'namespace') {
        if (scope.names.has(name)) return;
        crossedNamespace = true;
      }
    }
    if (span.quotedName || primitiveType(name) === undefined) this.error(span, `「${name}」は宣言されていません。`);
  }

  private capture(capture: Capture | undefined): void {
    if (!capture || isDiscardName(capture)) return;
    this.declare(capture.name, 'capture', capture);
  }

  // Statements ------------------------------------------------------------------------------------------------------

  /** @param opensBranch Whether the block is a function's or a branch's body, whose first statement may hint it. */
  private blockStatements(statements: readonly Statement[], opensBranch = false): void {
    let diverted = false;
    for (const [index, statement] of statements.entries()) {
      if (diverted) {
        this.minorError(statement, 'この文には、決して実行がたどり着きません。');
        diverted = false;
      }
      this.hintable = opensBranch && index === 0;
      this.statement(statement);
      if (statement.kind === 'expression' && divertsControl(statement.expression)) diverted = true;
    }
  }

  // code-gauge-allow functionCognitiveComplexity -- Mirrors one AstGen check over the constructs it covers.
  private statement(statement: Statement): void {
    this.budget.spend();
    switch (statement.kind) {
      case 'var': {
        this.localVariable(statement);
        break;
      }
      case 'destructure': {
        this.expression(statement.value, 'value');
        for (const target of statement.targets) {
          if (target.declaration) {
            if (target.declaration.type) this.typeExpression(target.declaration.type);
            if (!isDiscardName(target.declaration)) {
              this.declare(target.declaration.name, target.declaration.isConst ? 'local constant' : 'local variable', {
                ...target,
                ...target.declaration,
              });
            }
          } else if (target.target && !isDiscard(target.target)) {
            this.expression(target.target, 'ref');
          }
        }
        break;
      }
      case 'expression': {
        this.expression(statement.expression, 'value');
        break;
      }
      case 'defer': {
        this.withScope({ kind: 'defer', parent: this.scope }, () =>
          this.withBlock(() => this.expression(statement.body, 'value'))
        );
        break;
      }
      case 'comptime': {
        this.comptimeKeyword(statement);
        this.withComptime(statement, () => this.expression(statement.body, 'value'));
        break;
      }
    }
  }

  private localVariable(statement: Extract<Statement, { kind: 'var' }>): void {
    if (statement.isComptime) this.comptimeKeyword(statement);
    if (statement.alignment) this.expression(statement.alignment, 'value');
    if (statement.type) this.typeExpression(statement.type);
    const { value } = statement;
    if (value) this.initializer(statement, value);
    else this.error(statement, '変数は初期化してください（値が決まらないときは = undefined と書きます）。');
    if (!statement.type && statement.value?.kind === 'undefined') {
      this.error(statement, 'undefined で初期化する変数には、型を書いてください。');
    }
    if (statement.type?.kind === 'arrayType' && statement.type.count === undefined) {
      this.error(statement.type, '配列の長さを [_] で省くのは、[_]i32{ 1, 2 } のような初期化のときだけです。');
    }
    if (!isDiscardName(statement)) {
      this.declare(statement.name, statement.isConst ? 'local constant' : 'local variable', statement);
    } else {
      this.error(statement, '「_」という名前の変数は宣言できません。');
    }
  }

  /** A local's initializer, which runs at compile time for a `comptime var`. */
  private initializer(statement: Extract<Statement, { kind: 'var' }>, value: Expression): void {
    if (statement.isComptime) this.withComptime(statement, () => this.expression(value, 'value'));
    else this.expression(value, 'value');
  }

  private comptimeKeyword(span: Span): void {
    if (this.inComptime()) this.error(span, 'すでにコンパイルのときに実行される場所なので、comptime は要りません。');
  }

  // Expressions -----------------------------------------------------------------------------------------------------

  expression(expression: Expression, use: Use): void {
    this.budget.spend();
    switch (expression.kind) {
      case 'identifier': {
        this.reference(expression.name, expression, use);
        break;
      }
      case 'field': {
        this.expression(expression.object, use === 'ref' ? 'ref' : 'value');
        break;
      }
      case 'index': {
        this.expression(expression.object, use === 'ref' ? 'ref' : 'value');
        this.expression(expression.index, 'value');
        break;
      }
      case 'slice': {
        this.expression(expression.object, 'ref');
        this.expression(expression.start, 'value');
        if (expression.end) this.expression(expression.end, 'value');
        if (expression.sentinel) this.expression(expression.sentinel, 'value');
        break;
      }
      case 'deref': {
        this.expression(expression.operand, 'value');
        break;
      }
      case 'unwrap': {
        this.expression(expression.operand, use === 'ref' ? 'ref' : 'value');
        break;
      }
      case 'call': {
        if (expression.callee.kind === 'field') {
          this.expression(expression.callee.object, 'ref');
        } else {
          this.expression(expression.callee, 'value');
        }
        for (const arg of expression.args) this.expression(arg, 'value');
        break;
      }
      case 'builtinCall': {
        if (expression.name === '@field' && use === 'ref' && expression.args.length === 2) {
          this.expression(expression.args[0], 'ref');
          this.expression(expression.args[1], 'value');
          break;
        }
        this.builtinCall(expression);
        break;
      }
      case 'unary': {
        if (expression.operator === '-' && expression.operand.kind === 'integer' && expression.operand.value === 0n)
          this.error(expression, '整数の -0 は曖昧です（整数のゼロには 0 と書いてください）。');
        this.expression(expression.operand, expression.operator === '&' ? 'ref' : 'value');
        break;
      }
      case 'binary': {
        this.expression(expression.left, 'value');
        this.expression(expression.right, 'value');
        break;
      }
      case 'try': {
        if (!this.inFunction()) this.error(expression, 'try は関数の中でだけ使えます。');
        if (this.inDefer()) this.error(expression, 'defer の中では try を使えません。');
        this.expression(expression.operand, 'value');
        break;
      }
      case 'catch': {
        this.expression(expression.operand, 'value');
        this.withBlock(() => {
          if (expression.capture && isDiscardName(expression.capture)) {
            this.error(expression.capture, 'エラーを捨てる |_| は、書かずに省いてください。');
          }
          this.capture(expression.capture);
          this.expression(expression.handler, 'value');
        });
        break;
      }
      case 'if': {
        this.expression(expression.condition, expression.capture?.byPointer ? 'ref' : 'value');
        this.withBlock(() => {
          this.capture(expression.capture);
          this.branchBody(expression.consequent);
        });
        if (expression.otherwise) {
          const otherwise = expression.otherwise;
          this.withBlock(() => {
            this.capture(expression.elseCapture);
            this.branchBody(otherwise);
          });
        }
        break;
      }
      case 'while': {
        this.whileExpression(expression);
        break;
      }
      case 'for': {
        this.forExpression(expression);
        break;
      }
      case 'switch': {
        this.switchExpression(expression);
        break;
      }
      case 'block': {
        this.blockExpression(expression);
        break;
      }
      case 'break':
      case 'continue': {
        this.jump(expression);
        if (expression.value) this.expression(expression.value, 'value');
        break;
      }
      case 'return': {
        if (!this.inFunction()) this.error(expression, 'return は関数の中でだけ使えます。');
        if (this.inDefer()) this.error(expression, 'defer の中からは return できません。');
        if (expression.value) this.expression(expression.value, 'value');
        break;
      }
      case 'structInit': {
        if (expression.type) this.expression(expression.type, 'value');
        const names = new Set<string>();
        for (const field of expression.fields) {
          if (names.has(field.name)) this.error(field, `フィールド「${field.name}」を2回初期化しています。`);
          names.add(field.name);
          this.expression(field.value, 'value');
        }
        break;
      }
      case 'arrayInit': {
        if (expression.type) this.expression(expression.type, 'value');
        for (const element of expression.elements) this.expression(element, 'value');
        break;
      }
      case 'optionalType': {
        this.expression(expression.child, 'value');
        break;
      }
      case 'pointerType':
      case 'sliceType': {
        this.expression(expression.child, 'value');
        for (const part of [
          expression.sentinel,
          expression.alignment,
          ...(expression.bitRange ?? []),
          expression.addressSpace,
        ])
          if (part) this.expression(part, 'value');
        break;
      }
      case 'comptime':
      case 'nosuspend':
      case 'async': {
        this.scopeMarker(expression, use);
        break;
      }
      case 'arrayType': {
        if (expression.count) this.expression(expression.count, 'value');
        if (expression.sentinel) this.expression(expression.sentinel, 'value');
        this.expression(expression.child, 'value');
        break;
      }
      case 'errorUnionType': {
        this.expression(expression.errorSet, 'value');
        this.expression(expression.payload, 'value');
        break;
      }
      case 'fnType': {
        for (const param of expression.params) if (param.type) this.expression(param.type, 'value');
        this.expression(expression.returnType, 'value');
        if (expression.callingConvention) this.expression(expression.callingConvention, 'value');
        break;
      }
      case 'container': {
        this.checkContainer(expression, this.scope, expression);
        if (expression.argument) this.expression(expression.argument, 'value');
        break;
      }
      case 'paren': {
        this.expression(expression.operand, use);
        break;
      }
      case 'assign': {
        this.assignment(expression);
        break;
      }
      case 'errorSetType': {
        const seen = new Set<string>();
        for (const name of expression.names) {
          this.budget.spend();
          if (seen.has(name)) this.error(expression, `エラー集合に error.${name} が2回書かれています。`);
          seen.add(name);
        }
        break;
      }
      default: {
        break;
      }
    }
  }

  /** `comptime`, `nosuspend`, and the async syntax, which AstGen checks for the scope they stand in. */
  private scopeMarker(expression: Extract<Expression, { kind: 'comptime' | 'nosuspend' | 'async' }>, use: Use): void {
    switch (expression.kind) {
      case 'comptime': {
        this.comptimeKeyword(expression);
        this.withComptime(expression, () => this.expression(expression.operand, use));
        break;
      }
      case 'nosuspend': {
        if (this.nosuspendScope()) this.error(expression, 'nosuspend の中に、もう一度 nosuspend を書いています。');
        this.withScope({ kind: 'nosuspend', span: expression, parent: this.scope }, () =>
          this.expression(expression.operand, use)
        );
        break;
      }
      case 'async': {
        if (!expression.operand && this.nosuspendScope())
          this.error(expression, 'nosuspend の中には suspend を書けません。');
        if (expression.operand) this.expression(expression.operand, 'value');
        break;
      }
    }
  }

  private builtinCall(expression: Extract<Expression, { kind: 'builtinCall' }>): void {
    if (expression.name === '@branchHint' && !this.hintable)
      this.error(expression, '@branchHint は、関数か条件の分岐の最初の文に書いてください。');
    if (expression.name === '@import') {
      const [path] = expression.args;
      if (expression.args.length !== 1 || path.kind !== 'string') {
        this.error(expression, '@import の引数は、文字列のリテラル1つにしてください。');
      }
      return;
    }
    for (const arg of expression.args) this.expression(arg, 'value');
  }

  private assignment(expression: Extract<Expression, { kind: 'assign' }>): void {
    const [target] = expression.targets;
    if (expression.targets.length === 1 && isDiscard(target)) {
      if (expression.operator !== '=') this.error(target, '「_」には = でだけ代入できます。');
      this.expression(expression.value, unwrapParens(expression.value).kind === 'identifier' ? 'discard' : 'value');
      return;
    }
    this.expression(expression.value, 'value');
    for (const each of expression.targets) {
      if (isDiscard(each)) continue;
      if (!isAssignable(each)) this.error(each, 'この式には代入できません。');
      this.expression(each, 'ref');
    }
  }

  private blockExpression(expression: Extract<Expression, { kind: 'block' }>): void {
    const opensBranch = this.branchBodies.has(expression);
    if (!expression.label) {
      this.withBlock(() => this.blockStatements(expression.statements, opensBranch));
      return;
    }
    this.withLabel(expression.label, 'block', false, () =>
      this.withBlock(() => this.blockStatements(expression.statements, opensBranch))
    );
  }

  /** The body of a conditional branch or a loop, whose first statement may be `@branchHint`. */
  private branchBody(body: Expression): void {
    if (body.kind === 'block') this.branchBodies.add(body);
    this.expression(body, 'value');
  }

  private withLabel(label: Label, target: LabelScope['target'], isLoop: boolean, run: () => void): void {
    for (let scope = this.scope; scope; scope = scope.parent) {
      this.budget.spend();
      if (scope.kind === 'label' && scope.label.name === label.name) {
        this.error(label, `ラベル「${label.name}」が、外側でも使われています。`);
        break;
      }
      if (scope.kind === 'namespace') break;
    }
    const labelScope: LabelScope = {
      kind: 'label',
      label,
      target,
      used: false,
      isLoop,
      parent: this.scope,
    };
    this.withScope(labelScope, run);
    if (!labelScope.used) this.error(label, `ラベル「${label.name}」を使っていません。`);
  }

  private whileExpression(expression: Extract<Expression, { kind: 'while' }>): void {
    this.expression(expression.condition, expression.capture?.byPointer ? 'ref' : 'value');
    const body = (): void => {
      this.withBlock(() => {
        this.capture(expression.capture);
        if (expression.continueExpression) this.expression(expression.continueExpression, 'value');
        this.branchBody(expression.body);
      });
    };
    const loop: LoopScope = { kind: 'loop', parent: this.scope };
    if (expression.label) {
      this.withLabel(expression.label, 'while', true, () => this.withScope({ ...loop, parent: this.scope }, body));
    } else {
      this.withScope(loop, body);
    }
    if (expression.otherwise) {
      const otherwise = expression.otherwise;
      this.withBlock(() => {
        this.capture(expression.elseCapture);
        this.expression(otherwise, 'value');
      });
    }
  }

  // code-gauge-allow functionNcss -- Mirrors one AstGen check over the constructs it covers.
  // code-gauge-allow functionCognitiveComplexity -- Mirrors one AstGen check over the constructs it covers.
  private forExpression(expression: Extract<Expression, { kind: 'for' }>): void {
    for (const operand of expression.operands) {
      this.expression(operand.value, 'value');
      if (operand.rangeEnd) this.expression(operand.rangeEnd, 'value');
    }
    if (expression.captures.length < expression.operands.length) {
      this.error(expression, 'for の対象のそれぞれに、受け取る名前を書いてください。');
    }
    if (expression.captures.length > expression.operands.length) {
      this.error(expression, 'for の受け取る名前が、対象より多くなっています。');
    }
    if (expression.operands.every((operand) => operand.isRange && !operand.rangeEnd)) {
      this.error(expression, '終わりのない範囲だけでは、for の回数が決まりません。');
    }
    for (const [index, capture] of expression.captures.entries()) {
      const operand = expression.operands[index];
      if (!operand) continue;
      if (capture.byPointer && operand.isRange) this.error(capture, '範囲の値は |*x| で受け取れません。');
      if (isDiscardName(capture) && operand.isRange && !operand.rangeEnd) {
        this.error(capture, '終わりのない範囲を _ で捨てることはできません。');
      }
    }
    const body = (): void => {
      this.withBlock(() => {
        for (const capture of expression.captures) this.capture(capture);
        this.branchBody(expression.body);
      });
    };
    const loop: LoopScope = { kind: 'loop', parent: this.scope };
    if (expression.label) {
      this.withLabel(expression.label, 'for', true, () => this.withScope({ ...loop, parent: this.scope }, body));
    } else {
      this.withScope(loop, body);
    }
    if (expression.otherwise) {
      const otherwise = expression.otherwise;
      this.withBlock(() => this.expression(otherwise, 'value'));
    }
  }

  // code-gauge-allow functionCognitiveComplexity -- Mirrors one AstGen check over the constructs it covers.
  private switchExpression(expression: Extract<Expression, { kind: 'switch' }>): void {
    const byPointer = expression.cases.some((each) => each.capture?.byPointer);
    this.expression(expression.operand, byPointer ? 'ref' : 'value');
    const cases = (): void => {
      for (const each of expression.cases) {
        for (const item of each.items) {
          // `_ =>` takes a non-exhaustive enum's unnamed values.
          if (item.value.kind === 'identifier' && isDiscardName(item.value)) continue;
          this.expression(item.value, 'value');
          if (item.last) this.expression(item.last, 'value');
        }
        this.withBlock(() => {
          if (each.capture && isDiscardName(each.capture) && !each.tagCapture) {
            this.error(each.capture, '受け取らない値の |_| は、書かずに省いてください。');
          }
          if (each.tagCapture && isDiscardName(each.tagCapture)) {
            this.error(each.tagCapture, '受け取らないタグの |_| は、書かずに省いてください。');
          }
          this.capture(each.capture);
          this.capture(each.tagCapture);
          this.branchBody(each.body);
        });
      }
    };
    if (expression.label) this.withLabel(expression.label, 'switch', true, cases);
    else cases();
  }

  private jump(expression: Extract<Expression, { kind: 'break' | 'continue' }>): void {
    const isBreak = expression.kind === 'break';
    for (let scope = this.scope; scope; scope = scope.parent) {
      this.budget.spend();
      if (scope.kind === 'defer') {
        this.error(
          expression,
          isBreak ? 'defer の中から break はできません。' : 'defer の中から continue はできません。'
        );
        return;
      }
      if (scope.kind === 'namespace' || scope.kind === 'function') break;
      if (expression.label) {
        if (scope.kind === 'label' && scope.label.name === expression.label.name) {
          scope.used = true;
          if (!isBreak && !scope.isLoop) {
            this.error(expression, `ラベル「${expression.label.name}」はループではないので、continue できません。`);
          }
          if (!isBreak && scope.target !== 'switch' && expression.value) {
            this.error(expression, 'ループの continue には値を書けません。');
          }
          if (!isBreak && scope.target === 'switch' && !expression.value) {
            this.error(expression, 'switch への continue には値を書いてください。');
          }
          return;
        }
      } else if (scope.kind === 'loop') {
        if (!isBreak && expression.value) this.error(expression, 'ラベルのない continue には値を書けません。');
        return;
      }
    }
    if (expression.label) {
      this.error(expression, `ラベル「${expression.label.name}」が見つかりません。`);
    } else {
      this.error(
        expression,
        isBreak ? 'break は、ループの中でだけ使えます。' : 'continue は、ループの中でだけ使えます。'
      );
    }
  }

  private inFunction(): boolean {
    for (let scope = this.scope; scope; scope = scope.parent) {
      this.budget.spend();
      if (scope.kind === 'function') return true;
      if (scope.kind === 'namespace') return false;
    }
    return false;
  }

  private inDefer(): boolean {
    for (let scope = this.scope; scope; scope = scope.parent) {
      this.budget.spend();
      if (scope.kind === 'defer') return true;
      if (scope.kind === 'function' || scope.kind === 'namespace') return false;
    }
    return false;
  }
}

function unwrapParens(expression: Expression): Expression {
  return expression.kind === 'paren' ? unwrapParens(expression.operand) : expression;
}

function isDiscard(expression: Expression): boolean {
  return expression.kind === 'identifier' && isDiscardName(expression);
}

function isAssignable(expression: Expression): boolean {
  const inner = unwrapParens(expression);
  return (
    inner.kind === 'identifier' ||
    inner.kind === 'field' ||
    inner.kind === 'index' ||
    inner.kind === 'deref' ||
    inner.kind === 'unwrap' ||
    (inner.kind === 'builtinCall' && inner.name === '@field')
  );
}

/** Whether a statement never completes as AstGen knows it: a jump, `unreachable`, or `@panic`. */
function divertsControl(expression: Expression): boolean {
  switch (expression.kind) {
    case 'return':
    case 'break':
    case 'continue':
    case 'unreachable': {
      return true;
    }
    case 'builtinCall': {
      return expression.name === '@panic' || expression.name === '@trap' || expression.name === '@compileError';
    }
    default: {
      return false;
    }
  }
}
