// oxlint-disable unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import type {
  Block,
  ConstDeclaration,
  Expression,
  Parameter,
  SignatureSyntax,
  SimpleStatement,
  Span,
  Statement,
  TypeDeclaration,
  VarDeclaration,
} from './ast';
import { CallCompiler } from './callCompiler';
import type { FunctionContext, VarEntity } from './entities';
import { equalityOf } from './equality';
import { runesOf } from './literals';
import { dynamicMethod, invokeMethod, POINTER_METHOD, receiverFor } from './methods';
import type { Operand } from './operand';
import { arithmetic } from './operators';
import {
  BREAK,
  type Completion,
  CONTINUE,
  type Eval,
  evaluateAll,
  type Exec,
  FALLTHROUGH,
  type Frame,
  GoPanic,
  readLocal,
  RETURN,
  UNASSIGNED,
} from './runtime';
import { nilPointerPanic, panicNilValue } from './runtimeErrors';
import {
  ANY,
  BASIC,
  coreType,
  describeType,
  type FuncType,
  identical,
  isBoolean,
  isFloat,
  isInteger,
  isInterface,
  isString,
  isUntyped,
  type Type,
  underlying,
} from './types';
import {
  Cell,
  copyValue,
  type GoArray,
  GoFunc,
  type GoMap,
  type Iface,
  Pointer,
  type Slice,
  type Value,
} from './values';

/** Function names that, by Go's convention, construct a value, as Java's `new` does for the step rules. */
const CONSTRUCTOR_NAME = /^(?:New|new)(?:$|[^\p{Ll}])/u;

export abstract class StatementCompiler extends CallCompiler {
  // Steps -------------------------------------------------------------------------------------------------------------

  /** The row whose step a statement records, when the program is traced. */
  protected stepRow(span: Span): number | undefined {
    return this.fn?.recordsSteps ? span.row : undefined;
  }

  /** Records the step of a statement after it runs, as `StepTracker.runStatement` decides. */
  protected withStep(span: Span, exec: Exec, onlyCalls: boolean): Exec {
    const row = this.stepRow(span);
    if (row === undefined) return exec;
    return (frame) => frame.runtime.steps.runStatement(row, onlyCalls, () => exec(frame));
  }

  // Blocks --------------------------------------------------------------------------------------------------------

  /** Compiles a block in its own scope, whose variables go out of scope when it ends unless `keepsLocals`. */
  protected block(block: Block, keepsLocals = false): Exec {
    return this.scoped(() => this.statements(block.statements), keepsLocals);
  }

  protected scoped(compile: () => Exec, keepsLocals = false): Exec {
    const fn = this.fn as FunctionContext;
    const firstLocal = fn.info.locals.length;
    const exec = this.withScope(compile);
    if (keepsLocals) return exec;
    const slots = fn.info.locals.slice(firstLocal).map((local) => local.slot);
    if (slots.length === 0) return exec;
    return (frame) => {
      try {
        return exec(frame);
      } finally {
        for (const slot of slots) frame.locals[slot] = UNASSIGNED;
      }
    };
  }

  protected statements(statements: Statement[]): Exec {
    const compiled = statements.map((statement) => this.statement(statement));
    if (compiled.length === 1) return compiled[0];
    return (frame) => {
      for (const exec of compiled) {
        const completion = exec(frame);
        if (completion) return completion;
      }
      return;
    };
  }

  // code-gauge-allow functionCognitiveComplexity 25 -- One case per statement kind.
  protected statement(statement: Statement): Exec {
    const exec = this.statementBody(statement);
    return (frame) => {
      frame.runtime.spend();
      return exec(frame);
    };
  }

  private statementBody(statement: Statement): Exec {
    switch (statement.kind) {
      case 'expression':
      case 'assign':
      case 'define':
      case 'incDec':
      case 'empty': {
        return this.simpleStatement(statement);
      }
      case 'var': {
        return this.varDeclaration(statement);
      }
      case 'const': {
        this.constDeclaration(statement);
        return () => {};
      }
      case 'type': {
        this.localTypeDeclaration(statement);
        return () => {};
      }
      case 'block': {
        return this.block(statement.block);
      }
      case 'if': {
        return this.scoped(() => this.ifStatement(statement));
      }
      case 'for': {
        return this.scoped(() => this.forStatement(statement));
      }
      case 'range': {
        return this.scoped(() => this.rangeStatement(statement));
      }
      case 'switch': {
        return this.scoped(() => this.switchStatement(statement));
      }
      case 'typeSwitch': {
        return this.scoped(() => this.typeSwitchStatement(statement));
      }
      case 'return': {
        return this.returnStatement(statement);
      }
      case 'break': {
        if ((this.fn as FunctionContext).breakDepth === 0)
          this.error(statement, 'break 文はループや switch 文の中にしか書けません。');
        return () => BREAK;
      }
      case 'continue': {
        if ((this.fn as FunctionContext).loopDepth === 0)
          this.error(statement, 'continue 文はループの中にしか書けません。');
        return () => CONTINUE;
      }
      case 'fallthrough': {
        this.error(statement, 'fallthrough は switch 文の case の最後にしか書けません。');
        return () => FALLTHROUGH;
      }
      case 'defer': {
        return this.deferStatement(statement);
      }
    }
  }

  protected abstract constDeclaration(declaration: ConstDeclaration): void;
  protected abstract localTypeDeclaration(declaration: TypeDeclaration): void;

  // Simple statements ---------------------------------------------------------------------------------------------

  // code-gauge-allow functionCognitiveComplexity 20 -- One case per kind of simple statement.
  protected simpleStatement(statement: SimpleStatement): Exec {
    switch (statement.kind) {
      case 'expression': {
        const operand = this.expression(statement.expression);
        if (this.isInvalid(operand)) return () => {};
        if (!operand.isCall || (operand as { pureValue?: boolean }).pureValue) {
          if (operand.mode === 'type')
            this.error(statement, `${describeType(operand.type)} は型なので、文としては書けません。`);
          else this.error(statement, '式の値を使っていません（文として書けるのは関数の呼び出しなどだけです）。');
          return () => {};
        }
        const read = operand.eval;
        return this.withStep(
          statement,
          (frame) => {
            read(frame);
            return;
          },
          true
        );
      }
      case 'assign': {
        return this.assignment(statement);
      }
      case 'define': {
        return this.shortVarDeclaration(statement);
      }
      case 'incDec': {
        return this.incDec(statement);
      }
      case 'empty': {
        return () => {};
      }
    }
  }

  private incDec(statement: Extract<SimpleStatement, { kind: 'incDec' }>): Exec {
    const target = this.expression(statement.operand);
    if (this.isInvalid(target)) return () => {};
    if (!this.isAssignable(target, statement.operand)) return () => {};
    target.variable?.markUsed();
    if (!isNumericType(target.type)) {
      this.error(
        statement,
        `${statement.operator} は数の変数にしか使えません（${describeType(target.type)} 型の値が書かれています）。`
      );
      return () => {};
    }
    const one = this.assign(this.constant({ kind: 'int', value: 1n }, BASIC.untypedInt, statement), target.type, '値');
    const apply: (a: Value, b: Value) => Value = this.hasTypeParam(target.type)
      ? () => {}
      : arithmetic(statement.operator === '++' ? '+' : '-', target.type);
    const update = this.updater(target, statement.operand);
    return this.withStep(
      statement,
      (frame) => {
        update(frame, (value) => apply(value, one(frame)));
        return;
      },
      false
    );
  }

  /** Reads and writes a target once, evaluating its operands once, for `x++` and `x op= y`. */
  private updater(target: Operand, syntax: Expression): (frame: Frame, change: (value: Value) => Value) => void {
    const store = target.store as NonNullable<Operand['store']>;
    if (stripParens(syntax).kind === 'name' || target.mode === 'mapIndex' || !target.addressOf) {
      const read = target.eval;
      return (frame, change) => store(frame, change(read(frame)));
    }
    const address = target.addressOf();
    return (frame, change) => {
      const pointer = address(frame);
      pointer.store(change(pointer.load()));
    };
  }

  protected isAssignable(target: Operand, syntax: Expression): boolean {
    if (target.mode === 'variable' || target.mode === 'mapIndex') return true;
    if (target.mode === 'constant') this.error(syntax, `定数 ${nameOf(syntax)} には代入できません。`);
    else if (
      stripParens(syntax).kind === 'index' &&
      isString(
        coreType(this.expression((stripParens(syntax) as { operand: Expression }).operand).type) ?? BASIC.invalid
      )
    ) {
      this.error(syntax, '文字列の中のバイトには代入できません（文字列は変えられません）。');
    } else this.error(syntax, `${nameOf(syntax)} には代入できません。`);
    return false;
  }

  /** Compiles the target of an assignment; a bare name there does not count as a use of the variable. */
  private assignmentTarget(expression: Expression): Operand | undefined {
    const inner = stripParens(expression);
    if (inner.kind === 'name' && inner.name === '_') return undefined;
    const target = inner.kind === 'name' ? this.name(inner, false) : this.expression(expression);
    if (this.isInvalid(target)) return target;
    countWrite(target);
    if (!this.isAssignable(target, expression)) return { ...target, type: BASIC.invalid };
    return target;
  }

  // code-gauge-allow functionCognitiveComplexity 30 -- Plain, compound, multiple, and comma-ok assignments.
  private assignment(statement: Extract<SimpleStatement, { kind: 'assign' }>): Exec {
    const { operator, left, right } = statement;
    if (operator !== '=') return this.compoundAssignment(statement);
    const targets = left.map((target) => this.assignmentTarget(target));
    const stores = (index: number, value: Eval): ((frame: Frame, value: Value) => void) => {
      void value;
      const target = targets[index];
      if (!target || this.isInvalid(target)) return () => {};
      return target.store as NonNullable<Operand['store']>;
    };
    const typeOf = (index: number): Type | undefined => {
      const target = targets[index];
      if (!target) return undefined;
      return target.type;
    };
    const values = this.rightSide(statement, right, left.length, typeOf);
    if (!values) return () => {};
    const storeFns = values.map((value, index) => stores(index, value));
    const exec: Exec =
      values.length === 1
        ? (frame) => {
            storeFns[0](frame, values[0](frame));
            return;
          }
        : (frame) => {
            const evaluated = evaluateAll(frame, values);
            for (const [index, store] of storeFns.entries()) store(frame, evaluated[index]);
            return;
          };
    const createsObjects = right.length === left.length && right.every((value) => this.createsObject(value));
    return this.withStep(statement, exec, createsObjects);
  }

  /** Whether an expression only creates an object, which `Operand.createsObject` recorded when it compiled. */
  private readonly creations = new WeakSet<Expression>();

  protected createsObject(expression: Expression): boolean {
    return this.creations.has(expression);
  }

  /**
   * Compiles the right side of an assignment or declaration for `count` targets: one value per target, a call with
   * several results, or a comma-ok form. `typeOf` gives each target's type, or undefined for `_` and new variables.
   */
  // code-gauge-allow functionCognitiveComplexity 30 -- The forms of right sides that Go allows.
  protected rightSide(
    span: Span,
    right: Expression[],
    count: number,
    typeOf: (index: number) => Type | undefined,
    defineTypes?: Type[],
    /** The first value, when the caller has compiled it already. */
    precompiled?: Operand
  ): Eval[] | undefined {
    const convert = (operand: Operand, index: number): Eval => {
      const type = typeOf(index);
      if (type) return this.assign(operand, type, '変数');
      const value = this.asValue(operand);
      if (value.type === BASIC.untypedNil && !defineTypes) return value.eval;
      const defaulted = this.defaulted(value);
      if (defineTypes) defineTypes[index] = defaulted.type;
      if (isInterface(defaulted.type) || !isValueKind(defaulted.type)) return defaulted.eval;
      return this.assign(defaulted, defaulted.type, '変数');
    };
    if (right.length === count) {
      return right.map((expression, index) => {
        const operand = index === 0 && precompiled ? precompiled : this.expression(expression);
        if (operand.createsObject || (operand.isCall && this.isConstructorCall(expression)))
          this.creations.add(expression);
        if (operand.type.kind === 'tuple') {
          this.error(
            expression,
            `${(operand.type as { types: Type[] }).types.length} 個の値を返す関数の呼び出しは、1つの値としては使えません。`
          );
          return () => {};
        }
        return convert(operand, index);
      });
    }
    if (right.length === 1) {
      const operand = precompiled ?? this.expression(right[0]);
      if (this.isInvalid(operand)) return undefined;
      if (operand.type.kind === 'tuple' && operand.type.types.length === count) return spreadResults(operand, convert);
      if (count === 2 && operand.commaOk) return commaOkResults(operand, convert);
      const have = operand.type.kind === 'tuple' ? operand.type.types.length : operand.mode === 'novalue' ? 0 : 1;
      this.error(span, `左辺は ${count} 個ですが、右辺の値は ${have} 個です。`);
      return undefined;
    }
    for (const expression of right) this.expression(expression);
    this.error(span, `左辺は ${count} 個ですが、右辺の値は ${right.length} 個です。`);
    return undefined;
  }

  private isConstructorCall(expression: Expression): boolean {
    const inner = stripParens(expression);
    if (inner.kind !== 'call') return false;
    const callee = stripParens(inner.callee);
    const name = callee.kind === 'name' ? callee.name : callee.kind === 'selector' ? callee.field : undefined;
    return name !== undefined && CONSTRUCTOR_NAME.test(name);
  }

  private compoundAssignment(statement: Extract<SimpleStatement, { kind: 'assign' }>): Exec {
    const { left, right } = statement;
    const operator = statement.operator.slice(0, -1);
    if (left.length !== 1 || right.length !== 1) {
      this.error(statement, `${statement.operator} の左辺と右辺には、値を1つずつ書いてください。`);
      return () => {};
    }
    const target = this.expression(left[0]);
    if (this.isInvalid(target) || !this.isAssignable(target, left[0])) {
      this.expression(right[0]);
      return () => {};
    }
    target.variable?.markUsed();
    countWrite(target);
    const current: Operand = { ...target, mode: 'value', eval: (frame) => frame.temporaries.at(-1) as Value };
    const combined = this.binaryOfOperands(statement, operator, current, this.expression(right[0]));
    if (this.isInvalid(combined)) return () => {};
    const result = this.assign(combined, target.type, '変数');
    const update = this.updater(target, left[0]);
    return this.withStep(
      statement,
      (frame) => {
        update(frame, (value) => {
          frame.temporaries.push(value);
          try {
            return result(frame);
          } finally {
            frame.temporaries.pop();
          }
        });
        return;
      },
      false
    );
  }

  // code-gauge-allow functionCognitiveComplexity 25 -- := declares new variables and assigns existing ones.
  private shortVarDeclaration(statement: Extract<SimpleStatement, { kind: 'define' }>): Exec {
    const { left, right } = statement;
    const names: { name: string; span: Span }[] = [];
    for (const target of left) {
      if (target.kind !== 'name') {
        this.error(target, ':= の左辺には名前だけを書いてください。');
        return () => {};
      }
      names.push({ name: target.name, span: target });
    }
    const existing = names.map(({ name }) => (name === '_' ? undefined : this.scope.entities.get(name)));
    const seen = new Set<string>();
    for (const { name, span } of names) {
      if (name !== '_' && seen.has(name)) this.error(span, `${name} が := の左辺に2回書かれています。`);
      seen.add(name);
    }
    if (existing.every((entity, index) => entity !== undefined || names[index].name === '_')) {
      this.error(statement, ':= の左辺に新しい変数がありません（すでにある変数への代入は = で書きます）。');
    }
    const single = left.length === 1 && right.length === 1 && !existing[0] && names[0].name !== '_';
    const first = single ? this.expression(right[0]) : undefined;
    if (first?.product && isFloat(first.type) && !isUntyped(first.type)) {
      return this.productDeclaration(statement, names[0], first);
    }
    const types: Type[] = [];
    const definedAsConstant = first?.ssaConstant;
    const values = this.rightSide(
      statement,
      right,
      left.length,
      (index) => {
        const entity = existing[index];
        return entity?.kind === 'var' ? entity.type : undefined;
      },
      types,
      first
    );
    if (!values) {
      for (const [index, { name, span }] of names.entries())
        if (!existing[index] && name !== '_') this.declareLocal(name, BASIC.invalid, span).used = true;
      return () => {};
    }
    const targets: ((frame: Frame, value: Value) => void)[] = names.map(({ name, span }, index) => {
      const entity = existing[index];
      if (name === '_') return () => {};
      if (entity) {
        if (entity.kind !== 'var') {
          this.error(span, `${name} は変数ではないので代入できません。`);
          return () => {};
        }
        const operand = this.variableOperand(entity, span);
        countWrite(operand);
        return operand.store as NonNullable<Operand['store']>;
      }
      const type = types[index] ?? BASIC.invalid;
      if (isUntyped(type)) this.error(span, `${name} の型を決められません（nil には型がありません）。`);
      const variable = this.declareLocal(name, type, span);
      if (single) variable.definedAsConstant = definedAsConstant;
      return (frame, value) => declareValue(frame, variable, value);
    });
    const exec: Exec =
      values.length === 1
        ? (frame) => {
            targets[0](frame, values[0](frame));
            return;
          }
        : (frame) => {
            const evaluated = evaluateAll(frame, values);
            for (const [index, target] of targets.entries()) target(frame, evaluated[index]);
            return;
          };
    const createsObjects = right.length === left.length && right.every((value) => this.createsObject(value));
    return this.withStep(statement, exec, createsObjects);
  }

  /**
   * `x := a * b` with floats: keeps the factors in hidden slots so that an addition using x fuses the multiplication,
   * as Go's compiler does on arm64 while x keeps this single definition.
   */
  private productDeclaration(statement: Span, name: { name: string; span: Span }, operand: Operand): Exec {
    const product = operand.product as NonNullable<Operand['product']>;
    const left = this.hiddenSlot();
    const right = this.hiddenSlot();
    const variable = this.declareLocal(name.name, operand.type, name.span);
    variable.productFactors = { left, right, order: product.order };
    variable.definedAsConstant = operand.ssaConstant;
    const multiply = arithmetic('*', operand.type);
    return this.withStep(
      statement,
      (frame) => {
        const x = product.left(frame);
        const y = product.right(frame);
        frame.locals[left] = x;
        frame.locals[right] = y;
        declareValue(frame, variable, multiply(x, y));
        return;
      },
      false
    );
  }

  // code-gauge-allow functionCognitiveComplexity 20 -- var declarations with and without types and values.
  protected varDeclaration(declaration: VarDeclaration): Exec {
    const parts: Exec[] = [];
    for (const spec of declaration.specs) {
      const declaredType = spec.type ? this.resolveType(spec.type) : undefined;
      if (spec.values.length === 0) {
        const zero: () => Value = declaredType ? this.zeroOf(declaredType) : () => {};
        const variables = spec.names.map((name) => this.declareLocal(name.name, declaredType ?? BASIC.invalid, name));
        parts.push((frame) => {
          for (const variable of variables) declareValue(frame, variable, zero());
          return;
        });
        continue;
      }
      const types: Type[] = [];
      const values = this.rightSide(spec, spec.values, spec.names.length, () => declaredType, types);
      const variables = spec.names.map((name, index) => {
        const type = declaredType ?? types[index] ?? BASIC.invalid;
        if (isUntyped(type)) this.error(name, `${name.name} の型を決められません（nil には型がありません）。`);
        return this.declareLocal(name.name, type, name);
      });
      if (!values) continue;
      const exec: Exec = (frame) => {
        const evaluated = evaluateAll(frame, values);
        for (const [index, variable] of variables.entries()) declareValue(frame, variable, evaluated[index]);
        return;
      };
      parts.push(
        this.withStep(
          spec,
          exec,
          spec.values.every((value) => this.createsObject(value))
        )
      );
    }
    return (frame) => {
      for (const part of parts) part(frame);
      return;
    };
  }

  // Control flow ----------------------------------------------------------------------------------------------------

  protected condition(expression: Expression, statement: string): Eval {
    const operand = this.value(expression);
    if (this.isInvalid(operand)) return () => false;
    if (!isBoolean(operand.type)) {
      this.error(
        expression,
        `${statement}の条件には真偽値を書いてください（${describeType(operand.type)} 型の値が書かれています）。`
      );
      return () => false;
    }
    return operand.eval;
  }

  private ifStatement(statement: Extract<Statement, { kind: 'if' }>): Exec {
    const init = statement.init ? this.simpleStatement(statement.init) : undefined;
    const condition = this.condition(statement.condition, 'if 文');
    const consequence = this.block(statement.consequence);
    const { alternative } = statement;
    let otherwise: Exec | undefined;
    if (alternative) {
      otherwise =
        'statements' in alternative ? this.block(alternative) : this.scoped(() => this.ifStatement(alternative));
    }
    return (frame) => {
      init?.(frame);
      if (condition(frame)) return consequence(frame);
      return otherwise?.(frame);
    };
  }

  protected loopBody(body: Block): Exec {
    const fn = this.fn as FunctionContext;
    fn.loopDepth++;
    fn.breakDepth++;
    try {
      return this.block(body);
    } finally {
      fn.loopDepth--;
      fn.breakDepth--;
    }
  }

  // code-gauge-allow functionCognitiveComplexity 20 -- The three-clause loop with Go 1.22's per-iteration variables.
  private forStatement(statement: Extract<Statement, { kind: 'for' }>): Exec {
    const row = this.stepRow(statement);
    const fn = this.fn as FunctionContext;
    const firstLocal = fn.info.locals.length;
    const initExec =
      statement.init && statement.init.kind !== 'empty' ? this.simpleStatementWithoutStep(statement.init) : undefined;
    const loopVariables = [...this.scope.entities.values()].filter(
      (entity): entity is VarEntity => entity.kind === 'var'
    );
    void firstLocal;
    const condition = statement.condition ? this.condition(statement.condition, 'for 文') : () => true;
    const body = this.loopBody(statement.body);
    const post =
      statement.post && statement.post.kind !== 'empty' ? this.simpleStatementWithoutStep(statement.post) : undefined;
    const init: Exec | undefined =
      initExec && row !== undefined
        ? (frame) => {
            initExec(frame);
            frame.runtime.steps.step(row);
            return;
          }
        : initExec;
    const update: Exec | undefined =
      post && row !== undefined
        ? (frame) => {
            post(frame);
            frame.runtime.steps.step(row);
            return;
          }
        : post;
    return (frame) => {
      init?.(frame);
      while (condition(frame)) {
        frame.runtime.spend();
        const completion = body(frame);
        if (completion === BREAK) return;
        if (completion && completion !== CONTINUE) return completion;
        // Each iteration has its own copy of the loop's variables, which closures may have captured.
        for (const variable of loopVariables) {
          if (variable.boxed) frame.locals[variable.slot] = new Cell(readLocal(frame, variable.slot));
        }
        update?.(frame);
      }
      return;
    };
  }

  /** Compiles a for statement's init or post, which record the for statement's step as a whole. */
  private simpleStatementWithoutStep(statement: SimpleStatement): Exec {
    const fn = this.fn as FunctionContext;
    const records = fn.recordsSteps;
    fn.recordsSteps = false;
    try {
      return this.simpleStatement(statement);
    } finally {
      fn.recordsSteps = records;
    }
  }

  private rangeStatement(statement: Extract<Statement, { kind: 'range' }>): Exec {
    const range = this.value(statement.range);
    const source = this.isInvalid(range) ? undefined : this.rangeSource(statement, range);
    if (!source) {
      this.declareRangeTargets(statement, BASIC.invalid, BASIC.invalid);
      this.loopBody(statement.body);
      return () => {};
    }
    const { read, keyType, valueType, iterate } = source;
    const bind = this.rangeTargets(statement, keyType, valueType);
    const row = this.stepRow(statement);
    const storesAnswer = bind.answered;
    const body = this.loopBody(statement.body);
    return (frame) => {
      const collection = read(frame);
      frame.temporaries.push(collection);
      try {
        const result = iterate(collection, (key, value) => {
          frame.runtime.spend();
          bind.assign(frame, key, value);
          frame.runtime.steps.stepBinding(row, storesAnswer);
          const completion = body(frame);
          return completion === CONTINUE ? undefined : completion;
        });
        return result === BREAK ? undefined : result;
      } finally {
        frame.temporaries.pop();
      }
    };
  }

  /** What a range loop walks: the collection, the types of its keys and values, and how to visit them. */
  private rangeSource(
    statement: Extract<Statement, { kind: 'range' }>,
    range: Operand
  ): { read: Eval; keyType: Type; valueType: Type; iterate: RangeIterator } | undefined {
    let type = coreType(range.type) ?? range.type;
    let read = range.eval;
    if (type.kind === 'pointer' && underlying(type.element).kind === 'array') {
      const pointerRead = read;
      read = (frame) => {
        const pointer = pointerRead(frame);
        if (!(pointer instanceof Pointer)) nilPointerPanic();
        return pointer.load();
      };
      type = underlying(type.element);
    }
    if (isString(type)) return { read, keyType: BASIC.int, valueType: BASIC.int32, iterate: iterateString };
    if (type.kind === 'array') return { read, keyType: BASIC.int, valueType: type.element, iterate: iterateArray };
    if (type.kind === 'slice') return { read, keyType: BASIC.int, valueType: type.element, iterate: iterateSlice };
    if (type.kind === 'map') return { read, keyType: type.key, valueType: type.value, iterate: iterateMap };
    if (isInteger(type) || (range.mode === 'constant' && isUntyped(range.type))) {
      this.unsupported(statement.range, '整数の range（for i := range 10）');
    } else if (type.kind === 'func') {
      this.unsupported(statement.range, '関数の range（イテレータ）');
    } else {
      this.error(statement.range, `${describeType(range.type)} 型の値は range で回せません。`);
    }
    return undefined;
  }

  private declareRangeTargets(statement: Extract<Statement, { kind: 'range' }>, keyType: Type, valueType: Type): void {
    if (!statement.define) return;
    for (const [target, type] of [
      [statement.key, keyType],
      [statement.value, valueType],
    ] as const) {
      if (target?.kind === 'name' && target.name !== '_') this.declareLocal(target.name, type, target).used = true;
    }
  }

  /** Declares or resolves a range loop's targets, and tells whether one stores a value learners answer. */
  private rangeTargets(
    statement: Extract<Statement, { kind: 'range' }>,
    keyType: Type,
    valueType: Type
  ): { assign: (frame: Frame, key: Value, value: Value) => void; answered: boolean } {
    const targets = [statement.key, statement.value];
    const types = [keyType, valueType];
    let answered = false;
    const stores = targets.map((target, index): ((frame: Frame, value: Value) => void) | undefined => {
      if (!target) return undefined;
      const type = types[index];
      if (stripParens(target).kind === 'name' && (stripParens(target) as { name: string }).name === '_')
        return undefined;
      if (isAnswerType(type)) answered = true;
      if (statement.define) {
        if (target.kind !== 'name') {
          this.error(target, 'range の := の左辺には名前だけを書いてください。');
          return undefined;
        }
        const variable = this.declareLocal(target.name, type, target);
        const copy = isValueKind(type);
        return (frame, value) => declareValue(frame, variable, copy ? copyValue(value) : value);
      }
      const operand = this.assignmentTarget(target);
      if (!operand || this.isInvalid(operand)) return undefined;
      const convert = this.assign(
        { mode: 'value', type, span: target, eval: (frame) => frame.temporaries.at(-1) as Value },
        operand.type,
        '変数'
      );
      const store = operand.store as NonNullable<Operand['store']>;
      return (frame, value) => {
        frame.temporaries.push(value);
        try {
          store(frame, convert(frame));
        } finally {
          frame.temporaries.pop();
        }
      };
    });
    const [storeKey, storeValue] = stores;
    return {
      answered,
      assign: (frame, key, value) => {
        storeKey?.(frame, key);
        storeValue?.(frame, value);
      },
    };
  }

  // code-gauge-allow functionCognitiveComplexity 30 -- Expression switches with Go's rules for duplicates and fallthrough.
  private switchStatement(statement: Extract<Statement, { kind: 'switch' }>): Exec {
    const init = statement.init ? this.simpleStatement(statement.init) : undefined;
    let tag = statement.tag ? this.value(statement.tag) : undefined;
    if (tag && !this.isInvalid(tag)) tag = this.defaulted(tag);
    const tagType = tag && !this.isInvalid(tag) ? tag.type : statement.tag ? BASIC.invalid : BASIC.bool;
    const defaults = statement.cases.filter((switchCase) => !switchCase.values);
    if (defaults.length > 1) this.error(defaults[1], 'switch 文に default が2つあります。');
    const seenConstants = new Map<string, Span>();
    const fn = this.fn as FunctionContext;
    const cases = statement.cases.map((switchCase, index) => {
      const tests = (switchCase.values ?? []).map((value) => this.caseTest(value, tag, tagType, seenConstants));
      const last = switchCase.body.at(-1);
      const fallsThrough = last?.kind === 'fallthrough';
      if (fallsThrough && index === statement.cases.length - 1) {
        this.error(last, '最後の case では fallthrough を使えません。');
      }
      fn.breakDepth++;
      let body: Exec;
      try {
        body = this.scoped(() => this.statements(fallsThrough ? switchCase.body.slice(0, -1) : switchCase.body));
      } finally {
        fn.breakDepth--;
      }
      return { tests, body, fallsThrough, isDefault: !switchCase.values };
    });
    const readTag = tag && !this.isInvalid(tag) ? tag.eval : () => true;
    return (frame) => {
      init?.(frame);
      const value = readTag(frame);
      let start = cases.findIndex((switchCase) => switchCase.tests.some((test) => test(frame, value)));
      if (start < 0) start = cases.findIndex((switchCase) => switchCase.isDefault);
      if (start < 0) return;
      for (let index = start; index < cases.length; index++) {
        const completion = cases[index].body(frame);
        if (completion === BREAK) return;
        if (completion) return completion;
        if (!cases[index].fallsThrough) return;
      }
      return;
    };
  }

  private caseTest(
    expression: Expression,
    tag: Operand | undefined,
    tagType: Type,
    seen: Map<string, Span>
  ): (frame: Frame, value: Value) => boolean {
    let operand = this.value(expression);
    if (this.isInvalid(operand) || tagType === BASIC.invalid) return () => false;
    if (!tag) {
      if (!isBoolean(operand.type)) {
        this.error(
          expression,
          `条件のない switch 文の case には真偽値を書いてください（${describeType(operand.type)} 型の値が書かれています）。`
        );
        return () => false;
      }
      const read = operand.eval;
      return (frame) => read(frame) === true;
    }
    if (isUntyped(operand.type)) {
      const read = this.assign(operand, tagType, 'case の値');
      operand = { ...operand, type: tagType, eval: read };
    }
    if (!identical(operand.type, tagType) && !isInterface(tagType) && !isInterface(operand.type)) {
      this.error(
        expression,
        `case の値の型 ${describeType(operand.type)} が、switch の値の型 ${describeType(tagType)} と違います。`
      );
      return () => false;
    }
    if (operand.mode === 'constant' && operand.constant) {
      const key = `${operand.constant.kind}:${String((operand.constant as { value?: unknown }).value ?? JSON.stringify(operand.constant))}`;
      const previous = seen.get(key);
      if (previous)
        this.error(
          expression,
          `case の値 ${(stripParens(expression) as { text?: string }).text ?? ''} が2回書かれています。`
            .replace(' が', 'が')
            .replace('値が', '値が')
        );
      seen.set(key, expression);
    }
    const equal =
      isInterface(tagType) && !isInterface(operand.type)
        ? this.interfaceCaseEquality(operand.type)
        : equalityOf(tagType);
    const read = operand.eval;
    return (frame, value) => equal(value, read(frame));
  }

  private interfaceCaseEquality(type: Type): (a: Value, b: Value) => boolean {
    const box = this.boxed(type);
    const equal = equalityOf(ANY);
    return (a, b) => equal(a, box(b));
  }

  // code-gauge-allow functionCognitiveComplexity 30 -- Type switches with their bound variable per clause.
  private typeSwitchStatement(statement: Extract<Statement, { kind: 'typeSwitch' }>): Exec {
    const init = statement.init ? this.simpleStatement(statement.init) : undefined;
    const operand = this.value(statement.operand);
    const valid = !this.isInvalid(operand);
    if (valid && !isInterface(operand.type)) {
      this.error(
        statement.operand,
        `${describeType(operand.type)} 型の値はインターフェースではないので、型の switch は使えません。`
      );
    }
    const defaults = statement.cases.filter((typeCase) => !typeCase.types);
    if (defaults.length > 1) this.error(defaults[1], 'switch 文に default が2つあります。');
    const bindings: VarEntity[] = [];
    const cases = statement.cases.map((typeCase) => this.typeSwitchCase(statement, typeCase, operand.type, bindings));
    if (statement.binding && bindings.length > 0 && bindings.every((binding) => !binding.used)) {
      this.error(statement.binding, `宣言した変数 ${statement.binding.name} を使っていません。`);
    }
    for (const binding of bindings) binding.used = true;
    const read = operand.eval;
    return (frame) => {
      init?.(frame);
      const value = read(frame);
      const chosen =
        cases.find((typeCase) => !typeCase.isDefault && typeCase.matched(value)) ??
        cases.find((typeCase) => typeCase.isDefault);
      if (!chosen) return;
      if (chosen.binding) declareValue(frame, chosen.binding, copyValue(chosen.extract(value)));
      const completion = chosen.body(frame);
      return completion === BREAK ? undefined : completion;
    };
  }

  /** One clause of a type switch, with the variable it binds to the value as its single type, or as the operand. */
  private typeSwitchCase(
    statement: Extract<Statement, { kind: 'typeSwitch' }>,
    typeCase: Extract<Statement, { kind: 'typeSwitch' }>['cases'][number],
    operandType: Type,
    bindings: VarEntity[]
  ): {
    matched: (value: Value) => boolean;
    body: Exec;
    binding?: VarEntity;
    extract: (value: Value) => Value;
    isDefault: boolean;
  } {
    const types = (typeCase.types ?? []).map((syntax) => (syntax ? this.resolveType(syntax) : undefined));
    const tests = types.map((type) =>
      type === undefined || type === BASIC.invalid ? undefined : this.assertionTest(type)
    );
    const matched = (value: Value): boolean =>
      types.some((type, index) => {
        if (type === undefined) return value === undefined;
        const test = tests[index];
        return value !== undefined && test !== undefined && test(value as Iface) !== undefined;
      });
    const fn = this.fn as FunctionContext;
    fn.breakDepth++;
    let binding: VarEntity | undefined;
    let body: Exec;
    try {
      body = this.scoped(() => {
        if (statement.binding) {
          const single = types.length === 1 && types[0] !== undefined ? types[0] : operandType;
          binding = this.declareLocal(statement.binding.name, single, statement.binding);
          binding.quiet = true;
          bindings.push(binding);
        }
        return this.statements(typeCase.body);
      });
    } finally {
      fn.breakDepth--;
    }
    const singleType = types.length === 1 ? types[0] : undefined;
    const extract =
      singleType && !isInterface(singleType)
        ? (value: Value): Value => (value as Iface).value
        : (value: Value): Value => value;
    return { matched, body, binding, extract, isDefault: !typeCase.types };
  }

  private returnStatement(statement: Extract<Statement, { kind: 'return' }>): Exec {
    const fn = this.fn as FunctionContext;
    const { results } = fn;
    if (statement.results.length === 0) {
      if (results.length > 0 && !fn.hasNamedResults) {
        this.error(statement, 'return 文に値が足りません。');
      }
      if (fn.hasNamedResults) this.checkShadowedResults(statement);
      return () => RETURN;
    }
    if (results.length === 0) {
      for (const result of statement.results) this.expression(result);
      this.error(statement, '結果を返さない関数の return 文には、値を書けません。');
      return () => RETURN;
    }
    const values = this.rightSide(statement, statement.results, results.length, (index) => results[index]);
    if (!values) return () => RETURN;
    const slots = fn.info.resultSlots;
    return (frame) => {
      const evaluated = evaluateAll(frame, values);
      for (const [index, slot] of slots.entries()) {
        const current = frame.locals[slot];
        if (current instanceof Cell) current.v = evaluated[index];
        else frame.locals[slot] = evaluated[index];
      }
      return RETURN;
    };
  }

  /** A bare return needs the named results in scope, which a variable of the same name in an inner block hides. */
  private checkShadowedResults(statement: Span): void {
    const fn = this.fn as FunctionContext;
    for (const variable of fn.resultVariables) {
      if (variable && variable.name !== '_' && this.scope.lookup(variable.name) !== variable) {
        this.error(statement, `結果の ${variable.name} が内側の変数に隠されているので、値のない return は書けません。`);
      }
    }
  }

  // code-gauge-allow functionCognitiveComplexity 25 -- Deferred calls of functions, methods, and builtins.
  private deferStatement(statement: Extract<Statement, { kind: 'defer' }>): Exec {
    const call = stripParens(statement.call);
    if (call.kind !== 'call') {
      this.error(statement, 'defer には関数の呼び出しを書いてください。');
      return () => {};
    }
    const callee = this.expression(call.callee);
    if (this.isInvalid(callee)) {
      for (const arg of call.args) this.expression(arg);
      return () => {};
    }
    const row = call.row;
    if (callee.mode === 'builtin') return this.deferBuiltin(statement, call, callee.builtin as string);
    if (callee.mode === 'type') {
      this.error(statement, 'defer には関数の呼び出しを書いてください（型の変換は書けません）。');
      return () => {};
    }
    if (callee.mode === 'method') return this.deferMethod(call, callee, row);
    const value = this.asValue(callee);
    if (this.isInvalid(value)) return () => {};
    const signature = coreType(value.type);
    if (signature?.kind !== 'func' || value.func?.generic) {
      if (value.func?.generic) {
        const operand = this.expression(call);
        const read = operand.eval;
        return (frame) => {
          frame.runtime.defer(frame, () => void read(frame), []);
          return;
        };
      }
      this.error(statement, `${describeType(value.type)} 型の値は関数ではないので、defer で呼び出せません。`);
      return () => {};
    }
    const args = this.callArguments(call, signature);
    if (!args) return () => {};
    const readFunction = value.eval;
    return (frame) => {
      const fn = readFunction(frame);
      const argValues = args(frame);
      if (!(fn instanceof GoFunc)) {
        frame.runtime.defer(frame, () => nilPointerPanic(), []);
        return;
      }
      frame.runtime.defer(frame, () => void fn.call(argValues, row, frame), [fn, ...argValues]);
      return;
    };
  }

  private deferMethod(call: Extract<Expression, { kind: 'call' }>, callee: Operand, row: number): Exec {
    const { receiver, selection } = callee.method as NonNullable<Operand['method']>;
    const args = this.callArguments(call, selection.method.type);
    if (!args) return () => {};
    if (selection.kind === 'interfaceMethod') {
      const read = receiver.eval;
      const name = selection.method.name;
      return (frame) => {
        const iface = read(frame) as { type: Type; value: Value } | undefined;
        const argValues = args(frame);
        frame.runtime.defer(frame, () => {
          if (!iface) nilPointerPanic();
          const target = dynamicMethod(iface.type, name);
          target?.(iface.value, argValues, row, frame);
        }, [iface, ...argValues]);
        return;
      };
    }
    const { method, path } = selection;
    const pointer = method.pointerReceiver ? this.deferredPointerReceiver(receiver, path) : undefined;
    const read = receiver.eval;
    const viaPointer = underlying(receiver.type).kind === 'pointer';
    return (frame) => {
      const value = pointer ? pointer(frame) : receiverFor(read(frame), path, method, viaPointer);
      const argValues = args(frame);
      frame.runtime.defer(frame, () => void invokeMethod(method, value, argValues, row, frame), [value, ...argValues]);
      return;
    };
  }

  private deferredPointerReceiver(receiver: Operand, path: readonly number[]): Eval {
    if (path.length === 0 && underlying(receiver.type).kind !== 'pointer' && receiver.addressOf)
      return receiver.addressOf();
    const read = receiver.eval;
    if (path.length > 0 && underlying(receiver.type).kind !== 'pointer' && receiver.addressOf) {
      const address = receiver.addressOf();
      return (frame) => receiverFor(address(frame), path, POINTER_METHOD);
    }
    return (frame) => receiverFor(read(frame), path, POINTER_METHOD);
  }

  private deferBuiltin(statement: Span, call: Extract<Expression, { kind: 'call' }>, name: string): Exec {
    if (name === 'panic' || name === 'print' || name === 'println') {
      const values = call.args.map((arg) =>
        name === 'panic' ? this.assign(this.expression(arg), ANY, '引数') : this.defaulted(this.value(arg)).eval
      );
      if (name === 'panic' && values.length !== 1) this.error(call, 'panic の引数の数が合いません。');
      return (frame) => {
        const evaluated = values.map((value) => value(frame));
        frame.runtime.defer(
          frame,
          () => {
            if (name === 'panic') throw new GoPanic(evaluated[0] ?? panicNilValue());
          },
          evaluated
        );
        return;
      };
    }
    if (name === 'recover') {
      // A recover that the deferred mechanism calls directly is not called by a deferred function, so it stops nothing.
      return (frame) => {
        frame.runtime.defer(frame, () => {}, []);
        return;
      };
    }
    this.unsupported(statement, `defer での ${name} の呼び出し`);
    return () => {};
  }

  // Functions -------------------------------------------------------------------------------------------------------

  /**
   * Compiles a function body in a new context: declares the receiver, parameters, and results, compiles the body,
   * and checks that it ends with a terminating statement when it has results.
   */
  // code-gauge-allow functionCognitiveComplexity 20 -- Parameters, named and unnamed results, and the body.
  protected functionBody(
    name: string,
    signature: SignatureSyntax,
    type: FuncType,
    body: Block,
    receiver: { name?: string; type: Type; span: Span } | undefined,
    isAtomic: boolean
  ): FunctionContext {
    const outer = this.fn;
    const fn = this.newFunctionContext(name, outer, () => {});
    fn.info.isAtomic = isAtomic;
    if (outer && !outer.recordsSteps) fn.recordsSteps = false;
    this.fn = fn;
    try {
      this.withScope(() => {
        if (receiver) {
          const variable = this.declareLocal(receiver.name ?? '_', receiver.type, receiver.span, true);
          variable.used = true;
          fn.info.params.push(variable);
        }
        for (const [index, parameter] of signature.parameters.entries()) {
          const variable = this.declareParameter(parameter, type.params[index]);
          fn.info.params.push(variable);
        }
        fn.results = type.results;
        fn.hasNamedResults = signature.results.some((result) => result.name !== undefined);
        const zeros = type.results.map((result) => this.zeroOf(result));
        for (const [index, result] of signature.results.entries()) {
          if (result.name !== undefined) {
            const variable = this.declareLocal(result.name, type.results[index], result);
            variable.used = true;
            fn.resultVariables.push(variable);
            fn.info.resultSlots.push(variable.slot);
          } else {
            fn.resultVariables.push(undefined);
            fn.info.resultSlots.push(this.hiddenSlot());
          }
        }
        const statements = this.statements(body.statements);
        const resultSlots = fn.info.resultSlots;
        const resultVariables = fn.resultVariables;
        fn.info.body = (frame) => {
          for (const [index, slot] of resultSlots.entries()) {
            const variable = resultVariables[index];
            if (variable) declareValue(frame, variable, zeros[index]());
            else frame.locals[slot] = zeros[index]();
          }
          return statements(frame);
        };
        if (type.results.length > 0 && !isTerminatingList(body.statements)) {
          this.error(
            { row: body.endRow, column: 0 },
            'return 文がありません（結果を返す関数は return 文か panic で終わらせてください）。'
          );
        }
      });
    } finally {
      this.fn = outer;
    }
    return fn;
  }

  private declareParameter(parameter: Parameter, type: Type): VarEntity {
    const variable = this.declareLocal(parameter.name ?? '_', type, parameter);
    variable.used = true;
    return variable;
  }

  protected compileFuncLiteral(expression: Extract<Expression, { kind: 'funcLiteral' }>): Operand {
    const type = this.resolveSignature(expression.signature).type;
    const fn = this.functionBody('func', expression.signature, type, expression.body, undefined, false);
    const outer = this.fn as FunctionContext;
    const cellReaders = [...fn.captures.keys()].map((variable) => {
      if (variable.owner === outer) return (frame: Frame) => frame.locals[variable.slot] as Cell;
      const index = outer.captures.get(variable) as number;
      return (frame: Frame) => frame.cells[index];
    });
    const { info } = fn;
    return {
      mode: 'value',
      type,
      span: expression,
      eval: (frame) => {
        const cells = cellReaders.map((readCell) => readCell(frame));
        const runtime = frame.runtime;
        return new GoFunc(
          (args, callRow, deferredFor) => runtime.call(info, cells, args, callRow, deferredFor as Frame | undefined),
          cells
        );
      },
    };
  }
}

type RangeVisit = (key: Value, value: Value) => Completion | undefined;
type RangeIterator = (collection: Value, visit: RangeVisit) => Completion | undefined;

/** Visits the runes of a string with their byte offsets. */
function iterateString(collection: Value, visit: RangeVisit): Completion | undefined {
  const text = collection as string;
  let offset = 0;
  for (const rune of runesOf(text)) {
    const result = visit(BigInt(offset), BigInt(rune));
    if (result) return result;
    offset += runeSize(text, offset);
  }
  return undefined;
}

/** Visits a copy of an array's elements, since the range expression is evaluated, and copied, once. */
function iterateArray(collection: Value, visit: RangeVisit): Completion | undefined {
  for (const [index, value] of [...(collection as GoArray).elements].entries()) {
    const result = visit(BigInt(index), value);
    if (result) return result;
  }
  return undefined;
}

/** Visits a slice's elements up to its length when the loop began, reading each from the shared array. */
function iterateSlice(collection: Value, visit: RangeVisit): Completion | undefined {
  const slice = collection as Slice | undefined;
  const length = slice?.length ?? 0;
  for (let index = 0; index < length; index++) {
    const result = visit(BigInt(index), (slice as Slice).get(index));
    if (result) return result;
  }
  return undefined;
}

/** Visits a map's entries, skipping entries deleted during the loop; entries added may or may not be visited, as in Go. */
function iterateMap(collection: Value, visit: RangeVisit): Completion | undefined {
  const map = collection as GoMap | undefined;
  if (!map) return undefined;
  for (const [key, entry] of map.entries) {
    if (!map.entries.has(key)) continue;
    const result = visit(entry.key, entry.value);
    if (result) return result;
  }
  return undefined;
}

type Convert = (operand: Operand, index: number) => Eval;

/**
 * The results of a call with several results, converted one by one. The conversions call no code of the program, so
 * one holder serves every evaluation: the first conversion evaluates the call and the others read its results.
 */
function spreadResults(call: Operand, convert: Convert): Eval[] {
  let results: Value[] = [];
  const read = call.eval;
  const types = (call.type as { types: Type[] }).types;
  const converts = types.map((type, index) =>
    convert({ mode: 'value', type, span: call.span, eval: () => results[index] }, index)
  );
  return converts.map((value, index): Eval =>
    index === 0
      ? (frame) => {
          results = read(frame) as unknown as Value[];
          return value(frame);
        }
      : value
  );
}

/** `v, ok` of a map index or a type assertion, converted as `spreadResults` converts results. */
function commaOkResults(operand: Operand, convert: Convert): Eval[] {
  const lookup = operand.commaOk as NonNullable<Operand['commaOk']>;
  let result: [Value, boolean] = [undefined, false];
  const first = convert({ ...operand, mode: 'value', eval: () => result[0] }, 0);
  const second = convert({ mode: 'value', type: BASIC.untypedBool, span: operand.span, eval: () => result[1] }, 1);
  return [
    (frame) => {
      result = lookup(frame);
      return first(frame);
    },
    second,
  ];
}

/** Counts an assignment to a variable, after which its declared value may no longer reach its uses. */
function countWrite(target: Operand): void {
  const entity = target.variable?.entity;
  if (entity && target.type === entity.type) entity.writes = (entity.writes ?? 0) + 1;
}

/** Stores the value of a newly declared variable, in a fresh cell when closures or pointers may share it. */
export function declareValue(frame: Frame, variable: VarEntity, value: Value): void {
  frame.locals[variable.slot] = variable.boxed ? new Cell(value) : value;
}

function runeSize(text: string, offset: number): number {
  const first = text.charCodeAt(offset);
  if (first < 0x80) return 1;
  const decoded = runesOf(text.slice(offset, offset + 4));
  const rune = decoded[0];
  if (rune === 0xff_fd && !text.startsWith('ï¿½', offset)) return 1;
  if (rune < 0x8_00) return 2;
  if (rune < 0x1_00_00) return 3;
  return 4;
}

function stripParens(expression: Expression): Expression {
  return expression.kind === 'paren' ? stripParens(expression.expression) : expression;
}

function nameOf(expression: Expression): string {
  const inner = stripParens(expression);
  return inner.kind === 'name' ? inner.name : 'この式';
}

function isNumericType(type: Type): boolean {
  const under = coreType(type) ?? underlying(type);
  return under.kind === 'basic' &&
    !['bool', 'string', 'untypedBool', 'untypedString', 'untypedNil', 'invalid'].includes(under.basic)
    ? true
    : type.kind === 'typeParam';
}

function isValueKind(type: Type): boolean {
  const kind = underlying(type).kind;
  return kind === 'struct' || kind === 'array';
}

/** Whether learners write down the value of a variable of this type, as Java's primitives and strings. */
function isAnswerType(type: Type): boolean {
  const under = underlying(type);
  return under.kind === 'basic' && under.basic !== 'invalid';
}

/** Whether a statement list ends with a terminating statement, as a function with results must. */
export function isTerminatingList(statements: Statement[]): boolean {
  const last = statements.toReversed().find((statement) => statement.kind !== 'empty');
  return last !== undefined && isTerminating(last);
}

// code-gauge-allow functionCognitiveComplexity 20 -- The terminating statements of the specification.
function isTerminating(statement: Statement): boolean {
  switch (statement.kind) {
    case 'return': {
      return true;
    }
    case 'expression': {
      const call = stripParens(statement.expression);
      return (
        call.kind === 'call' &&
        stripParens(call.callee).kind === 'name' &&
        (stripParens(call.callee) as { name: string }).name === 'panic'
      );
    }
    case 'block': {
      return isTerminatingList(statement.block.statements);
    }
    case 'if': {
      if (!statement.alternative) return false;
      const otherwise =
        'statements' in statement.alternative
          ? isTerminatingList(statement.alternative.statements)
          : isTerminating(statement.alternative);
      return isTerminatingList(statement.consequence.statements) && otherwise;
    }
    case 'for': {
      return statement.condition === undefined && !hasBreak(statement.body.statements);
    }
    case 'switch':
    case 'typeSwitch': {
      const cases = statement.cases;
      const hasDefault = cases.some((switchCase) => ('values' in switchCase ? !switchCase.values : !switchCase.types));
      return (
        hasDefault &&
        cases.every((switchCase) => {
          const body = switchCase.body;
          const last = body.at(-1);
          return !hasBreak(body) && (last?.kind === 'fallthrough' || isTerminatingList(body));
        })
      );
    }
    default: {
      return false;
    }
  }
}

/** Whether a break in the statements targets the enclosing statement, skipping nested loops and switches. */
function hasBreak(statements: Statement[]): boolean {
  return statements.some((statement) => {
    switch (statement.kind) {
      case 'break': {
        return true;
      }
      case 'block': {
        return hasBreak(statement.block.statements);
      }
      case 'if': {
        const alternative = statement.alternative;
        return (
          hasBreak(statement.consequence.statements) ||
          (alternative !== undefined &&
            ('statements' in alternative ? hasBreak(alternative.statements) : hasBreak([alternative])))
        );
      }
      default: {
        return false;
      }
    }
  });
}

export type { Completion, Slice };
