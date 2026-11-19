// oxlint-disable unicorn/prefer-code-point -- C# characters are UTF-16 code units, which code points would merge.
import { BinderBase } from './binderBase';
import type {
  BoundArgument,
  BoundBlock,
  BoundDeconstructTarget,
  BoundExpression,
  BoundInitializerEntry,
  BoundLValue,
  BoundPattern,
  BoundStatement,
  LambdaInfo,
} from './bound';
import type { CompiledProgram } from './compiler';
import type { ConversionKind, Conversions } from './conversions';
import { CsDecimal } from './decimal';
import { formatValue } from './library/formatting';
import type { NativeCall } from './natives';
import {
  arithmetic,
  compareNumeric,
  convertNumeric,
  type NumericValue,
  PendingException,
  stepNumeric,
  unaryNumeric,
} from './numeric';
import { environmentOf, exceptionMessage, recordMember, runtimeTypeName, stringOf, valuesEqual } from './objects';
import { CsThrow, type ExceptionState, Frame, type Runtime, type Slot, StackOverflow } from './runtime';
import {
  type ArrayType,
  baseTypeOf,
  type FieldSymbol,
  isReferenceType,
  type LocalSymbol,
  type MethodSymbol,
  type NamedType,
  namedType,
  nullableUnderlying,
  type PropertySymbol,
  sameType,
  specialOf,
  type SpecialType,
  substitute,
  substitutionOf,
  type Type,
  type TypeParameterSymbol,
} from './types';
import {
  Cell,
  copyValue,
  CsArray,
  CsBox,
  CsDelegate,
  CsObject,
  CsStruct,
  type DelegateEntry,
  UNASSIGNED,
  type Value,
  type VariableReference,
} from './values';

const BREAK = Symbol('break');
const CONTINUE = Symbol('continue');
interface ReturnCompletion {
  value: Value;
}
type Completion = undefined | typeof BREAK | typeof CONTINUE | ReturnCompletion;

/** A `ref` or `out` argument, which reads and writes the caller's variable. */
export class Reference implements VariableReference {
  constructor(
    readonly get: () => Value,
    readonly set: (value: Value) => void
  ) {}
}

/** Storage that an assignment reads and writes after evaluating its receiver and indices once. */
interface Place {
  get(): Value;
  set(value: Value): void;
}

const NULL_REFERENCE = (): PendingException =>
  new PendingException('System.NullReferenceException', 'Object reference not set to an instance of an object.');

/** Runs the bound tree of a compiled program. */
export class Evaluator {
  /** Whether statements record steps, which only traces need. */
  tracing = false;

  private readonly conversions: Conversions;

  constructor(
    readonly runtime: Runtime,
    readonly program: CompiledProgram
  ) {
    runtime.evaluator = this;
    this.conversions = new BinderBase(program.library).conversions;
  }

  // ---- Calls ----

  /** Calls a method with a receiver and arguments that the caller already evaluated. */
  invoke(
    caller: Frame,
    method: MethodSymbol,
    receiver: Value,
    args: (Value | VariableReference)[],
    callRow: number | undefined,
    typeEnvironment: Map<TypeParameterSymbol, Type>,
    captured?: Map<LocalSymbol, Cell>
  ): Value {
    // A struct's method called through its box, as a virtual call on an object does, runs on the boxed value.
    const self = receiver instanceof CsBox && method.owner.isValueType ? receiver.value : receiver;
    if (method.native) {
      this.runtime.spend();
      const call: NativeCall = {
        frame: caller,
        method,
        typeArgs: method.typeParameters.map((parameter) => typeEnvironment.get(parameter) ?? parameter.type),
        owner: this.ownerFromEnvironment(method, typeEnvironment),
      };
      return method.native(call, self, args);
    }
    const body = method.body;
    if (!body) {
      if (method.isAbstract)
        throw new PendingException('System.EntryPointNotFoundException', `Entry point was not found.`);
      return undefined;
    }
    const frame = new Frame(this.runtime, method, self, typeEnvironment, callRow, method.locals.length);
    if (captured) frame.captured = captured;
    for (const [index, local] of method.locals.entries()) {
      if (!local.isParameter || local.owner !== method) continue;
      const arg = args[index];
      frame.slots[local.slot] = local.isCaptured ? new Cell(arg as Value) : arg;
    }
    this.runtime.pushFrame(frame);
    try {
      if (method.kind === 'constructor') this.runConstructorPrologue(frame, method);
      const completion = this.executeBlock(body, frame);
      return completion !== undefined && typeof completion === 'object' ? completion.value : undefined;
    } finally {
      this.runtime.popFrame();
    }
  }

  private ownerFromEnvironment(
    method: MethodSymbol,
    environment: Map<TypeParameterSymbol, Type>
  ): NamedType | undefined {
    const parameters = method.owner.allTypeParameters;
    if (parameters.length === 0) return method.owner.declaredType;
    return namedType(
      method.owner,
      parameters.map((parameter) => environment.get(parameter) ?? parameter.type)
    );
  }

  /** Runs a constructor's field initializers and its call of another constructor, before its body. */
  private runConstructorPrologue(frame: Frame, constructor: MethodSymbol): void {
    const initializer = constructor.constructorInitializer;
    const isThisChain = (initializer as { isThisInitializer?: boolean } | undefined)?.isThisInitializer === true;
    const owner = constructor.owner;
    if (!isThisChain && owner.instanceInitializer)
      this.runInitializer(owner.instanceInitializer, owner.initializerLocals, frame, frame.thisValue, false);
    if (initializer) this.evaluate(initializer, frame);
  }

  /** Runs a type's static field initializers and its static constructor, as the type's first use does. */
  runStaticInitialization(type: NamedType): void {
    const symbol = type.symbol;
    const environment = substitutionOf(type);
    const frame = new Frame(this.runtime, undefined, undefined, environment, undefined, 0);
    if (symbol.staticInitializer)
      this.runInitializer(
        symbol.staticInitializer,
        symbol.staticInitializerLocals,
        frame,
        undefined,
        true,
        environment
      );
    if (symbol.staticConstructor) this.invoke(frame, symbol.staticConstructor, undefined, [], undefined, environment);
  }

  private runInitializer(
    block: BoundBlock,
    locals: LocalSymbol[],
    caller: Frame,
    thisValue: Value,
    isStatic: boolean,
    environment = caller.typeEnvironment
  ): void {
    const owner = locals[0]?.owner;
    const frame = new Frame(this.runtime, owner, thisValue, environment, undefined, locals.length);
    // Initializers run as part of the constructor or type initialization that started them, in its frame for traces.
    if (isStatic) {
      this.runtime.pushFrame(frame);
      try {
        this.executeBlock(block, frame);
      } finally {
        this.runtime.frames.pop();
      }
      return;
    }
    const slots = caller.slots;
    void slots;
    this.executeInitializerStatements(block, caller, frame);
  }

  /** Runs instance field initializers in the constructor's frame, so that the trace shows their steps there. */
  private executeInitializerStatements(block: BoundBlock, constructorFrame: Frame, initializerFrame: Frame): void {
    for (const statement of block.statements) {
      if (statement.kind !== 'expression') continue;
      const run = (): void => {
        this.evaluate(statement.expression, initializerFrame.slots.length > 0 ? initializerFrame : constructorFrame);
      };
      this.withStep(statement.row, statement.step, run);
    }
  }

  /** Calls a delegate's invocation list, returning the last result. */
  invokeDelegate(
    caller: Frame,
    target: Value,
    args: (Value | VariableReference)[],
    callRow: number | undefined
  ): Value {
    if (!(target instanceof CsDelegate)) throw NULL_REFERENCE();
    let result: Value = undefined;
    for (const entry of target.entries) result = this.invokeEntry(caller, entry, args, callRow);
    return result;
  }

  invokeEntry(
    caller: Frame,
    entry: DelegateEntry,
    args: (Value | VariableReference)[],
    callRow: number | undefined
  ): Value {
    if (entry.native) return entry.native(args as Value[]);
    if (entry.lambda) {
      const { info, cells, thisValue, typeEnvironment } = entry.lambda;
      return this.invoke(
        caller,
        info.method,
        thisValue,
        args,
        callRow,
        typeEnvironment as Map<TypeParameterSymbol, Type>,
        cells as Map<LocalSymbol, Cell>
      );
    }
    const method = entry.method as MethodSymbol;
    if (method.isExtension && !entry.lambda && entry.target !== undefined && method.isStatic) {
      return this.invoke(
        caller,
        method,
        undefined,
        [entry.target, ...args],
        callRow,
        this.environmentOf(method, entry.owner, entry.typeArgs)
      );
    }
    const implementation = entry.isVirtual ? this.runtime.dispatch(method, entry.target) : method;
    const owner = entry.isVirtual
      ? (this.ownerOfImplementation(implementation, entry.target) ?? entry.owner)
      : entry.owner;
    return this.invoke(
      caller,
      implementation,
      entry.target,
      args,
      callRow,
      this.environmentOf(implementation, owner, entry.typeArgs),
      this.localFunctionCells(caller, method)
    );
  }

  /** The type environment of a call: the owner type's arguments and the method's own. */
  environmentOf(method: MethodSymbol, owner: NamedType | undefined, typeArgs: Type[]): Map<TypeParameterSymbol, Type> {
    const environment = owner ? substitutionOf(owner) : new Map<TypeParameterSymbol, Type>();
    for (const [index, parameter] of method.typeParameters.entries()) environment.set(parameter, typeArgs[index]);
    return environment;
  }

  /** The constructed type that declares an implementation, as the receiver's runtime type sees it. */
  private ownerOfImplementation(method: MethodSymbol, receiver: Value): NamedType | undefined {
    const type = this.runtime.runtimeTypeOf(receiver);
    if (!type || type.kind !== 'named') return undefined;
    for (let current: NamedType | undefined = type; current; current = baseTypeOf(current))
      if (current.symbol === method.owner) return current;
    return undefined;
  }

  /** The cells that a local function reads from the functions around its call. */
  private localFunctionCells(frame: Frame, method: MethodSymbol): Map<LocalSymbol, Cell> | undefined {
    if (method.kind !== 'localFunction' || method.captures.length === 0) return undefined;
    const cells = new Map<LocalSymbol, Cell>();
    for (const local of method.captures) cells.set(local, this.cellOf(frame, local));
    return cells;
  }

  private cellOf(frame: Frame, local: LocalSymbol): Cell {
    if (local.owner === frame.method) {
      const slot = frame.slots[local.slot];
      if (slot instanceof Cell) return slot;
      const cell = new Cell(slot as Value | typeof UNASSIGNED);
      frame.slots[local.slot] = cell;
      return cell;
    }
    const cell = frame.captured.get(local);
    if (cell) return cell;
    const created = new Cell(UNASSIGNED);
    frame.captured.set(local, created);
    return created;
  }

  // ---- Statements ----

  /** Runs a statement, recording its step when it completes as the trace's rules say. */
  private withStep<T>(row: number, step: BoundStatement['step'], run: () => T): T {
    if (!this.tracing || step === 'none') return run();
    return this.runtime.steps.runStatement(row, step === 'callsOnly', run);
  }

  executeBlock(block: BoundBlock, frame: Frame): Completion {
    for (const local of block.capturedLocals) frame.slots[local.slot] = new Cell(UNASSIGNED);
    try {
      for (const statement of block.statements) {
        const completion = this.execute(statement, frame);
        if (completion !== undefined) return completion;
      }
      return undefined;
    } finally {
      // Locals go out of scope when their block ends, so the trace stops showing them.
      for (const local of block.locals) if (!local.isCaptured) frame.slots[local.slot] = UNASSIGNED;
    }
  }

  // code-gauge-allow functionNcss 120 -- One case per kind of statement.
  execute(statement: BoundStatement, frame: Frame): Completion {
    this.runtime.spend();
    switch (statement.kind) {
      case 'block': {
        if ((statement as { isDeclarationGroup?: boolean }).isDeclarationGroup) {
          return this.withStep<Completion>(statement.row, statement.step, () => {
            for (const inner of statement.statements) this.execute(inner, frame);
            return;
          });
        }
        return this.executeBlock(statement, frame);
      }
      case 'empty': {
        return undefined;
      }
      case 'expression': {
        this.withStep(statement.row, statement.step, () => this.evaluate(statement.expression, frame));
        return undefined;
      }
      case 'localDeclaration': {
        this.withStep(statement.row, statement.step, () => {
          if (statement.value)
            this.storeLocal(frame, statement.local, copyValue(this.evaluate(statement.value, frame)));
        });
        return undefined;
      }
      case 'if': {
        if (this.evaluate(statement.condition, frame) as boolean) return this.execute(statement.consequence, frame);
        return statement.alternative ? this.execute(statement.alternative, frame) : undefined;
      }
      case 'while': {
        while (this.evaluate(statement.condition, frame) as boolean) {
          const completion = this.execute(statement.body, frame);
          if (completion === BREAK) break;
          if (completion !== undefined && completion !== CONTINUE) return completion;
        }
        return undefined;
      }
      case 'do': {
        do {
          const completion = this.execute(statement.body, frame);
          if (completion === BREAK) break;
          if (completion !== undefined && completion !== CONTINUE) return completion;
        } while (this.evaluate(statement.condition, frame) as boolean);
        return undefined;
      }
      case 'for': {
        return this.executeFor(statement, frame);
      }
      case 'foreach': {
        return this.executeForeach(statement, frame);
      }
      case 'switch': {
        return this.executeSwitch(statement, frame);
      }
      case 'break': {
        return BREAK;
      }
      case 'continue': {
        return CONTINUE;
      }
      case 'return': {
        return { value: statement.value ? this.evaluate(statement.value, frame) : undefined };
      }
      case 'throw': {
        if (!statement.value) {
          const current = this.currentExceptions.at(-1);
          if (!current) throw NULL_REFERENCE();
          throw current;
        }
        throw this.throwValue(this.evaluate(statement.value, frame));
      }
      case 'try': {
        return this.executeTry(statement, frame);
      }
    }
  }

  private executeFor(statement: Extract<BoundStatement, { kind: 'for' }>, frame: Frame): Completion {
    for (const local of statement.capturedLocals) frame.slots[local.slot] = new Cell(UNASSIGNED);
    try {
      if (statement.initializers.length > 0) {
        this.withStep(statement.row, this.headerStep(statement.initializers), () => {
          for (const initializer of statement.initializers) this.execute(withoutStep(initializer), frame);
        });
      }
      while (!statement.condition || (this.evaluate(statement.condition, frame) as boolean)) {
        const completion = this.execute(statement.body, frame);
        if (completion === BREAK) break;
        if (completion !== undefined && completion !== CONTINUE) return completion;
        if (statement.updates.length > 0) {
          this.withStep(statement.row, 'step', () => {
            for (const update of statement.updates) this.evaluate(update, frame);
          });
        }
      }
      return undefined;
    } finally {
      for (const local of statement.locals) if (!local.isCaptured) frame.slots[local.slot] = UNASSIGNED;
    }
  }

  /** A for loop's initializers record one step, unless they declare without initializing. */
  private headerStep(initializers: BoundStatement[]): BoundStatement['step'] {
    const recordsStep = initializers.some(
      (initializer) => initializer.step !== 'none' || initializer.kind === 'expression'
    );
    return recordsStep ? 'step' : 'none';
  }

  private executeForeach(statement: Extract<BoundStatement, { kind: 'foreach' }>, frame: Frame): Completion {
    const collection = this.evaluate(statement.collection, frame);
    if (collection === undefined) throw NULL_REFERENCE();
    frame.temporaries.push(collection);
    try {
      const runIteration = (element: Value): Completion => {
        const converted = statement.elementConversion
          ? this.withOperand(frame, element, () => this.evaluate(statement.elementConversion as BoundExpression, frame))
          : element;
        this.storeLocal(frame, statement.variable, copyValue(converted), true);
        if (statement.deconstruction) this.evaluate(statement.deconstruction, frame);
        if (this.tracing) this.runtime.steps.stepBinding(statement.row, statement.bindingStoresAnswer);
        return this.execute(statement.body, frame);
      };
      return this.iterate(statement, collection, frame, runIteration);
    } finally {
      frame.temporaries.pop();
      for (const local of [statement.variable, ...statement.locals])
        if (!local.isCaptured) frame.slots[local.slot] = UNASSIGNED;
    }
  }

  private iterate(
    statement: Extract<BoundStatement, { kind: 'foreach' }>,
    collection: Value,
    frame: Frame,
    runIteration: (element: Value) => Completion
  ): Completion {
    const { iteration } = statement;
    const handle = (completion: Completion): Completion | 'stop' | 'next' => {
      if (completion === BREAK) return 'stop';
      if (completion === undefined || completion === CONTINUE) return 'next';
      return completion;
    };
    if (iteration.kind === 'array') {
      const array = collection as CsArray;
      for (let index = 0; index < array.values.length; index++) {
        const result = handle(runIteration(array.values[index]));
        if (result === 'stop') return undefined;
        if (result !== 'next') return result;
      }
      return undefined;
    }
    if (iteration.kind === 'string') {
      const text = collection as string;
      for (let index = 0; index < text.length; index++) {
        const result = handle(runIteration(text.charCodeAt(index)));
        if (result === 'stop') return undefined;
        if (result !== 'next') return result;
      }
      return undefined;
    }
    const receiverType = this.runtime.runtimeTypeOf(collection);
    const getEnumerator =
      iteration.getEnumerator.owner.kind === 'interface' || iteration.getEnumerator.isVirtual
        ? this.runtime.dispatch(iteration.getEnumerator, collection)
        : iteration.getEnumerator;
    const enumerator = this.invoke(
      frame,
      getEnumerator,
      collection,
      [],
      statement.row,
      this.environmentFor(getEnumerator, receiverType)
    );
    if (enumerator === undefined) throw NULL_REFERENCE();
    frame.temporaries.push(enumerator);
    try {
      const enumeratorType = this.runtime.runtimeTypeOf(enumerator);
      const moveNext = this.runtime.dispatch(iteration.moveNext, enumerator);
      const getter = iteration.current.getter as MethodSymbol;
      const current = this.runtime.dispatch(getter, enumerator);
      for (;;) {
        if (
          !(this.invoke(
            frame,
            moveNext,
            enumerator,
            [],
            statement.row,
            this.environmentFor(moveNext, enumeratorType)
          ) as boolean)
        )
          return undefined;
        const element = this.invoke(
          frame,
          current,
          enumerator,
          [],
          statement.row,
          this.environmentFor(current, enumeratorType)
        );
        const result = handle(runIteration(element));
        if (result === 'stop') return undefined;
        if (result !== 'next') return result;
      }
    } finally {
      frame.temporaries.pop();
      if (iteration.dispose) {
        const dispose = this.runtime.dispatch(iteration.dispose, enumerator);
        this.invoke(
          frame,
          dispose,
          enumerator,
          [],
          statement.row,
          this.environmentFor(dispose, this.runtime.runtimeTypeOf(enumerator))
        );
      }
    }
  }

  /** The type environment of an instance method called on a receiver of a runtime type. */
  private environmentFor(method: MethodSymbol, receiverType: Type | undefined): Map<TypeParameterSymbol, Type> {
    if (!receiverType || receiverType.kind !== 'named') return new Map();
    for (let current: NamedType | undefined = receiverType; current; current = baseTypeOf(current)) {
      if (current.symbol === method.owner) return substitutionOf(current);
    }
    return substitutionOf(receiverType);
  }

  private executeSwitch(statement: Extract<BoundStatement, { kind: 'switch' }>, frame: Frame): Completion {
    const value = this.evaluate(statement.value, frame);
    let chosen: (typeof statement.sections)[number] | undefined;
    let defaultSection: (typeof statement.sections)[number] | undefined;
    search: for (const section of statement.sections) {
      for (const label of section.labels) {
        if (label === 'default') {
          defaultSection = section;
          continue;
        }
        if (
          this.matches(label.pattern, value, frame) &&
          (!label.guard || (this.evaluate(label.guard, frame) as boolean))
        ) {
          chosen = section;
          break search;
        }
      }
    }
    chosen ??= defaultSection;
    if (!chosen) return undefined;
    for (const inner of chosen.statements) {
      const completion = this.execute(inner, frame);
      if (completion === BREAK) return undefined;
      if (completion !== undefined) return completion;
    }
    return undefined;
  }

  /** The exceptions that catch clauses are handling, which `throw;` rethrows. */
  private readonly currentExceptions: CsThrow[] = [];

  private executeTry(statement: Extract<BoundStatement, { kind: 'try' }>, frame: Frame): Completion {
    let completion: Completion;
    try {
      try {
        completion = this.executeBlock(statement.body, frame);
      } catch (error) {
        const thrown = this.asThrow(error);
        if (!thrown) throw error;
        const handled = this.handle(statement, thrown, frame);
        if (handled === 'unhandled') throw thrown;
        completion = handled;
      }
    } finally {
      if (statement.finally) {
        const finallyCompletion = this.runFinally(statement.finally, frame);
        if (finallyCompletion !== undefined) completion = finallyCompletion;
      }
    }
    return completion;
  }

  private runFinally(block: BoundBlock, frame: Frame): Completion {
    return this.executeBlock(block, frame);
  }

  /** Runs the first catch clause that accepts an exception, or tells that none did. */
  private handle(
    statement: Extract<BoundStatement, { kind: 'try' }>,
    thrown: CsThrow,
    frame: Frame
  ): Completion | 'unhandled' {
    for (const clause of statement.catches) {
      if (!this.isInstanceOf(thrown.exception, clause.type)) continue;
      if (clause.local) this.storeLocal(frame, clause.local, thrown.exception, true);
      if (clause.filter && !(this.evaluate(clause.filter, frame) as boolean)) continue;
      this.currentExceptions.push(thrown);
      try {
        return this.executeBlock(clause.body, frame);
      } finally {
        this.currentExceptions.pop();
      }
    }
    return 'unhandled';
  }

  /** The C# exception that a host error stands for, if the program can catch it. */
  asThrow(error: unknown): CsThrow | undefined {
    if (error instanceof CsThrow) return error;
    if (error instanceof PendingException) {
      const exception = this.runtime.materialize(error);
      (exception.native as ExceptionState).wasThrown = true;
      return new CsThrow(exception);
    }
    return undefined;
  }

  private throwValue(value: Value): CsThrow {
    if (!(value instanceof CsObject)) throw NULL_REFERENCE();
    if (value.native) (value.native as ExceptionState).wasThrown = true;
    return new CsThrow(value);
  }

  // ---- Locals ----

  readLocal(frame: Frame, local: LocalSymbol): Value {
    const slot: Slot =
      local.owner === frame.method || !local.owner ? frame.slots[local.slot] : frame.captured.get(local);
    if (slot === UNASSIGNED) return undefined;
    if (slot instanceof Cell) return slot.value === UNASSIGNED ? undefined : (slot.value as Value);
    if (slot instanceof Reference) return slot.get();
    return slot as Value;
  }

  /** Stores a local's value; a fresh variable of a loop or a catch clause gets a fresh cell when lambdas capture it. */
  storeLocal(frame: Frame, local: LocalSymbol, value: Value, isFresh = false): void {
    if (local.owner !== frame.method && local.owner) {
      const cell = frame.captured.get(local);
      if (cell) cell.value = value;
      return;
    }
    const slot = frame.slots[local.slot];
    if (local.isCaptured && (isFresh || !(slot instanceof Cell))) {
      frame.slots[local.slot] = new Cell(value);
      return;
    }
    if (slot instanceof Cell) slot.value = value;
    else if (slot instanceof Reference) slot.set(value);
    else frame.slots[local.slot] = value;
  }

  // ---- Expressions ----

  private withOperand<T>(frame: Frame, value: Value, run: () => T): T {
    frame.operands.push(value);
    try {
      return run();
    } finally {
      frame.operands.pop();
    }
  }

  // code-gauge-allow functionNcss 220 -- One case per kind of bound expression.
  evaluate(expression: BoundExpression, frame: Frame): Value {
    switch (expression.kind) {
      case 'constant': {
        return expression.value as Value;
      }
      case 'local': {
        return this.readLocal(frame, expression.local);
      }
      case 'this': {
        return frame.thisValue;
      }
      case 'field': {
        const receiver = this.evaluate(expression.receiver, frame);
        return this.fieldsOf(receiver)[expression.field.slot];
      }
      case 'staticField': {
        return this.runtime.staticsOf(frame.resolve(expression.owner) as NamedType)[expression.field.slot];
      }
      case 'element': {
        return this.elementPlace(expression, frame).get();
      }
      case 'call': {
        return this.evaluateCall(expression, frame);
      }
      case 'property': {
        return this.propertyPlace(expression, frame).get();
      }
      case 'invokeDelegate': {
        const target = this.evaluate(expression.target, frame);
        frame.temporaries.push(target);
        try {
          const args = this.evaluateArguments(expression.args, frame);
          return this.invokeDelegate(frame, target, args, expression.row);
        } finally {
          frame.temporaries.pop();
        }
      }
      case 'new': {
        return this.evaluateNew(expression, frame);
      }
      case 'newArray': {
        return this.evaluateNewArray(expression, frame);
      }
      case 'newDelegate': {
        const receiver = expression.receiver ? this.evaluate(expression.receiver, frame) : undefined;
        if (expression.receiver && receiver === undefined && !expression.method.isExtension) throw NULL_REFERENCE();
        const entry: DelegateEntry = {
          method: expression.method,
          target: expression.method.isStatic && !expression.method.isExtension ? undefined : copyValue(receiver),
          typeArgs: expression.typeArgs.map((type) => frame.resolve(type)),
          owner: expression.owner ? (frame.resolve(expression.owner) as NamedType) : undefined,
          isVirtual: expression.isVirtual,
        };
        if (expression.method.kind === 'localFunction') {
          const cells = this.localFunctionCells(frame, expression.method);
          return new CsDelegate(frame.resolve(expression.type) as NamedType, [
            {
              ...entry,
              target: frame.thisValue,
              lambda: {
                info: { method: expression.method, captures: expression.method.captures, isStatic: false },
                cells: cells ?? new Map(),
                thisValue: frame.thisValue,
                typeEnvironment: frame.typeEnvironment,
              },
            },
          ]);
        }
        return new CsDelegate(frame.resolve(expression.type) as NamedType, [entry]);
      }
      case 'lambda': {
        return this.createLambda(expression.lambda, expression.type, frame);
      }
      case 'unary': {
        return this.evaluateUnary(expression, this.evaluate(expression.operand, frame));
      }
      case 'binary': {
        return this.evaluateBinary(expression, frame);
      }
      case 'logical': {
        const left = this.evaluate(expression.left, frame) as boolean;
        if (expression.operator === '&&') return left && (this.evaluate(expression.right, frame) as boolean);
        return left || (this.evaluate(expression.right, frame) as boolean);
      }
      case 'coalesce': {
        const left = this.evaluate(expression.left, frame);
        if (left !== undefined) return left;
        return this.evaluate(expression.right, frame);
      }
      case 'conditional': {
        return this.evaluate(expression.condition, frame)
          ? this.evaluate(expression.whenTrue, frame)
          : this.evaluate(expression.whenFalse, frame);
      }
      case 'convert': {
        return this.convertValue(
          this.evaluate(expression.operand, frame),
          expression.conversion,
          frame.resolve(expression.from),
          frame.resolve(expression.type)
        );
      }
      case 'assign': {
        if (expression.target.kind === 'discard') return this.evaluate(expression.value, frame);
        const place = this.place(expression.target, frame);
        const value = copyValue(this.evaluate(expression.value, frame));
        place.set(value);
        return value;
      }
      case 'compoundAssign': {
        const place = this.place(expression.target, frame);
        const current = place.get();
        const value = this.withOperand(frame, current, () => this.evaluate(expression.operation, frame));
        place.set(value);
        return value;
      }
      case 'compoundOperand': {
        return frame.operands.at(-1) as Value;
      }
      case 'increment': {
        const place = this.place(expression.target, frame);
        const current = place.get();
        const next = this.withOperand(frame, current, () => this.evaluate(expression.operation, frame));
        place.set(next);
        return expression.isPrefix ? next : current;
      }
      case 'is': {
        return this.matches(expression.pattern, this.evaluate(expression.operand, frame), frame);
      }
      case 'as': {
        const value = this.evaluate(expression.operand, frame);
        const target = frame.resolve(expression.targetType);
        if (value === undefined) return undefined;
        const underlying = nullableUnderlying(target);
        if (underlying) return value instanceof CsBox && this.isInstanceOf(value, underlying) ? value.value : undefined;
        return this.isInstanceOf(value, target) ? value : undefined;
      }
      case 'switch': {
        const value = this.evaluate(expression.value, frame);
        for (const arm of expression.arms) {
          if (this.matches(arm.pattern, value, frame) && (!arm.guard || (this.evaluate(arm.guard, frame) as boolean)))
            return this.evaluate(arm.value, frame);
        }
        throw new PendingException(
          'System.Runtime.CompilerServices.SwitchExpressionException',
          `Non-exhaustive switch expression failed to match its input.\nUnmatched value was ${this.evaluator().formatUnmatched(value, expression.value.type, frame)}.`
        );
      }
      case 'concat': {
        let text = '';
        for (const part of expression.parts) {
          const value = this.evaluate(part, frame);
          text += this.stringOf(value, frame.resolve(part.type), frame);
        }
        this.runtime.allocateString(text.length);
        return text;
      }
      case 'interpolated': {
        return this.evaluateInterpolated(expression, frame);
      }
      case 'tuple': {
        const type = frame.resolve(expression.type) as NamedType;
        return new CsStruct(
          type,
          expression.elements.map((element) => copyValue(this.evaluate(element, frame)))
        );
      }
      case 'conditionalAccess': {
        const receiver = this.evaluate(expression.receiver, frame);
        if (receiver === undefined) return undefined;
        this.storeLocal(frame, expression.temporary, receiver);
        return this.evaluate(expression.access, frame);
      }
      case 'throw': {
        throw this.throwValue(this.evaluate(expression.value, frame));
      }
      case 'with': {
        const source = this.evaluate(expression.value, frame);
        if (source === undefined) throw NULL_REFERENCE();
        const copy = source instanceof CsStruct ? source.clone() : this.cloneObject(source as CsObject);
        this.storeLocal(frame, expression.temporary, copy);
        for (const assignment of expression.assignments) {
          if (assignment.target.kind === 'discard' || !assignment.value) continue;
          const place = this.place(assignment.target, frame);
          place.set(copyValue(this.evaluate(assignment.value, frame)));
        }
        return copy;
      }
      case 'default': {
        return this.defaultOf(frame.resolve(expression.type));
      }
      case 'deconstructAssign': {
        const value = this.evaluate(expression.value, frame);
        frame.temporaries.push(value);
        try {
          this.deconstruct(expression.targets, value, frame);
        } finally {
          frame.temporaries.pop();
        }
        return undefined;
      }
      case 'eventAccessor': {
        const place = this.place(expression.target, frame);
        const value = this.evaluate(expression.value, frame);
        place.set(expression.isAdd ? combineDelegates(place.get(), value) : removeDelegate(place.get(), value));
        return undefined;
      }
      case 'sequence': {
        for (const effect of expression.sideEffects) this.evaluate(effect, frame);
        return this.evaluate(expression.value, frame);
      }
      case 'unbound': {
        throw new Error(`Cannot evaluate ${expression.kind}`);
      }
    }
  }

  private evaluator(): Evaluator {
    return this;
  }

  /** The text of the value that a switch expression failed to match, as `SwitchExpressionException` shows it. */
  formatUnmatched(value: Value, type: Type, frame: Frame): string {
    return this.stringOf(value, frame.resolve(type), frame);
  }

  /** The fields of an object or struct, failing on null as reading a member of null does. */
  private fieldsOf(receiver: Value): Value[] {
    if (receiver instanceof CsObject || receiver instanceof CsStruct) return receiver.fields;
    if (receiver instanceof CsBox && receiver.value instanceof CsStruct) return receiver.value.fields;
    throw NULL_REFERENCE();
  }

  private evaluateCall(expression: Extract<BoundExpression, { kind: 'call' }>, frame: Frame): Value {
    const { method } = expression;
    let receiver: Value = undefined;
    if (expression.receiver) {
      receiver = this.evaluate(expression.receiver, frame);
      if (receiver === undefined && !method.isStatic) throw NULL_REFERENCE();
      // A method of a struct runs on a copy of a value that is not a variable, so it cannot change the original.
      if (receiver instanceof CsStruct && !this.isVariableExpression(expression.receiver)) receiver = receiver.clone();
    } else if (!method.isStatic && method.kind !== 'localFunction') {
      receiver = frame.thisValue;
    }
    if (method.kind === 'localFunction') receiver = frame.thisValue;
    frame.temporaries.push(receiver);
    try {
      const args = this.evaluateArguments(expression.args, frame);
      const owner = expression.owner ? (frame.resolve(expression.owner) as NamedType) : undefined;
      if (method.isStatic && owner && method.owner.staticConstructor) this.runtime.ensureInitialized(owner);
      const typeArgs = expression.typeArgs.map((type) => frame.resolve(type));
      if (expression.isVirtual && receiver !== undefined) {
        const implementation = this.runtime.dispatch(method, receiver);
        const implementationOwner = this.ownerOfImplementation(implementation, receiver) ?? owner;
        return this.invoke(
          frame,
          implementation,
          receiver,
          args,
          expression.row,
          this.environmentOf(implementation, implementationOwner, typeArgs)
        );
      }
      return this.invoke(
        frame,
        method,
        receiver,
        args,
        expression.row,
        this.environmentOf(method, owner, typeArgs),
        this.localFunctionCells(frame, method)
      );
    } finally {
      frame.temporaries.pop();
    }
  }

  /** Whether an expression denotes storage, whose struct a method call may change in place. */
  private isVariableExpression(expression: BoundExpression): boolean {
    switch (expression.kind) {
      case 'local':
      case 'this':
      case 'element':
      case 'staticField':
      case 'compoundOperand': {
        return true;
      }
      case 'field': {
        return !expression.field.isReadonly && this.isVariableExpression(expression.receiver);
      }
      default: {
        return false;
      }
    }
  }

  /** Evaluates arguments in order: values copied as their parameters receive them, and references to variables. */
  evaluateArguments(args: BoundArgument[], frame: Frame): (Value | VariableReference)[] {
    const values: (Value | VariableReference)[] = [];
    const start = frame.temporaries.length;
    try {
      for (const arg of args) {
        if (arg.kind === 'refArgument') {
          values.push(
            arg.target.kind === 'discard'
              ? new Reference(
                  () => {},
                  () => {}
                )
              : this.referenceTo(arg.target, frame)
          );
          continue;
        }
        const value = copyValue(this.evaluate(arg, frame));
        values.push(value);
        frame.temporaries.push(value);
      }
      return values;
    } finally {
      frame.temporaries.length = start;
    }
  }

  private referenceTo(target: BoundLValue, frame: Frame): Reference {
    if (target.kind === 'local') {
      const { local } = target;
      const slot = local.owner === frame.method ? frame.slots[local.slot] : frame.captured.get(local);
      if (slot instanceof Reference) return slot;
      return new Reference(
        () => this.readLocal(frame, local),
        (value) => this.storeLocal(frame, local, value)
      );
    }
    const place = this.place(target, frame);
    return new Reference(
      () => place.get(),
      (value) => place.set(value)
    );
  }

  /** The storage an lvalue names, with its receiver and indices evaluated once. */
  place(target: BoundLValue, frame: Frame): Place {
    switch (target.kind) {
      case 'local': {
        const { local } = target;
        return { get: () => this.readLocal(frame, local), set: (value) => this.storeLocal(frame, local, value) };
      }
      case 'field': {
        const receiver = this.evaluate(target.receiver, frame);
        const fields = this.fieldsOf(receiver);
        const { slot } = target.field;
        return { get: () => fields[slot], set: (value) => (fields[slot] = value) };
      }
      case 'staticField': {
        const statics = this.runtime.staticsOf(frame.resolve(target.owner) as NamedType);
        const { slot } = target.field;
        return { get: () => statics[slot], set: (value) => (statics[slot] = value) };
      }
      case 'element': {
        return this.elementPlace(target, frame);
      }
      case 'property': {
        return this.propertyPlace(target, frame);
      }
      case 'this': {
        return {
          get: () => frame.thisValue,
          set: (value) => {
            const self = frame.thisValue as CsStruct;
            const source = value as CsStruct;
            for (const [index, field] of source.fields.entries()) self.fields[index] = field;
          },
        };
      }
      case 'discard': {
        return { get: () => {}, set: () => {} };
      }
    }
  }

  private elementPlace(target: Extract<BoundExpression, { kind: 'element' }>, frame: Frame): Place {
    const array = this.evaluate(target.array, frame);
    if (!(array instanceof CsArray)) throw NULL_REFERENCE();
    const indices = target.indices.map((index) => Number(this.evaluate(index, frame)));
    let offset = 0;
    for (const [dimension, index] of indices.entries()) {
      const length = array.lengths[dimension];
      if (index < 0 || index >= length || !Number.isInteger(index))
        throw new PendingException('System.IndexOutOfRangeException', 'Index was outside the bounds of the array.');
      offset = offset * length + index;
    }
    return {
      get: () => array.values[offset],
      set: (value) => {
        if (
          value !== undefined &&
          isReferenceType(array.type.element) &&
          !this.isInstanceOf(value, array.type.element)
        ) {
          throw new PendingException(
            'System.ArrayTypeMismatchException',
            'Attempted to access an element as a type incompatible with the array.'
          );
        }
        array.values[offset] = value;
      },
    };
  }

  private propertyPlace(target: Extract<BoundExpression, { kind: 'property' }>, frame: Frame): Place {
    const { property } = target;
    let receiver: Value = undefined;
    if (target.receiver) {
      receiver = this.evaluate(target.receiver, frame);
      if (receiver === undefined) throw NULL_REFERENCE();
    } else if (!property.isStatic) {
      receiver = frame.thisValue;
    }
    const isBase = (target.receiver as { isBase?: boolean } | undefined)?.isBase === true;
    const owner = frame.resolve(target.owner) as NamedType;
    if (property.isStatic && owner.symbol.staticConstructor) this.runtime.ensureInitialized(owner);
    const args = this.evaluateArguments(target.args, frame);
    const call = (accessor: MethodSymbol | undefined, extra: Value[]): Value => {
      if (!accessor) throw new Error(`The property ${property.name} lacks an accessor`);
      const isVirtual =
        !isBase &&
        (accessor.isVirtual || accessor.isAbstract || accessor.isOverride || accessor.owner.kind === 'interface');
      const implementation = isVirtual && receiver !== undefined ? this.runtime.dispatch(accessor, receiver) : accessor;
      const implementationOwner = isVirtual ? (this.ownerOfImplementation(implementation, receiver) ?? owner) : owner;
      return this.invoke(
        frame,
        implementation,
        receiver,
        [...args, ...extra],
        target.row,
        this.environmentOf(implementation, implementationOwner, [])
      );
    };
    if (property.backingField && !property.getter?.native && !property.isAbstract) {
      const field = property.backingField;
      const fields = property.isStatic ? this.runtime.staticsOf(owner) : this.fieldsOf(receiver);
      const isOverridden =
        !property.isStatic &&
        receiver !== undefined &&
        this.runtime.dispatch(property.getter as MethodSymbol, receiver) !== property.getter;
      if (!isOverridden) {
        return {
          get: () => fields[field.slot],
          set: (value) => {
            if (
              property.setter &&
              !this.runtime.dispatch(property.setter, receiver).isAbstract &&
              this.runtime.dispatch(property.setter, receiver) !== property.setter &&
              !property.isStatic
            ) {
              call(property.setter, [value]);
              return;
            }
            fields[field.slot] = value;
          },
        };
      }
    }
    return {
      get: () => call(this.getterOf(property), []),
      set: (value) => {
        call(this.setterOf(property), [value]);
      },
    };
  }

  private getterOf(property: PropertySymbol): MethodSymbol | undefined {
    for (let current: PropertySymbol | undefined = property; current; current = current.overridden)
      if (current.getter) return current.getter;
    return undefined;
  }

  private setterOf(property: PropertySymbol): MethodSymbol | undefined {
    for (let current: PropertySymbol | undefined = property; current; current = current.overridden)
      if (current.setter) return current.setter;
    return undefined;
  }

  private evaluateNew(expression: Extract<BoundExpression, { kind: 'new' }>, frame: Frame): Value {
    const type = frame.resolve(expression.objectType);
    let created: Value;
    if (
      type.kind === 'typeParameter' ||
      (type.kind === 'named' && !expression.constructor && type.symbol.isValueType)
    ) {
      created = this.defaultOf(type);
      if (type.kind === 'named' && type.symbol.kind === 'class') created = this.allocate(type);
    } else {
      const named = type as NamedType;
      if (named.symbol.kind === 'class' || expression.constructor) this.runtime.ensureInitialized(named);
      const object = named.symbol.isValueType ? (this.defaultOf(named) as CsStruct) : this.allocate(named);
      frame.temporaries.push(object);
      try {
        const args = this.evaluateArguments(expression.args, frame);
        if (expression.constructor) {
          const result = this.invoke(
            frame,
            expression.constructor,
            object,
            args,
            expression.row,
            substitutionOf(named)
          );
          // A library constructor of a primitive, such as `new string('a', 3)`, returns the value it creates.
          if (expression.constructor.native && result !== undefined) return result;
        }
      } finally {
        frame.temporaries.pop();
      }
      created = object;
    }
    if (expression.initializer) {
      frame.temporaries.push(created);
      try {
        this.withOperand(frame, created, () =>
          this.initialize(expression.initializer as BoundInitializerEntry[], frame)
        );
      } finally {
        frame.temporaries.pop();
      }
    }
    return created;
  }

  private initialize(entries: BoundInitializerEntry[], frame: Frame): void {
    for (const entry of entries) {
      if (entry.kind === 'collectionAdd') {
        this.evaluate(entry.call, frame);
        continue;
      }
      if (entry.target.kind === 'discard') continue;
      if (entry.nested) {
        const place = this.place(entry.target, frame);
        const nested = place.get();
        this.withOperand(frame, nested, () => this.initialize(entry.nested as BoundInitializerEntry[], frame));
        continue;
      }
      const place = this.place(entry.target, frame);
      place.set(copyValue(this.evaluate(entry.value as BoundExpression, frame)));
    }
  }

  /** Creates an instance of a class with its fields at their defaults. */
  allocate(type: NamedType): CsObject {
    const symbol = type.symbol;
    this.runtime.allocateSlots(symbol.instanceFieldCount + 1);
    const fields: Value[] = Array.from<Value>({ length: symbol.instanceFieldCount });
    for (let current: NamedType | undefined = type; current; current = baseTypeOf(current)) {
      const substitution = substitutionOf(current);
      for (const field of current.symbol.fields) {
        if (!field.isStatic && !field.isConst)
          fields[field.slot] = this.defaultOf(substitute(field.type, substitution));
      }
    }
    return new CsObject(type, fields);
  }

  private cloneObject(source: CsObject): CsObject {
    const copy = new CsObject(
      source.type,
      source.fields.map((field) => copyValue(field))
    );
    copy.native = source.native;
    return copy;
  }

  private evaluateNewArray(expression: Extract<BoundExpression, { kind: 'newArray' }>, frame: Frame): Value {
    const type = frame.resolve(expression.arrayType) as ArrayType;
    const lengths = expression.sizes.map((size) => {
      const value = Number(this.evaluate(size, frame));
      if (value < 0)
        throw new PendingException('System.OverflowException', 'Arithmetic operation resulted in an overflow.');
      return value;
    });
    const total = lengths.reduce((product, length) => product * length, 1);
    this.runtime.allocateSlots(total);
    if (expression.elements) {
      const values = expression.elements.map((element) => copyValue(this.evaluate(element, frame)));
      return new CsArray(type, lengths, values);
    }
    const element = type.element;
    const values: Value[] = Array.from({ length: total }, () => this.defaultOf(element));
    return new CsArray(type, lengths, values);
  }

  private createLambda(info: LambdaInfo, type: Type, frame: Frame): Value {
    const cells = new Map<LocalSymbol, Cell>();
    for (const local of info.captures) cells.set(local, this.cellOf(frame, local));
    const entry: DelegateEntry = {
      method: info.method,
      target: frame.thisValue,
      typeArgs: [],
      owner: undefined,
      isVirtual: false,
      lambda: { info, cells, thisValue: frame.thisValue, typeEnvironment: frame.typeEnvironment },
    };
    return new CsDelegate(frame.resolve(type) as NamedType, [entry]);
  }

  private evaluateUnary(expression: Extract<BoundExpression, { kind: 'unary' }>, operand: Value): Value {
    if (expression.isLifted && operand === undefined) return undefined;
    if (expression.operator === '!') return !(operand as boolean);
    if (expression.operandKind === 'enum') {
      const type = nullableUnderlying(expression.type) ?? expression.type;
      const underlying = specialOf((type as NamedType).symbol.enumUnderlying as Type) as SpecialType;
      if (expression.operator === '++' || expression.operator === '--')
        return stepNumeric(underlying, operand as NumericValue, expression.operator === '++' ? 1 : -1);
      return unaryNumeric('~', underlying as never, operand as NumericValue);
    }
    if (expression.operator === '++' || expression.operator === '--') {
      const type = nullableUnderlying(expression.type) ?? expression.type;
      return stepNumeric(
        specialOf(type) as SpecialType,
        operand as NumericValue,
        expression.operator === '++' ? 1 : -1
      );
    }
    return unaryNumeric(expression.operator, expression.operandKind, operand as NumericValue);
  }

  // code-gauge-allow functionNcss 50 -- One case per kind of operand.
  private evaluateBinary(expression: Extract<BoundExpression, { kind: 'binary' }>, frame: Frame): Value {
    const left = this.evaluate(expression.left, frame);
    const right = this.evaluate(expression.right, frame);
    const { operator, operandKind } = expression;
    const isComparison = ['==', '!=', '<', '>', '<=', '>='].includes(operator);
    if (operandKind === 'object' || operandKind === 'delegate' || operandKind === 'string') {
      if (operandKind === 'delegate' && (operator === '+' || operator === '-'))
        return operator === '+' ? combineDelegates(left, right) : removeDelegate(left, right);
      const equal =
        operandKind === 'string'
          ? left === right
          : operandKind === 'delegate'
            ? delegatesEqual(left, right)
            : referenceEquals(left, right);
      return operator === '==' ? equal : !equal;
    }
    if (left === undefined || right === undefined) {
      if (!expression.isLifted) throw NULL_REFERENCE();
      if (operator === '==') return left === right;
      if (operator === '!=') return left !== right;
      if (isComparison) return false;
      if (operandKind === 'bool' && (operator === '&' || operator === '|'))
        return liftedBool(operator, left as boolean | undefined, right as boolean | undefined);
      return undefined;
    }
    if (operandKind === 'bool') {
      const a = left as boolean;
      const b = right as boolean;
      switch (operator) {
        case '&': {
          return a && b;
        }
        case '|': {
          return a || b;
        }
        case '^': {
          return a !== b;
        }
        case '==': {
          return a === b;
        }
        default: {
          return a !== b;
        }
      }
    }
    if (operandKind === 'enum') return this.enumBinary(expression, left as NumericValue, right as NumericValue);
    if (isComparison) return compareNumeric(operator, operandKind, left as NumericValue, right as NumericValue);
    return arithmetic(operator, operandKind, left as NumericValue, right as NumericValue);
  }

  private enumBinary(
    expression: Extract<BoundExpression, { kind: 'binary' }>,
    left: NumericValue,
    right: NumericValue
  ): Value {
    const enumType = [expression.left.type, expression.right.type]
      .map((type) => nullableUnderlying(type) ?? type)
      .find((type) => type.kind === 'named' && type.symbol.kind === 'enum') as NamedType;
    const underlying = specialOf(enumType.symbol.enumUnderlying as Type) as SpecialType;
    const kind = ['long', 'ulong', 'uint'].includes(underlying) ? (underlying as 'long') : 'int';
    if (['==', '!=', '<', '>', '<=', '>='].includes(expression.operator))
      return compareNumeric(expression.operator, kind, left, right);
    const result = arithmetic(expression.operator, kind, left, right);
    return convertNumeric(result, kind, underlying);
  }

  private evaluateInterpolated(expression: Extract<BoundExpression, { kind: 'interpolated' }>, frame: Frame): Value {
    let text = '';
    for (const part of expression.parts) {
      if (typeof part === 'string') {
        text += part;
        continue;
      }
      const value = this.evaluate(part.value, frame);
      text += this.formatHole(value, frame.resolve(part.value.type), part.format, part.alignment, frame);
    }
    this.runtime.allocateString(text.length);
    return text;
  }

  /** Formats one hole of an interpolated string or a composite format, with its format string and alignment. */
  formatHole(
    value: Value,
    type: Type,
    format: string | undefined,
    alignment: number | undefined,
    frame: Frame
  ): string {
    const text = formatValue(this, value, type, format, frame);
    if (alignment === undefined) return text;
    return alignment < 0 ? text.padEnd(-alignment) : text.padStart(alignment);
  }

  /** The text that string concatenation gives a value: its `ToString()`, or empty for null. */
  stringOf(value: Value, type: Type, frame: Frame): string {
    return stringOf(this, value, type, frame);
  }

  recordMember(call: NativeCall, name: string, receiver: Value, args: Value[]): Value {
    return recordMember(this, call, name, receiver, args);
  }

  /** The `Message` of an exception, calling the program's override of the property. */
  exceptionMessageOf(exception: CsObject): string {
    const exceptionSymbol = this.runtime.library.specials.get('exception');
    const property = exceptionSymbol?.properties.find((candidate) => candidate.name === 'Message');
    const getter = property?.getter;
    if (!getter) return exceptionMessage(exception);
    const implementation = this.runtime.dispatch(getter, exception);
    if (implementation === getter) return exceptionMessage(exception);
    const frame = this.runtime.frames.at(-1) ?? new Frame(this.runtime, undefined, undefined, new Map(), undefined, 0);
    return (
      (this.invoke(frame, implementation, exception, [], undefined, environmentOf(this, implementation, exception)) as
        | string
        | undefined) ?? ''
    );
  }

  /** The text of an exception that escaped the program: its `ToString()`, as .NET prints it after "Unhandled exception.". */
  uncaughtText(exception: CsObject): string {
    const frame = new Frame(this.runtime, undefined, undefined, new Map(), undefined, 0);
    return this.stringOf(exception, exception.type, frame);
  }

  /** Compares through `IComparable<T>.CompareTo` or `IComparable.CompareTo`, as `Comparer<T>.Default` does for other types. */
  compareThroughInterface(a: Value, b: Value, frame: Frame): number {
    const type = this.runtime.runtimeTypeOf(a);
    const library = this.runtime.library;
    const generic = library.typeNamed('System.IComparable', 1);
    const nonGeneric = library.typeNamed('System.IComparable');
    if (type?.kind === 'named') {
      const faces =
        this.conversions.isReferenceConvertible(type, namedType(generic, [type])) ||
        this.conversions.implicit(type, namedType(generic, [type]))
          ? [generic]
          : [];
      for (const face of [...faces, nonGeneric]) {
        const method = face.methods.find((candidate) => candidate.name === 'CompareTo');
        if (!method) continue;
        const implementation = this.runtime.dispatch(method, a);
        if (implementation === method) continue;
        return this.invoke(frame, implementation, a, [b], undefined, environmentOf(this, implementation, a)) as number;
      }
    }
    const inner = this.runtime.createException(
      'System.ArgumentException',
      'At least one object must implement IComparable.'
    );
    throw new CsThrow(
      this.runtime.createException(
        'System.InvalidOperationException',
        'Failed to compare two elements in the array.',
        inner
      )
    );
  }

  // ---- Conversions ----

  // code-gauge-allow functionNcss 80 -- One case per kind of conversion.
  convertValue(value: Value, conversion: ConversionKind, from: Type, to: Type): Value {
    switch (conversion) {
      case 'identity':
      case 'reference':
      case 'nullableWrap':
      case 'nullLiteral': {
        return value;
      }
      case 'numeric':
      case 'enumNumeric': {
        if (value === undefined) throw NULL_REFERENCE();
        return convertNumeric(value as NumericValue, numericKindOf(from), numericKindOf(to));
      }
      case 'referenceCheck': {
        if (value === undefined || this.isInstanceOf(value, to)) return value;
        throw this.invalidCast(value, to);
      }
      case 'boxing':
      case 'typeParameterBox': {
        if (value === undefined) return undefined;
        if (!this.isValueTypeValue(value, from)) return value;
        const underlying = nullableUnderlying(from);
        const boxedType = underlying ?? from;
        return new CsBox(boxedType, copyValue(value));
      }
      case 'unboxing':
      case 'typeParameterUnbox': {
        return this.unbox(value, to);
      }
      case 'nullableUnwrap': {
        if (value === undefined)
          throw new PendingException('System.InvalidOperationException', 'Nullable object must have a value.');
        const underlying = nullableUnderlying(from) as Type;
        return sameType(underlying, to)
          ? value
          : convertNumeric(value as NumericValue, numericKindOf(underlying), numericKindOf(to));
      }
      case 'nullableLifted': {
        if (value === undefined) return undefined;
        const fromType = nullableUnderlying(from) ?? from;
        const toType = nullableUnderlying(to) ?? to;
        if (sameType(fromType, toType)) return value;
        if (value instanceof CsBox) return this.unbox(value, to);
        return convertNumeric(value as NumericValue, numericKindOf(fromType), numericKindOf(toType));
      }
      case 'tuple': {
        const tuple = value as CsStruct;
        const fromArgs = (from as NamedType).args;
        const toArgs = (to as NamedType).args;
        return new CsStruct(
          to as NamedType,
          tuple.fields.map((field, index) => this.convertRuntime(field, fromArgs[index], toArgs[index]))
        );
      }
      case 'userDefined': {
        throw new Error('User-defined conversions are not supported');
      }
    }
  }

  /** Converts a value between types without a bound conversion, as tuple element conversions need. */
  private convertRuntime(value: Value, from: Type, to: Type): Value {
    if (sameType(from, to)) return value;
    const fromSpecial = specialOf(from);
    const toSpecial = specialOf(to);
    if (
      fromSpecial &&
      toSpecial &&
      typeof value !== 'string' &&
      value !== undefined &&
      !(value instanceof CsStruct) &&
      !(value instanceof CsObject) &&
      !(value instanceof CsBox) &&
      typeof value !== 'boolean' &&
      toSpecial !== 'object' &&
      toSpecial !== 'string'
    ) {
      return convertNumeric(value as NumericValue, fromSpecial, toSpecial);
    }
    if (nullableUnderlying(to)) return value;
    if (isReferenceType(to) && this.isValueTypeValue(value, from)) return new CsBox(from, copyValue(value));
    return value;
  }

  private isValueTypeValue(value: Value, type: Type): boolean {
    if (
      value instanceof CsObject ||
      value instanceof CsArray ||
      value instanceof CsDelegate ||
      value instanceof CsBox ||
      typeof value === 'string'
    )
      return false;
    return type.kind !== 'typeParameter' || true;
  }

  private unbox(value: Value, to: Type): Value {
    const underlying = nullableUnderlying(to);
    if (value === undefined) {
      if (underlying || isReferenceType(to)) return undefined;
      throw NULL_REFERENCE();
    }
    if (!(value instanceof CsBox)) {
      if (this.isInstanceOf(value, to)) return value;
      throw this.invalidCast(value, to);
    }
    const target = underlying ?? to;
    if (this.boxMatches(value.type, target)) return copyValue(value.value);
    if (isReferenceType(target) && this.isInstanceOf(value, target)) return value;
    throw this.invalidCast(value, to);
  }

  /** Whether a box of one type unboxes to another, which an enum allows to its underlying type and back. */
  private boxMatches(boxed: Type, target: Type): boolean {
    if (sameType(boxed, target)) return true;
    return sameType(enumUnderlyingOf(boxed), enumUnderlyingOf(target));
  }

  private invalidCast(value: Value, to: Type): PendingException {
    const from = this.runtime.runtimeTypeOf(value);
    return new PendingException(
      'System.InvalidCastException',
      `Unable to cast object of type '${from ? runtimeTypeName(from) : 'System.Object'}' to type '${runtimeTypeName(to)}'.`
    );
  }

  /** Whether a value is of a type at run time, as `is` and casts test. */
  isInstanceOf(value: Value, type: Type): boolean {
    if (value === undefined) return false;
    if (type.kind === 'named' && type.symbol.special === 'object') return true;
    const actual = this.runtime.runtimeTypeOf(value instanceof CsBox ? value : value) ?? undefined;
    if (value instanceof CsBox) {
      if (sameType(value.type, type)) return true;
      if (nullableUnderlying(type) && sameType(nullableUnderlying(type) as Type, value.type)) return true;
      return this.isAssignable(value.type, type);
    }
    if (!actual) {
      return this.primitiveIsInstance(value, type);
    }
    return this.isAssignable(actual, type);
  }

  private primitiveIsInstance(_value: Value, _type: Type): boolean {
    return false;
  }

  /** Whether a runtime type converts to another by reference or boxing, as instance tests decide. */
  isAssignable(actual: Type, type: Type): boolean {
    if (sameType(actual, type)) return true;
    const conversion = this.conversions.implicit(actual, type);
    return conversion === 'reference' || conversion === 'boxing' || conversion === 'identity';
  }

  /** The default value of a type: null, zero, false, or an empty struct. */
  defaultOf(type: Type): Value {
    if (type.kind !== 'named') return undefined;
    const special = type.symbol.special;
    switch (special) {
      case 'bool': {
        return false;
      }
      case 'long':
      case 'ulong': {
        return 0n;
      }
      case 'decimal': {
        return CsDecimal.ZERO;
      }
      case 'char':
      case 'sbyte':
      case 'byte':
      case 'short':
      case 'ushort':
      case 'int':
      case 'uint':
      case 'float':
      case 'double': {
        return 0;
      }
      case 'nullable': {
        return undefined;
      }
      default: {
        break;
      }
    }
    if (type.symbol.kind === 'enum') {
      const underlying = specialOf(type.symbol.enumUnderlying as Type);
      return underlying === 'long' || underlying === 'ulong' ? 0n : 0;
    }
    if (type.symbol.kind !== 'struct') return undefined;
    const fields: Value[] = Array.from<Value>({ length: type.symbol.instanceFieldCount });
    const substitution = substitutionOf(type);
    for (const field of type.symbol.fields) {
      if (!field.isStatic && !field.isConst) fields[field.slot] = this.defaultOf(substitute(field.type, substitution));
    }
    return new CsStruct(type, fields);
  }

  // ---- Patterns ----

  // code-gauge-allow functionNcss 60 -- One case per kind of pattern.
  matches(pattern: BoundPattern, value: Value, frame: Frame): boolean {
    switch (pattern.kind) {
      case 'any': {
        if (pattern.local) this.storeLocal(frame, pattern.local, copyValue(value));
        return true;
      }
      case 'constant': {
        const constant = this.evaluate(pattern.value, frame);
        if (constant === undefined) return value === undefined;
        if (value === undefined) return false;
        const inner = value instanceof CsBox ? value.value : value;
        if (value instanceof CsBox && !sameType(value.type, pattern.type) && !this.boxMatches(value.type, pattern.type))
          return false;
        return valuesEqual(this, inner, constant, frame);
      }
      case 'type': {
        if (value === undefined) return false;
        const type = frame.resolve(pattern.testType);
        const inputIsValue = !(value instanceof CsBox) && this.runtime.runtimeTypeOf(value) === undefined;
        if (
          !inputIsValue &&
          !(value instanceof CsStruct && sameType(value.type, type)) &&
          !this.isInstanceOf(value, type)
        )
          return false;
        if (pattern.local)
          this.storeLocal(
            frame,
            pattern.local,
            value instanceof CsBox && !isReferenceType(type) ? copyValue(value.value) : copyValue(value)
          );
        return true;
      }
      case 'relational': {
        if (value === undefined) return false;
        const inner = value instanceof CsBox ? value.value : value;
        if (value instanceof CsBox && !sameType(value.type, pattern.value.type)) return false;
        const constant = this.evaluate(pattern.value, frame);
        if (typeof inner === 'number' && Number.isNaN(inner)) return false;
        return compareNumeric(
          pattern.operator,
          pattern.operandKind === 'enum' ? 'int' : pattern.operandKind,
          inner as NumericValue,
          constant as NumericValue
        );
      }
      case 'not': {
        return !this.matches(pattern.pattern, value, frame);
      }
      case 'and': {
        return this.matches(pattern.left, value, frame) && this.matches(pattern.right, value, frame);
      }
      case 'or': {
        return this.matches(pattern.left, value, frame) || this.matches(pattern.right, value, frame);
      }
      case 'recursive': {
        return this.matchesRecursive(pattern, value, frame);
      }
    }
  }

  private matchesRecursive(pattern: Extract<BoundPattern, { kind: 'recursive' }>, value: Value, frame: Frame): boolean {
    if (value === undefined) return false;
    if (
      pattern.testType &&
      !this.isInstanceOf(value, frame.resolve(pattern.testType)) &&
      !(value instanceof CsStruct && sameType(value.type, frame.resolve(pattern.testType)))
    )
      return false;
    const target = value instanceof CsBox ? value.value : value;
    if (pattern.positional.length > 0) {
      let elements: Value[];
      if (pattern.isTuple) elements = (target as CsStruct).fields;
      else {
        const references = pattern.positional.map(() => {
          const cell = new Cell(undefined);
          return new Reference(
            () => cell.value as Value,
            (stored) => (cell.value = stored)
          );
        });
        const method = this.runtime.dispatch(pattern.deconstruct as MethodSymbol, target);
        this.invoke(
          frame,
          method,
          target,
          references,
          undefined,
          this.environmentFor(method, this.runtime.runtimeTypeOf(target))
        );
        elements = references.map((reference) => reference.get());
      }
      for (const [index, sub] of pattern.positional.entries())
        if (!this.matches(sub, elements[index], frame)) return false;
    }
    for (const property of pattern.properties) {
      let current: Value = target;
      for (const [index, member] of property.members.entries()) {
        if (current === undefined) return false;
        current = this.readMember(current, member, property.owners[index], frame);
      }
      if (!this.matches(property.pattern, current, frame)) return false;
    }
    if (pattern.local) this.storeLocal(frame, pattern.local, copyValue(target));
    return true;
  }

  private readMember(receiver: Value, member: FieldSymbol | PropertySymbol, owner: NamedType, frame: Frame): Value {
    if ('getter' in member) {
      const getter = this.getterOf(member) as MethodSymbol;
      const implementation = this.runtime.dispatch(getter, receiver);
      return this.invoke(
        frame,
        implementation,
        receiver,
        [],
        undefined,
        this.environmentFor(implementation, this.runtime.runtimeTypeOf(receiver) ?? owner)
      );
    }
    if (member.isStatic) return this.runtime.staticsOf(owner)[member.slot];
    return this.fieldsOf(receiver)[member.slot];
  }

  private deconstruct(targets: BoundDeconstructTarget, value: Value, frame: Frame): void {
    if (targets.kind === 'single') {
      if (!targets.target) return;
      const converted = targets.conversion
        ? this.withOperand(frame, value, () => this.evaluate(targets.conversion as BoundExpression, frame))
        : value;
      this.place(targets.target, frame).set(copyValue(converted));
      return;
    }
    let elements: Value[];
    if (!targets.deconstruct) {
      if (!(value instanceof CsStruct)) throw NULL_REFERENCE();
      elements = value.fields;
    } else {
      if (value === undefined) throw NULL_REFERENCE();
      const cells = targets.elements.map(() => new Cell(undefined));
      const references = cells.map(
        (cell) =>
          new Reference(
            () => cell.value as Value,
            (stored) => (cell.value = stored)
          )
      );
      const method = this.runtime.dispatch(targets.deconstruct, value);
      this.invoke(
        frame,
        method,
        value,
        references,
        undefined,
        this.environmentFor(method, this.runtime.runtimeTypeOf(value))
      );
      elements = cells.map((cell) => cell.value as Value);
    }
    // Every element is evaluated before any target is assigned, as `(a, b) = (b, a)` swaps.
    const snapshot = [...elements];
    for (const [index, element] of targets.elements.entries()) this.deconstruct(element, snapshot[index], frame);
  }

  /** Converts a host stack overflow into the fatal error .NET reports. */
  isStackOverflow(error: unknown): boolean {
    return error instanceof StackOverflow || (error instanceof RangeError && /call stack/i.test(error.message));
  }
}

function withoutStep(statement: BoundStatement): BoundStatement {
  return statement.step === 'none' ? statement : ({ ...statement, step: 'none' } as BoundStatement);
}

function numericKindOf(type: Type): SpecialType {
  if (type.kind === 'named' && type.symbol.kind === 'enum')
    return specialOf(type.symbol.enumUnderlying as Type) as SpecialType;
  return (specialOf(nullableUnderlying(type) ?? type) ?? 'int') as SpecialType;
}

function referenceEquals(a: Value, b: Value): boolean {
  return a === b;
}

function liftedBool(operator: '&' | '|', a: boolean | undefined, b: boolean | undefined): boolean | undefined {
  if (operator === '&') {
    if (a === false || b === false) return false;
    return a === undefined || b === undefined ? undefined : true;
  }
  if (a === true || b === true) return true;
  return a === undefined || b === undefined ? undefined : false;
}

/** Combines two delegates into one that calls both, as `+` does. */
export function combineDelegates(a: Value, b: Value): Value {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const first = a as CsDelegate;
  const second = b as CsDelegate;
  return new CsDelegate(first.type, [...first.entries, ...second.entries]);
}

/** Removes the last occurrence of a delegate's invocation list from another's, as `-` does. */
export function removeDelegate(a: Value, b: Value): Value {
  if (a === undefined || b === undefined) return a;
  const source = (a as CsDelegate).entries;
  const removed = (b as CsDelegate).entries;
  for (let start = source.length - removed.length; start >= 0; start--) {
    if (removed.every((entry, index) => entriesEqual(source[start + index], entry))) {
      const remaining = [...source.slice(0, start), ...source.slice(start + removed.length)];
      return remaining.length === 0 ? undefined : new CsDelegate((a as CsDelegate).type, remaining);
    }
  }
  return a;
}

function entriesEqual(a: DelegateEntry, b: DelegateEntry): boolean {
  if (a.lambda || b.lambda) return a.lambda?.info === b.lambda?.info && a.lambda?.cells === b.lambda?.cells && a === b;
  return a.method === b.method && a.target === b.target;
}

export function delegatesEqual(a: Value, b: Value): boolean {
  if (a === undefined || b === undefined) return a === b;
  const first = (a as CsDelegate).entries;
  const second = (b as CsDelegate).entries;
  return first.length === second.length && first.every((entry, index) => entriesEqual(entry, second[index]));
}

/** The underlying type of an enum, which its box unboxes to as well, or any other type itself. */
function enumUnderlyingOf(type: Type): Type {
  return type.kind === 'named' && type.symbol.kind === 'enum' ? (type.symbol.enumUnderlying as Type) : type;
}
