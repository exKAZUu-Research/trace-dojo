// code-gauge-allow-file fileNcss 900 -- One method per kind of Kotlin statement and control structure.
import type {
  AssignmentStatement,
  Block,
  DestructuringDecl,
  DoWhileStatement,
  Expression,
  ForStatement,
  PropertyDecl,
  Statement,
  WhenCondition,
  WhileStatement,
} from './ast';
import type { ArgumentSyntax } from './callCompiler';
import {
  type Compiled,
  convertRepr,
  type Eval,
  Flow,
  type FunctionContext,
  Handoff,
  type LoopContext,
  type Repr,
  reprOf,
  Scope,
  typeMismatchMessage,
} from './compilerBase';
import { getPropertyValue, setPropertyValue } from './dispatch';
import { type BoundPlace, ExpressionCompiler, keyOf, type Place } from './expressionCompiler';
import { valueEquals } from './format';
import { type Frame, KotlinThrow, LoopSignal, UNASSIGNED } from './runtime';
import { type ClassSymbol, type PropertySymbol, type TypeParameterSymbol, VariableSymbol } from './symbols';
import { instanceTest } from './typeChecks';
import { commonSupertype, isSubtype } from './typeRelations';
import { type ClassType, type KType, nonNull, NOTHING, resolved, substitute, typeToString } from './types';
import { Boxed, type KObject, NULL, UNIT, type Value } from './values';

type Exec = (frame: Frame) => void;

/** Learners answer the values of primitive types and strings, so a loop variable of those records a step. */
const ANSWERED_CLASSES = new Set([
  'Int',
  'Long',
  'Short',
  'Byte',
  'Double',
  'Float',
  'Char',
  'Boolean',
  'String',
  'UInt',
  'ULong',
  'UShort',
  'UByte',
]);

export abstract class StatementCompiler extends ExpressionCompiler {
  /** Records the step of a statement after it runs, as `StepTracker.runStatement` says. */
  protected withStep(row: number, exec: Exec, onlyCalls: boolean): Exec {
    if (!this.recordsSteps || this.file.isLibrary) return exec;
    return (frame) => frame.runtime.steps.runStatement(row, onlyCalls, () => exec(frame));
  }

  /** Whether learners write down the value of a variable of the type, for the step rules of loop variables. */
  protected isAnswered(type: KType): boolean {
    const actual = resolved(type);
    return actual.kind === 'class' && ANSWERED_CLASSES.has(actual.cls.name) && actual.cls.isLibrary;
  }

  compileBlockValue(
    scope: Scope,
    context: FunctionContext,
    block: Block,
    expected: KType | undefined,
    asStatement: boolean
  ): Compiled {
    return this.compileStatementsValue(
      new Scope(scope, context),
      context,
      block.statements,
      expected,
      asStatement,
      true
    );
  }

  /**
   * Compiles statements whose last one, when it is an expression, gives their value.
   *
   * @param clearsLocals Function bodies keep their locals so that a trace can report `main`'s final variables.
   */
  protected compileStatementsValue(
    scope: Scope,
    context: FunctionContext,
    statements: Statement[],
    expected: KType | undefined,
    asStatement: boolean,
    clearsLocals: boolean
  ): Compiled {
    const firstSlot = context.info.slotCount;
    const execs: Exec[] = [];
    let last: Compiled | undefined;
    for (const [index, statement] of statements.entries()) {
      const isLast = index === statements.length - 1;
      if (isLast && !asStatement && statement.kind === 'expressionStatement') {
        last = this.compileValueStatement(scope, context, statement, expected);
      } else {
        execs.push(this.compileStatement(scope, context, statement));
      }
    }
    const lastSlot = context.info.slotCount;
    const value = last ?? { type: this.unitType, repr: 'ref' as const, eval: () => UNIT };
    const lastEval = value.eval;
    const clears = clearsLocals && lastSlot > firstSlot;
    const run: Eval =
      execs.length === 0 && !clears
        ? lastEval
        : (frame) => {
            try {
              for (const exec of execs) exec(frame);
              return lastEval(frame);
            } finally {
              if (clears) for (let slot = firstSlot; slot < lastSlot; slot++) frame.locals[slot] = UNASSIGNED;
            }
          };
    return { ...value, eval: run, isCall: false, isCreation: false, stableKey: undefined, constant: undefined };
  }

  /** Compiles the last statement of a block whose value is used, recording its step as an expression statement. */
  private compileValueStatement(
    scope: Scope,
    context: FunctionContext,
    statement: Extract<Statement, { kind: 'expressionStatement' }>,
    expected: KType | undefined
  ): Compiled {
    const compiled = this.compileExpression(scope, context, statement.expression, expected);
    if (!this.recordsStepOf(statement.expression)) return compiled;
    const { eval: evaluate } = compiled;
    const onlyCalls = compiled.isCall === true || compiled.isCreation === true;
    const { row } = statement;
    if (!this.recordsSteps || this.file.isLibrary) return compiled;
    return { ...compiled, eval: (frame) => frame.runtime.steps.runStatement(row, onlyCalls, () => evaluate(frame)) };
  }

  /** Whether an expression statement records a step: `if`, `when`, `try`, and jumps record none, as Java's do not. */
  private recordsStepOf(expression: Expression): boolean {
    return !['if', 'when', 'try', 'return', 'throw', 'break', 'continue', 'lambda'].includes(expression.kind);
  }

  // code-gauge-allow functionCognitiveComplexity 20 -- One case per kind of statement.
  protected compileStatement(scope: Scope, context: FunctionContext, statement: Statement): Exec {
    const exec = this.compileStatementBody(scope, context, statement);
    return (frame) => {
      frame.runtime.spend();
      exec(frame);
    };
  }

  private compileStatementBody(scope: Scope, context: FunctionContext, statement: Statement): Exec {
    switch (statement.kind) {
      case 'property': {
        return this.compileLocalProperty(scope, context, statement);
      }
      case 'destructuring': {
        return this.compileDestructuring(scope, context, statement);
      }
      case 'assignment': {
        return this.compileAssignment(scope, context, statement);
      }
      case 'for': {
        return this.compileFor(scope, context, statement);
      }
      case 'while': {
        return this.compileWhile(scope, context, statement);
      }
      case 'doWhile': {
        return this.compileDoWhile(scope, context, statement);
      }
      case 'expressionStatement': {
        const compiled = this.compileForEffect(scope, context, statement.expression);
        const evaluate = compiled.eval;
        const exec: Exec = (frame) => {
          evaluate(frame);
        };
        if (!this.recordsStepOf(statement.expression)) return exec;
        return this.withStep(statement.row, exec, compiled.isCall === true || compiled.isCreation === true);
      }
      case 'function':
      case 'class': {
        return this.unavailable(
          statement.row,
          statement.kind === 'function' ? '関数の中での関数の宣言' : '関数の中でのクラスの宣言'
        );
      }
    }
  }

  // Declarations.

  private compileLocalProperty(scope: Scope, context: FunctionContext, statement: PropertyDecl): Exec {
    const { row, name } = statement;
    if (statement.getter || statement.setter) this.error(row, 'ローカル変数には get・set を書けません。');
    const declared = statement.type ? this.resolveType(scope, statement.type) : undefined;
    if (statement.delegate) return this.compileLocalDelegate(scope, context, statement, declared);
    if (!statement.initializer) {
      if (!declared) this.error(row, `変数 ${name} の型を書くか、初期値を書いてください。`);
      this.newVariable(scope, context, name, declared, statement.isVar, row);
      return () => {};
    }
    const initializer = this.compileExpression(scope, context, statement.initializer, declared);
    const type = declared ?? this.inferredVariableType(initializer, row, name);
    const value = this.expectType(initializer, type, statement.initializer.row);
    const variable = this.newVariable(scope, context, name, type, statement.isVar, row);
    this.flow.assigned.add(variable);
    this.flow.maybeAssigned.add(variable);
    const write = this.variableAccess(context, variable).write;
    return this.withStep(
      row,
      (frame) => {
        write(frame, value(frame));
      },
      initializer.isCreation === true
    );
  }

  /** The type of a variable declared without one, which `null` alone cannot give. */
  private inferredVariableType(initializer: Compiled, row: number, name: string): KType {
    const type = resolved(initializer.type);
    if (type.kind === 'nothing' && type.nullable)
      this.error(row, `変数 ${name} の型を決められません。型を書いてください。`);
    if (initializer.integerLiteral) return this.primitiveType(this.primitiveOf(type) ?? 'Int');
    return type;
  }

  private compileLocalDelegate(
    scope: Scope,
    context: FunctionContext,
    statement: PropertyDecl,
    declared: KType | undefined
  ): Exec {
    const { row, name } = statement;
    const delegate = this.compileExpression(scope, context, statement.delegate as Expression);
    const holder = this.newVariable(scope, context, `\0${name}`, delegate.type, false, row, false);
    scope.variables.delete(`\0${name}`);
    this.flow.assigned.add(holder);
    const delegateCompiled: Compiled = {
      type: delegate.type,
      repr: delegate.repr,
      eval: this.variableAccess(context, holder).read,
    };
    const property = this.propertyReference(scope, name, row);
    const getter = this.compileDelegateCall(
      scope,
      context,
      delegateCompiled,
      'getValue',
      [this.nullArgument(row), property],
      row
    );
    const type = declared ?? getter.type;
    if (declared && !isSubtype(getter.type, declared)) this.error(row, typeMismatchMessage(declared, getter.type));
    const variable = new VariableSymbol(name, type, statement.isVar, 0, holder.slot, row);
    variable.owner = context;
    variable.delegateRead = convertRepr(getter.eval, getter.repr, reprOf(this.core, type));
    scope.variables.set(name, variable);
    this.flow.assigned.add(variable);
    const write = this.variableAccess(context, holder).write;
    const evaluate = delegate.eval;
    return this.withStep(row, (frame) => write(frame, evaluate(frame)), delegate.isCreation === true);
  }

  /** A `null` argument, as delegated local variables pass for the object that holds them. */
  private nullArgument(row: number): ArgumentSyntax {
    return { row, name: undefined, value: { kind: 'null', row } };
  }

  /** The `KProperty` argument of a delegate's `getValue` and `setValue`, as a name the compiler understands. */
  protected abstract propertyReference(scope: Scope, name: string, row: number): ArgumentSyntax;

  protected compileDelegateCall(
    scope: Scope,
    context: FunctionContext,
    delegate: Compiled,
    name: string,
    args: ArgumentSyntax[],
    row: number
  ): Compiled {
    return this.compileOperatorCall(scope, context, delegate, name, args, row, `by（${name}）`);
  }

  private compileDestructuring(scope: Scope, context: FunctionContext, statement: DestructuringDecl): Exec {
    const { row } = statement;
    const initializer = this.compileExpression(scope, context, statement.initializer);
    const holder = this.newVariable(scope, context, '\0destructured', initializer.type, false, row, false);
    scope.variables.delete('\0destructured');
    this.flow.assigned.add(holder);
    const holderCompiled: Compiled = {
      type: initializer.type,
      repr: initializer.repr,
      eval: this.variableAccess(context, holder).read,
    };
    const parts = statement.names.map((part, index) => {
      if (!part) return;
      const component = this.compileOperatorCall(
        scope,
        context,
        holderCompiled,
        `component${index + 1}`,
        [],
        row,
        `分解宣言の ${index + 1} 番目`
      );
      const declared = part.type ? this.resolveType(scope, part.type) : undefined;
      const type = declared ?? component.type;
      const value = this.expectType(component, type, row);
      return { name: part.name, type, value, row: part.row };
    });
    const writes = parts.map((part) => {
      if (!part) return;
      const variable = this.newVariable(scope, context, part.name, part.type, statement.isVar, part.row);
      this.flow.assigned.add(variable);
      const { write } = this.variableAccess(context, variable);
      const { value } = part;
      return (frame: Frame) => write(frame, value(frame));
    });
    const holderWrite = this.variableAccess(context, holder).write;
    const evaluate = initializer.eval;
    return this.withStep(
      row,
      (frame) => {
        holderWrite(frame, evaluate(frame));
        for (const write of writes) write?.(frame);
      },
      false
    );
  }

  // Assignments.

  private compileAssignment(scope: Scope, context: FunctionContext, statement: AssignmentStatement): Exec {
    const { operator, row, target } = statement;
    if (operator === '=') {
      const place = this.compilePlace(scope, context, target, row, false);
      const value = this.compileExpression(scope, context, statement.value, place.type);
      const converted = this.expectType(value, place.type, statement.value.row);
      const toPlace = convertRepr(converted, reprOf(this.core, place.type), place.repr);
      this.narrowAfterAssignment(scope, target, value.type, place.type);
      return this.withStep(
        row,
        (frame) => {
          const bound = place.bind(frame);
          bound.set(toPlace(frame));
        },
        value.isCreation === true
      );
    }
    return this.withStep(row, this.compileCompoundAssignment(scope, context, statement), false);
  }

  /** `x += y` and the like: `plusAssign` when the target's type has one, else `x = x + y`. */
  private compileCompoundAssignment(scope: Scope, context: FunctionContext, statement: AssignmentStatement): Exec {
    const { operator, row, target } = statement;
    const operation = operator.slice(0, -1) as '+' | '-' | '*' | '/' | '%';
    const assignName = ASSIGN_OPERATORS[operation];
    const targetValue = this.peekType(scope, context, target);
    if (targetValue && !this.primitiveOf(targetValue)) {
      const receiver = this.compileExpression(scope, context, target);
      const members = this.memberCandidates(nonNull(receiver.type), assignName).filter(
        (candidate) => candidate.symbol.isOperator
      );
      const extensions = this.extensionCandidates(receiver.type, assignName).filter(
        (candidate) => candidate.symbol.isOperator
      );
      if (members.length + extensions.length > 0) {
        if (this.isAssignableVar(scope, target) && this.hasOperator(receiver.type, OPERATOR_FUNCTION[operation])) {
          this.error(
            row,
            `${operator} が ${assignName} と ${OPERATOR_FUNCTION[operation]} のどちらのことか決められません。val にするか、x = x ${operation} y と書いてください。`
          );
        }
        const args: ArgumentSyntax[] = [{ row: statement.value.row, name: undefined, value: statement.value }];
        const call = this.compileOperatorCall(scope, context, receiver, assignName, args, row, operator);
        const evaluate = call.eval;
        return (frame) => {
          evaluate(frame);
        };
      }
    }
    const place = this.compilePlace(scope, context, target, row, true);
    const current = new Handoff<BoundPlace>();
    const currentHolder: Compiled = { type: place.type, repr: place.repr, eval: () => current.get().get() };
    const combined = this.compileArithmeticWith(scope, context, operation, currentHolder, statement.value, row);
    const converted = this.expectType(combined, place.type, row);
    const toPlace = convertRepr(converted, reprOf(this.core, place.type), place.repr);
    return (frame) => {
      const bound = place.bind(frame);
      const value = current.run(frame, bound, () => toPlace(frame));
      bound.set(value);
    };
  }

  private hasOperator(type: KType, name: string): boolean {
    return (
      this.memberCandidates(nonNull(type), name).some((candidate) => candidate.symbol.isOperator) ||
      this.extensionCandidates(type, name).some((candidate) => candidate.symbol.isOperator)
    );
  }

  private isAssignableVar(scope: Scope, target: Expression): boolean {
    if (target.kind === 'name') {
      const variable = this.findVariable(scope, target.name);
      if (variable) return variable.isVar;
      for (const receiver of this.receiversOf(scope)) {
        const property = this.findProperty(scope, this.receiverTypeOf(receiver), target.name);
        if (property) return property.symbol.isVar;
      }
      return this.topLevelProperties(target.name)[0]?.[0]?.isVar ?? false;
    }
    if (target.kind === 'member') {
      return false;
    }
    return false;
  }

  /** The type of an assignment's target, without compiling it, for choosing between `plusAssign` and `plus`. */
  private peekType(scope: Scope, context: FunctionContext, target: Expression): KType | undefined {
    const saved = this.flow.copy();
    try {
      return this.compileExpression(scope, this.probeContext(context), target).type;
    } catch {
      return undefined;
    } finally {
      this.flow = saved;
    }
  }

  /** After `x = value`, a stable `x` has the value's type, which may be narrower than its declared one. */
  private narrowAfterAssignment(scope: Scope, target: Expression, valueType: KType, declared: KType): void {
    if (target.kind !== 'name') return;
    const variable = this.findVariable(scope, target.name);
    if (!variable) return;
    const key = keyOf(variable);
    if (isSubtype(valueType, declared) && !isSubtype(declared, valueType) && resolved(valueType).kind !== 'nothing') {
      this.flow.narrowed.set(key, valueType);
    } else {
      this.flow.narrowed.delete(key);
    }
  }

  // code-gauge-allow functionCognitiveComplexity 35 -- One case per kind of assignable place.
  compilePlace(scope: Scope, context: FunctionContext, target: Expression, row: number, isCompound: boolean): Place {
    if (target.kind === 'parenthesized') return this.compilePlace(scope, context, target.expression, row, isCompound);
    if (target.kind === 'name') {
      const variable = this.findVariable(scope, target.name);
      if (variable) return this.variablePlace(context, variable, row, isCompound);
      for (const receiver of this.receiversOf(scope)) {
        const property = this.findProperty(scope, this.receiverTypeOf(receiver), target.name);
        if (property)
          return this.propertyPlace(
            property,
            {
              type: receiver.type,
              repr: reprOf(this.core, receiver.type),
              eval: this.receiverAccess(context, receiver),
            },
            row,
            scope
          );
      }
      const companion = this.findCompanionProperty(scope, target.name);
      if (companion) {
        const holder: Compiled = {
          type: companion.holder.type,
          repr: 'ref',
          eval: this.objectInstance(companion.holder),
        };
        return this.propertyPlace(companion.property, holder, row, scope);
      }
      const property = this.topLevelProperties(target.name)[0]?.find((candidate) => !candidate.extensionReceiver);
      if (property) return this.propertyPlace({ symbol: property, substitution: new Map() }, undefined, row, scope);
      return this.error(row, `${target.name} が見つかりません。`);
    }
    if (target.kind === 'member') {
      const qualified = this.compileQualifier(scope, target.receiver);
      if (qualified?.kind === 'class') {
        const holder = qualified.cls.isObject ? qualified.cls : qualified.cls.companion;
        const property = holder ? this.findProperty(scope, holder.type, target.name) : undefined;
        if (!property || !holder) return this.error(row, `${qualified.cls.name}.${target.name} が見つかりません。`);
        return this.propertyPlace(
          property,
          { type: holder.type, repr: 'ref', eval: this.objectInstance(holder) },
          row,
          scope
        );
      }
      if (target.isSafe) this.unavailable(row, '?. を使った代入');
      const receiver = this.compileExpression(scope, context, target.receiver);
      this.requireNonNullReceiver(receiver, row, false);
      const property = this.findProperty(scope, receiver.type, target.name);
      if (!property)
        return this.error(row, `${typeToString(resolved(receiver.type))} には ${target.name} がありません。`);
      return this.propertyPlace(property, receiver, row, scope);
    }
    if (target.kind === 'index') return this.indexPlace(scope, context, target, row, isCompound);
    return this.error(row, 'ここには代入できません。');
  }

  private variablePlace(context: FunctionContext, variable: VariableSymbol, row: number, isCompound: boolean): Place {
    const { delegateRead, delegateWrite } = variable;
    if (delegateRead) {
      if (!delegateWrite) return this.unavailable(row, '委譲したローカル変数への代入');
      return {
        type: variable.type,
        repr: reprOf(this.core, variable.type),
        bind: (frame) => ({ get: () => delegateRead(frame), set: (value) => delegateWrite(frame, value) }),
      };
    }
    const isAssigned = this.flow.assigned.has(variable);
    if (isCompound && !isAssigned) this.error(row, `変数 ${variable.name} に値が入っていません。`);
    if (!variable.isVar) {
      if (this.flow.maybeAssigned.has(variable) || isCompound)
        this.error(row, `val で宣言した ${variable.name} には、再び代入できません。`);
      if (variable.owner !== context)
        this.error(row, `val で宣言した ${variable.name} には、ラムダ式の中で代入できません。`);
      if (context.loops.some((loop) => loop.outerVals.has(variable)))
        this.error(row, `val で宣言した ${variable.name} には、ループの中で代入できません。`);
    }
    if (variable.owner !== context) {
      for (
        let current: FunctionContext | undefined = context;
        current && current !== variable.owner;
        current = current.parent
      ) {
        current.assignedCaptures.add(variable);
      }
      variable.isCapturedAndModified = true;
    }
    this.flow.assigned.add(variable);
    this.flow.maybeAssigned.add(variable);
    const access = this.variableAccess(context, variable);
    return {
      type: variable.type,
      repr: reprOf(this.core, variable.type),
      bind: (frame) => ({ get: () => access.read(frame), set: (value) => access.write(frame, value) }),
    };
  }

  private propertyPlace(
    member: {
      symbol: PropertySymbol;
      substitution: Map<TypeParameterSymbol, KType> | ReadonlyMap<TypeParameterSymbol, KType>;
    },
    receiver: Compiled | undefined,
    row: number,
    scope: Scope
  ): Place {
    const { symbol } = member;
    const type = resolved(substitute(this.ensurePropertyType(symbol, row), member.substitution));
    if (!symbol.isVar && !this.mayInitializeVal(scope, symbol))
      this.error(row, `val で宣言した ${symbol.name} には、再び代入できません。`);
    this.checkAccessible(scope, symbol, row);
    if (symbol.isVar && symbol.setterVisibility === 'private' && !this.isInsideClass(scope, symbol.owner)) {
      this.error(row, `${symbol.name} の set は private なので、クラスの外からは代入できません。`);
    }
    const receiverEval: Eval = receiver ? convertRepr(receiver.eval, receiver.repr, 'ref') : () => NULL;
    const repr = this.propertyReprOf(symbol);
    return {
      type,
      repr,
      bind: (frame) => {
        const target = receiverEval(frame);
        return {
          get: () => getPropertyValue(symbol, frame, target),
          set: (value) => setPropertyValue(symbol, frame, target, value),
        };
      },
    };
  }

  protected abstract propertyReprOf(symbol: PropertySymbol): Repr;

  protected abstract nothing(): KType;

  /** Whether a `val` property may be assigned here: in its class's `init` block, once, before it is read. */
  protected abstract mayInitializeVal(scope: Scope, symbol: PropertySymbol): boolean;

  protected isInsideClass(scope: Scope, cls: ClassSymbol | undefined): boolean {
    return this.receiversOf(scope).some((receiver) => receiver.cls !== undefined && receiver.cls === cls);
  }

  /**
   * `a[i]` as a place: `set` stores into it, and for a compound assignment `get` reads it. The receiver and indexes
   * are evaluated once and held, where the compiled `get` and `set` calls read them.
   */
  private indexPlace(
    scope: Scope,
    context: FunctionContext,
    target: Extract<Expression, { kind: 'index' }>,
    row: number,
    isCompound: boolean
  ): Place {
    const receiver = this.compileExpression(scope, context, target.receiver);
    const indexValues = target.indices.map((index) => this.compileExpression(scope, context, index));
    const handoff = new Handoff<HeldIndex>();
    const held = (): HeldIndex => handoff.get();
    const receiverHolder: Compiled = { type: receiver.type, repr: receiver.repr, eval: () => held().receiver };
    const indexScope = new Scope(scope, context);
    const heldName = (name: string, type: KType, read: (frame: Frame) => Value): ArgumentSyntax => {
      const variable = new VariableSymbol(name, type, false, 0, -1, row);
      variable.owner = context;
      variable.delegateRead = read;
      indexScope.variables.set(name, variable);
      this.flow.assigned.add(variable);
      return { row, name: undefined, value: { kind: 'name', row, name } };
    };
    const indexArgs = indexValues.map((compiled, index) =>
      heldName(`\0index${index}`, compiled.type, () => held().indexes[index])
    );
    // A value of type Nothing fits any `set`, whose parameter then gives the type the place stores.
    const valueArg = heldName('\0assigned', this.nothing(), () => held().value);
    const setter = this.resolveOperator(
      indexScope,
      context,
      receiverHolder,
      'set',
      [...indexArgs, valueArg],
      row,
      '[]='
    );
    const valueParam = setter.call.symbol.params.at(-1);
    if (!valueParam) return this.error(row, 'ここには代入できません。');
    const substitution = new Map([...setter.call.candidate.substitution, ...setter.call.typeArguments]);
    const type = resolved(substitute(valueParam.type, substitution));
    const repr = reprOf(this.core, type);
    const setEval = setter.compiled.eval;
    let getEval: Eval | undefined;
    if (isCompound) {
      const getter = this.compileOperatorCall(indexScope, context, receiverHolder, 'get', indexArgs, row, '[]');
      if (!isSubtype(getter.type, type)) this.error(row, typeMismatchMessage(type, getter.type));
      getEval = convertRepr(getter.eval, getter.repr, repr);
    }
    const receiverEval = receiver.eval;
    const indexEvals = indexValues.map((compiled) => this.convertTo(compiled, compiled.type, row));
    return {
      type,
      repr,
      bind: (frame) => {
        const state: HeldIndex = { receiver: receiverEval(frame), indexes: [], value: undefined };
        for (const evaluate of indexEvals) state.indexes.push(evaluate(frame));
        const run = (evaluate: Eval): Value => handoff.run(frame, state, () => evaluate(frame));
        return {
          get: () => run(getEval as Eval),
          set: (value) => {
            state.value = value;
            run(setEval);
          },
        };
      },
    };
  }

  // Loops.

  private newLoop(context: FunctionContext, scope: Scope): LoopContext {
    const outerVals = new Set<VariableSymbol>();
    for (let current: Scope | undefined = scope; current; current = current.parent) {
      for (const variable of current.variables.values()) if (!variable.isVar) outerVals.add(variable);
    }
    return { identity: {}, outerVals, hasBreak: false };
  }

  /** Forgets the smart casts of the variables a loop assigns, since another iteration may have changed them. */
  private forgetAssignedIn(scope: Scope, statements: Statement[] | Expression): void {
    for (const name of assignedNames(statements)) {
      const variable = this.findVariable(scope, name);
      if (variable) this.flow.narrowed.delete(keyOf(variable));
    }
  }

  private runLoopBody(loop: LoopContext, body: Exec, frame: Frame): 'break' | undefined {
    try {
      body(frame);
    } catch (error) {
      if (error instanceof LoopSignal && error.loop === loop.identity) return error.isBreak ? 'break' : undefined;
      throw error;
    }
    return undefined;
  }

  private compileLoopBody(
    scope: Scope,
    context: FunctionContext,
    loop: LoopContext,
    body: Block,
    bodyScope?: Scope
  ): Exec {
    context.loops.push(loop);
    try {
      const compiled = this.compileStatementsValue(
        bodyScope ?? new Scope(scope, context),
        context,
        body.statements,
        undefined,
        true,
        true
      );
      const evaluate = compiled.eval;
      return (frame) => {
        evaluate(frame);
      };
    } finally {
      context.loops.pop();
    }
  }

  private compileWhile(scope: Scope, context: FunctionContext, statement: WhileStatement): Exec {
    this.forgetAssignedIn(scope, [...statement.body.statements]);
    this.forgetAssignedIn(scope, statement.condition);
    const before = this.flow.copy();
    const condition = this.compileCondition(scope, context, statement.condition);
    const afterCondition = this.flow.copy();
    this.applyNarrowing(condition.whenTrue);
    const loop = this.newLoop(context, scope);
    const body = this.compileLoopBody(scope, context, loop, statement.body);
    const isInfinite = condition.compiled.constant === true;
    this.flow = this.withNarrowing(afterCondition, condition.whenFalse);
    this.flow.isDead = isInfinite && !loop.hasBreak;
    this.flow.assigned.clear();
    for (const variable of before.assigned) this.flow.assigned.add(variable);
    const test = condition.compiled.eval;
    return (frame) => {
      while (test(frame) as boolean) {
        frame.runtime.spend();
        if (this.runLoopBody(loop, body, frame) === 'break') return;
      }
    };
  }

  private compileDoWhile(scope: Scope, context: FunctionContext, statement: DoWhileStatement): Exec {
    this.forgetAssignedIn(scope, [...statement.body.statements]);
    const loop = this.newLoop(context, scope);
    // The condition sees the body's variables, as Kotlin's scoping of do-while does.
    const bodyScope = new Scope(scope, context);
    context.loops.push(loop);
    let bodyEval: Eval;
    let test: Eval;
    const firstSlot = context.info.slotCount;
    try {
      for (const name of assignedNames([...statement.body.statements])) void name;
      const compiled = this.compileStatementsValue(
        bodyScope,
        context,
        statement.body.statements,
        undefined,
        true,
        false
      );
      bodyEval = compiled.eval;
    } finally {
      context.loops.pop();
    }
    const condition = this.compileCondition(bodyScope, context, statement.condition);
    test = condition.compiled.eval;
    const lastSlot = context.info.slotCount;
    this.applyNarrowing(condition.whenFalse);
    const body: Exec = (frame) => {
      bodyEval(frame);
    };
    return (frame) => {
      try {
        do {
          frame.runtime.spend();
          if (this.runLoopBody(loop, body, frame) === 'break') return;
        } while (test(frame) as boolean);
      } finally {
        for (let slot = firstSlot; slot < lastSlot; slot++) frame.locals[slot] = UNASSIGNED;
      }
    };
  }

  // code-gauge-allow functionNcss 70 -- Ranges and progressions loop over numbers; the rest use iterators.
  private compileFor(scope: Scope, context: FunctionContext, statement: ForStatement): Exec {
    this.forgetAssignedIn(scope, [...statement.body.statements]);
    const iterable = this.compileExpression(scope, context, statement.iterable);
    const loopScope = new Scope(scope, context);
    const loop = this.newLoop(context, scope);
    const firstSlot = context.info.slotCount;
    const { variable } = statement;
    const progression = this.progressionOf(iterable.type);
    let elementType: KType;
    let next: (frame: Frame, state: LoopState) => boolean;
    let start: (frame: Frame, iterableValue: Value) => LoopState;
    if (progression) {
      elementType = this.primitiveType(progression);
      const isLong = progression === 'Long';
      start = (_, value) => {
        const object = value as KObject;
        const [first, last, stepValue] = object.fields as (number | bigint)[];
        return {
          current: first,
          last,
          step: stepValue,
          isDone: isLong
            ? stepValue > 0
              ? first > last
              : first < last
            : (stepValue as number) > 0
              ? (first as number) > (last as number)
              : (first as number) < (last as number),
          iterator: undefined,
        };
      };
      next = (_, state) => {
        if (state.isDone) return false;
        state.value = state.current;
        if (state.current === state.last) state.isDone = true;
        else
          state.current = isLong
            ? (state.current as bigint) + (state.step as bigint)
            : ((state.current as number) + (state.step as number)) & (progression === 'Char' ? 0xff_ff : -1);
        return true;
      };
    } else {
      const iterableHandoff = new Handoff<Value>();
      const stateHandoff = new Handoff<LoopState>();
      const iteratorCall = this.compileOperatorCall(
        loopScope,
        context,
        { ...iterable, eval: () => iterableHandoff.get() },
        'iterator',
        [],
        statement.row,
        'for の in'
      );
      const iteratorType = iteratorCall.type;
      const holderScope = new Scope(loopScope, context);
      const iteratorVariable = new VariableSymbol('\0iterator', iteratorType, false, 0, -1, statement.row);
      iteratorVariable.owner = context;
      iteratorVariable.delegateRead = () => stateHandoff.get().iterator;
      holderScope.variables.set(iteratorVariable.name, iteratorVariable);
      this.flow.assigned.add(iteratorVariable);
      const iteratorName: Expression = { kind: 'name', row: statement.row, name: '\0iterator' };
      const hasNext = this.compileExpression(holderScope, context, {
        kind: 'call',
        row: statement.row,
        callee: { kind: 'member', row: statement.row, receiver: iteratorName, name: 'hasNext', isSafe: false },
        typeArgs: [],
        args: [],
        trailingLambda: undefined,
      });
      const nextCall = this.compileExpression(holderScope, context, {
        kind: 'call',
        row: statement.row,
        callee: { kind: 'member', row: statement.row, receiver: iteratorName, name: 'next', isSafe: false },
        typeArgs: [],
        args: [],
        trailingLambda: undefined,
      });
      elementType = nextCall.type;
      const iteratorEval = iteratorCall.eval;
      const hasNextEval = convertRepr(hasNext.eval, hasNext.repr, 'ref');
      const nextEval = nextCall.eval;
      const elementRepr = nextCall.repr;
      void elementRepr;
      start = (frame, value) =>
        iterableHandoff.run(frame, value, () => ({
          current: 0,
          last: 0,
          step: 0,
          isDone: false,
          iterator: iteratorEval(frame),
        }));
      next = (frame, state) =>
        stateHandoff.run(frame, state, () => {
          if (!(hasNextEval(frame) as boolean)) return false;
          state.value = nextEval(frame);
          return true;
        });
      this.loopElementRepr = nextCall.repr;
    }
    const elementRepr = progression ?? this.loopElementRepr;
    const bind = this.compileLoopBinding(loopScope, context, variable, elementType, elementRepr, statement.row);
    const body = this.compileLoopBody(loopScope, context, loop, statement.body);
    const lastSlot = context.info.slotCount;
    const iterableEval = iterable.eval;
    return (frame) => {
      const value = iterableEval(frame);
      const mark = frame.temporaries.length;
      frame.temporaries.push(value);
      try {
        const state = start(frame, value);
        frame.temporaries.push(state as unknown as Value);
        while (next(frame, state)) {
          frame.runtime.spend();
          bind(frame, state.value);
          if (this.runLoopBody(loop, body, frame) === 'break') return;
        }
      } finally {
        frame.temporaries.length = mark;
        for (let slot = firstSlot; slot < lastSlot; slot++) frame.locals[slot] = UNASSIGNED;
      }
    };
  }

  private loopElementRepr: Repr = 'ref';

  /** The kind of the numbers a range or progression of the standard library steps through. */
  protected abstract progressionOf(type: KType): 'Int' | 'Long' | 'Char' | undefined;

  private compileLoopBinding(
    scope: Scope,
    context: FunctionContext,
    variable: ForStatement['variable'],
    elementType: KType,
    elementRepr: Repr,
    row: number
  ): (frame: Frame, value: Value) => void {
    const stepRow = this.recordsSteps && !this.file.isLibrary ? row : undefined;
    if ('name' in variable) {
      const declared = variable.type ? this.resolveType(scope, variable.type) : undefined;
      if (declared && !isSubtype(elementType, declared)) this.error(row, typeMismatchMessage(declared, elementType));
      const type = declared ?? elementType;
      const symbol = this.newVariable(scope, context, variable.name, type, false, variable.row, variable.name !== '_');
      if (variable.name === '_') scope.variables.delete('_');
      this.flow.assigned.add(symbol);
      const { write } = this.variableAccess(context, symbol);
      const element = new Handoff<Value>();
      const convert = convertRepr(() => element.get(), elementRepr, reprOf(this.core, type));
      const isAnswered = this.isAnswered(type);
      return (frame, value) => {
        element.run(frame, value, () => write(frame, convert(frame)));
        frame.runtime.steps.stepBinding(stepRow, isAnswered);
      };
    }
    const holder = this.newVariable(scope, context, '\0element', elementType, false, row, false);
    scope.variables.delete('\0element');
    this.flow.assigned.add(holder);
    const holderAccess = this.variableAccess(context, holder);
    const holderCompiled: Compiled = { type: elementType, repr: elementRepr, eval: holderAccess.read };
    const writes = variable.names.map((part, index) => {
      if (!part) return;
      const component = this.compileOperatorCall(
        scope,
        context,
        holderCompiled,
        `component${index + 1}`,
        [],
        row,
        `分解宣言の ${index + 1} 番目`
      );
      const declared = part.type ? this.resolveType(scope, part.type) : undefined;
      const type = declared ?? component.type;
      const value = this.expectType(component, type, row);
      const symbol = this.newVariable(scope, context, part.name, type, false, part.row);
      this.flow.assigned.add(symbol);
      const { write } = this.variableAccess(context, symbol);
      return (frame: Frame) => write(frame, value(frame));
    });
    return (frame, value) => {
      holderAccess.write(frame, value);
      for (const write of writes) write?.(frame);
      frame.runtime.steps.stepBinding(stepRow, true);
    };
  }

  // Control structures as expressions.

  protected compileIf(
    scope: Scope,
    context: FunctionContext,
    expression: Extract<Expression, { kind: 'if' }>,
    expected: KType | undefined,
    asStatement: boolean
  ): Compiled {
    const { row } = expression;
    if (!asStatement && !expression.elseBranch) this.error(row, 'if を式として使うときは、else も書いてください。');
    const condition = this.compileCondition(scope, context, expression.condition);
    const before = this.flow.copy();
    this.applyNarrowing(condition.whenTrue);
    const thenCompiled = this.compileBlockValue(scope, context, expression.thenBranch, expected, asStatement);
    const afterThen = this.flow;
    this.flow = this.withNarrowing(before, condition.whenFalse);
    const elseCompiled = expression.elseBranch
      ? this.compileBlockValue(scope, context, expression.elseBranch, expected, asStatement)
      : undefined;
    const afterElse = this.flow;
    this.flow = Flow.merge([afterThen, afterElse]);
    const branches = elseCompiled ? [thenCompiled, elseCompiled] : [thenCompiled];
    const type = asStatement ? this.unitType : this.branchType(branches, expected);
    const repr = asStatement ? 'ref' : reprOf(this.core, type);
    const [thenEval, elseEval] = branches.map((branch) =>
      asStatement ? branch.eval : convertRepr(this.convertTo(branch, type, row), reprOf(this.core, type), repr)
    );
    const test = condition.compiled.eval;
    if (asStatement && this.isConstantTrue(condition.compiled)) this.flow.isDead = afterThen.isDead;
    return {
      type,
      repr,
      eval: elseEval
        ? (frame) => ((test(frame) as boolean) ? thenEval(frame) : elseEval(frame))
        : (frame) => {
            if (test(frame) as boolean) thenEval(frame);
            return UNIT;
          },
    };
  }

  private isConstantTrue(compiled: Compiled): boolean {
    return compiled.constant === true;
  }

  /** The common type of the branches of an `if`, `when`, or `try` used as an expression. */
  private branchType(branches: Compiled[], expected: KType | undefined): KType {
    const types = branches.map((branch) =>
      branch.integerLiteral && expected
        ? this.acceptsArgument(branch, expected)
          ? expected
          : branch.type
        : branch.type
    );
    if (expected && types.every((type, index) => this.acceptsArgument({ ...branches[index], type }, expected))) {
      const common = commonSupertype(types);
      return isSubtype(common, expected) ? common : expected;
    }
    return commonSupertype(types);
  }

  // code-gauge-allow functionNcss 80 -- Subjects, conditions of three kinds, smart casts, and exhaustiveness.
  // code-gauge-allow functionCognitiveComplexity 40 -- Subjects, conditions of three kinds, smart casts, and exhaustiveness.
  protected compileWhen(
    scope: Scope,
    context: FunctionContext,
    expression: Extract<Expression, { kind: 'when' }>,
    expected: KType | undefined,
    asStatement: boolean
  ): Compiled {
    const { row } = expression;
    const subject = expression.subject ? this.compileExpression(scope, context, expression.subject) : undefined;
    const subjectSlot = subject ? context.allocate('\0subject', subject.type, false) : -1;
    const subjectValue: Compiled | undefined = subject && {
      type: subject.type,
      repr: subject.repr,
      eval: (frame) => frame.locals[subjectSlot] as Value,
      stableKey: subject.stableKey,
    };
    const before = this.flow.copy();
    const branchFlows: Flow[] = [];
    const entries: { tests: ((frame: Frame) => boolean)[]; body: Compiled }[] = [];
    const covered = new Set<string>();
    let hasElse = false;
    for (const entry of expression.entries) {
      if (entry.conditions.length === 0) {
        hasElse = true;
        const body = this.compileBlockValue(scope, context, entry.body, expected, asStatement);
        branchFlows.push(this.flow);
        entries.push({ tests: [], body });
        this.flow = this.flow.copy();
        continue;
      }
      const tests: ((frame: Frame) => boolean)[] = [];
      let whenTrue = new Map<string, KType>();
      let whenFalse = new Map<string, KType>();
      for (const condition of entry.conditions) {
        const compiled = this.compileWhenCondition(scope, context, subjectValue, condition, covered);
        tests.push(compiled.test);
        whenTrue = entry.conditions.length === 1 ? compiled.whenTrue : new Map();
        whenFalse = new Map([...whenFalse, ...compiled.whenFalse]);
      }
      const atEntry = this.flow.copy();
      this.applyNarrowing(whenTrue);
      const body = this.compileBlockValue(scope, context, entry.body, expected, asStatement);
      branchFlows.push(this.flow);
      entries.push({ tests, body });
      this.flow = this.withNarrowing(atEntry, entry.conditions.length === 1 ? whenFalse : new Map());
    }
    const isExhaustive = hasElse || (subject !== undefined && this.isExhaustive(subject.type, covered));
    const needsExhaustive = !asStatement || (subject !== undefined && this.isSealedLike(subject.type));
    if (needsExhaustive && !isExhaustive) {
      this.error(
        row,
        asStatement
          ? 'when の分岐が足りません。すべての場合か else を書いてください。'
          : 'when を式として使うときは、すべての場合か else を書いてください。'
      );
    }
    if (!isExhaustive) branchFlows.push(this.flow);
    this.flow = branchFlows.length > 0 ? Flow.merge(branchFlows) : before;
    const bodies = entries.map((entry) => entry.body);
    const type = asStatement ? this.unitType : bodies.length === 0 ? NOTHING : this.branchType(bodies, expected);
    const repr = asStatement ? 'ref' : reprOf(this.core, type);
    const compiledEntries = entries.map((entry) => ({
      tests: entry.tests,
      body: asStatement
        ? entry.body.eval
        : convertRepr(this.convertTo(entry.body, type, row), reprOf(this.core, type), repr),
    }));
    const subjectEval = subject?.eval;
    return {
      type,
      repr,
      eval: (frame) => {
        if (subjectEval) frame.locals[subjectSlot] = subjectEval(frame);
        try {
          for (const entry of compiledEntries) {
            if (entry.tests.length === 0 || entry.tests.some((test) => test(frame))) return entry.body(frame);
          }
          return UNIT;
        } finally {
          if (subjectEval) frame.locals[subjectSlot] = UNASSIGNED;
        }
      },
    };
  }

  // code-gauge-allow functionCognitiveComplexity 25 -- One case per kind of when condition.
  private compileWhenCondition(
    scope: Scope,
    context: FunctionContext,
    subject: Compiled | undefined,
    condition: WhenCondition,
    covered: Set<string>
  ): { test: (frame: Frame) => boolean; whenTrue: Map<string, KType>; whenFalse: Map<string, KType> } {
    if (!subject) {
      if (condition.kind !== 'expression')
        this.error(condition.row, '主語のない when には、is や in の条件を書けません。');
      const compiled = this.compileCondition(scope, context, condition.expression);
      const evaluate = compiled.compiled.eval;
      return {
        test: (frame) => evaluate(frame) as boolean,
        whenTrue: compiled.whenTrue,
        whenFalse: compiled.whenFalse,
      };
    }
    if (condition.kind === 'is') {
      const type = this.checkableType(scope, condition.type, condition.row, subject.type);
      const test = instanceTest(this.core, type);
      const evaluate = convertRepr(subject.eval, subject.repr, 'ref');
      const narrowing = new Map<string, KType>();
      if (subject.stableKey) narrowing.set(subject.stableKey, this.narrowedType(subject.type, type));
      const actual = resolved(type);
      if (!condition.negated && actual.kind === 'class') covered.add(`class:${keyOf(actual.cls)}`);
      if (!condition.negated && actual.kind === 'nothing') covered.add('null');
      return condition.negated
        ? { test: (frame) => !test(evaluate(frame)), whenTrue: new Map(), whenFalse: narrowing }
        : { test: (frame) => test(evaluate(frame)), whenTrue: narrowing, whenFalse: new Map() };
    }
    if (condition.kind === 'in') {
      const subjectName = '\0whenSubject';
      const conditionScope = new Scope(scope, context);
      const variable = new VariableSymbol(subjectName, subject.type, false, 0, -1, condition.row);
      variable.owner = context;
      variable.delegateRead = convertRepr(subject.eval, subject.repr, reprOf(this.core, subject.type));
      conditionScope.variables.set(subjectName, variable);
      this.flow.assigned.add(variable);
      const compiled = this.compileIn(
        conditionScope,
        context,
        { kind: 'name', row: condition.row, name: subjectName },
        condition.expression,
        condition.negated,
        condition.row
      );
      const evaluate = compiled.eval;
      return { test: (frame) => evaluate(frame) as boolean, whenTrue: new Map(), whenFalse: new Map() };
    }
    const value = this.compileExpression(scope, context, condition.expression, nonNull(subject.type));
    this.recordCovered(value, condition.expression, covered);
    const subjectEval = convertRepr(subject.eval, subject.repr, 'ref');
    const valueEval = convertRepr(
      this.convertTo(value, value.integerLiteral ? nonNull(subject.type) : value.type, condition.row),
      reprOf(this.core, value.integerLiteral ? nonNull(subject.type) : value.type),
      'ref'
    );
    const subjectKind = this.primitiveOf(nonNull(subject.type));
    if (subjectKind && !this.acceptsArgument(value, nonNull(subject.type)) && resolved(value.type).kind !== 'nothing') {
      this.error(
        condition.row,
        `演算子 == は ${typeToString(resolved(subject.type))} と ${typeToString(resolved(value.type))} には使えません。`
      );
    }
    const narrowing = new Map<string, KType>();
    if (resolved(value.type).kind === 'nothing' && subject.stableKey)
      narrowing.set(subject.stableKey, nonNull(subject.type));
    return {
      test: (frame) => {
        const a = subjectEval(frame);
        const b = valueEval(frame);
        if (a instanceof Boxed && b instanceof Boxed && subjectKind) return a.value === b.value;
        return valueEquals(frame, a, b);
      },
      whenTrue: new Map(),
      whenFalse: narrowing,
    };
  }

  /** Notes the constants a `when` branch covers: enum entries, objects, `true`, `false`, and `null`. */
  private recordCovered(value: Compiled, expression: Expression, covered: Set<string>): void {
    if (expression.kind === 'boolean') covered.add(String(expression.value));
    if (expression.kind === 'null') covered.add('null');
    if (value.stableKey && value.stableKey.includes('.')) covered.add(`entry:${value.stableKey}`);
    const type = resolved(value.type);
    if (type.kind === 'class' && type.cls.isObject && value.stableKey === keyOf(type.cls))
      covered.add(`class:${keyOf(type.cls)}`);
  }

  /** Whether a `when` statement on the subject must cover every case, as one on an enum, sealed type, or Boolean must. */
  private isSealedLike(type: KType): boolean {
    const actual = resolved(type);
    return (
      actual.kind === 'class' && (actual.cls.kind === 'enum' || actual.cls.isSealed || actual.cls === this.core.boolean)
    );
  }

  // code-gauge-allow functionCognitiveComplexity 20 -- Booleans, enums, sealed hierarchies, and null.
  private isExhaustive(type: KType, covered: Set<string>): boolean {
    const actual = resolved(type);
    if (actual.nullable && !covered.has('null')) return false;
    if (actual.kind !== 'class') return false;
    const coversClass = (cls: ClassSymbol): boolean => {
      if (covered.has(`class:${keyOf(cls)}`)) return true;
      if (cls.kind === 'enum')
        return cls.enumEntries.every((entry) => covered.has(`entry:${keyOf(cls)}.${entry.name}`));
      if (cls.isSealed) return cls.sealedSubclasses.length > 0 && cls.sealedSubclasses.every(coversClass);
      return false;
    };
    if (actual.cls === this.core.boolean) return covered.has('true') && covered.has('false');
    return coversClass(actual.cls);
  }

  // code-gauge-allow functionNcss 50 -- try, catch clauses, and finally, as an expression.
  protected compileTry(
    scope: Scope,
    context: FunctionContext,
    expression: Extract<Expression, { kind: 'try' }>,
    expected: KType | undefined,
    asStatement: boolean
  ): Compiled {
    const before = this.flow.copy();
    const body = this.compileBlockValue(scope, context, expression.body, expected, asStatement);
    const flows = [this.flow];
    const catches = expression.catches.map((clause) => {
      this.flow = before.copy();
      for (const variable of flows[0].maybeAssigned) this.flow.maybeAssigned.add(variable);
      const catchScope = new Scope(scope, context);
      const type = this.resolveType(scope, clause.type);
      if (!isSubtype(type, this.core.throwable.type))
        this.error(clause.row, typeMismatchMessage(this.core.throwable.type, type));
      const variable = this.newVariable(catchScope, context, clause.name, type, false, clause.row);
      this.flow.assigned.add(variable);
      const { write } = this.variableAccess(context, variable);
      const value = this.compileBlockValue(catchScope, context, clause.body, expected, asStatement);
      flows.push(this.flow);
      return { test: instanceTest(this.core, type), write, value, slot: variable.slot };
    });
    this.flow = Flow.merge(flows);
    let finallyEval: Eval | undefined;
    if (expression.finally) {
      const afterTry = this.flow;
      this.flow = Flow.merge([before, afterTry]);
      finallyEval = this.compileBlockValue(scope, context, expression.finally, undefined, true).eval;
      const afterFinally = this.flow;
      this.flow = afterTry;
      this.flow.isDead = afterTry.isDead || afterFinally.isDead;
    }
    const branches = [body, ...catches.map((clause) => clause.value)];
    const type = asStatement ? this.unitType : this.branchType(branches, expected);
    const repr = asStatement ? 'ref' : reprOf(this.core, type);
    const convert = (compiled: Compiled): Eval =>
      asStatement
        ? compiled.eval
        : convertRepr(this.convertTo(compiled, type, expression.row), reprOf(this.core, type), repr);
    const bodyEval = convert(body);
    const clauses = catches.map((clause) => ({ ...clause, value: convert(clause.value) }));
    return {
      type,
      repr,
      eval: (frame) => {
        try {
          return bodyEval(frame);
        } catch (error) {
          const thrown = throwableOf(frame, error);
          if (!thrown) throw error;
          const clause = clauses.find((candidate) => candidate.test(thrown));
          if (!clause) throw error instanceof KotlinThrow ? error : new KotlinThrow(thrown);
          clause.write(frame, thrown);
          try {
            return clause.value(frame);
          } finally {
            frame.locals[clause.slot] = UNASSIGNED;
          }
        } finally {
          finallyEval?.(frame);
        }
      },
    };
  }
}

/** The exception a `catch` sees: a Kotlin exception, or the host's stack overflow as `StackOverflowError`. */
function throwableOf(frame: Frame, error: unknown): KObject | undefined {
  if (error instanceof KotlinThrow) return error.value;
  if (error instanceof RangeError && /call stack/i.test(error.message)) {
    return frame.runtime.exceptions.create(frame, 'java.lang.StackOverflowError', undefined);
  }
  return undefined;
}

interface LoopState {
  current: number | bigint;
  last: number | bigint;
  step: number | bigint;
  isDone: boolean;
  iterator: Value;
  value?: Value;
}

interface HeldIndex {
  receiver: Value;
  indexes: Value[];
  value: Value;
}

const ASSIGN_OPERATORS = {
  '+': 'plusAssign',
  '-': 'minusAssign',
  '*': 'timesAssign',
  '/': 'divAssign',
  '%': 'remAssign',
} as const;
const OPERATOR_FUNCTION = { '+': 'plus', '-': 'minus', '*': 'times', '/': 'div', '%': 'rem' } as const;

/** The names that statements assign, which loops forget smart casts of. */
function assignedNames(node: unknown): Set<string> {
  const names = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    const record = value as Record<string, unknown>;
    if (record.kind === 'assignment' && (record.target as { kind?: string }).kind === 'name') {
      names.add((record.target as { name: string }).name);
    }
    if (
      (record.kind === 'prefix' || record.kind === 'postfix') &&
      (record.operand as { kind?: string }).kind === 'name'
    ) {
      names.add((record.operand as { name: string }).name);
    }
    for (const child of Object.values(record)) if (typeof child === 'object') visit(child);
  };
  visit(node);
  return names;
}

export type { ClassType };
