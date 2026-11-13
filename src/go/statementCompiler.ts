// oxlint-disable unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import { constantIdentityKey, represent } from './assignability';
import {
  type Block,
  type ConstDeclaration,
  type Expression,
  type Parameter,
  type SignatureSyntax,
  type SimpleStatement,
  type Span,
  type Statement,
  stripParens,
  type TypeDeclaration,
  type VarDeclaration,
} from './ast';
import { CallCompiler } from './callCompiler';
import { type FunctionContext, linkEscapeSource, linkTemporary, markReturned, type VarEntity } from './entities';
import { equalityOf } from './equality';
import { describeMissingMethod } from './expressionCompiler';
import { runesOf } from './literals';
import { dynamicMethod, invokeMethod, receiverFor } from './methods';
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
  withTemporary,
} from './runtime';
import { nilPointerPanic, panicNilValue } from './runtimeErrors';
import { runtimePrint } from './runtimePrint';
import { sizeOf } from './sliceOps';
import type { SliceTracking } from './slicePass';
import { clobberMemory, define, joining, storeLocalMemory } from './ssaValues';
import {
  ANY,
  BASIC,
  coreType,
  defaultType,
  describeType,
  type FuncType,
  identical,
  isBoolean,
  isFloat,
  isInteger,
  isInterface,
  isString,
  isUntyped,
  missingMethod,
  type Type,
  typeIdentityKey,
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
  writeInPlace,
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
    (this.fn as FunctionContext).inlineCost++;
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
    const { result: target, run } = this.hoistingCalls(() => this.expression(statement.operand));
    if (this.isInvalid(target)) return () => {};
    if (!this.isAssignable(target, statement.operand)) return () => {};
    target.variable?.markUsed();
    countWrite(target);
    this.defineTarget(target, { type: target.type, ssaConstant: target.ssaConstant });
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
        run(frame, () => update(frame, (value) => apply(value, one(frame))));
        return;
      },
      false
    );
  }

  /** Reads and writes a target once, evaluating its operands once, for `x++` and `x op= y`. */
  private updater(target: Operand, syntax: Expression): (frame: Frame, change: (value: Value) => Value) => void {
    if (target.mapUpdate) return target.mapUpdate;
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
    const compiled: Operand[] = [];
    const {
      result: [targets, values],
      run,
    } = this.hoistingCalls(() => {
      const compiledTargets = left.map((target) => this.assignmentTarget(target));
      if (left.length === 1 && right.length === 1) this.markInPlaceAppend(left[0], right[0], compiledTargets[0]);
      const typeOf = (index: number): Type | undefined => compiledTargets[index]?.type;
      const localAt = (index: number): VarEntity | 'discard' | undefined => {
        const inner = stripParens(left[index]);
        if (inner.kind === 'name' && inner.name === '_') return 'discard';
        const target = compiledTargets[index];
        // A field or array element of a local variable holds what the variable holds, as Go's escape analysis sees it.
        return inner.kind === 'name' ? target?.variable?.entity : target?.ssaRoot;
      };
      return [
        compiledTargets,
        this.rightSide(statement, right, left.length, typeOf, undefined, compiled, localAt),
      ] as const;
    });
    for (const [index, target] of targets.entries()) this.defineTarget(target, compiled[index], values, index);
    for (const [index, target] of left.entries()) {
      this.sliceAssignment(target, right.length === left.length ? right[index] : undefined);
    }
    if (!values) return () => {};
    const prepareFor = (index: number): ((frame: Frame) => (value: Value) => void) => {
      const target = targets[index];
      if (!target || this.isInvalid(target)) return () => () => {};
      if (target.prepareStore) return target.prepareStore;
      const store = target.store as NonNullable<Operand['store']>;
      return (frame) => (value) => store(frame, value);
    };
    const prepares = values.map((_, index) => prepareFor(index));
    // The right side's values, then every destination's operands, then the stores in order, each checking its own
    // destination, as Go's compiler orders an assignment after the calls.
    const exec: Exec = (frame) => {
      run(frame, () => {
        const evaluated = evaluateAll(frame, values);
        const writers = prepares.map((prepare) => prepare(frame));
        for (const [index, write] of writers.entries()) write(evaluated[index]);
      });
      return;
    };
    const createsObjects = right.length === left.length && right.every((value) => this.createsObject(value));
    return this.withStep(statement, exec, createsObjects);
  }

  /**
   * `s = v` for a tracked slice variable s, which the slice optimization pass understands when v is nil, a slice
   * literal, `s[i:j]`, or `append(s, ...)`.
   */
  private sliceAssignment(target: Expression, value: Expression | undefined): void {
    const tracking = this.sliceUseOf(target)?.tracking;
    if (!tracking || !value) return;
    const inner = stripParens(value);
    const isTarget = (syntax: Expression | undefined): boolean =>
      syntax !== undefined && this.sliceUseOf(syntax)?.tracking === tracking;
    const callee = inner.kind === 'call' ? stripParens(inner.callee) : undefined;
    if (inner.kind === 'name' && inner.name === 'nil') {
      this.understandSlice(target);
    } else if (inner.kind === 'composite') {
      this.understandSlice(target);
      tracking.capReads.push(() => true);
    } else if (inner.kind === 'slice' && isTarget(inner.operand)) {
      this.understandSlice(target);
      this.understandSlice(inner.operand);
      tracking.capReads.push(() => true);
    } else if (
      inner.kind === 'call' &&
      callee?.kind === 'name' &&
      callee.name === 'append' &&
      isTarget(inner.args[0])
    ) {
      this.understandSlice(target);
      this.understandSlice(inner.args[0]);
      tracking.appendWeight += 1 + (this.fn as FunctionContext).loopDepth - tracking.declDepth;
    }
  }

  /** Records `x = append(x, ...)`, which Go's compiler compiles as an update of x in memory unless x can be in registers. */
  private markInPlaceAppend(target: Expression, value: Expression, compiled: Operand | undefined): void {
    const inner = stripParens(value);
    if (inner.kind !== 'call' || !compiled || !sameSafeExpression(target, inner.args[0])) return;
    const callee = stripParens(inner.callee);
    if (callee.kind !== 'name' || this.lookup(callee.name)?.kind !== 'builtin' || callee.name !== 'append') return;
    const root = compiled.ssaRoot;
    this.inPlaceAppends.set(inner, () => !root || root.addressTaken === true || !fitsRegisters(root.type));
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
  protected rightSide(
    span: Span,
    right: Expression[],
    count: number,
    typeOf: (index: number) => Type | undefined,
    defineTypes?: Type[],
    /** Receives the operand of each value when there is one value per target. */
    compiled?: Operand[],
    targetLocal?: (index: number) => VarEntity | 'discard' | undefined
  ): Eval[] | undefined {
    const convert = (operand: Operand, index: number): Eval => {
      const local = targetLocal?.(index);
      const type = typeOf(index);
      if (type) {
        const assignTarget = local === 'discard' ? this.discardTarget(span) : local;
        return this.assign(operand, type, '変数', assignTarget);
      }
      const value = this.asValue(operand);
      if (local === 'discard') {
        // Assigning to `_` evaluates and discards without escaping the operand.
      } else if (local && local.owner !== undefined) {
        this.recordLocalEscapeAlias(value, local);
      } else {
        this.escapeOperand(value);
      }
      if (value.type === BASIC.untypedNil && !defineTypes) return value.eval;
      const defaulted = this.defaulted(value);
      if (defineTypes) defineTypes[index] = defaulted.type;
      if (isInterface(defaulted.type) || !isValueKind(defaulted.type)) return defaulted.eval;
      const read = defaulted.eval;
      return (frame) => copyValue(read(frame));
    };
    if (right.length === count) {
      return right.map((expression, index) => {
        const expressionOperand = this.expression(expression);
        if (compiled) compiled[index] = expressionOperand;
        // Assigning or returning a slice variable lets its array be shared, unless it converts to an interface.
        const target = typeOf(index);
        const operand =
          target && isInterface(target) ? expressionOperand : this.sliceTransition(expression, expressionOperand);
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
      const operand = this.expression(right[0]);
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

  private discardTarget(span: Span): VarEntity {
    return this.hiddenVariable('_', span);
  }

  private resultHolder(): VarEntity {
    const holder = this.hiddenVariable();
    markReturned(holder);
    return holder;
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
    // Go reads the destination after the calls on both sides, so the right side's calls may change it.
    const {
      result: [target, value],
      run,
    } = this.hoistingCalls(() => [this.expression(left[0]), this.expression(right[0])] as const);
    if (this.isInvalid(target) || !this.isAssignable(target, left[0])) return () => {};
    target.variable?.markUsed();
    countWrite(target);
    const current: Operand = { ...target, mode: 'value', eval: (frame) => frame.temporaries.at(-1) as Value };
    const combined = this.binaryOfOperands(statement, operator, current, value);
    if (this.isInvalid(combined)) return () => {};
    this.defineTarget(target, combined);
    const result = this.assign(combined, target.type, '変数');
    const update = this.updater(target, left[0]);
    return this.withStep(
      statement,
      (frame) => {
        run(frame, () =>
          update(frame, (currentValue) => withTemporary(frame, currentValue, () => result(frame) as Value))
        );
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
    const types: Type[] = [];
    const compiled: Operand[] = [];
    const holders = names.map(({ name, span }, index): VarEntity | 'discard' => {
      if (name === '_') return 'discard';
      const current = existing[index];
      if (current?.kind === 'var') return current;
      return this.discardTarget(span);
    });
    const values = this.rightSide(
      statement,
      right,
      left.length,
      (index) => {
        const entity = existing[index];
        return entity?.kind === 'var' ? entity.type : undefined;
      },
      types,
      compiled,
      (index) => holders[index]
    );
    if (!values) {
      for (const [index, { name, span }] of names.entries())
        if (!existing[index] && name !== '_') this.declareLocal(name, BASIC.invalid, span).used = true;
      return () => {};
    }
    const prepares: ((frame: Frame) => (value: Value) => void)[] = names.map(({ name, span }, index) => {
      const entity = existing[index];
      if (name === '_') return () => () => {};
      if (entity) {
        if (entity.kind !== 'var') {
          this.error(span, `${name} は変数ではないので代入できません。`);
          return () => () => {};
        }
        const operand = this.variableOperand(entity, span);
        countWrite(operand);
        this.defineTarget(operand, compiled[index], values, index);
        if (entity.owner === this.fn) untrackSlice(entity);
        return operand.prepareStore ?? ((frame) => (value) => operand.store?.(frame, value));
      }
      const type = types[index] ?? BASIC.invalid;
      if (isUntyped(type)) this.error(span, `${name} の型を決められません（nil には型がありません）。`);
      const variable = this.declareLocal(name, type, span);
      sliceDeclaration(variable, right.length === left.length ? right[index] : undefined);
      const holder = holders[index];
      if (holder !== 'discard') transferEscapeLinks(holder, variable);
      this.defineFromValue(variable, compiled[index], values, index);
      return (frame) => (value) => declareValue(frame, variable, value);
    });
    const exec: Exec = (frame) => {
      const writers = prepares.map((prepare) => prepare(frame));
      const evaluated = evaluateAll(frame, values);
      for (const [index, write] of writers.entries()) write(evaluated[index]);
      return;
    };
    const createsObjects = right.length === left.length && right.every((value) => this.createsObject(value));
    return this.withStep(statement, exec, createsObjects);
  }

  /** Records a write of an assignment's target: a definition of a variable Go's SSA form tracks, else a store. */
  private defineTarget(
    target: Operand | undefined,
    value: Pick<Operand, 'type' | 'product' | 'ssaConstant'> | undefined,
    values?: Eval[],
    index = 0
  ): void {
    if (!target) return;
    if (target.ssaVariable) this.defineFromValue(target.ssaVariable, value, values, index);
    else if (target.ssaRoot && !target.ssaRoot.boxed) storeLocalMemory(this.fn);
    else clobberMemory(this.fn);
  }

  /**
   * Lets the uses a definition of a variable reaches see the value as Go's SSA form does: as a constant when the
   * value is one, and for a float product as the multiplication, keeping the factors in hidden slots so that an
   * addition using the variable fuses it, as Go's compiler does on arm64.
   */
  private defineFromValue(
    variable: VarEntity,
    operand: Pick<Operand, 'type' | 'product' | 'ssaConstant'> | undefined,
    values: Eval[] | undefined,
    index: number
  ): void {
    const product = operand?.product;
    if (
      !operand ||
      !values ||
      !product ||
      !isFloat(operand.type) ||
      isUntyped(operand.type) ||
      operand.type !== variable.type
    ) {
      define(this.fn, variable, { constant: operand?.ssaConstant });
      return;
    }
    const left = this.hiddenSlot();
    const right = this.hiddenSlot();
    const multiply = arithmetic('*', operand.type);
    values[index] = (frame) => {
      const x = product.left(frame);
      const y = product.right(frame);
      frame.locals[left] = x;
      frame.locals[right] = y;
      return multiply(x, y);
    };
    define(this.fn, variable, {
      constant: operand.ssaConstant,
      factors: { left, right, source: product.source, enabled: product.enabled },
    });
  }

  // code-gauge-allow functionCognitiveComplexity 20 -- var declarations with and without types and values.
  protected varDeclaration(declaration: VarDeclaration): Exec {
    const parts: Exec[] = [];
    for (const spec of declaration.specs) {
      const declaredType = spec.type ? this.resolveType(spec.type) : undefined;
      if (spec.values.length === 0) {
        const zero: () => Value = declaredType ? this.zeroOf(declaredType) : () => {};
        const variables = spec.names.map((name) => this.declareLocal(name.name, declaredType ?? BASIC.invalid, name));
        for (const variable of variables) define(this.fn, variable, { constant: () => true });
        parts.push((frame) => {
          for (const variable of variables) declareValue(frame, variable, zero());
          return;
        });
        continue;
      }
      const types: Type[] = [];
      const compiled: Operand[] = [];
      const holders = spec.names.map((name): VarEntity | 'discard' =>
        name.name === '_' ? 'discard' : this.discardTarget(name)
      );
      const values = this.rightSide(
        spec,
        spec.values,
        spec.names.length,
        () => declaredType,
        types,
        compiled,
        (index) => holders[index]
      );
      const variables = spec.names.map((name, index) => {
        const type = declaredType ?? types[index] ?? BASIC.invalid;
        if (isUntyped(type)) this.error(name, `${name.name} の型を決められません（nil には型がありません）。`);
        const variable = this.declareLocal(name.name, type, name);
        sliceDeclaration(variable, spec.values.length === spec.names.length ? spec.values[index] : undefined);
        const holder = holders[index];
        if (holder !== 'discard') transferEscapeLinks(holder, variable);
        this.defineFromValue(variable, compiled[index], values, index);
        return variable;
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
    const { alternative } = statement;
    const [consequence, otherwise] = joining(this.fn, false, (branch) => {
      const then = this.block(statement.consequence);
      branch();
      if (!alternative) return [then, undefined];
      return [
        then,
        'statements' in alternative ? this.block(alternative) : this.scoped(() => this.ifStatement(alternative)),
      ];
    });
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
    const initExec =
      statement.init && statement.init.kind !== 'empty' ? this.simpleStatementWithoutStep(statement.init) : undefined;
    const loopVariables = [...this.scope.entities.values()].filter(
      (entity): entity is VarEntity => entity.kind === 'var'
    );
    const [condition, body, post] = joining(
      this.fn,
      true,
      () =>
        [
          statement.condition ? this.condition(statement.condition, 'for 文') : () => true,
          this.loopBody(statement.body),
          statement.post && statement.post.kind !== 'empty'
            ? this.simpleStatementWithoutStep(statement.post)
            : undefined,
        ] as const
    );
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
        reboxLoopVariables(frame, loopVariables);
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
    const { result: ranged, hasRuntimeCall } = this.withRuntimeCallTracking(() => this.value(statement.range));
    // The loop keeps the slice's array, which lets it be shared.
    const range = this.sliceTransition(statement.range, ranged);
    const source = this.isInvalid(range) ? undefined : this.rangeSource(statement, range, hasRuntimeCall);
    if (!source) {
      this.declareRangeTargets(statement, BASIC.invalid, BASIC.invalid);
      this.loopBody(statement.body);
      return () => {};
    }
    const { read, keyType, valueType, iterate } = source;
    const [bind, body] = joining(
      this.fn,
      true,
      () => [this.rangeTargets(statement, keyType, valueType), this.loopBody(statement.body)] as const
    );
    const row = this.stepRow(statement);
    const storesAnswer = bind.answered;
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
    range: Operand,
    hasRuntimeCall: boolean
  ): { read: Eval; keyType: Type; valueType: Type; iterate: RangeIterator } | undefined {
    const type = coreType(range.type) ?? range.type;
    const read = range.eval;
    const arrayType = type.kind === 'pointer' ? underlying(type.element) : type;
    const value = statement.value && stripParens(statement.value);
    if (arrayType.kind === 'array' && (!value || (value.kind === 'name' && value.name === '_'))) {
      // With at most one iteration variable, the length of an array type is constant, so Go evaluates the range
      // expression only for its calls and never reads or dereferences the array.
      const { length } = arrayType;
      return {
        read: hasRuntimeCall ? (frame) => void read(frame) : () => {},
        keyType: BASIC.int,
        valueType: arrayType.element,
        iterate: (_, visit) => iterateIndices(length, visit),
      };
    }
    if (type.kind === 'pointer' && arrayType.kind === 'array') {
      return {
        read: (frame) => dereferenceArray(read(frame)),
        keyType: BASIC.int,
        valueType: arrayType.element,
        iterate: iterateArray,
      };
    }
    if (isString(type)) return { read, keyType: BASIC.int, valueType: BASIC.int32, iterate: iterateString };
    if (type.kind === 'array') {
      return {
        read: (frame) => copyValue(read(frame)),
        keyType: BASIC.int,
        valueType: type.element,
        iterate: iterateArray,
      };
    }
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
    const prepares = targets.map((target, index): ((frame: Frame) => (value: Value) => void) | undefined => {
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
        untrackSlice(variable);
        const copy = isValueKind(type);
        return (frame) => (value) => declareValue(frame, variable, copy ? copyValue(value) : value);
      }
      const operand = this.assignmentTarget(target);
      this.defineTarget(operand, undefined);
      if (!operand || this.isInvalid(operand)) return undefined;
      const localTarget = stripParens(target).kind === 'name' ? operand.variable?.entity : undefined;
      const convert = this.assign(
        { mode: 'value', type, span: target, eval: (frame) => frame.temporaries.at(-1) as Value },
        operand.type,
        '変数',
        localTarget
      );
      const prepare = operand.prepareStore ?? ((frame: Frame) => (value: Value) => operand.store?.(frame, value));
      return (frame) => {
        const write = prepare(frame);
        return (value) => {
          frame.temporaries.push(value);
          try {
            write(convert(frame));
          } finally {
            frame.temporaries.pop();
          }
        };
      };
    });
    const [prepareKey, prepareValue] = prepares;
    return {
      answered,
      assign: (frame, key, value) => {
        const writeKey = prepareKey?.(frame);
        const writeValue = prepareValue?.(frame);
        writeKey?.(key);
        writeValue?.(value);
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
    const cases = joining(fn, false, (branch) =>
      statement.cases.map((switchCase, index) => {
        branch(statement.cases[index - 1]?.body.at(-1)?.kind === 'fallthrough');
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
      })
    );
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

  // code-gauge-allow functionCognitiveComplexity 30 -- Case values, untyped conversions, and duplicate constant checks.
  private caseTest(
    expression: Expression,
    tag: Operand | undefined,
    tagType: Type,
    seen: Map<string, Span>
  ): (frame: Frame, value: Value) => boolean {
    let operand = this.value(expression);
    if (this.isInvalid(operand) || tagType === BASIC.invalid) return () => false;
    if (!tag) {
      if (operand.resolveUntyped) {
        operand = operand.resolveUntyped(BASIC.bool);
        if (this.isInvalid(operand)) return () => false;
      }
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
    const concreteType = isInterface(tagType)
      ? isUntyped(operand.type)
        ? defaultType(operand.type)
        : operand.type
      : tagType;
    if (isUntyped(operand.type)) {
      const read = this.assign(operand, tagType, 'case の値');
      if (operand.mode === 'constant' && operand.constant) {
        const rep = represent(operand.constant, concreteType);
        operand = {
          ...operand,
          type: tagType,
          constant: 'constant' in rep ? rep.constant : undefined,
          eval: read,
        };
      } else {
        operand = { ...operand, mode: 'value', type: tagType, eval: read };
      }
    }
    if (!identical(operand.type, tagType) && !isInterface(tagType) && !isInterface(operand.type)) {
      const allowed = !StatementCompiler.assignFailure(operand.type, tagType);
      if (!allowed) {
        this.error(
          expression,
          `case の値の型 ${describeType(operand.type)} が、switch の値の型 ${describeType(tagType)} と違います。`
        );
        return () => false;
      }
    } else if (
      isInterface(tagType) &&
      !isInterface(operand.type) &&
      StatementCompiler.assignFailure(operand.type, tagType)
    ) {
      this.error(
        expression,
        `case の値の型 ${describeType(operand.type)} が、switch の値の型 ${describeType(tagType)} と違います。`
      );
      return () => false;
    }
    if (operand.mode === 'constant' && operand.constant) {
      const key = constantIdentityKey(operand.constant, concreteType);
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
    const seenTypes = new Set<string>();
    const cases = joining(this.fn, false, (branch) =>
      statement.cases.map((typeCase) => {
        branch();
        return this.typeSwitchCase(statement, typeCase, operand.type, bindings, seenTypes);
      })
    );
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
  // code-gauge-allow functionCognitiveComplexity 25 -- Type switch clause checking including duplicate types and nil.
  private typeSwitchCase(
    statement: Extract<Statement, { kind: 'typeSwitch' }>,
    typeCase: Extract<Statement, { kind: 'typeSwitch' }>['cases'][number],
    operandType: Type,
    bindings: VarEntity[],
    seenTypes: Set<string>
  ): {
    matched: (value: Value) => boolean;
    body: Exec;
    binding?: VarEntity;
    extract: (value: Value) => Value;
    isDefault: boolean;
  } {
    const types = (typeCase.types ?? []).map((syntax) => {
      if (!syntax) {
        if (seenTypes.has('nil')) this.error(typeCase, '型の switch に nil が2回書かれています。');
        seenTypes.add('nil');
        return;
      }
      const resolved = this.resolveType(syntax);
      if (resolved !== BASIC.invalid) {
        const key = typeIdentityKey(resolved);
        if (seenTypes.has(key)) this.error(syntax, `型の switch に ${describeType(resolved)} が2回書かれています。`);
        seenTypes.add(key);
        const operandInterface = underlying(operandType);
        const missing =
          !isInterface(resolved) && operandInterface.kind === 'interface'
            ? missingMethod(resolved, operandInterface)
            : undefined;
        if (missing) {
          this.error(
            syntax,
            `${describeType(resolved)} 型は ${describeType(operandType)} を実装していないので、この case には決して当てはまりません${describeMissingMethod(resolved, missing)}。`
          );
        }
      }
      return resolved;
    });
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
          untrackSlice(binding);
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
      if (!fn.hasNamedResults) return () => RETURN;
      this.checkShadowedResults(statement);
      const moves = fn.resultVariables.flatMap((variable) =>
        variable?.slice ? [this.namedResultTransition(variable, variable.slice)] : []
      );
      return (frame) => {
        for (const move of moves) move(frame);
        return RETURN;
      };
    }
    if (results.length === 0) {
      for (const result of statement.results) this.expression(result);
      this.error(statement, '結果を返さない関数の return 文には、値を書けません。');
      return () => RETURN;
    }
    const holder = (fn.resultHolder ??= this.resultHolder());
    const values = this.rightSide(
      statement,
      statement.results,
      results.length,
      (index) => results[index],
      undefined,
      undefined,
      () => holder
    );
    if (!values) return () => RETURN;
    const slots = fn.info.resultSlots;
    return (frame) => {
      const evaluated = evaluateAll(frame, values);
      for (const [index, slot] of slots.entries()) {
        const current = frame.locals[slot];
        if (current instanceof Cell) current.v = writeInPlace(current.v, evaluated[index]);
        else frame.locals[slot] = writeInPlace(current as Value, evaluated[index]);
      }
      return RETURN;
    };
  }

  /**
   * A bare return of a tracked slice result, which lets its array be shared as `return s` does, unless Go's compiler
   * inlines the function, where the result variable becomes the caller's.
   */
  private namedResultTransition(variable: VarEntity, tracking: SliceTracking): (frame: Frame) => void {
    const fn = this.fn as FunctionContext;
    const applies = (): boolean => !fn.summary?.inlinable();
    tracking.transitions.push({ loopDepth: fn.loopDepth, applies });
    const move = this.moveSliceToHeap(variable.type, tracking, applies);
    const operand = this.variableOperand(variable, variable.span);
    const read = operand.eval;
    const store = operand.store as NonNullable<Operand['store']>;
    return (frame) => {
      const value = read(frame);
      const moved = move(frame, value);
      if (moved !== value) store(frame, moved);
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

  // code-gauge-allow functionCognitiveComplexity 30 -- Deferred calls of functions, generic functions, methods, and builtins.
  private deferStatement(statement: Extract<Statement, { kind: 'defer' }>): Exec {
    (this.fn as FunctionContext).notInlinable = true;
    const call = stripParens(statement.call);
    if (call.kind !== 'call') {
      this.expression(statement.call);
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
      for (const arg of call.args) this.expression(arg);
      this.error(statement, 'defer には関数の呼び出しを書いてください（型の変換は書けません）。');
      return () => {};
    }
    if (callee.mode === 'method') return this.deferMethod(call, callee, row);
    const value = this.asValue(callee);
    if (this.isInvalid(value)) {
      for (const arg of call.args) this.expression(arg);
      return () => {};
    }
    const signature = coreType(value.type);
    if (signature?.kind !== 'func' || value.func?.generic) {
      if (value.func?.generic) {
        const prepared = this.prepareGenericCall(call, value.func);
        if (!prepared || !prepared.instance) return () => {};
        const { instance, args } = prepared;
        return (frame) => {
          const argValues = args(frame);
          frame.runtime.defer(frame, () => void instance.call(argValues, row, frame), [instance, ...argValues]);
          return;
        };
      }
      for (const arg of call.args) this.expression(arg);
      this.error(statement, `${describeType(value.type)} 型の値は関数ではないので、defer で呼び出せません。`);
      return () => {};
    }
    const args = this.callArguments(call, signature);
    if (!args) return () => {};
    const readFunction = value.eval;
    return (frame) => {
      const fn = readFunction(frame);
      const argValues = withTemporary(frame, fn, () => args(frame));
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
      const read = this.embeddedReceiver(receiver, selection.path);
      const name = selection.method.name;
      return (frame) => {
        const iface = read(frame) as { type: Type; value: Value } | undefined;
        const argValues = withTemporary(frame, iface, () => args(frame));
        if (!iface) nilPointerPanic();
        frame.runtime.defer(frame, () => {
          const target = dynamicMethod(iface.type, name);
          target?.(iface.value, argValues, row, frame);
        }, [iface, ...argValues]);
        return;
      };
    }
    const { method, path } = selection;
    const pointer = method.pointerReceiver ? this.pointerReceiver(call, receiver, path) : undefined;
    if (method.pointerReceiver && !pointer) return () => {};
    const storage = this.receiverStorage(receiver, path, method.pointerReceiver);
    if (storage) this.escapeOperand(storage);
    const read = receiver.eval;
    const viaPointer = underlying(receiver.type).kind === 'pointer';
    return (frame) => {
      const value = pointer ? pointer(frame) : receiverFor(read(frame), path, method, viaPointer);
      const argValues = withTemporary(frame, value, () => args(frame));
      frame.runtime.defer(frame, () => void invokeMethod(method, value, argValues, row, frame), [value, ...argValues]);
      return;
    };
  }

  private deferBuiltin(statement: Span, call: Extract<Expression, { kind: 'call' }>, name: string): Exec {
    if (name === 'panic') {
      const values = call.args.map((arg) => this.assign(this.expression(arg), ANY, '引数'));
      if (values.length !== 1) this.error(call, 'panic の引数の数が合いません。');
      return (frame) => {
        const evaluated = evaluateAll(frame, values);
        frame.runtime.defer(
          frame,
          () => {
            throw new GoPanic(evaluated[0] ?? panicNilValue());
          },
          evaluated
        );
        return;
      };
    }
    if (name === 'print' || name === 'println') {
      const operands = call.args.map((arg) => this.defaulted(this.value(arg)));
      const values = operands.map((operand) => operand.eval);
      const types = operands.map((operand) => operand.type);
      const line = name === 'println';
      return (frame) => {
        const evaluated = evaluateAll(frame, values);
        frame.runtime.defer(
          frame,
          () => {
            const texts = evaluated.map((value, index) => runtimePrint(value, types[index]));
            frame.runtime.writeStderr(line ? `${texts.join(' ')}\n` : texts.join(''));
          },
          evaluated
        );
        return;
      };
    }
    if (name === 'recover') {
      if (call.args.length > 0) {
        this.error(call, 'recover の引数の数が合いません。');
        for (const arg of call.args) this.expression(arg);
        return () => {};
      }
      // A recover that the deferred mechanism calls directly is not called by a deferred function, so it stops nothing.
      return (frame) => {
        frame.runtime.defer(frame, () => {}, []);
        return;
      };
    }
    for (const arg of call.args) this.expression(arg);
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
    const outerInAllocatedSlice = this.inAllocatedSlice;
    const fn = this.newFunctionContext(name, outer, () => {});
    fn.info.isAtomic = isAtomic;
    if (outer && !outer.recordsSteps) fn.recordsSteps = false;
    this.fn = fn;
    this.inAllocatedSlice = false;
    try {
      this.withScope(() => {
        if (receiver) {
          const variable = this.declareLocal(receiver.name ?? '_', receiver.type, receiver.span, true);
          variable.used = true;
          fn.params.push(variable);
        }
        for (const [index, parameter] of signature.parameters.entries()) {
          fn.params.push(this.declareParameter(parameter, type.params[index]));
        }
        for (const [index, param] of fn.params.entries())
          define(fn, param, { constant: (frame) => frame?.constantParam(index) ?? false });
        fn.info.params.push(...fn.params);
        fn.results = type.results;
        fn.hasNamedResults = signature.results.some((result) => result.name !== undefined);
        const zeros = type.results.map((result) => this.zeroOf(result));
        for (const [index, result] of signature.results.entries()) {
          if (result.name !== undefined) {
            const variable = this.declareLocal(result.name, type.results[index], result);
            variable.used = true;
            define(fn, variable, { constant: () => true });
            markReturned(variable);
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
        if (type.results.length > 0 && !isTerminatingList(body.statements, this.builtinPanicCalls)) {
          this.error(
            { row: body.endRow, column: 0 },
            'return 文がありません（結果を返す関数は return 文か panic で終わらせてください）。'
          );
        }
      });
    } finally {
      this.fn = outer;
      this.inAllocatedSlice = outerInAllocatedSlice;
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
      // The closure refers to the variables it captures, which escape with it.
      backingVars: [...fn.captures.keys()],
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

/** Gives each iteration its own cell for loop variables that closures or pointers share. */
function reboxLoopVariables(frame: Frame, loopVariables: VarEntity[]): void {
  for (const variable of loopVariables) {
    if (variable.boxed) frame.locals[variable.slot] = new Cell(copyValue(readLocal(frame, variable.slot)));
  }
}

function dereferenceArray(pointer: Value): Value {
  if (!(pointer instanceof Pointer)) nilPointerPanic();
  return pointer.load();
}

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

function iterateIndices(length: number, visit: RangeVisit): Completion | undefined {
  for (let index = 0; index < length; index++) {
    const result = visit(BigInt(index), undefined);
    if (result) return result;
  }
  return undefined;
}

/** Visits an array's elements (`range a` passes a copy of the array; `range &a` passes the live array). */
function iterateArray(collection: Value, visit: RangeVisit): Completion | undefined {
  for (const [index, value] of (collection as GoArray).elements.entries()) {
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

/**
 * `s := v` or `var s = v` for a tracked slice variable s, which the slice optimization pass understands when v is nil or
 * a slice literal.
 */
function sliceDeclaration(variable: VarEntity, value: Expression | undefined): void {
  const inner = value && stripParens(value);
  if (inner?.kind === 'composite') variable.slice?.capReads.push(() => true);
  else if (inner?.kind !== 'name' || inner.name !== 'nil') untrackSlice(variable);
}

/** Makes Go's slice optimization pass give up on a variable, for a use it does not understand. */
function untrackSlice(variable: VarEntity): void {
  variable.slice?.uses.push({});
}

function transferEscapeLinks(from: VarEntity, to: VarEntity): void {
  if (from.escapeSources) {
    for (const source of from.escapeSources) linkEscapeSource(source, to);
  }
  if (from.temporaries) {
    for (const temporary of from.temporaries) linkTemporary(temporary, to);
  }
}

/** Records a store into an element as a write of its array. */
function countWrite(target: Operand): void {
  target.onWrite?.();
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
export function isTerminatingList(statements: Statement[], panics: WeakSet<Expression>): boolean {
  const last = statements.toReversed().find((statement) => statement.kind !== 'empty');
  return last !== undefined && isTerminating(last, panics);
}

// code-gauge-allow functionCognitiveComplexity 20 -- The terminating statements of the specification.
function isTerminating(statement: Statement, panics: WeakSet<Expression>): boolean {
  switch (statement.kind) {
    case 'return': {
      return true;
    }
    case 'expression': {
      return panics.has(stripParens(statement.expression));
    }
    case 'block': {
      return isTerminatingList(statement.block.statements, panics);
    }
    case 'if': {
      if (!statement.alternative) return false;
      const otherwise =
        'statements' in statement.alternative
          ? isTerminatingList(statement.alternative.statements, panics)
          : isTerminating(statement.alternative, panics);
      return isTerminatingList(statement.consequence.statements, panics) && otherwise;
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
          return !hasBreak(body) && (last?.kind === 'fallthrough' || isTerminatingList(body, panics));
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

/** Go's ir.SameSafeExpr: whether two expressions denote the same value without calls or other side effects. */
function sameSafeExpression(a: Expression | undefined, b: Expression | undefined): boolean {
  if (!a || !b) return false;
  const x = stripParens(a);
  const y = stripParens(b);
  switch (x.kind) {
    case 'name': {
      return y.kind === 'name' && x.name === y.name;
    }
    case 'selector': {
      return y.kind === 'selector' && x.field === y.field && sameSafeExpression(x.operand, y.operand);
    }
    case 'unary': {
      return (
        y.kind === 'unary' &&
        x.operator === y.operator &&
        x.operator !== '&' &&
        x.operator !== '<-' &&
        sameSafeExpression(x.operand, y.operand)
      );
    }
    case 'index': {
      return (
        y.kind === 'index' &&
        x.indices.length === 1 &&
        y.indices.length === 1 &&
        sameSafeExpression(x.operand, y.operand) &&
        sameSafeExpression(x.indices[0], y.indices[0])
      );
    }
    case 'binary': {
      return (
        y.kind === 'binary' &&
        x.operator === y.operator &&
        ARITHMETIC_OPERATORS.has(x.operator) &&
        sameSafeExpression(x.left, y.left) &&
        sameSafeExpression(x.right, y.right)
      );
    }
    case 'int':
    case 'float':
    case 'imaginary': {
      return y.kind === x.kind && x.text === (y as typeof x).text;
    }
    case 'rune':
    case 'string': {
      return y.kind === x.kind && x.value === (y as typeof x).value;
    }
    default: {
      return false;
    }
  }
}

const ARITHMETIC_OPERATORS = new Set(['+', '-', '|', '^', '*', '<<', '>>', '&', '&^', '/', '%']);

/** Go's ssa.CanSSA: whether its compiler can keep a value of the type in registers. */
function fitsRegisters(type: Type): boolean {
  const size = sizeOf(type);
  if (size === 0) return true;
  if (size > 32) return false;
  const under = underlying(type);
  if (under.kind === 'array') return under.length <= 1 && fitsRegisters(under.element);
  if (under.kind === 'struct')
    return under.fields.length <= 4 && under.fields.every((field) => fitsRegisters(field.type));
  return true;
}
