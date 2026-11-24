import { annotationSite } from './annotationSites';
// code-gauge-allow-file fileNcss -- One method per kind of Kotlin statement and control structure.
import type {
  AssignmentStatement,
  Block,
  ClassDecl,
  DestructuringDecl,
  DoWhileStatement,
  Expression,
  ForStatement,
  FunctionDecl,
  PropertyDecl,
  Statement,
  WhenCondition,
  WhileStatement,
} from './ast';
import { isNullLiteral } from './ast';
import type { ArgumentSyntax } from './callCompiler';
import {
  checkedBoolean,
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
import { discardResult, ifEval, tryEval, whenEval } from './controlEvaluation';
import { getPropertyValue, receiverRepr, setPropertyValue } from './dispatch';
import { type BoundPlace, type Place } from './expressionCompiler';
import { applyFinallyJumpFields, finallyEffect, keepAssignedBefore, throughFinally } from './finallyFlow';
import { caseOf, keyOf } from './flowKeys';
import { assignedNames, localRefinement, refineLocalType, remainingWrites } from './flowWrites';
import { valueEquals } from './format';
import { isExclusion, OperatorCompiler } from './operatorCompiler';
import { NUMBER_OPERATOR_NAMES } from './operators';
import { framedInstanceTest } from './reified';
import { needsSiblingHint, siblingResultType } from './resultInference';
import { type Frame, LoopSignal, UNASSIGNED } from './runtime';
import { type ClassSymbol, type PropertySymbol, type TypeParameterSymbol, VariableSymbol } from './symbols';
import { checkedRead, instanceTest } from './typeChecks';
import { commonSupertype, isSubtype } from './typeRelations';
import {
  type ClassType,
  hasOpenVariables,
  isNonNullClass,
  type KType,
  nonNull,
  resolved,
  substitute,
  typeToString,
} from './types';
import { Boxed, Cell, type KObject, NULL, type PrimitiveKind, UNIT, type Value } from './values';
import { WhenCoverage } from './whenCoverage';

export type Exec = (frame: Frame) => void;

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
  // code-gauge-allow functionCognitiveComplexity -- statement compilation and execution both restore the block state when an exit interrupts them.
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
      case 'function': {
        return this.compileLocalFunction(scope, context, statement);
      }
      case 'class': {
        return this.compileLocalClass(scope, context, statement);
      }
      case 'typeAlias': {
        return this.error(statement.row, '型の別名（typealias）は、関数の中には書けません。');
      }
    }
  }

  // Declarations.

  protected abstract checkLateinitType(type: KType | undefined, row: number): void;

  /** Declares a function in a function body, whose body sees the variables declared before it. */
  protected abstract compileLocalFunction(scope: Scope, context: FunctionContext, decl: FunctionDecl): Exec;

  /** Declares a class in a function body, whose members see the variables declared before it. */
  protected abstract compileLocalClass(scope: Scope, context: FunctionContext, decl: ClassDecl): Exec;

  // code-gauge-allow functionNcss -- the parts of the construct this function compiles follow one another, and splitting them would only rename them.
  // code-gauge-allow functionCognitiveComplexity -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
  private compileLocalProperty(scope: Scope, context: FunctionContext, statement: PropertyDecl): Exec {
    this.validateAnnotations(
      scope,
      statement.modifiers,
      annotationSite(['LOCAL_VARIABLE'], statement.delegate ? ['delegate'] : [])
    );
    const { row, name } = statement;
    if (statement.getter || statement.setter) this.error(row, 'ローカル変数には get・set を書けません。');
    const misplaced = [...statement.modifiers.keywords].find((keyword) => keyword !== 'lateinit');
    if (misplaced) this.error(row, `ローカル変数には ${misplaced} 修飾子を付けられません。`);
    const isLateinit = statement.modifiers.keywords.has('lateinit');
    const declared = statement.type ? this.resolveType(scope, statement.type) : undefined;
    if (isLateinit) {
      if (!statement.isVar) this.error(row, 'lateinit は var にだけ付けられます。');
      if (statement.initializer || statement.delegate) this.error(row, 'lateinit の変数には初期値を書けません。');
      this.checkLateinitType(declared, row);
    }
    if (statement.delegate) return this.compileLocalDelegate(scope, context, statement, declared);
    if (!statement.initializer) {
      if (!declared) this.error(row, `変数 ${name} の型を書くか、初期値を書いてください。`);
      const variable = this.newVariable(scope, context, name, declared, statement.isVar, row);
      variable.awaitsValue = !statement.isVar;
      variable.isLateinit = isLateinit;
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

  // code-gauge-allow functionParameterCount -- the declaration's scope, receiver, arguments and runtime value are distinct.
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
    // Releasing the initializer lets the collector remove what no component keeps, such as a skipped `_` turtle.
    const releasesHolder = initializer.repr === 'ref';
    const exec: Exec = (frame) => {
      holderWrite(frame, evaluate(frame));
      try {
        for (const write of writes) write?.(frame);
      } finally {
        if (releasesHolder) holderWrite(frame, NULL);
      }
    };
    if (statement.isParameter) return exec;
    return this.withStep(row, exec, false);
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
        (frame) =>
          place.withBound(frame, (bound) => {
            if (!bound.isSkipped) bound.set(toPlace(frame));
          }),
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
    const { target } = statement;
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
    return (frame) =>
      place.withBound(frame, (bound) => {
        if (bound.isSkipped) return;
        const value = current.run(frame, bound, () => toPlace(frame));
        bound.set(value);
      });
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
      const property = this.findProperty(this.receiverTypeOf(receiver), target.name, row);
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
    const companion = this.findCompanionProperty(scope, target.name, row);
    if (companion) {
      const holder: Compiled = {
        type: companion.holder.type,
        repr: 'ref',
        eval: this.objectInstance(companion.holder),
      };
      return this.propertyPlace(companion.property, holder, row, scope);
    }
    const property = this.topLevelPlainProperty(target.name);
    if (property) return this.topLevelPlace(scope, context, property, row, isCompound);
    return this.error(row, `${target.name} が見つかりません。`);
  }

  // code-gauge-allow functionCognitiveComplexity -- qualifiers and safe calls share property legality and assignment flow.
  private memberPlace(
    scope: Scope,
    context: FunctionContext,
    target: Extract<Expression, { kind: 'member' }>,
    row: number,
    isCompound: boolean
  ): Place {
    if (target.receiver.kind === 'super') {
      if (target.isSafe) this.error(row, 'super には ?. を使えません。');
      const { property, receiver } = this.resolveSuperProperty(scope, context, target.name, row, target.receiver);
      return this.propertyPlace(property, receiver, row, scope);
    }
    const qualified = this.compileQualifier(scope, target.receiver);
    if (qualified?.kind === 'class')
      return this.classPropertyPlace(scope, context, qualified.cls, target.name, row, isCompound);
    if (qualified) {
      const property = qualified.scope?.properties.get(target.name)?.find((candidate) => !candidate.extensionReceiver);
      if (!property) this.error(row, `${qualified.path}.${target.name} が見つかりません。`);
      return this.topLevelPlace(scope, context, property, row, isCompound);
    }
    const receiver = this.compileExpression(scope, context, target.receiver);
    const property = this.findProperty(target.isSafe ? nonNull(receiver.type) : receiver.type, target.name, row);
    if (!target.isSafe) this.requirePropertyReceiver(receiver, property?.symbol, row);
    if (!property)
      return this.error(row, `${typeToString(resolved(receiver.type))} には ${target.name} がありません。`);
    if (target.isSafe) return this.safePlace(receiver, (holder) => this.propertyPlace(property, holder, row, scope));
    const isOwnReceiver = target.receiver.kind === 'this' && !target.receiver.label;
    if (isOwnReceiver && isCompound) this.checkInitialized(context, property.symbol, target.name, row);
    return this.propertyPlace(property, receiver, row, scope, isOwnReceiver && !isCompound ? context : undefined);
  }

  private classPropertyPlace(
    scope: Scope,
    context: FunctionContext,
    cls: ClassSymbol,
    name: string,
    row: number,
    isCompound: boolean
  ): Place {
    const holder = cls.isObject ? cls : cls.companion;
    const property = holder && this.findProperty(holder.type, name, row);
    if (!property || !holder) this.error(row, `${cls.name}.${name} が見つかりません。`);
    // A compound write reads the property first, which the object's own initializer may not do before it is set.
    if (isCompound) this.checkInitialized(context, property.symbol, name, row);
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
    // A property imported from an object, such as `Config.count`, is stored on that object.
    const { owner } = property;
    const holder: Compiled | undefined = owner?.isObject
      ? { type: owner.type, repr: 'ref', eval: this.objectInstance(owner) }
      : undefined;
    return this.propertyPlace({ symbol: property, substitution: new Map() }, holder, row, scope);
  }

  private variablePlace(
    scope: Scope,
    context: FunctionContext,
    variable: VariableSymbol,
    row: number,
    isCompound: boolean
  ): Place {
    const { backingField, delegateRead, localDelegate } = variable;
    if (localDelegate) return this.localDelegatePlace(context, variable, localDelegate, row);
    if (backingField) return this.backingFieldPlace(context, variable, backingField, row);
    if (delegateRead) return this.unavailable(row, '委譲したローカル変数への代入');
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
    const { readType, read } = isCompound
      ? this.narrowedRead(scope, context, variable, access.read)
      : { readType: undefined, read: access.read };
    return {
      type: variable.type,
      readType,
      repr: reprOf(this.core, variable.type),
      recordAssignment: (type) => {
        this.recordLocalWrite(context, variable, type);
        this.recordAssignment(context, variable, row);
      },
      withBound: (frame, use) => use({ get: () => read(frame), set: (value) => access.write(frame, value) }),
    };
  }

  /** A compound assignment reads the value as an expression does, through the same check of its smart cast. */
  private narrowedRead(
    scope: Scope,
    context: FunctionContext,
    variable: VariableSymbol,
    read: (frame: Frame) => Value
  ): { readType: KType | undefined; read: (frame: Frame) => Value } {
    const key = keyOf(variable);
    const readType = refineLocalType(localRefinement(scope, context, variable), variable, this.flow.narrowed.get(key));
    const isReference = reprOf(this.core, variable.type) === 'ref';
    return { readType, read: readType && isReference ? checkedRead(this.core, read, readType) : read };
  }

  private backingFieldPlace(
    context: FunctionContext,
    variable: VariableSymbol,
    field: NonNullable<VariableSymbol['backingField']>,
    row: number
  ): Place {
    if (!variable.isVar) this.error(row, `val で宣言した ${variable.name} には、再び代入できません。`);
    const { read, write } = this.backingFieldAccess(context, field);
    return {
      type: variable.type,
      repr: reprOf(this.core, variable.type),
      withBound: (frame, use) => use({ get: () => read(frame), set: (value) => write(frame, value) }),
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
      withBound: (frame, use) => {
        const instance = read(frame);
        return frame.runtime.withNativeRoots([instance], () =>
          use({ get: () => delegate.read(frame, instance), set: (value) => write(frame, instance, value) })
        );
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
    const receiverEval: Eval = receiver ? convertRepr(receiver.eval, receiver.repr, receiverRepr(symbol)) : () => NULL;
    const repr = this.propertyReprOf(symbol);
    return {
      type,
      repr,
      recordAssignment: initializes ? () => this.recordAssignment(initializer, symbol, row) : undefined,
      withBound: (frame, use) => {
        const target = receiverEval(frame);
        return frame.runtime.withNativeRoots([target], () =>
          use({
            get: () => getPropertyValue(symbol, frame, target, !member.isSuper),
            set: (value) => setPropertyValue(symbol, frame, target, value, !member.isSuper),
          })
        );
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
   * are evaluated once and stay rooted while assignment operands and accessors run.
   */
  // code-gauge-allow functionNcss -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
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
    // Reading that placeholder would mark the code after the assignment unreachable, which the real value is not.
    const wasDead = this.flow.isDead;
    const setter = this.resolveOperator(
      indexScope,
      context,
      receiverHolder,
      'set',
      [...indexArgs, valueArg],
      row,
      '[]='
    );
    this.flow.isDead = wasDead;
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
      withBound: (frame, use) => {
        const state: HeldIndex = { receiver: receiverEval(frame), indexes: [], value: undefined };
        return handoff.run(frame, state, () => {
          for (const evaluate of indexEvals) state.indexes.push(evaluate(frame));
          return use({
            get: () => (getEval as Eval)(frame),
            set: (value) => {
              state.value = value;
              setEval(frame);
            },
          });
        });
      },
    };
  }

  // Loops.

  private newLoop(scope: Scope, label: string | undefined): LoopContext {
    const outerVals = new Set<VariableSymbol>();
    for (let current: Scope | undefined = scope; current; current = current.parent) {
      for (const variable of current.variables.values()) if (!variable.isVar) outerVals.add(variable);
    }
    return { identity: {}, label, outerVals, breaks: [], continues: [], valWrites: new Map() };
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
    const loop = this.newLoop(scope, statement.label);
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

  // code-gauge-allow functionNcss -- the loop shares its locals and condition between analysis and execution.
  private compileDoWhile(scope: Scope, context: FunctionContext, statement: DoWhileStatement): Exec {
    this.forgetAssignedIn(scope, [...statement.body.statements]);
    this.forgetAssignedIn(scope, statement.condition);
    const loop = this.newLoop(scope, statement.label);
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

  // code-gauge-allow functionNcss -- the loop shares its locals and condition between analysis and execution.
  private compileFor(scope: Scope, context: FunctionContext, statement: ForStatement): Exec {
    // The iterable runs once, before any iteration's writes.
    const iterable = this.compileExpression(scope, context, statement.iterable);
    this.forgetAssignedIn(scope, [...statement.body.statements]);
    const loopScope = new Scope(scope, context);
    const loop = this.newLoop(scope, statement.label);
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
      start: (frame, value) => {
        // An overridden range property read by a superclass initializer is still null.
        if (value === undefined) return frame.runtime.throwError(frame, 'java.lang.NullPointerException');
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
    const hasNextEval = checkedBoolean(hasNext, convertRepr(hasNext.eval, hasNext.repr, 'ref'));
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
    const { thenBranch, elseBranch } = expression;
    const thenFlow = this.withNarrowing(before, condition.whenTrue);
    const elseFlow = this.withNarrowing(before, condition.whenFalse);
    const entries = [{ body: thenBranch, flow: thenFlow }];
    if (elseBranch) entries.push({ body: elseBranch, flow: elseFlow });
    const compiled = this.compileResultBranches(scope, context, entries, expected, branchUse);
    const branches = compiled.map(({ value }) => value);
    const flows = compiled.map(({ flow }) => flow);
    if (!elseBranch) flows.push(elseFlow);
    this.flow = Flow.merge(flows);
    const inferredUnit = use === 'inferUnit' && (branchUse === true || branches.some((branch) => branch.inferredUnit));
    const asStatement = branchUse === true || inferredUnit;
    const type = asStatement ? this.unitType : this.branchType(branches, expected);
    const repr = asStatement ? 'ref' : reprOf(this.core, type);
    const [thenEval, elseEval] = branches.map((branch) =>
      asStatement
        ? discardResult(branch.eval)
        : convertRepr(this.convertTo(branch, type, row), reprOf(this.core, type), repr)
    );
    return {
      type,
      repr,
      inferredUnit: inferredUnit || undefined,
      eval: ifEval(condition.compiled.eval, thenEval, elseEval),
    };
  }

  private compileResultBranches(
    scope: Scope,
    context: FunctionContext,
    branches: { body: Block; flow: Flow }[],
    expected: KType | undefined,
    use: ExpressionUse
  ): { value: Compiled; flow: Flow }[] {
    const hint = this.inferBranchType(
      context,
      branches.map(({ body }) => body),
      expected,
      use,
      (index, probe) => {
        const { body, flow } = branches[index];
        this.flow = flow.copy();
        return this.compileBlockValue(scope, probe, body, undefined, use);
      }
    );
    return branches.map(({ body, flow }) => {
      this.flow = flow;
      const value = this.compileBlockValue(scope, context, body, typeForBranch(body, expected, hint), use);
      return { value, flow: this.flow };
    });
  }

  private inferBranchType(
    context: FunctionContext,
    blocks: Block[],
    expected: KType | undefined,
    use: ExpressionUse,
    compile: (index: number, probe: FunctionContext) => Compiled
  ): KType | undefined {
    if (use === true || !needsSiblingHint(expected) || !blocks.some(isBareCall)) return undefined;
    const types = blocks.flatMap((block, index) => {
      if (isBareCall(block)) return [];
      const type = this.probeResultType(context, (probe) => compile(index, probe));
      return type ? [type] : [];
    });
    return siblingResultType(types, expected);
  }

  private isConstantTrue(compiled: Compiled): boolean {
    return compiled.constant === true;
  }

  /** The common type of the branches of an `if`, `when`, or `try` used as an expression. */
  private branchType(branches: Compiled[], expected: KType | undefined): KType {
    // A variable bound from elsewhere, as `V` of `getOrElse` on a Long map, types the literals as its bounds' integer type
    // does a sibling's; one nothing has bound yet, as `R` of `sortedBy`, leaves them to their siblings.
    const hint = expected && resolved(expected);
    const bounds =
      hint?.kind === 'variable' && !hint.variable.fixed
        ? hint.variable.lower.map((type): Compiled => ({ type, repr: 'ref', eval: () => {} }))
        : [];
    const joined = this.joinedTypes([...branches, ...bounds]);
    const decides = hint && !hasOpenVariables(hint);
    const types = branches.map((branch, index) =>
      branch.integerLiteral && decides
        ? this.acceptsArgument(branch, expected)
          ? expected
          : branch.type
        : joined[index]
    );
    if (expected && types.every((type, index) => this.acceptsArgument({ ...branches[index], type }, expected))) {
      const common = commonSupertype(types);
      return isSubtype(common, expected) ? common : expected;
    }
    return commonSupertype(types);
  }

  // code-gauge-allow functionCognitiveComplexity -- exhaustiveness selects the result type and participates in branch flow.
  // code-gauge-allow functionNcss -- the parts of the construct this function compiles follow one another, and splitting them would only rename them.
  protected compileWhen(
    scope: Scope,
    context: FunctionContext,
    expression: Extract<Expression, { kind: 'when' }>,
    expected: KType | undefined,
    use: ExpressionUse
  ): Compiled {
    const { row } = expression;
    if (expression.subjectVariable) scope = new Scope(scope, context);
    const subject = expression.subject && this.compileWhenSubject(scope, context, expression);
    const subjectSlot = subject ? context.allocate('\0subject', subject.type, false) : -1;
    const subjectValue: Compiled | undefined = subject && {
      type: subject.type,
      repr: subject.repr,
      eval: (frame) => frame.locals[subjectSlot] as Value,
      stableKey: subject.stableKey,
      whenNonNull: subject.whenNonNull,
      narrowing: subject.narrowing,
    };
    const before = this.flow.copy();
    const covered = new WhenCoverage();
    let hasElse = false;
    const heads = expression.entries.map((entry) => {
      if (hasElse) this.error(entry.row, 'else は、when の最後に書いてください。');
      hasElse = entry.conditions.length === 0 && !entry.guard;
      return entry.guard
        ? this.compileGuardedEntryHead(scope, context, subjectValue, entry)
        : this.compileWhenEntryHead(scope, context, subjectValue, entry, covered);
    });
    const afterHeads = this.flow;
    const branches = this.compileResultBranches(
      scope,
      context,
      expression.entries.map((entry, index) => ({ body: entry.body, flow: heads[index].flow })),
      expected,
      use
    );
    const entries = heads.map(({ tests }, index) => ({ tests, body: branches[index].value }));
    const branchFlows = branches.map(({ flow }) => flow);
    const isExhaustive = hasElse || (subject !== undefined && this.coversSubject(subject, covered.cases, before));
    const inferredUnit = use === 'inferUnit' && (!isExhaustive || entries.some((entry) => entry.body.inferredUnit));
    const asStatement = use === true || inferredUnit;
    this.checkWhenExhaustive(subject, isExhaustive, asStatement, row);
    if (!isExhaustive) branchFlows.push(afterHeads);
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
      // A non-null Boolean subject is consumed as a condition is.
      eval: whenEval(
        subject && isNonNullClass(subject.type, this.core.boolean)
          ? checkedBoolean(subject, subject.eval)
          : subject?.eval,
        subjectSlot,
        compiledEntries
      ),
    };
  }

  /** The subject of `when`, which `when (val x = ...)` also stores in its variable, whose smart casts the branches see. */
  private compileWhenSubject(
    scope: Scope,
    context: FunctionContext,
    expression: Extract<Expression, { kind: 'when' }>
  ): Compiled {
    const initializer = this.compileExpression(scope, context, expression.subject as Expression);
    const declaration = expression.subjectVariable;
    if (!declaration) return initializer;
    const declared = declaration.type ? this.resolveType(scope, declaration.type) : undefined;
    const type = declared ?? this.inferredVariableType(initializer);
    const value = this.expectType(initializer, type, declaration.row);
    const variable = this.newVariable(scope, context, declaration.name, type, false, declaration.row);
    this.flow.assigned.add(variable);
    this.flow.maybeAssigned.add(variable);
    if (!declared) this.narrowToCase(keyOf(variable), initializer);
    const { write } = this.variableAccess(context, variable);
    const read = this.readVariable(scope, context, variable, declaration.row);
    const readEval = read.eval;
    return {
      ...read,
      eval: (frame) => {
        write(frame, value(frame));
        return readEval(frame);
      },
    };
  }

  /**
   * The head of a branch with a guard, as `is Int if x > 0 ->` or `else if c ->`, which matches when its condition and
   * then its guard hold. The guard may fail after the condition matched, so the branch covers no case and leaves the
   * later branches no smart cast.
   */
  private compileGuardedEntryHead(
    scope: Scope,
    context: FunctionContext,
    subject: Compiled | undefined,
    entry: Extract<Expression, { kind: 'when' }>['entries'][number]
  ): { tests: ((frame: Frame) => boolean)[]; flow: Flow } {
    if (!subject) this.error(entry.row, 'if のガードは、主語のある when にだけ書けます。');
    if (entry.conditions.length > 1)
      this.error(entry.conditions[1].row, 'if のガードがある分岐には、条件を1つだけ書けます。');
    const before = this.flow.copy();
    const [condition] = entry.conditions;
    let matches: (frame: Frame) => boolean = alwaysMatches;
    if (condition) {
      const compiled = this.compileWhenCondition(scope, context, subject, condition, new WhenCoverage());
      matches = compiled.test;
      this.applyNarrowing(compiled.whenTrue);
    }
    const guard = this.compileCondition(scope, context, entry.guard as Expression);
    const flow = this.withNarrowing(this.flow, guard.whenTrue);
    this.flow = Flow.merge([before, this.flow]);
    const guardEval = guard.compiled.eval;
    return { tests: [(frame) => matches(frame) && (guardEval(frame) as boolean)], flow };
  }

  private compileWhenEntryHead(
    scope: Scope,
    context: FunctionContext,
    subject: Compiled | undefined,
    entry: Extract<Expression, { kind: 'when' }>['entries'][number],
    covered: WhenCoverage
  ): { tests: ((frame: Frame) => boolean)[]; flow: Flow } {
    if (entry.conditions.length === 0) return { tests: [], flow: this.flow.copy() };
    if (!subject && entry.conditions.length > 1)
      this.error(entry.conditions[1].row, '主語のない when では、条件をカンマで区切らずに || でつないでください。');
    const tests: ((frame: Frame) => boolean)[] = [];
    // A condition runs only after the earlier ones failed, and any may match, skipping the later ones.
    const matches: Flow[] = [];
    for (const condition of entry.conditions) {
      const compiled = this.compileWhenCondition(scope, context, subject, condition, covered);
      tests.push(compiled.test);
      matches.push(this.withNarrowing(this.flow, compiled.whenTrue));
      this.flow = this.withNarrowing(this.flow, compiled.whenFalse);
    }
    return { tests, flow: Flow.merge(matches) };
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
      const test = framedInstanceTest(this.core, type);
      const evaluate = convertRepr(subject.eval, subject.repr, 'ref');
      const narrowing = this.typeTestNarrowing(subject, type);
      covered.coverTypeCases(subject.type, type, condition.negated, this.core.boolean);
      const exclusion = isExclusion(subject, type);
      return condition.negated
        ? { test: (frame) => !test(frame, evaluate(frame)), whenTrue: exclusion, whenFalse: narrowing }
        : { test: (frame) => test(frame, evaluate(frame)), whenTrue: narrowing, whenFalse: exclusion };
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
  private compileWhenValue(
    scope: Scope,
    context: FunctionContext,
    subject: Compiled,
    expression: Expression,
    row: number,
    covered: Set<string>
  ): { test: (frame: Frame) => boolean; whenTrue: Map<string, KType>; whenFalse: Map<string, KType> } {
    // A literal keeps its own type here, as kotlinc rejects `6` among a Long subject's branches and `6u` among a ULong's.
    const subjectKind = this.primitiveOf(nonNull(subject.type));
    const keepsIntLiterals = subjectKind !== undefined && LITERAL_KEEPING_KINDS.has(subjectKind);
    const value = this.compileExpression(
      scope,
      context,
      expression,
      keepsIntLiterals ? undefined : nonNull(subject.type)
    );
    this.checkEqualityApplicable(subject, value, row, '==');
    this.recordCovered(value, expression, covered);
    const subjectEval = convertRepr(subject.eval, subject.repr, 'ref');
    const valueEval = convertRepr(
      this.convertTo(value, value.integerLiteral ? nonNull(subject.type) : value.type, row),
      reprOf(this.core, value.integerLiteral ? nonNull(subject.type) : value.type),
      'ref'
    );
    // Two primitive operands compare as numbers, as `0.0 == -0.0` does; an `Any` operand compares with `equals`.
    const comparesPrimitives =
      subjectKind !== undefined &&
      (value.integerLiteral !== undefined || this.primitiveOf(nonNull(value.type)) !== undefined);
    // Compiled on its own, a literal has the type its suffixes and magnitude give it, as `2147483648` is a Long.
    if (keepsIntLiterals && value.integerLiteral && this.primitiveOf(value.type) !== subjectKind) {
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
    const equality = this.equalityNarrowing(subject, value, false, [undefined, expression]);
    for (const [key, type] of equality.whenFalse) narrowing.set(key, type);
    return {
      test: whenValueTest(subjectEval, nullLiteral ? undefined : valueEval, comparesPrimitives),
      whenTrue: nullLiteral ? new Map() : equality.whenTrue,
      whenFalse: narrowing,
    };
  }

  /** Notes the constants a `when` branch covers: enum entries, objects, `true`, `false`, and `null`. */
  private recordCovered(value: Compiled, expression: Expression, covered: Set<string>): void {
    if (expression.kind === 'boolean') covered.add(String(expression.value));
    if (expression.kind === 'null') covered.add('null');
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
      if (local && !local.backingField && !local.delegateRead && this.isNonThrowingExpression(scope, statement.value))
        return;
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
        return Boolean(
          variable && !variable.backingField && !variable.delegateRead && this.flow.assigned.has(variable)
        );
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

  // code-gauge-allow functionNcss -- try, catch clauses, and finally, as an expression.
  // code-gauge-allow functionCognitiveComplexity -- the body, each catch clause, and finally take their own entry flows.
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
    const blocks = [expression.body, ...expression.catches.map((clause) => clause.body)];
    const hint = this.inferBranchType(context, blocks, expected, use, (index, probe) => {
      this.flow = before.copy();
      const clause = expression.catches[index - 1];
      if (clause) this.forgetAssignedIn(scope, expression.body.statements);
      const branchScope = clause ? this.catchParameter(scope, probe, clause).scope : scope;
      return this.compileBlockValue(branchScope, probe, blocks[index], undefined, use);
    });
    const body = this.compileTryBlock(
      scope,
      context,
      expression.body,
      typeForBranch(expression.body, expected, hint),
      use,
      bodyThrows
    );
    const flows = [this.flow];
    const assignmentsBeforeThrow = Flow.merge([before, ...bodyThrows]).maybeAssigned;
    for (const target of this.flow.maybeAssigned) assignmentsBeforeThrow.add(target);
    const catches = expression.catches.map((clause) => {
      this.flow = before.copy();
      this.forgetAssignedIn(scope, expression.body.statements);
      for (const variable of assignmentsBeforeThrow) this.flow.maybeAssigned.add(variable);
      const binding = this.catchParameter(scope, context, clause);
      const value = this.compileTryBlock(
        binding.scope,
        context,
        clause.body,
        typeForBranch(clause.body, expected, hint),
        use,
        catchThrows
      );
      flows.push(this.flow);
      return { ...binding, value };
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
    const clauses = catches.map(({ test, write, slot, value }) => ({ test, write, slot, value: convert(value) }));
    return { type, repr, inferredUnit: inferredUnit || undefined, eval: tryEval(convert(body), clauses, finallyEval) };
  }

  private catchParameter(
    scope: Scope,
    context: FunctionContext,
    clause: Extract<Expression, { kind: 'try' }>['catches'][number]
  ): { scope: Scope; test: (value: Value) => boolean; write: (frame: Frame, value: Value) => void; slot: number } {
    const catchScope = new Scope(scope, context);
    const type = this.resolveType(scope, clause.type);
    if (!isSubtype(type, this.core.throwable.type))
      this.error(clause.row, typeMismatchMessage(this.core.throwable.type, type));
    const variable = this.newVariable(catchScope, context, clause.name, type, false, clause.row);
    this.flow.assigned.add(variable);
    const { write } = this.variableAccess(context, variable);
    return { scope: catchScope, test: instanceTest(this.core, type), write, slot: variable.slot };
  }

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
    keepAssignedBefore(this.flow, beforeTry);
    const atEntry = new Map(this.flow.narrowed);
    const exitStarts = loopExits.map(({ exits }) => exits.length);
    const evaluate = this.compileBlockValue(scope, context, block, undefined, true).eval;
    const afterFinally = this.flow;
    const finallyJumps = loopExits.flatMap(({ exits }, index) => exits.slice(exitStarts[index]));
    applyFinallyJumpFields(finallyJumps, beforeTry, afterTry);
    const assignedKeys = [...assignedNames(block.statements)].flatMap((name) => {
      const variable = this.findVariable(scope, name);
      return variable ? [keyOf(variable)] : [];
    });
    const effect = finallyEffect(afterFinally, atEntry, assignedKeys);
    const transfer = (flow: Flow): Flow => throughFinally(flow, effect);
    this.flow = transfer(afterTry);
    if (afterFinally.isDead) return evaluate;
    for (const { exits, pending } of loopExits) {
      for (const flow of pending) exits.push(transfer(flow));
    }
    return evaluate;
  }
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

function alwaysMatches(): boolean {
  return true;
}

function typeForBranch(block: Block, expected: KType | undefined, inferred: KType | undefined): KType | undefined {
  return inferred && isBareCall(block) ? inferred : expected;
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

/** @param valueEval The branch value, or `undefined` for the `null` literal. */
function whenValueTest(
  subjectEval: Eval,
  valueEval: Eval | undefined,
  comparesPrimitives: boolean
): (frame: Frame) => boolean {
  return (frame) => {
    const a = subjectEval(frame);
    if (!valueEval) return a === NULL;
    const b = valueEval(frame);
    if (a instanceof Boxed && b instanceof Boxed && comparesPrimitives) return a.value === b.value;
    return valueEquals(frame, a, b);
  };
}

/** The integer kinds that an integer literal does not convert to among a `when` subject's branches. */
const LITERAL_KEEPING_KINDS: ReadonlySet<string> = new Set(['Long', 'Byte', 'Short', 'ULong', 'UByte', 'UShort']);
