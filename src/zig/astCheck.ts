import { CompileError, type SourceDiagnostic } from '../interpreter/diagnostics';
import type {
  Capture,
  Container,
  ContainerField,
  ContainerMember,
  Expression,
  FunctionDeclaration,
  Label,
  SourceFile,
  Span,
  Statement,
} from './ast';
import { primitiveType } from './types';

/**
 * Checks what Zig's AstGen checks in every function, whether or not the program calls it: unused locals, parameters,
 * and captures, variables never mutated, pointless discards, shadowing, undeclared names, misplaced jumps and labels,
 * and code after a statement that never completes.
 */
export function checkSource(file: SourceFile, predeclared: readonly string[]): void {
  const checker = new AstChecker();
  const environment: NamespaceScope = {
    kind: 'namespace',
    names: new Set(predeclared),
    parent: undefined,
  };
  checker.checkContainer(file.members, file.fields, environment, undefined);
  if (checker.errors.length > 0) {
    throw new CompileError(checker.errors.toSorted((a, b) => a.row - b.row).slice(0, 5));
  }
}

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
  discarded: boolean;
  usedAsLvalue: boolean;
}

interface NamespaceScope {
  kind: 'namespace';
  names: Set<string>;
  parent: Scope | undefined;
}

interface BlockScope {
  kind: 'block';
  locals: LocalBinding[];
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

type Scope = NamespaceScope | BlockScope | LabelScope | LoopScope | DeferScope | FunctionScope;

/** How an expression's value is used: read, referred to by address (which counts as mutating a `var`), or discarded. */
type Use = 'value' | 'ref' | 'discard';

class AstChecker {
  readonly errors: SourceDiagnostic[] = [];
  private scope: Scope | undefined;

  private error(span: Span, message: string): void {
    this.errors.push({ row: span.row, message });
  }

  // Containers ------------------------------------------------------------------------------------------------------

  checkContainer(
    members: readonly ContainerMember[],
    fields: readonly ContainerField[],
    parent: Scope | undefined,
    container: Container | undefined
  ): void {
    const names = new Set<string>();
    const seen = new Map<string, Span>();
    for (const member of members) {
      if (seen.has(member.name)) {
        this.error(member, `名前「${member.name}」が、同じ型の中で2回宣言されています。`);
      }
      seen.set(member.name, member);
      names.add(member.name);
      if (primitiveType(member.name) !== undefined || member.name === 'true' || member.name === 'false') {
        this.error(
          member,
          `「${member.name}」は組み込みの名前なので、宣言には使えません（@"${member.name}" と書いてください）。`
        );
      }
    }
    const fieldNames = new Set<string>();
    for (const field of fields) {
      if (field.name === undefined) continue;
      if (fieldNames.has(field.name) || seen.has(field.name)) {
        this.error(field, `名前「${field.name}」が、同じ型の中で2回宣言されています。`);
      }
      fieldNames.add(field.name);
    }
    const namespace: NamespaceScope = { kind: 'namespace', names, parent };
    const outer = this.scope;
    this.scope = namespace;
    try {
      this.checkFields(fields, container);
      for (const member of members) {
        if (member.kind === 'fn') this.checkFunction(member);
        else this.checkContainerVariable(member);
      }
    } finally {
      this.scope = outer;
    }
  }

  private checkFields(fields: readonly ContainerField[], container: Container | undefined): void {
    if (container?.containerKind === 'enum') {
      for (const [index, field] of fields.entries()) {
        if (field.type) this.error(field, 'enum のフィールドには型を書けません。');
        if (field.name === '_' && index !== fields.length - 1) {
          this.error(field, '「_」は enum の最後のフィールドにだけ書けます。');
        }
        if (field.name === '_' && field.value) this.error(field, '「_」には値を書けません。');
        if (field.value && !container.argument) {
          this.error(field, '値を指定する enum には、enum(u8) のように整数の型を書いてください。');
        }
        if (field.name === '_' && !container.argument) {
          this.error(field, '「_」で終わる enum には、enum(u8) のように整数の型を書いてください。');
        }
        if (field.value) this.expression(field.value, 'value');
      }
      return;
    }
    for (const field of fields) {
      if (field.type) this.expression(field.type, 'value');
      if (field.value) this.expression(field.value, 'value');
      if (container?.containerKind === 'struct' && !field.type && field.name !== undefined) {
        this.error(field, '構造体のフィールドには型を書いてください。');
      }
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

  private checkFunction(fn: FunctionDeclaration): void {
    const outer = this.scope;
    this.scope = { kind: 'function', parent: outer };
    const params: BlockScope = { kind: 'block', locals: [], parent: this.scope };
    try {
      // Each parameter is in scope for the types of the later ones and the return type.
      this.scope = params;
      for (const param of fn.params) {
        if (param.type) this.expression(param.type, 'value');
        if (param.name !== '_') this.declare(param.name, 'function parameter', param);
      }
      this.expression(fn.returnType, 'value');
      this.blockStatements(fn.body.statements);
      this.checkUsed(params);
    } finally {
      this.scope = outer;
    }
  }

  // Bindings --------------------------------------------------------------------------------------------------------

  private declare(name: string, category: Category, span: Span): LocalBinding {
    const what = CATEGORY_NAMES[category];
    if (primitiveType(name) !== undefined) {
      this.error(span, `「${name}」は組み込みの型の名前なので、${what}の名前には使えません。`);
    }
    for (let scope = this.scope; scope; scope = scope.parent) {
      if (scope.kind === 'block') {
        const outer = scope.locals.find((local) => local.name === name);
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
      discarded: false,
      usedAsLvalue: false,
    };
    const block = this.scope as BlockScope;
    block.locals.push(binding);
    return binding;
  }

  private checkUsed(block: BlockScope): void {
    for (const local of block.locals) {
      const what = CATEGORY_NAMES[local.category];
      if (!local.used && !local.discarded) {
        this.error(local.span, `${what}「${local.name}」を使っていません。`);
      } else if (local.used && local.discarded) {
        this.error(local.span, `${what}「${local.name}」を使っているので、_ = ${local.name}; は要りません。`);
      }
      if (local.category === 'local variable' && (local.used || local.discarded) && !local.usedAsLvalue) {
        this.error(local.span, `変数「${local.name}」は変更していないので、var ではなく const で宣言してください。`);
      }
    }
  }

  private withBlock<T>(run: (block: BlockScope) => T): T {
    const outer = this.scope;
    const block: BlockScope = { kind: 'block', locals: [], parent: outer };
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

  private reference(name: string, span: Span, use: Use): void {
    if (name === '_') {
      this.error(span, '「_」は、値を捨てる代入（_ = x;）の左辺にだけ書けます。');
      return;
    }
    let crossedNamespace = false;
    for (let scope = this.scope; scope; scope = scope.parent) {
      if (scope.kind === 'block') {
        const local = scope.locals.findLast((binding) => binding.name === name);
        if (!local) continue;
        if (crossedNamespace && local.category === 'local variable') {
          this.error(span, `変数「${name}」は、型の中の関数からは使えません。`);
        }
        if (use === 'discard') local.discarded = true;
        else local.used = true;
        if (use === 'ref') local.usedAsLvalue = true;
        return;
      }
      if (scope.kind === 'namespace') {
        if (scope.names.has(name)) return;
        crossedNamespace = true;
      }
    }
    if (primitiveType(name) === undefined) this.error(span, `「${name}」は宣言されていません。`);
  }

  private capture(capture: Capture | undefined): void {
    if (!capture || capture.name === '_') return;
    this.declare(capture.name, 'capture', capture);
  }

  // Statements ------------------------------------------------------------------------------------------------------

  private blockStatements(statements: readonly Statement[]): void {
    let diverted = false;
    for (const statement of statements) {
      if (diverted) {
        this.error(statement, 'この文には、決して実行がたどり着きません。');
        diverted = false;
      }
      this.statement(statement);
      if (statement.kind === 'expression' && divertsControl(statement.expression)) diverted = true;
    }
  }

  private statement(statement: Statement): void {
    switch (statement.kind) {
      case 'var': {
        if (statement.type) this.expression(statement.type, 'value');
        if (statement.value) this.expression(statement.value, 'value');
        else this.error(statement, '変数は初期化してください（値が決まらないときは = undefined と書きます）。');
        if (!statement.type && statement.value?.kind === 'undefined') {
          this.error(statement, 'undefined で初期化する変数には、型を書いてください。');
        }
        if (statement.type?.kind === 'arrayType' && statement.type.count === undefined) {
          this.error(statement.type, '配列の長さを [_] で省くのは、[_]i32{ 1, 2 } のような初期化のときだけです。');
        }
        if (statement.name !== '_') {
          this.declare(statement.name, statement.isConst ? 'local constant' : 'local variable', statement);
        } else {
          this.error(statement, '「_」という名前の変数は宣言できません。');
        }
        break;
      }
      case 'destructure': {
        this.expression(statement.value, 'value');
        for (const target of statement.targets) {
          if (target.declaration) {
            if (target.declaration.type) this.expression(target.declaration.type, 'value');
            if (target.declaration.name !== '_') {
              this.declare(
                target.declaration.name,
                target.declaration.isConst ? 'local constant' : 'local variable',
                target
              );
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
    }
  }

  // Expressions -----------------------------------------------------------------------------------------------------

  // code-gauge-allow functionCognitiveComplexity 45 -- One case per kind of expression.
  // code-gauge-allow functionNcss 110 -- One case per kind of expression.
  expression(expression: Expression, use: Use): void {
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
        this.builtinCall(expression);
        break;
      }
      case 'unary': {
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
          if (expression.capture?.name === '_') {
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
          this.expression(expression.consequent, 'value');
        });
        if (expression.otherwise) {
          const otherwise = expression.otherwise;
          this.withBlock(() => {
            if (expression.elseCapture?.name === '_') {
              this.error(expression.elseCapture, 'エラーを捨てる |_| は、書かずに省いてください。');
            }
            this.capture(expression.elseCapture);
            this.expression(otherwise, 'value');
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
        for (const field of expression.fields) this.expression(field.value, 'value');
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
        if (expression.kind === 'sliceType' && expression.sentinel) this.expression(expression.sentinel, 'value');
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
        break;
      }
      case 'container': {
        this.checkContainer(expression.members, expression.fields, this.scope, expression);
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
      default: {
        break;
      }
    }
  }

  private builtinCall(expression: Extract<Expression, { kind: 'builtinCall' }>): void {
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
    if (!expression.label) {
      this.withBlock(() => this.blockStatements(expression.statements));
      return;
    }
    this.withLabel(expression.label, 'block', false, () =>
      this.withBlock(() => this.blockStatements(expression.statements))
    );
  }

  private withLabel(label: Label, target: LabelScope['target'], isLoop: boolean, run: () => void): void {
    for (let scope = this.scope; scope; scope = scope.parent) {
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
        this.expression(expression.body, 'value');
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
        if (expression.elseCapture?.name === '_') {
          this.error(expression.elseCapture, 'エラーを捨てる |_| は、書かずに省いてください。');
        }
        this.capture(expression.elseCapture);
        this.expression(otherwise, 'value');
      });
    }
  }

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
      if (capture.name === '_' && operand.isRange && !operand.rangeEnd) {
        this.error(capture, '終わりのない範囲を _ で捨てることはできません。');
      }
    }
    const body = (): void => {
      this.withBlock(() => {
        for (const capture of expression.captures) this.capture(capture);
        this.expression(expression.body, 'value');
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

  private switchExpression(expression: Extract<Expression, { kind: 'switch' }>): void {
    const byPointer = expression.cases.some((each) => each.capture?.byPointer);
    this.expression(expression.operand, byPointer ? 'ref' : 'value');
    const cases = (): void => {
      for (const each of expression.cases) {
        for (const item of each.items) {
          // `_ =>` takes a non-exhaustive enum's unnamed values.
          if (item.value.kind === 'identifier' && item.value.name === '_') continue;
          this.expression(item.value, 'value');
          if (item.last) this.expression(item.last, 'value');
        }
        this.withBlock(() => {
          if (each.capture?.name === '_' && !each.tagCapture) {
            this.error(each.capture, '受け取らない値の |_| は、書かずに省いてください。');
          }
          if (each.tagCapture?.name === '_') {
            this.error(each.tagCapture, '受け取らないタグの |_| は、書かずに省いてください。');
          }
          this.capture(each.capture);
          this.capture(each.tagCapture);
          this.expression(each.body, 'value');
        });
      }
    };
    if (expression.label) this.withLabel(expression.label, 'switch', true, cases);
    else cases();
  }

  private jump(expression: Extract<Expression, { kind: 'break' | 'continue' }>): void {
    const isBreak = expression.kind === 'break';
    for (let scope = this.scope; scope; scope = scope.parent) {
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
      if (scope.kind === 'function') return true;
      if (scope.kind === 'namespace') return false;
    }
    return false;
  }

  private inDefer(): boolean {
    for (let scope = this.scope; scope; scope = scope.parent) {
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
  return expression.kind === 'identifier' && expression.name === '_';
}

function isAssignable(expression: Expression): boolean {
  const inner = unwrapParens(expression);
  return (
    inner.kind === 'identifier' ||
    inner.kind === 'field' ||
    inner.kind === 'index' ||
    inner.kind === 'deref' ||
    inner.kind === 'unwrap'
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
