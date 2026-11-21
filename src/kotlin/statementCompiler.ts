// code-gauge-allow-file fileNcss 991 -- One method per kind of Kotlin statement and control structure.
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
import { isNullLiteral } from './ast';
import type { ArgumentSyntax } from './callCompiler';
import {
  type Compiled,
  convertRepr,
  type Eval,
  excludingCases,
  type ExpressionUse,
  Flow,
  type FunctionContext,
  Handoff,
  isBareCall,
  type LoopContext,
  type Repr,
  reprOf,
  Scope,
  typeMismatchMessage,
} from './compilerBase';
import { getPropertyValue, setPropertyValue } from './dispatch';
import { type BoundPlace, type Place } from './expressionCompiler';
import { caseOf, keyOf } from './flowKeys';
import { assignedNames, localRefinement, refineLocalType, remainingWrites } from './flowWrites';
import { valueEquals } from './format';
import { isExclusion, OperatorCompiler } from './operatorCompiler';
import { NUMBER_OPERATOR_NAMES } from './operators';
import { type Frame, KotlinThrow, LoopSignal, UNASSIGNED } from './runtime';
import { type ClassSymbol, PropertySymbol, type TypeParameterSymbol, VariableSymbol } from './symbols';
import { instanceTest } from './typeChecks';
import { branchHint, commonSupertype, isSubtype } from './typeRelations';
import { type ClassType, isNonNullClass, type KType, nonNull, resolved, substitute, typeToString } from './types';
import { Boxed, Cell, type KObject, NULL, type PrimitiveKind, UNIT, type Value } from './values';
import { WhenCoverage } from './whenCoverage';

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

export abstract class StatementCompiler extends OperatorCompiler {
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
    use: ExpressionUse
  ): Compiled {
    return this.compileStatementsValue(new Scope(scope, context), context, block.statements, expected, use, true);
  }

  /**
   * Compiles statements whose last one, when it is an expression, gives their value.
   *
   * @param clearsLocals Function bodies keep their locals so that a trace can report `main`'s final variables.
   */
  // code-gauge-allow functionCognitiveComplexity 19 -- statement compilation and execution both restore the block state when an exit interrupts them.
  protected compileStatementsValue(
    scope: Scope,
    context: FunctionContext,
    statements: Statement[],
    expected: KType | undefined,
    use: ExpressionUse,
    clearsLocals: boolean
  ): Compiled {
    const firstSlot = context.info.slotCount;
    const execs: Exec[] = [];
    let last: Compiled | undefined;
    const writes = scope.context?.info.isLibrary ? undefined : remainingWrites(statements);
    const prior = scope.pendingWrites;
    scope.pendingWrites = writes?.pending;
    try {
      for (const [index, statement] of statements.entries()) {
        writes?.advance(index);
        const isLast = index === statements.length - 1;
        if (isLast && use !== true && statement.kind === 'expressionStatement') {
          this.recordExceptionEntry(scope, context, statement);
          last = this.compileAny(scope, context, statement.expression, expected, use);
        } else {
          execs.push(this.compileStatement(scope, context, statement));
        }
      }
    } finally {
      scope.pendingWrites = prior;
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
    return {
      ...value,
      eval: run,
      isCall: false,
      isCreation: false,
      floatRangeBounds: undefined,
      stableKey: undefined,
      constant: undefined,
    };
  }

  /** Whether an expression statement records a step: `if`, `when`, `try`, and jumps record none, as Java's do not. */
  private recordsStepOf(expression: Expression): boolean {
    return !['if', 'when', 'try', 'return', 'throw', 'break', 'continue', 'lambda'].includes(expression.kind);
  }

  protected compileStatement(scope: Scope, context: FunctionContext, statement: Statement): Exec {
    this.recordExceptionEntry(scope, context, statement);
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
      const variable = this.newVariable(scope, context, name, declared, statement.isVar, row);
      variable.awaitsValue = !statement.isVar;
      return (frame) => {
        if (variable.isCell) frame.locals[variable.slot] = new Cell(undefined, false);
      };
    }
    const initializer = this.compileExpression(scope, context, statement.initializer, declared);
    // A `var` that a smart-cast value initializes takes the value's declared type, starting smart-cast, as kotlinc infers
    // it, so that `var c = head` may later hold `c.next`.
    const unnarrowed = statement.isVar && !declared ? initializer.unnarrowedType : undefined;
    const type = declared ?? this.inferredVariableType(unnarrowed ? { ...initializer, type: unnarrowed } : initializer);
    const value = this.expectType(initializer, type, statement.initializer.row);
    const variable = this.newVariable(scope, context, name, type, statement.isVar, row);
    this.flow.assigned.add(variable);
    this.flow.maybeAssigned.add(variable);
    if (unnarrowed) this.flow.narrowed.set(keyOf(variable), initializer.type);
    if (!declared) this.narrowToCase(keyOf(variable), initializer);
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
  private inferredVariableType(initializer: Compiled): KType {
    const type = resolved(initializer.type);
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
    const delegate = this.compileDelegateExpression(
      scope,
      context,
      statement.delegate as Expression,
      declared,
      statement.isVar
    );
    const holder = this.newVariable(scope, context, `\0${name}`, delegate.type, false, row, false);
    scope.variables.delete(`\0${name}`);
    this.flow.assigned.add(holder);
    const held = new Handoff<{ delegate: Value; value?: Value }>();
    const delegateCompiled: Compiled = { type: delegate.type, repr: delegate.repr, eval: () => held.get().delegate };
    const args = [this.nullArgument(row), this.propertyReference(scope, name, row)];
    const getter = this.compileDelegateCall(scope, context, delegateCompiled, 'getValue', args, row);
    const type = declared ?? getter.type;
    if (declared && !isSubtype(getter.type, declared)) this.error(row, typeMismatchMessage(declared, getter.type));
    const evaluateGet = convertRepr(getter.eval, getter.repr, reprOf(this.core, type));
    const setter = statement.isVar
      ? this.compileLocalDelegateSetter(scope, context, delegateCompiled, args, type, row, held)
      : undefined;
    const variable = new VariableSymbol(name, type, statement.isVar, 0, holder.slot, row);
    variable.owner = context;
    variable.localDelegate = {
      holder,
      read: (frame, instance) => held.run(frame, { delegate: instance }, () => evaluateGet(frame)),
      write:
        setter && ((frame, instance, value) => held.run(frame, { delegate: instance, value }, () => setter(frame))),
    };
    this.bindLocalVariable(scope, variable);
    this.flow.assigned.add(variable);
    const write = this.variableAccess(context, holder).write;
    const evaluate = delegate.eval;
    return this.withStep(row, (frame) => write(frame, evaluate(frame)), delegate.isCreation === true);
  }

  // code-gauge-allow functionParameterCount 7 -- the declaration's scope, receiver, arguments and runtime value are distinct.
  private compileLocalDelegateSetter(
    scope: Scope,
    context: FunctionContext,
    delegate: Compiled,
    args: ArgumentSyntax[],
    type: KType,
    row: number,
    held: Handoff<{ delegate: Value; value?: Value }>
  ): Eval {
    const setterScope = new Scope(scope, context);
    const value = new VariableSymbol('\0delegateValue', type, false, 0, -1, row);
    value.owner = context;
    value.delegateRead = () => held.get().value;
    setterScope.variables.set(value.name, value);
    const argument: ArgumentSyntax = { row, name: undefined, value: { kind: 'name', row, name: value.name } };
    return this.compileDelegateCall(setterScope, context, delegate, 'setValue', [...args, argument], row).eval;
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
    const parts = this.compileComponents(scope, context, holderCompiled, statement.names, row);
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
      const skipped = place.canSkip ? this.flow.copy() : undefined;
      const value = this.compileExpression(scope, context, statement.value, place.type);
      const converted = this.expectType(value, place.type, statement.value.row);
      const toPlace = convertRepr(converted, reprOf(this.core, place.type), place.repr);
      place.recordAssignment?.(value.type);
      this.narrowAfterAssignment(scope, target, value, place.type);
      if (skipped) this.flow = Flow.merge([skipped, this.flow]);
      return this.withStep(
        row,
        (frame) => {
          const bound = place.bind(frame);
          if (!bound.isSkipped) bound.set(toPlace(frame));
        },
        value.isCreation === true
      );
    }
    return this.withStep(row, this.compileCompoundAssignment(scope, context, statement), false);
  }

  private compileCompoundAssignment(scope: Scope, context: FunctionContext, statement: AssignmentStatement): Exec {
    const { operator, row } = statement;
    const operation = operator.slice(0, -1) as keyof typeof ASSIGN_OPERATORS;
    const assignName = ASSIGN_OPERATORS[operation];
    const mutating = (owner: FunctionContext): Exec =>
      this.compileMutatingCompoundAssignment(scope, owner, statement, assignName);
    const storing = (owner: FunctionContext): Exec =>
      this.compileStoredCompoundAssignment(scope, owner, statement, operation);
    if (!this.isApplicableAssignment(context, mutating)) return storing(context);
    if (this.isApplicableAssignment(context, storing)) {
      this.error(
        row,
        `${operator} が ${assignName} と ${NUMBER_OPERATOR_NAMES[operation]} のどちらのことか決められません。val にするか、x = x ${operation} y と書いてください。`
      );
    }
    return mutating(context);
  }

  private compileMutatingCompoundAssignment(
    scope: Scope,
    context: FunctionContext,
    statement: AssignmentStatement,
    name: string
  ): Exec {
    const { operator, row, value } = statement;
    let target = statement.target;
    while (target.kind === 'parenthesized') target = target.expression;
    const args: ArgumentSyntax[] = [{ row: value.row, name: undefined, value }];
    const call = (receiver: Compiled): Compiled => {
      const result = this.compileOperatorCall(scope, context, receiver, name, args, row, operator);
      if (!isNonNullClass(result.type, this.core.unit)) this.error(row, `${name} の戻り値の型は Unit にしてください。`);
      return result;
    };
    const { eval: evaluate } =
      target.kind === 'member' && target.isSafe
        ? this.compileMemberAccess(scope, context, target, call)
        : call(this.compileExpression(scope, context, target));
    return (frame) => {
      evaluate(frame);
    };
  }

  private isApplicableAssignment(context: FunctionContext, compile: (probe: FunctionContext) => Exec): boolean {
    return this.probeApplicability(context, compile, true) === undefined;
  }

  private compileStoredCompoundAssignment(
    scope: Scope,
    context: FunctionContext,
    statement: AssignmentStatement,
    operation: keyof typeof ASSIGN_OPERATORS
  ): Exec {
    const { row, target } = statement;
    const place = this.compilePlace(scope, context, target, row, true);
    const skipped = place.canSkip ? this.flow.copy() : undefined;
    const current = new Handoff<BoundPlace>();
    const currentHolder: Compiled = {
      type: place.readType ?? place.type,
      repr: place.repr,
      eval: () => current.get().get(),
    };
    const combined = this.compileArithmeticWith(scope, context, operation, currentHolder, statement.value, row);
    const converted = this.expectType(combined, place.type, row);
    const toPlace = convertRepr(converted, reprOf(this.core, place.type), place.repr);
    place.recordAssignment?.(combined.type);
    this.narrowAfterAssignment(scope, target, combined, place.type);
    if (skipped) this.flow = Flow.merge([skipped, this.flow]);
    return (frame) => {
      const bound = place.bind(frame);
      if (bound.isSkipped) return;
      const value = current.run(frame, bound, () => toPlace(frame));
      bound.set(value);
    };
  }

  /** After `x = value`, a stable `x` has the value's type, which may be narrower than its declared one. */
  private narrowAfterAssignment(scope: Scope, target: Expression, value: Compiled, declared: KType): void {
    if (target.kind !== 'name') return;
    const variable = this.findVariable(scope, target.name);
    if (!variable) return;
    const key = keyOf(variable);
    const valueType = value.type;
    this.flow.forget(key);
    if (isSubtype(valueType, declared) && !isSubtype(declared, valueType) && resolved(valueType).kind !== 'nothing')
      this.flow.narrowed.set(key, valueType);
    this.narrowToCase(key, value);
  }

  /** After a stable value takes an enum entry, a `when` on it need not cover the other entries, as in Kotlin 2.4. */
  private narrowToCase(key: string, value: Compiled): void {
    const found = caseOf(value);
    if (found) this.applyNarrowing(excludingCases(key, found.others));
  }

  compilePlace(scope: Scope, context: FunctionContext, target: Expression, row: number, isCompound: boolean): Place {
    if (target.kind === 'parenthesized') return this.compilePlace(scope, context, target.expression, row, isCompound);
    if (target.kind === 'name') return this.namePlace(scope, context, target, row, isCompound);
    if (target.kind === 'member') return this.memberPlace(scope, context, target, row, isCompound);
    if (target.kind === 'index') return this.indexPlace(scope, context, target, row, isCompound);
    return this.error(row, 'ここには代入できません。');
  }

  /** A name as a place: a variable, a property of an implicit receiver or a companion object, or a top-level property. */
  private namePlace(
    scope: Scope,
    context: FunctionContext,
    target: Extract<Expression, { kind: 'name' }>,
    row: number,
    isCompound: boolean
  ): Place {
    const variable = this.findVariable(scope, target.name);
    if (variable) return this.variablePlace(scope, context, variable, row, isCompound);
    for (const receiver of this.receiversOf(scope)) {
      const property = this.findProperty(scope, this.receiverTypeOf(receiver), target.name);
      if (property) {
        if (isCompound) this.checkInitialized(context, property.symbol, property.symbol.name, row);
        return this.propertyPlace(
          property,
          {
            type: receiver.type,
            repr: reprOf(this.core, receiver.type),
            eval: this.receiverAccess(context, receiver),
          },
          row,
          scope,
          !isCompound && receiver.context === context ? context : undefined
        );
      }
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
    if (property) return this.topLevelPlace(scope, context, property, row, isCompound);
    return this.error(row, `${target.name} が見つかりません。`);
  }

  /** `a.b` as a place, where `a` may be an object or a class with a companion, and `a?.b` binds to nothing for a null `a`. */
  private memberPlace(
    scope: Scope,
    context: FunctionContext,
    target: Extract<Expression, { kind: 'member' }>,
    row: number,
    isCompound: boolean
  ): Place {
    if (target.receiver.kind === 'super') {
      if (target.isSafe) this.error(row, 'super には ?. を使えません。');
      const { property, receiver } = this.resolveSuperProperty(scope, context, target.name, row);
      return this.propertyPlace(property, receiver, row, scope);
    }
    const qualified = this.compileQualifier(scope, target.receiver);
    if (qualified?.kind === 'class') return this.classPropertyPlace(scope, qualified.cls, target.name, row);
    if (qualified) {
      const property = qualified.scope?.properties.get(target.name)?.find((candidate) => !candidate.extensionReceiver);
      if (!property) this.error(row, `${qualified.path}.${target.name} が見つかりません。`);
      return this.topLevelPlace(scope, context, property, row, isCompound);
    }
    const receiver = this.compileExpression(scope, context, target.receiver);
    if (!target.isSafe) this.requireNonNullReceiver(receiver, row, false);
    const property = this.findProperty(scope, nonNull(receiver.type), target.name);
    if (!property)
      return this.error(row, `${typeToString(resolved(receiver.type))} には ${target.name} がありません。`);
    if (target.isSafe) return this.safePlace(receiver, (holder) => this.propertyPlace(property, holder, row, scope));
    const isOwnReceiver = target.receiver.kind === 'this' && !target.receiver.label;
    if (isOwnReceiver && isCompound) this.checkInitialized(context, property.symbol, target.name, row);
    return this.propertyPlace(property, receiver, row, scope, isOwnReceiver && !isCompound ? context : undefined);
  }

  private classPropertyPlace(scope: Scope, cls: ClassSymbol, name: string, row: number): Place {
    const holder = cls.isObject ? cls : cls.companion;
    const property = holder && this.findProperty(scope, holder.type, name);
    if (!property || !holder) this.error(row, `${cls.name}.${name} が見つかりません。`);
    return this.propertyPlace(
      property,
      { type: holder.type, repr: 'ref', eval: this.objectInstance(holder) },
      row,
      scope
    );
  }

  private topLevelPlace(
    scope: Scope,
    context: FunctionContext,
    property: PropertySymbol,
    row: number,
    isCompound: boolean
  ): Place {
    if (isCompound) this.checkGlobalInitialized(context, property, row);
    return this.propertyPlace({ symbol: property, substitution: new Map() }, undefined, row, scope);
  }

  // code-gauge-allow functionCognitiveComplexity 20 -- finds the closest variable and determines which assignments it permits.
  private variablePlace(
    scope: Scope,
    context: FunctionContext,
    variable: VariableSymbol,
    row: number,
    isCompound: boolean
  ): Place {
    const { delegateRead, delegateWrite, localDelegate } = variable;
    if (localDelegate) return this.localDelegatePlace(context, variable, localDelegate, row);
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
      // Parameters, loop variables, and the other variables a declaration gives a value are read-only as well.
      if (!variable.awaitsValue || isCompound)
        this.error(row, `val で宣言した ${variable.name} には、再び代入できません。`);
      if (!context.canInitializeIn(variable.owner))
        this.error(row, `val で宣言した ${variable.name} には、ラムダ式の中で代入できません。`);
      if (variable.owner !== context && !context.isProbe) variable.isCell = true;
    }
    const access = this.variableAccess(context, variable);
    return {
      type: variable.type,
      readType: isCompound
        ? refineLocalType(localRefinement(scope, context, variable), variable, this.flow.narrowed.get(keyOf(variable)))
        : undefined,
      repr: reprOf(this.core, variable.type),
      recordAssignment: (type) => {
        this.recordLocalWrite(context, variable, type);
        this.recordAssignment(context, variable, row);
      },
      bind: (frame) => ({ get: () => access.read(frame), set: (value) => access.write(frame, value) }),
    };
  }

  private recordLocalWrite(context: FunctionContext, variable: VariableSymbol, type: KType): void {
    for (
      let current = context;
      current !== variable.owner && current.inlineLambda && current.parent && (!context.isProbe || current.isProbe);
      current = current.parent
    )
      current.inlineWrites.add(variable);
    if (
      (!context.isProbe || variable.owner?.isProbe) &&
      context.directExecutionContext() !== variable.owner?.directExecutionContext()
    ) {
      variable.capturedWriteTypes.add(type);
    }
  }

  private localDelegatePlace(
    context: FunctionContext,
    variable: VariableSymbol,
    delegate: NonNullable<VariableSymbol['localDelegate']>,
    row: number
  ): Place {
    const { write } = delegate;
    if (!write) this.error(row, `val で宣言した ${variable.name} には、再び代入できません。`);
    const { read } = this.variableAccess(context, delegate.holder);
    return {
      type: variable.type,
      repr: reprOf(this.core, variable.type),
      bind: (frame) => {
        const instance = read(frame);
        return {
          get: () => delegate.read(frame, instance),
          set: (value) => write(frame, instance, value),
        };
      },
    };
  }

  private propertyPlace(
    member: {
      symbol: PropertySymbol;
      isSuper?: true;
      substitution: Map<TypeParameterSymbol, KType> | ReadonlyMap<TypeParameterSymbol, KType>;
    },
    receiver: Compiled | undefined,
    row: number,
    scope: Scope,
    initializer?: FunctionContext
  ): Place {
    const { symbol } = member;
    const type = resolved(substitute(this.ensurePropertyType(symbol, row), member.substitution));
    const initializes = initializer !== undefined && this.mayInitializeVal(initializer, symbol);
    if (!symbol.isVar && !initializes) this.error(row, `val で宣言した ${symbol.name} には、再び代入できません。`);
    this.checkAccessible(scope, symbol, row, member.isSuper ? undefined : receiver?.type);
    if (symbol.isVar && symbol.setterVisibility === 'private' && !this.isInsideClass(scope, symbol.owner)) {
      this.error(row, `${symbol.name} の set は private なので、クラスの外からは代入できません。`);
    }
    const receiverEval: Eval = receiver ? convertRepr(receiver.eval, receiver.repr, 'ref') : () => NULL;
    const repr = this.propertyReprOf(symbol);
    return {
      type,
      repr,
      recordAssignment: initializes ? () => this.recordAssignment(initializer, symbol, row) : undefined,
      bind: (frame) => {
        const target = receiverEval(frame);
        return {
          get: () => getPropertyValue(symbol, frame, target, !member.isSuper),
          set: (value) => setPropertyValue(symbol, frame, target, value, !member.isSuper),
        };
      },
    };
  }

  protected abstract propertyReprOf(symbol: PropertySymbol): Repr;

  protected abstract nothing(): KType;

  protected isInsideClass(scope: Scope, cls: ClassSymbol | undefined): boolean {
    return this.receiversOf(scope).some((receiver) => receiver.cls !== undefined && receiver.cls === cls);
  }

  /**
   * `a[i]` as a place: `set` stores into it, and for a compound assignment `get` reads it. The receiver and indexes
   * are evaluated once and held, where the compiled `get` and `set` calls read them.
   */
  // code-gauge-allow functionNcss 40 -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
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

  private newLoop(scope: Scope): LoopContext {
    const outerVals = new Set<VariableSymbol>();
    for (let current: Scope | undefined = scope; current; current = current.parent) {
      for (const variable of current.variables.values()) if (!variable.isVar) outerVals.add(variable);
    }
    return { identity: {}, outerVals, breaks: [], continues: [], valWrites: new Map() };
  }

  private recordAssignment(context: FunctionContext, target: VariableSymbol | PropertySymbol, row: number): void {
    if (!target.isVar) {
      if (this.flow.maybeAssigned.has(target))
        this.error(row, `val で宣言した ${target.name} には、再び代入できません。`);
      this.recordLoopValWrite(context, target, row);
    }
    this.flow.assigned.add(target);
    this.flow.maybeAssigned.add(target);
  }

  private recordLoopValWrite(context: FunctionContext, target: VariableSymbol | PropertySymbol, row: number): void {
    if (this.flow.isDead) return;
    for (const loop of context.loops) {
      if (!(target instanceof VariableSymbol) || loop.outerVals.has(target)) loop.valWrites.set(target, row);
    }
  }

  private checkLoopBackEdge(loop: LoopContext, backEdge: Flow): void {
    if (backEdge.isDead) return;
    for (const [target, row] of loop.valWrites) {
      if (backEdge.maybeAssigned.has(target))
        this.error(row, `val で宣言した ${target.name} には、再び代入できません。`);
    }
  }

  /** Forgets the smart casts of the variables a loop assigns, since another iteration may have changed them. */
  private forgetAssignedIn(scope: Scope, statements: Statement[] | Expression): void {
    for (const name of assignedNames(statements)) {
      const variable = this.findVariable(scope, name);
      if (variable) this.flow.forget(keyOf(variable));
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
    const condition = this.compileCondition(scope, context, statement.condition);
    const normalExit = this.withNarrowing(this.flow, condition.whenFalse);
    normalExit.isDead ||= condition.compiled.constant === true;
    this.applyNarrowing(condition.whenTrue);
    this.flow.isDead ||= condition.compiled.constant === false;
    const loop = this.newLoop(scope);
    const body = this.compileLoopBody(scope, context, loop, statement.body);
    this.checkLoopBackEdge(loop, Flow.merge([this.flow, ...loop.continues]));
    this.flow = Flow.merge([normalExit, ...loop.breaks]);
    const test = condition.compiled.eval;
    return (frame) => {
      while (test(frame) as boolean) {
        frame.runtime.spend();
        if (this.runLoopBody(loop, body, frame) === 'break') return;
      }
    };
  }

  // code-gauge-allow functionNcss 31 -- the loop shares its locals and condition between analysis and execution.
  private compileDoWhile(scope: Scope, context: FunctionContext, statement: DoWhileStatement): Exec {
    this.forgetAssignedIn(scope, [...statement.body.statements]);
    this.forgetAssignedIn(scope, statement.condition);
    const loop = this.newLoop(scope);
    // The condition sees the body's variables, as Kotlin's scoping of do-while does.
    const bodyScope = new Scope(scope, context);
    context.loops.push(loop);
    let bodyEval: Eval;
    const firstSlot = context.info.slotCount;
    try {
      bodyEval = this.compileStatementsValue(
        bodyScope,
        context,
        statement.body.statements,
        undefined,
        true,
        false
      ).eval;
    } finally {
      context.loops.pop();
    }
    this.flow = Flow.merge([this.flow, ...loop.continues]);
    const condition = this.compileCondition(bodyScope, context, statement.condition);
    const backEdge = this.withNarrowing(this.flow, condition.whenTrue);
    backEdge.isDead ||= condition.compiled.constant === false;
    this.checkLoopBackEdge(loop, backEdge);
    const test = condition.compiled.eval;
    const lastSlot = context.info.slotCount;
    const conditionExit = this.withNarrowing(this.flow, condition.whenFalse);
    conditionExit.isDead ||= condition.compiled.constant === true;
    this.flow = Flow.merge([conditionExit, ...loop.breaks]);
    const body: Exec = (frame) => {
      bodyEval(frame);
    };
    return (frame) => {
      while (true) {
        try {
          frame.runtime.spend();
          if (this.runLoopBody(loop, body, frame) === 'break' || !(test(frame) as boolean)) return;
        } finally {
          for (let slot = firstSlot; slot < lastSlot; slot++) frame.locals[slot] = UNASSIGNED;
        }
      }
    };
  }

  // code-gauge-allow functionNcss 31 -- the loop shares its locals and condition between analysis and execution.
  private compileFor(scope: Scope, context: FunctionContext, statement: ForStatement): Exec {
    this.forgetAssignedIn(scope, [...statement.body.statements]);
    const iterable = this.compileExpression(scope, context, statement.iterable);
    const loopScope = new Scope(scope, context);
    const loop = this.newLoop(scope);
    const firstSlot = context.info.slotCount;
    const progression = this.progressionOf(iterable.type);
    const { elementType, elementRepr, start, next } = progression
      ? this.progressionStepping(progression)
      : this.iteratorStepping(loopScope, context, iterable, statement.row);
    const bind = this.compileLoopBinding(
      loopScope,
      context,
      statement.variable,
      elementType,
      elementRepr,
      statement.row
    );
    const beforeBody = this.flow.copy();
    const body = this.compileLoopBody(loopScope, context, loop, statement.body);
    const nextIteration = Flow.merge([this.flow, ...loop.continues]);
    this.checkLoopBackEdge(loop, nextIteration);
    this.flow = Flow.merge([beforeBody, nextIteration, ...loop.breaks]);
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

  /** Steps through a range or progression of numbers or characters, without an iterator, as Kotlin compiles it. */
  private progressionStepping(progression: PrimitiveKind): LoopStepping {
    const isLong = progression === 'Long';
    return {
      elementType: this.primitiveType(progression),
      elementRepr: progression,
      start: (_, value) => {
        const [first, last, stepValue] = (value as KObject).fields as (number | bigint)[];
        return {
          current: first,
          last,
          step: stepValue,
          isDone: isEmptyProgression(first, last, stepValue),
          iterator: undefined,
        };
      },
      next: (_, state) => {
        if (state.isDone) return false;
        state.value = state.current;
        if (state.current === state.last) state.isDone = true;
        else
          state.current = isLong
            ? (state.current as bigint) + (state.step as bigint)
            : ((state.current as number) + (state.step as number)) & (progression === 'Char' ? 0xff_ff : -1);
        return true;
      },
    };
  }

  /** Steps through an iterable with the `iterator()`, `hasNext()`, and `next()` that it resolves to. */
  private iteratorStepping(loopScope: Scope, context: FunctionContext, iterable: Compiled, row: number): LoopStepping {
    const iterableHandoff = new Handoff<Value>();
    const stateHandoff = new Handoff<LoopState>();
    const iteratorCall = this.compileOperatorCall(
      loopScope,
      context,
      { ...iterable, eval: () => iterableHandoff.get() },
      'iterator',
      [],
      row,
      'for の in'
    );
    const holderScope = new Scope(loopScope, context);
    const iteratorVariable = new VariableSymbol('\0iterator', iteratorCall.type, false, 0, -1, row);
    iteratorVariable.owner = context;
    iteratorVariable.delegateRead = () => stateHandoff.get().iterator;
    holderScope.variables.set(iteratorVariable.name, iteratorVariable);
    this.flow.assigned.add(iteratorVariable);
    const callOnIterator = (name: string): Compiled =>
      this.compileExpression(holderScope, context, {
        kind: 'call',
        row,
        callee: { kind: 'member', row, receiver: { kind: 'name', row, name: '\0iterator' }, name, isSafe: false },
        typeArgs: [],
        args: [],
        trailingLambda: undefined,
      });
    const hasNext = callOnIterator('hasNext');
    const nextCall = callOnIterator('next');
    const iteratorEval = iteratorCall.eval;
    const hasNextEval = convertRepr(hasNext.eval, hasNext.repr, 'ref');
    const nextEval = nextCall.eval;
    return {
      elementType: nextCall.type,
      elementRepr: nextCall.repr,
      start: (frame, value) =>
        iterableHandoff.run(frame, value, () => ({
          current: 0,
          last: 0,
          step: 0,
          isDone: false,
          iterator: iteratorEval(frame),
        })),
      next: (frame, state) =>
        stateHandoff.run(frame, state, () => {
          if (!(hasNextEval(frame) as boolean)) return false;
          state.value = nextEval(frame);
          return true;
        }),
    };
  }

  /** The kind of the numbers a range or progression of the standard library steps through. */
  protected abstract progressionOf(type: KType): 'Int' | 'Long' | 'Char' | undefined;

  // code-gauge-allow functionNcss 39 -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
  // code-gauge-allow functionCognitiveComplexity 16 -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
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
      const write = this.bindLoopLocal(scope, context, variable.name, type, variable.row);
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
    const parts = this.compileComponents(scope, context, holderCompiled, variable.names, row);
    const writes = parts.map((part) => {
      if (!part) return;
      const write = this.bindLoopLocal(scope, context, part.name, part.type, part.row);
      return (frame: Frame) => write(frame, part.value(frame));
    });
    return (frame, value) => {
      holderAccess.write(frame, value);
      for (const write of writes) write?.(frame);
      frame.runtime.steps.stepBinding(stepRow, true);
    };
  }

  private bindLoopLocal(
    scope: Scope,
    context: FunctionContext,
    name: string,
    type: KType,
    row: number
  ): (frame: Frame, value: Value) => void {
    const symbol = this.newVariable(scope, context, name, type, false, row);
    this.flow.assigned.add(symbol);
    return this.variableAccess(context, symbol).write;
  }

  private compileComponents(
    scope: Scope,
    context: FunctionContext,
    holderCompiled: Compiled,
    names: DestructuringDecl['names'],
    row: number
  ): ({ name: string; type: KType; value: Eval; row: number } | undefined)[] {
    return names.map((part, index) => {
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
  }

  // Control structures as expressions.

  // code-gauge-allow functionCognitiveComplexity 23 -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
  protected compileIf(
    scope: Scope,
    context: FunctionContext,
    expression: Extract<Expression, { kind: 'if' }>,
    expected: KType | undefined,
    use: ExpressionUse
  ): Compiled {
    const { row } = expression;
    const branchUse = use === 'inferUnit' && !expression.elseBranch ? true : use;
    if (branchUse === false && !expression.elseBranch)
      this.error(row, 'if を式として使うときは、else も書いてください。');
    const condition = this.compileCondition(scope, context, expression.condition);
    const before = this.flow.copy();
    this.applyNarrowing(condition.whenTrue);
    const thenCompiled = this.compileBlockValue(scope, context, expression.thenBranch, expected, branchUse);
    const afterThen = this.flow;
    this.flow = this.withNarrowing(before, condition.whenFalse);
    const { elseBranch } = expression;
    const elseCompiled = elseBranch
      ? this.compileBlockValue(
          scope,
          context,
          elseBranch,
          laterBranchExpected(thenCompiled, elseBranch, expected, branchUse),
          branchUse
        )
      : undefined;
    const afterElse = this.flow;
    this.flow = Flow.merge([afterThen, afterElse]);
    const branches = elseCompiled ? [thenCompiled, elseCompiled] : [thenCompiled];
    const inferredUnit = use === 'inferUnit' && (branchUse === true || branches.some((branch) => branch.inferredUnit));
    const asStatement = branchUse === true || inferredUnit;
    const type = asStatement ? this.unitType : this.branchType(branches, expected);
    const repr = asStatement ? 'ref' : reprOf(this.core, type);
    const [thenEval, elseEval] = branches.map((branch) =>
      asStatement
        ? discardResult(branch.eval)
        : convertRepr(this.convertTo(branch, type, row), reprOf(this.core, type), repr)
    );
    const test = condition.compiled.eval;
    if (asStatement && this.isConstantTrue(condition.compiled)) this.flow.isDead = afterThen.isDead;
    return {
      type,
      repr,
      inferredUnit: inferredUnit || undefined,
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

  // code-gauge-allow functionCognitiveComplexity 19 -- exhaustiveness selects the result type and participates in branch flow.
  protected compileWhen(
    scope: Scope,
    context: FunctionContext,
    expression: Extract<Expression, { kind: 'when' }>,
    expected: KType | undefined,
    use: ExpressionUse
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
    const covered = new WhenCoverage();
    let hasElse = false;
    for (const entry of expression.entries) {
      if (hasElse) this.error(entry.row, 'else は、when の最後に書いてください。');
      hasElse = entry.conditions.length === 0;
      entries.push(this.compileWhenEntry(scope, context, subjectValue, entry, covered, expected, use, branchFlows));
    }
    const isExhaustive = hasElse || (subject !== undefined && this.coversSubject(subject, covered.cases, before));
    const inferredUnit = use === 'inferUnit' && (!isExhaustive || entries.some((entry) => entry.body.inferredUnit));
    const asStatement = use === true || inferredUnit;
    this.checkWhenExhaustive(subject, isExhaustive, asStatement, row);
    if (!isExhaustive) branchFlows.push(this.flow);
    this.flow = branchFlows.length > 0 ? Flow.merge(branchFlows) : before;
    const bodies = entries.map((entry) => entry.body);
    const type = asStatement || bodies.length === 0 ? this.unitType : this.branchType(bodies, expected);
    const repr = asStatement ? 'ref' : reprOf(this.core, type);
    const compiledEntries = entries.map((entry) => ({
      tests: entry.tests,
      body: asStatement
        ? discardResult(entry.body.eval)
        : convertRepr(this.convertTo(entry.body, type, row), reprOf(this.core, type), repr),
    }));
    return {
      type,
      repr,
      inferredUnit: inferredUnit || undefined,
      eval: whenEval(subject?.eval, subjectSlot, compiledEntries),
    };
  }

  /**
   * One branch of a `when`: its conditions, with the smart casts that hold in its body and after it, and its body,
   * whose flow joins `branchFlows`.
   */
  // code-gauge-allow functionParameterCount 8 -- the scope, the function context, and the parts of the when are each needed, and bundling them would only rename them.
  private compileWhenEntry(
    scope: Scope,
    context: FunctionContext,
    subject: Compiled | undefined,
    entry: Extract<Expression, { kind: 'when' }>['entries'][number],
    covered: WhenCoverage,
    expected: KType | undefined,
    use: ExpressionUse,
    branchFlows: Flow[]
  ): { tests: ((frame: Frame) => boolean)[]; body: Compiled } {
    if (entry.conditions.length === 0) {
      const body = this.compileBlockValue(scope, context, entry.body, expected, use);
      branchFlows.push(this.flow);
      this.flow = this.flow.copy();
      return { tests: [], body };
    }
    const tests: ((frame: Frame) => boolean)[] = [];
    let whenTrue = new Map<string, KType>();
    let whenFalse = new Map<string, KType>();
    for (const condition of entry.conditions) {
      const compiled = this.compileWhenCondition(scope, context, subject, condition, covered);
      tests.push(compiled.test);
      whenTrue = entry.conditions.length === 1 ? compiled.whenTrue : new Map();
      whenFalse = new Map([...whenFalse, ...compiled.whenFalse]);
    }
    const atEntry = this.flow.copy();
    this.applyNarrowing(whenTrue);
    const body = this.compileBlockValue(scope, context, entry.body, expected, use);
    branchFlows.push(this.flow);
    this.flow = this.withNarrowing(atEntry, entry.conditions.length === 1 ? whenFalse : new Map());
    return { tests, body };
  }

  /** Rejects a `when` that misses cases, where an expression or a statement over a sealed type must cover all. */
  private checkWhenExhaustive(
    subject: Compiled | undefined,
    isExhaustive: boolean,
    asStatement: boolean,
    row: number
  ): void {
    const needsExhaustive = !asStatement || (subject !== undefined && this.isSealedLike(subject.type));
    if (!needsExhaustive || isExhaustive) return;
    this.error(
      row,
      asStatement
        ? 'when の分岐が足りません。すべての場合か else を書いてください。'
        : 'when を式として使うときは、すべての場合か else を書いてください。'
    );
  }

  private compileWhenCondition(
    scope: Scope,
    context: FunctionContext,
    subject: Compiled | undefined,
    condition: WhenCondition,
    covered: WhenCoverage
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
      covered.coverTypeCases(subject.type, type, condition.negated, this.core.boolean);
      const exclusion = isExclusion(subject.stableKey, type);
      return condition.negated
        ? { test: (frame) => !test(evaluate(frame)), whenTrue: exclusion, whenFalse: narrowing }
        : { test: (frame) => test(evaluate(frame)), whenTrue: narrowing, whenFalse: exclusion };
    }
    if (condition.kind === 'in') return this.compileWhenIn(scope, context, subject, condition);
    return this.compileWhenValue(scope, context, subject, condition.expression, condition.row, covered.cases);
  }

  /** A `when` branch's `in` or `!in` condition, which tests the subject. */
  private compileWhenIn(
    scope: Scope,
    context: FunctionContext,
    subject: Compiled,
    condition: Extract<WhenCondition, { kind: 'in' }>
  ): { test: (frame: Frame) => boolean; whenTrue: Map<string, KType>; whenFalse: Map<string, KType> } {
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

  /** A `when` branch's value, which the subject equals for the branch to run. */
  // code-gauge-allow functionCognitiveComplexity 16 -- the branch test and its resulting narrowing share resolved operands.
  private compileWhenValue(
    scope: Scope,
    context: FunctionContext,
    subject: Compiled,
    expression: Expression,
    row: number,
    covered: Set<string>
  ): { test: (frame: Frame) => boolean; whenTrue: Map<string, KType>; whenFalse: Map<string, KType> } {
    // An Int literal does not become a Long here, as kotlinc rejects `6` among the branches of a Long subject.
    const isLongSubject = this.primitiveOf(nonNull(subject.type)) === 'Long';
    const value = this.compileExpression(scope, context, expression, isLongSubject ? undefined : nonNull(subject.type));
    this.checkEqualityApplicable(subject, value, row, '==');
    this.recordCovered(value, expression, covered);
    const subjectEval = convertRepr(subject.eval, subject.repr, 'ref');
    const valueEval = convertRepr(
      this.convertTo(value, value.integerLiteral ? nonNull(subject.type) : value.type, row),
      reprOf(this.core, value.integerLiteral ? nonNull(subject.type) : value.type),
      'ref'
    );
    const subjectKind = this.primitiveOf(nonNull(subject.type));
    const isIntLiteralForLong = isLongSubject && value.integerLiteral !== undefined && !value.integerLiteral.isLong;
    if (
      subjectKind &&
      (isIntLiteralForLong || !this.acceptsArgument(value, nonNull(subject.type))) &&
      resolved(value.type).kind !== 'nothing'
    ) {
      this.error(
        row,
        `演算子 == は ${typeToString(resolved(subject.type))} と ${typeToString(resolved(value.type))} には使えません。`
      );
    }
    const nullLiteral = isNullLiteral(expression);
    const valueCase = caseOf(value);
    const narrowing =
      subject.stableKey && valueCase ? excludingCases(subject.stableKey, [valueCase.id]) : new Map<string, KType>();
    if (resolved(value.type).kind === 'nothing' && subject.stableKey)
      narrowing.set(subject.stableKey, nonNull(subject.type));
    return {
      test: (frame) => {
        const a = subjectEval(frame);
        if (nullLiteral) return a === NULL;
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
    if (isNullLiteral(expression)) covered.add('null');
    const found = caseOf(value);
    if (found) covered.add(found.id);
  }

  /** Whether a `when` statement on the subject must cover every case, as one on an enum, sealed type, or Boolean must. */
  private isSealedLike(type: KType): boolean {
    const actual = resolved(type);
    return (
      actual.kind === 'class' && (actual.cls.kind === 'enum' || actual.cls.isSealed || actual.cls === this.core.boolean)
    );
  }

  /**
   * Whether the branches cover every case of the subject, where the cases a smart cast rules out need no branch, as
   * `if (c == C.R) return` before `when (c)` in Kotlin 2.4.
   */
  private coversSubject(subject: Compiled, covered: Set<string>, flow: Flow): boolean {
    const all = new Set([...covered, ...(subject.stableKey ? flow.excludedCases(subject.stableKey) : [])]);
    return this.isExhaustive(subject.type, all);
  }

  private isExhaustive(type: KType, covered: Set<string>): boolean {
    const actual = resolved(type);
    if (actual.nullable && !covered.has('null')) return false;
    if (actual.kind === 'nothing') return true;
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

  private readonly exceptionEntries = new WeakMap<FunctionContext, Flow[]>();

  private recordExceptionEntry(scope: Scope, context: FunctionContext, statement: Statement): void {
    const entries = this.exceptionEntries.get(context);
    if (!entries || this.flow.isDead) return;
    if (statement.kind === 'expressionStatement' && this.isNonThrowingExpression(scope, statement.expression)) return;
    if (statement.kind === 'assignment' && statement.operator === '=' && statement.target.kind === 'name') {
      const local = this.findVariable(scope, statement.target.name);
      if (local && !local.delegateRead && this.isNonThrowingExpression(scope, statement.value)) return;
    }
    entries.push(this.flow.copy());
  }

  private isNonThrowingExpression(scope: Scope, expression: Expression): boolean {
    switch (expression.kind) {
      case 'break':
      case 'continue':
      case 'integer':
      case 'real':
      case 'boolean':
      case 'char':
      case 'null': {
        return true;
      }
      case 'string': {
        return expression.parts.every((part) => typeof part === 'string');
      }
      case 'name': {
        const variable = this.findVariable(scope, expression.name);
        return Boolean(variable && !variable.delegateRead && this.flow.assigned.has(variable));
      }
      case 'parenthesized': {
        return this.isNonThrowingExpression(scope, expression.expression);
      }
      default: {
        return false;
      }
    }
  }

  private compileTryBlock(
    scope: Scope,
    context: FunctionContext,
    block: Block,
    expected: KType | undefined,
    use: ExpressionUse,
    thrown: Flow[]
  ): Compiled {
    const previous = this.exceptionEntries.get(context);
    this.exceptionEntries.set(context, thrown);
    try {
      return this.compileBlockValue(scope, context, block, expected, use);
    } finally {
      if (previous) this.exceptionEntries.set(context, previous);
      else this.exceptionEntries.delete(context);
    }
  }

  // code-gauge-allow functionNcss 50 -- try, catch clauses, and finally, as an expression.
  // code-gauge-allow functionCognitiveComplexity 26 -- the same try and catch branches decide the flow and runtime result.
  protected compileTry(
    scope: Scope,
    context: FunctionContext,
    expression: Extract<Expression, { kind: 'try' }>,
    expected: KType | undefined,
    use: ExpressionUse
  ): Compiled {
    const loopExits = expression.finally ? context.loops.flatMap(({ breaks, continues }) => [breaks, continues]) : [];
    const exitStarts = loopExits.map((exits) => exits.length);
    const before = this.flow.copy();
    const bodyThrows: Flow[] = [];
    const catchThrows: Flow[] = [];
    const body = this.compileTryBlock(scope, context, expression.body, expected, use, bodyThrows);
    const flows = [this.flow];
    const assignmentsBeforeThrow = Flow.merge([before, ...bodyThrows]).maybeAssigned;
    for (const target of this.flow.maybeAssigned) assignmentsBeforeThrow.add(target);
    const catches = expression.catches.map((clause) => {
      this.flow = before.copy();
      for (const variable of assignmentsBeforeThrow) this.flow.maybeAssigned.add(variable);
      const catchScope = new Scope(scope, context);
      const type = this.resolveType(scope, clause.type);
      if (!isSubtype(type, this.core.throwable.type))
        this.error(clause.row, typeMismatchMessage(this.core.throwable.type, type));
      const variable = this.newVariable(catchScope, context, clause.name, type, false, clause.row);
      this.flow.assigned.add(variable);
      const { write } = this.variableAccess(context, variable);
      const value = this.compileTryBlock(catchScope, context, clause.body, expected, use, catchThrows);
      flows.push(this.flow);
      return { test: instanceTest(this.core, type), write, value, slot: variable.slot };
    });
    this.flow = Flow.merge(flows);
    const finallyEval = expression.finally
      ? this.compileFinally(
          scope,
          context,
          expression.finally,
          before,
          [...bodyThrows, ...catchThrows],
          loopExits.map((exits, index) => ({
            exits,
            pending: exits.splice(exitStarts[index]),
          }))
        )
      : undefined;
    const branches = [body, ...catches.map((clause) => clause.value)];
    const inferredUnit = use === 'inferUnit' && branches.some((branch) => branch.inferredUnit);
    const asStatement = use === true || inferredUnit;
    const type = asStatement ? this.unitType : this.branchType(branches, expected);
    const repr = asStatement ? 'ref' : reprOf(this.core, type);
    const convert = (compiled: Compiled): Eval =>
      asStatement
        ? discardResult(compiled.eval)
        : convertRepr(this.convertTo(compiled, type, expression.row), reprOf(this.core, type), repr);
    const bodyEval = convert(body);
    const clauses = catches.map((clause) => ({ ...clause, value: convert(clause.value) }));
    return {
      type,
      repr,
      inferredUnit: inferredUnit || undefined,
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

  // code-gauge-allow functionNcss 31 -- compiles the body and transfers its result to each kind of incoming path.
  private compileFinally(
    scope: Scope,
    context: FunctionContext,
    block: Block,
    beforeTry: Flow,
    throws: Flow[],
    loopExits: { exits: Flow[]; pending: Flow[] }[]
  ): Eval {
    const afterTry = this.flow;
    this.flow = Flow.merge([afterTry, ...throws, ...loopExits.flatMap(({ pending }) => pending)]);
    restrictFieldReads(this.flow, beforeTry);
    const exitStarts = loopExits.map(({ exits }) => exits.length);
    const evaluate = this.compileBlockValue(scope, context, block, undefined, true).eval;
    const afterFinally = this.flow;
    const finallyJumps = loopExits.flatMap(({ exits }, index) => exits.slice(exitStarts[index]));
    applyFinallyJumpFields(finallyJumps, beforeTry, afterTry);
    const assignedKeys = [...assignedNames(block.statements)].flatMap((name) => {
      const variable = this.findVariable(scope, name);
      return variable ? [keyOf(variable)] : [];
    });
    const transfer = (flow: Flow): Flow => {
      const completed = flow.copy();
      completed.isDead ||= afterFinally.isDead;
      for (const key of assignedKeys) completed.forget(key);
      for (const [key, type] of afterFinally.narrowed) completed.narrowed.set(key, type);
      for (const variable of afterFinally.assigned) completed.assigned.add(variable);
      for (const variable of afterFinally.maybeAssigned) completed.maybeAssigned.add(variable);
      return completed;
    };
    this.flow = transfer(afterTry);
    if (afterFinally.isDead) return evaluate;
    for (const { exits, pending } of loopExits) {
      for (const flow of pending) exits.push(transfer(flow));
    }
    return evaluate;
  }
}

function applyFinallyJumpFields(jumps: Flow[], beforeTry: Flow, afterTry: Flow): void {
  // Kotlin checks finally's field reads before try, but uses normal try/catch flow for its own jumps.
  if (afterTry.isDead) {
    for (const jump of jumps) restrictFieldReads(jump, beforeTry);
    return;
  }
  const fields = [...afterTry.assigned].filter((target) => target instanceof PropertySymbol);
  for (const jump of jumps) for (const field of fields) jump.assigned.add(field);
}

function restrictFieldReads(flow: Flow, beforeTry: Flow): void {
  for (const target of flow.assigned)
    if (target instanceof PropertySymbol && !beforeTry.assigned.has(target)) flow.assigned.delete(target);
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

export type { ClassType };

/** The expected type of a later branch of an `if` used as an expression, which an earlier branch may guide. */
function laterBranchExpected(
  earlier: Compiled,
  later: Block,
  expected: KType | undefined,
  use: ExpressionUse
): KType | undefined {
  return use === true ? expected : branchHint(earlier.type, expected, isBareCall(later));
}

function discardResult(evaluate: Eval): Eval {
  return (frame) => {
    evaluate(frame);
    return UNIT;
  };
}

/** How a `for` loop starts and steps through its iterable, and the type and representation of its elements. */
interface LoopStepping {
  elementType: KType;
  elementRepr: Repr;
  start: (frame: Frame, iterableValue: Value) => LoopState;
  next: (frame: Frame, state: LoopState) => boolean;
}

function isEmptyProgression(first: number | bigint, last: number | bigint, step: number | bigint): boolean {
  return step > 0 ? first > last : first < last;
}

/** Runs the first branch of a `when` whose conditions hold, with the subject held in its slot meanwhile. */
function whenEval(
  subjectEval: Eval | undefined,
  subjectSlot: number,
  entries: { tests: ((frame: Frame) => boolean)[]; body: Eval }[]
): Eval {
  return (frame) => {
    if (subjectEval) frame.locals[subjectSlot] = subjectEval(frame);
    try {
      for (const entry of entries) {
        if (entry.tests.length === 0 || entry.tests.some((test) => test(frame))) return entry.body(frame);
      }
      return UNIT;
    } finally {
      if (subjectEval) frame.locals[subjectSlot] = UNASSIGNED;
    }
  };
}
