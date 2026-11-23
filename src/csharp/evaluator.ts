import { checkElementStore } from './arrayStore';
import type {
  BoundArguments,
  BoundBlock,
  BoundExpression,
  BoundInitializerEntry,
  BoundLValue,
  LambdaInfo,
} from './bound';
import type { CompiledProgram } from './compiler';
import { combineDelegates, delegatesEqual, removeDelegate } from './delegates';
import { NULL_REFERENCE, type Place, Reference } from './evaluatorBase';
import { formatValue } from './library/formatting';
// code-gauge-allow-file fileNcss -- The evaluator module keeps one stage of the C# interpreter together.
import { MeteredText } from './meteredText';
import type { NativeCall } from './natives';
import {
  arithmetic,
  booleanOperation,
  compareNumeric,
  convertNumeric,
  type NumericValue,
  PendingException,
  stepNumeric,
  unaryNumeric,
} from './numeric';
import { environmentOf, exceptionMessage, recordMember, stringOf, toStringValue } from './objects';
import { CsThrow, Frame, type Runtime, type Slot, StackOverflow } from './runtime';
import { StatementExecutor } from './statementExecutor';
import {
  type ArrayType,
  baseTypeOf,
  type LocalSymbol,
  type MethodSymbol,
  type NamedType,
  namedType,
  nullableUnderlying,
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
  type CsString,
  CsStruct,
  type DelegateEntry,
  freshString,
  plainString,
  stringText,
  UNASSIGNED,
  type Value,
  type VariableReference,
} from './values';
import { isVariable } from './variables';

type BinaryExpression = Extract<BoundExpression, { kind: 'binary' }>;
type AccessExpression = Extract<
  BoundExpression,
  {
    kind:
      | 'constant'
      | 'local'
      | 'this'
      | 'field'
      | 'staticField'
      | 'element'
      | 'property'
      | 'compoundOperand'
      | 'conditionalAccess';
  }
>;
type InvocationExpression = Extract<
  BoundExpression,
  { kind: 'call' | 'invokeDelegate' | 'new' | 'newArray' | 'newDelegate' | 'lambda' | 'tuple' | 'with' | 'default' }
>;
type OperationExpression = Extract<
  BoundExpression,
  {
    kind:
      | 'unary'
      | 'binary'
      | 'logical'
      | 'coalesce'
      | 'conditional'
      | 'convert'
      | 'is'
      | 'as'
      | 'switch'
      | 'concat'
      | 'interpolated'
      | 'throw'
      | 'sequence';
  }
>;
type AssignmentExpression = Extract<
  BoundExpression,
  { kind: 'assign' | 'compoundAssign' | 'increment' | 'deconstructAssign' | 'eventAccessor' }
>;

/** Runs the bound tree of a compiled program. */
export class Evaluator extends StatementExecutor {
  constructor(runtime: Runtime, program: CompiledProgram) {
    super(runtime, program);
    runtime.evaluator = this;
  }

  // code-gauge-allow functionParameterCount -- The values that the operation needs, which share no object.
  // code-gauge-allow functionNcss -- One case per kind of syntax or value that the function handles.
  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
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
        row: callRow,
      };
      // The callbacks a native runs may collect garbage while its receiver and arguments are reachable from no frame.
      const start = caller.temporaries.length;
      caller.temporaries.push(self, ...(args as Value[]));
      try {
        return method.native(call, self, args);
      } finally {
        caller.temporaries.length = start;
      }
    }
    const body = method.body;
    const backingField = method.property?.backingField;
    if (!body && backingField) {
      // An auto-property's accessors read and write its backing field.
      const fields = backingField.isStatic
        ? this.runtime.staticsOf(this.ownerFromEnvironment(method, typeEnvironment) as NamedType)
        : this.fieldsOf(self);
      if (method.kind === 'getter') return fields[backingField.slot];
      fields[backingField.slot] = args.at(-1) as Value;
      return undefined;
    }
    if (!body) {
      if (method.isAbstract)
        throw new PendingException('System.EntryPointNotFoundException', `Entry point was not found.`);
      return undefined;
    }
    const frame = new Frame(this.runtime, method, self, typeEnvironment, callRow, method.locals.length);
    if (captured) frame.captured = captured;
    for (const [index, local] of method.locals.entries()) {
      if (!local.isParameter || local.owner !== method) continue;
      // A value parameter receives a copy also when the library calls back with a struct it stores.
      const arg = args[index] instanceof CsStruct ? copyValue(args[index]) : args[index];
      frame.slots[local.slot] = local.isCaptured ? new Cell(arg as Value) : arg;
    }
    this.runtime.pushFrame(frame);
    try {
      if (method.kind === 'constructor') this.runConstructorPrologue(frame, method);
      const completion = this.executeBlock(body, frame, true);
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
    const isThisChain = initializer?.kind === 'call' && initializer.isThisInitializer === true;
    const owner = constructor.owner;
    if (!isThisChain && owner.instanceInitializer) {
      const primaryArguments =
        constructor.parameters === owner.primaryParameters ? frame.slots.slice(0, constructor.parameters.length) : [];
      this.runInitializer(
        owner.instanceInitializer,
        owner.initializerLocals,
        frame,
        frame.thisValue,
        false,
        frame.typeEnvironment,
        primaryArguments
      );
    }
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

  // code-gauge-allow functionParameterCount -- The values that the operation needs, which share no object.
  private runInitializer(
    block: BoundBlock,
    locals: LocalSymbol[],
    caller: Frame,
    thisValue: Value,
    isStatic: boolean,
    environment = caller.typeEnvironment,
    /** The arguments of a primary constructor, which the initializers read as its parameters. */
    primaryArguments: Slot[] = []
  ): void {
    const owner = locals[0]?.owner;
    const frame = new Frame(this.runtime, owner, thisValue, environment, undefined, locals.length);
    for (const [index, value] of primaryArguments.entries()) frame.slots[index] = value;
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

  // ---- Expressions ----

  // code-gauge-allow functionNcss -- One case label per kind of bound expression, grouped into sub-dispatchers.
  evaluate(expression: BoundExpression, frame: Frame): Value {
    switch (expression.kind) {
      case 'constant':
      case 'local':
      case 'this':
      case 'field':
      case 'staticField':
      case 'element':
      case 'property':
      case 'compoundOperand':
      case 'conditionalAccess': {
        return this.evaluateAccess(expression, frame);
      }
      case 'call':
      case 'invokeDelegate':
      case 'new':
      case 'newArray':
      case 'newDelegate':
      case 'lambda':
      case 'tuple':
      case 'with':
      case 'default': {
        return this.evaluateInvocation(expression, frame);
      }
      case 'unary':
      case 'binary':
      case 'logical':
      case 'coalesce':
      case 'conditional':
      case 'convert':
      case 'is':
      case 'as':
      case 'switch':
      case 'concat':
      case 'interpolated':
      case 'throw':
      case 'sequence': {
        return this.evaluateOperation(expression, frame);
      }
      case 'assign':
      case 'compoundAssign':
      case 'increment':
      case 'deconstructAssign':
      case 'eventAccessor': {
        return this.evaluateAssignment(expression, frame);
      }
      case 'unbound': {
        throw new Error(`Cannot evaluate ${expression.kind}`);
      }
    }
  }

  /** Evaluates an expression that reads a value or a variable. */
  private evaluateAccess(expression: AccessExpression, frame: Frame): Value {
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
      case 'property': {
        return this.propertyPlace(expression, frame).get();
      }
      case 'compoundOperand': {
        return frame.operands.at(-1) as Value;
      }
      case 'conditionalAccess': {
        const receiver = this.evaluate(expression.receiver, frame);
        if (receiver === undefined) return undefined;
        return this.inScope(frame, [expression.temporary], [], () => {
          this.storeLocal(frame, expression.temporary, receiver);
          return this.evaluate(expression.access, frame);
        });
      }
    }
  }

  /** Evaluates an expression that calls a function or creates a value. */
  private evaluateInvocation(expression: InvocationExpression, frame: Frame): Value {
    switch (expression.kind) {
      case 'call': {
        return this.evaluateCall(expression, frame);
      }
      case 'invokeDelegate': {
        return this.evaluateInvokeDelegate(expression, frame);
      }
      case 'new': {
        return this.evaluateNew(expression, frame);
      }
      case 'newArray': {
        return this.evaluateNewArray(expression, frame);
      }
      case 'newDelegate': {
        return this.evaluateNewDelegate(expression, frame);
      }
      case 'lambda': {
        return this.createLambda(expression.lambda, expression.type, frame);
      }
      case 'tuple': {
        const type = frame.resolve(expression.type) as NamedType;
        return new CsStruct(type, this.evaluateHeld(expression.elements, frame));
      }
      case 'with': {
        return this.evaluateWith(expression, frame);
      }
      case 'default': {
        return this.defaultOf(frame.resolve(expression.type));
      }
    }
  }

  /** Evaluates an expression that operates on the values of its operands. */
  // code-gauge-allow functionNcss -- One case per kind of operation.
  private evaluateOperation(expression: OperationExpression, frame: Frame): Value {
    switch (expression.kind) {
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
        if (left === undefined) return this.evaluate(expression.right, frame);
        const { leftConversion } = expression;
        return leftConversion ? this.withOperand(frame, left, () => this.evaluate(leftConversion, frame)) : left;
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
      case 'is': {
        return this.matches(expression.pattern, this.evaluate(expression.operand, frame), frame);
      }
      case 'as': {
        return this.evaluateAs(expression, frame);
      }
      case 'switch': {
        return this.evaluateSwitch(expression, frame);
      }
      case 'concat': {
        return this.evaluateConcat(expression, frame);
      }
      case 'interpolated': {
        return this.evaluateInterpolated(expression, frame);
      }
      case 'throw': {
        throw this.throwValue(this.evaluate(expression.value, frame));
      }
      case 'sequence': {
        // The sequence's hidden locals leave scope with it, so they hold no object the program has let go.
        return this.inScope(frame, expression.locals, [], () => {
          for (const effect of expression.sideEffects) this.evaluate(effect, frame);
          return this.evaluate(expression.value, frame);
        });
      }
    }
  }

  /** Evaluates an expression that stores into variables. */
  // code-gauge-allow functionNcss -- One case per kind of assignment.
  private evaluateAssignment(expression: AssignmentExpression, frame: Frame): Value {
    switch (expression.kind) {
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
        // `x ??= y` stores only when x is null, so a setter runs only then.
        if (expression.operation.kind !== 'coalesce' || current === undefined) place.set(value);
        return value;
      }
      case 'increment': {
        const place = this.place(expression.target, frame);
        const current = place.get();
        const next = this.withOperand(frame, current, () => this.evaluate(expression.operation, frame));
        place.set(next);
        return expression.isPrefix ? next : current;
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
        place.set(
          expression.isAdd
            ? combineDelegates(this.runtime, place.get(), value)
            : removeDelegate(this.runtime, place.get(), value)
        );
        return undefined;
      }
    }
  }

  private evaluateInvokeDelegate(
    expression: Extract<BoundExpression, { kind: 'invokeDelegate' }>,
    frame: Frame
  ): Value {
    const target = this.evaluate(expression.target, frame);
    frame.temporaries.push(target);
    try {
      const args = this.evaluateArguments(expression.args, frame);
      return this.invokeDelegate(frame, target, args, expression.row);
    } finally {
      frame.temporaries.pop();
    }
  }

  private evaluateNewDelegate(expression: Extract<BoundExpression, { kind: 'newDelegate' }>, frame: Frame): Value {
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

  private evaluateWith(expression: Extract<BoundExpression, { kind: 'with' }>, frame: Frame): Value {
    const source = this.evaluate(expression.value, frame);
    if (source === undefined) throw NULL_REFERENCE();
    // A primitive struct, as in `5 with { }`, is its own copy.
    const copy =
      source instanceof CsStruct ? source.clone() : source instanceof CsObject ? this.cloneObject(source) : source;
    this.storeLocal(frame, expression.temporary, copy);
    for (const assignment of expression.assignments) {
      if (assignment.target.kind === 'discard' || !assignment.value) continue;
      const place = this.place(assignment.target, frame);
      place.set(copyValue(this.evaluate(assignment.value, frame)));
    }
    return copy;
  }

  private evaluateAs(expression: Extract<BoundExpression, { kind: 'as' }>, frame: Frame): Value {
    const value = this.evaluate(expression.operand, frame);
    const target = frame.resolve(expression.targetType);
    if (value === undefined) return undefined;
    const underlying = nullableUnderlying(target);
    if (underlying) return value instanceof CsBox && this.isInstanceOf(value, underlying) ? value.value : undefined;
    return this.isInstanceOf(value, target) ? value : undefined;
  }

  private evaluateSwitch(expression: Extract<BoundExpression, { kind: 'switch' }>, frame: Frame): Value {
    const value = this.evaluate(expression.value, frame);
    for (const arm of expression.arms) {
      // Each arm is a scope of its own, whose variables leave it whether the arm is taken or not.
      const captured = arm.locals.filter((local) => local.isCaptured);
      const result = this.inScope(frame, arm.locals, captured, () =>
        this.matches(arm.pattern, value, frame) && (!arm.guard || (this.evaluate(arm.guard, frame) as boolean))
          ? { value: this.evaluate(arm.value, frame) }
          : undefined
      );
      if (result) return result.value;
    }
    throw new PendingException(
      'System.Runtime.CompilerServices.SwitchExpressionException',
      `Non-exhaustive switch expression failed to match its input.\nUnmatched value was ${this.evaluator().formatUnmatched(value, expression.value.type, frame)}.`
    );
  }

  /** `+` on strings, which Roslyn compiles to one `string.Concat` of the operands' `ToString()`, without empty constants. */
  private evaluateConcat(expression: Extract<BoundExpression, { kind: 'concat' }>, frame: Frame): Value {
    const strings = expression.parts
      .filter((part) => !(part.kind === 'constant' && (part.value === '' || part.value === undefined)))
      .map((part) => toStringValue(this, this.evaluate(part, frame), frame.resolve(part.type), frame));
    return this.concatStrings(strings);
  }

  /**
   * `string.Concat` of strings: one string is returned itself, and the overloads for two to four return the one
   * non-empty string among them; the overload for more always makes a new one.
   */
  private concatStrings(strings: (string | CsString)[]): string | CsString {
    if (strings.length === 1) return strings[0];
    const nonEmpty = strings.filter((part) => stringText(part) !== '');
    if (nonEmpty.length === 0) return '';
    if (nonEmpty.length === 1 && strings.length <= 4) return nonEmpty[0];
    const texts = strings.map((part) => stringText(part));
    // The length is checked before joining, since repeating one long string builds a host string past the limit.
    this.runtime.allocateString(texts.reduce((length, part) => length + part.length, 0));
    return freshString(texts.join(''));
  }

  protected evaluator(): Evaluator {
    return this;
  }

  /** The text of the value that a switch expression failed to match, as `SwitchExpressionException` shows it. */
  formatUnmatched(value: Value, type: Type, frame: Frame): string {
    return this.stringOf(value, frame.resolve(type), frame);
  }

  private evaluateCall(expression: Extract<BoundExpression, { kind: 'call' }>, frame: Frame): Value {
    const { method } = expression;
    const receiver = this.evaluateReceiver(expression, frame);
    frame.temporaries.push(receiver);
    try {
      const args = this.evaluateArguments(expression.args, frame);
      if (method.kind === 'delegateInvoke') return this.invokeDelegate(frame, receiver, args, expression.row);
      const owner = expression.owner ? (frame.resolve(expression.owner) as NamedType) : undefined;
      if (method.isStatic && owner && method.owner.staticConstructor) this.runtime.ensureInitialized(owner);
      const typeArgs = expression.typeArgs.map((type) => frame.resolve(type));
      if (expression.isVirtual && (receiver !== undefined || expression.receiver !== undefined)) {
        return this.invokeVirtual(expression, receiver, args, owner, typeArgs, frame);
      }
      return this.invoke(
        frame,
        method,
        receiver,
        args,
        expression.isImplicit ? undefined : expression.row,
        this.environmentOf(method, owner, typeArgs),
        this.localFunctionCells(frame, method)
      );
    } finally {
      frame.temporaries.pop();
    }
  }

  /** The receiver a call runs on: its value, a copy of a struct that is no variable, a box, or `this`. */
  private evaluateReceiver(expression: Extract<BoundExpression, { kind: 'call' }>, frame: Frame): Value {
    const { method } = expression;
    if (method.kind === 'localFunction') return frame.thisValue;
    if (!expression.receiver) return method.isStatic ? undefined : frame.thisValue;
    let receiver = this.evaluate(expression.receiver, frame);
    // A nullable value's members run on its missing value too, as `HasValue` and its `ToString` override do.
    if (receiver === undefined && !method.isStatic && !this.runsOnNullable(expression)) throw NULL_REFERENCE();
    // A method of a struct runs on a copy of a value that is not a variable, so it cannot change the original.
    if (receiver instanceof CsStruct && !isVariable(expression.receiver, true)) receiver = receiver.clone();
    // A value calls a non-virtual method of a reference type, such as `GetType`, through a box of its own type.
    const receiverType = frame.resolve(expression.receiver.type);
    if (
      !expression.isVirtual &&
      !method.isStatic &&
      !method.isExtension &&
      !method.owner.isValueType &&
      this.isValueTypeValue(receiver, receiverType)
    ) {
      receiver = new CsBox(receiverType, copyValue(receiver));
    }
    return receiver;
  }

  /** Calls the implementation of a virtual method that the receiver's runtime type, or its static type, has. */
  private invokeVirtual(
    expression: Extract<BoundExpression, { kind: 'call' }>,
    receiver: Value,
    args: (Value | VariableReference)[],
    owner: NamedType | undefined,
    typeArgs: Type[],
    frame: Frame
  ): Value {
    const staticType = expression.receiver ? frame.resolve(expression.receiver.type) : undefined;
    const implementation = this.runtime.dispatch(expression.method, receiver, staticType);
    const implementationOwner =
      this.ownerOfImplementation(implementation, receiver) ??
      (staticType && nullableUnderlying(staticType) ? (staticType as NamedType) : owner);
    // An enum's or a primitive's value runs an implementation of a class (Enum, ValueType) in its box.
    const self =
      staticType &&
      receiver !== undefined &&
      !implementation.owner.isValueType &&
      !(receiver instanceof CsStruct) &&
      this.isValueTypeValue(receiver, staticType) &&
      !nullableUnderlying(staticType)
        ? new CsBox(staticType, receiver)
        : receiver;
    const result = this.invoke(
      frame,
      implementation,
      self,
      args,
      expression.row,
      this.environmentOf(implementation, implementationOwner, typeArgs)
    );
    return this.boxedAsCalled(expression.method, implementation, this.runtime.runtimeTypeOf(receiver), result);
  }

  private runsOnNullable(expression: Extract<BoundExpression, { kind: 'call' }>): boolean {
    if (expression.method.owner.special === 'nullable') return true;
    return (
      expression.isVirtual &&
      expression.receiver !== undefined &&
      nullableUnderlying(expression.receiver.type) !== undefined
    );
  }

  /** Evaluates elements in order, keeping the evaluated ones alive (with their turtles) while the rest run. */
  private evaluateHeld(elements: BoundExpression[], frame: Frame): Value[] {
    const values: Value[] = [];
    const start = frame.temporaries.length;
    try {
      for (const element of elements) {
        const value = copyValue(this.evaluate(element, frame));
        values.push(value);
        frame.temporaries.push(value);
      }
      return values;
    } finally {
      frame.temporaries.length = start;
    }
  }

  /** Evaluates arguments in order: values copied as their parameters receive them, and references to variables. */
  evaluateArguments(args: BoundArguments, frame: Frame): (Value | VariableReference)[] {
    const values: (Value | VariableReference)[] = Array.from({ length: args.length });
    const start = frame.temporaries.length;
    const sourceOrder = args.sourceOrder ?? [];
    const order = [...sourceOrder, ...args.keys().filter((index) => !sourceOrder.includes(index))];
    try {
      for (const index of order) {
        const arg = args[index];
        if (arg.kind === 'refArgument') {
          values[index] =
            arg.target.kind === 'discard'
              ? new Reference(
                  () => {},
                  () => {}
                )
              : this.referenceTo(arg.target, frame);
          continue;
        }
        const value = copyValue(this.evaluate(arg, frame));
        values[index] = value;
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
        checkElementStore(this, array, value);
        array.values[offset] = value;
      },
    };
  }

  // code-gauge-allow functionNcss -- One case per kind of syntax or value that the function handles.
  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
  private propertyPlace(target: Extract<BoundExpression, { kind: 'property' }>, frame: Frame): Place {
    const { property } = target;
    let receiver: Value = undefined;
    if (target.receiver) {
      receiver = this.evaluate(target.receiver, frame);
      if (receiver === undefined && property.owner.special !== 'nullable') throw NULL_REFERENCE();
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
      // The constructed owner picks a generic interface's overload by its substituted parameter types.
      const implementation =
        isVirtual && receiver !== undefined ? this.runtime.dispatch(accessor, receiver, owner) : accessor;
      const implementationOwner = isVirtual ? (this.ownerOfImplementation(implementation, receiver) ?? owner) : owner;
      const result = this.invoke(
        frame,
        implementation,
        receiver,
        [...args, ...extra],
        target.row,
        this.environmentOf(implementation, implementationOwner, [])
      );
      return this.boxedAsCalled(accessor, implementation, this.runtime.runtimeTypeOf(receiver), result);
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

  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
  private evaluateNew(expression: Extract<BoundExpression, { kind: 'new' }>, frame: Frame): Value {
    const type = frame.resolve(expression.objectType);
    // `new T()` runs the parameterless constructor of the class that the type argument gives.
    const constructor =
      expression.constructor ??
      (expression.objectType.kind === 'typeParameter' && type.kind === 'named' && type.symbol.kind === 'class'
        ? type.symbol.constructors.find((candidate) => candidate.parameters.length === 0)
        : undefined);
    let created: Value;
    if (type.kind === 'typeParameter' || (type.kind === 'named' && !constructor && type.symbol.isValueType)) {
      created = this.defaultOf(type);
    } else {
      const named = type as NamedType;
      if (named.symbol.kind === 'class' || constructor) this.runtime.ensureInitialized(named);
      const object = named.symbol.isValueType ? (this.defaultOf(named) as CsStruct) : this.allocate(named);
      frame.temporaries.push(object);
      try {
        const args = this.evaluateArguments(expression.args, frame);
        if (constructor) {
          const result = this.invoke(frame, constructor, object, args, expression.row, substitutionOf(named));
          // A library constructor of a primitive, such as `new string('a', 3)`, returns the value it creates.
          if (constructor.native && result !== undefined) return result;
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

  /** A shallow copy of an object, as `with` and `MemberwiseClone` make, charged as an allocation like `new`. */
  cloneObject(source: CsObject): CsObject {
    this.runtime.allocateSlots(source.fields.length + 1);
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
      return new CsArray(type, lengths, this.evaluateHeld(expression.elements, frame));
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

  private evaluateBinary(expression: BinaryExpression, frame: Frame): Value {
    const left = this.evaluate(expression.left, frame);
    const right = this.evaluate(expression.right, frame);
    const { operator, operandKind } = expression;
    if (operandKind === 'object' || operandKind === 'delegate' || operandKind === 'string')
      return referenceBinary(this.runtime, operator, operandKind, left, right);
    if (left === undefined || right === undefined) {
      if (!expression.isLifted) throw NULL_REFERENCE();
      return liftedNullBinary(operator, operandKind, left, right);
    }
    if (operandKind === 'bool') return booleanOperation(operator, left as boolean, right as boolean);
    if (operandKind === 'enum') return this.enumBinary(expression, left as NumericValue, right as NumericValue);
    if (COMPARISONS.has(operator))
      return compareNumeric(operator, operandKind, left as NumericValue, right as NumericValue);
    return arithmetic(operator, operandKind, left as NumericValue, right as NumericValue);
  }

  private enumBinary(expression: BinaryExpression, left: NumericValue, right: NumericValue): Value {
    const enumType = [expression.left.type, expression.right.type]
      .map((type) => nullableUnderlying(type) ?? type)
      .find((type) => type.kind === 'named' && type.symbol.kind === 'enum') as NamedType;
    const underlying = specialOf(enumType.symbol.enumUnderlying as Type) as SpecialType;
    const kind = ['long', 'ulong', 'uint'].includes(underlying) ? (underlying as 'long') : 'int';
    if (COMPARISONS.has(expression.operator)) return compareNumeric(expression.operator, kind, left, right);
    const result = arithmetic(expression.operator, kind, left, right);
    return convertNumeric(result, kind, underlying);
  }

  /**
   * An interpolated string, which Roslyn compiles to `string.Concat` when every hole is a string without an alignment
   * or a format, and otherwise to an interpolated string handler, which makes a new string.
   */
  private evaluateInterpolated(expression: Extract<BoundExpression, { kind: 'interpolated' }>, frame: Frame): Value {
    const { parts } = expression;
    if (
      parts.every(
        (part) =>
          typeof part === 'string' ||
          (part.alignment === undefined && part.format === undefined && specialOf(part.value.type) === 'string')
      )
    ) {
      return this.concatStrings(
        parts.map((part) =>
          typeof part === 'string' ? part : ((this.evaluate(part.value, frame) as string | CsString | undefined) ?? '')
        )
      );
    }
    const text = new MeteredText(this.runtime);
    for (const part of expression.parts) {
      if (typeof part === 'string') {
        text.append(part);
        continue;
      }
      const value = this.evaluate(part.value, frame);
      text.append(this.formatHole(value, frame.resolve(part.value.type), part.format, part.alignment, frame));
    }
    this.runtime.returnInterpolationBuffer();
    return freshString(text.toString());
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
    // A wide alignment is checked against the string limit before the host pads to it.
    this.runtime.allocateString(Math.max(text.length, Math.abs(alignment)), 0);
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
  /**
   * `IEquatable<T>.Equals` of a program's type that implements it for its own type, which `EqualityComparer<T>.Default`
   * calls instead of `Object.Equals`, or undefined for other values.
   */
  equalsThroughEquatable(a: Value, b: Value, elementType: Type | undefined, frame: Frame): boolean | undefined {
    if (!(a instanceof CsObject || a instanceof CsStruct) || elementType?.kind !== 'named') return undefined;
    if (elementType.symbol.isLibrary) return undefined;
    const face = namedType(this.runtime.library.typeNamed('System.IEquatable', 1), [elementType]);
    if (!this.conversions.implicit(a.type, face)) return undefined;
    const method = face.symbol.methods.find((candidate) => candidate.name === 'Equals') as MethodSymbol;
    const implementation = this.runtime.dispatch(method, a, face);
    if (implementation === method) return undefined;
    if (b === undefined) return false;
    return this.invoke(frame, implementation, a, [b], undefined, environmentOf(this, implementation, a)) as boolean;
  }

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

  /** Converts a host stack overflow into the fatal error .NET reports. */
  isStackOverflow(error: unknown): boolean {
    return error instanceof StackOverflow || (error instanceof RangeError && /call stack/i.test(error.message));
  }
}

const COMPARISONS = new Set<string>(['==', '!=', '<', '>', '<=', '>=']);

/** A binary operator on references, strings, or delegates: equality, or combining and removing delegates. */
function referenceBinary(
  runtime: Runtime,
  operator: BinaryExpression['operator'],
  operandKind: BinaryExpression['operandKind'],
  left: Value,
  right: Value
): Value {
  if (operandKind === 'delegate' && (operator === '+' || operator === '-'))
    return operator === '+' ? combineDelegates(runtime, left, right) : removeDelegate(runtime, left, right);
  const equal =
    operandKind === 'string'
      ? plainString(left) === plainString(right)
      : operandKind === 'delegate'
        ? delegatesEqual(left, right)
        : referenceEquals(left, right);
  return operator === '==' ? equal : !equal;
}

/** A lifted binary operator with a null operand. */
function liftedNullBinary(
  operator: BinaryExpression['operator'],
  operandKind: BinaryExpression['operandKind'],
  left: Value,
  right: Value
): Value {
  if (operator === '==') return left === right;
  if (operator === '!=') return left !== right;
  if (COMPARISONS.has(operator)) return false;
  if (operandKind === 'bool' && (operator === '&' || operator === '|'))
    return liftedBool(operator, left as boolean | undefined, right as boolean | undefined);
  return undefined;
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
