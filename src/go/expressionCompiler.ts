// oxlint-disable unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import { LIMITS } from '../interpreter/limits';
import { assignFailure, constantValue, convertible, represent } from './assignability';
import { type CompositeLiteral, type Expression, type Span, stripParens, type TypeExpression } from './ast';
import { CompilerBase } from './compilerBase';
import {
  binaryConstant,
  type Constant,
  ConstantDivisionByZero,
  ConstantOverflow,
  exactInteger,
  parseFloatLiteral,
  type Rational,
  rationalToFloat,
  shiftConstant,
  unaryConstant,
} from './constants';
import { conversion, stringToBytesWithMode, stringToRunesWithMode, toInterface } from './conversions';
import {
  always,
  type Entity,
  type FuncEntity,
  type FunctionContext,
  linkEscapeSource,
  linkTemporary,
  markEscapes,
  markWritten,
  never,
  type ProductSource,
  staticValueOf,
  staysLocal,
  type Temporary,
  type VarEntity,
} from './entities';
import { checkKeyHashable, equalityOf, mapKeyOf } from './equality';
import { fma } from './fma';
import { containsTypeParam, substitute } from './generics';
import { utf8Decode } from './literals';
import { currentRuntime, libraryCell } from './native';
import {
  allConstant,
  gateFacts,
  keyedFields,
  type Negation,
  type Operand,
  type SsaFacts,
  ssaFactsAt,
  type Storage,
} from './operand';
import {
  arithmetic,
  bitwiseNot,
  type ComplexNegations,
  complexProduct,
  foldedComplexProduct,
  negate,
  ordering,
  shift,
} from './operators';
import {
  clearHoists,
  type Eval,
  type Frame,
  type FunctionInfo,
  readLocal,
  runHoists,
  runToEnd,
  type Suspending,
  UNASSIGNED,
  writeLocal,
} from './runtime';
import {
  boundsPanic,
  indexPanic,
  nilPointerPanic,
  plainPanic,
  runtimeErrorPanic,
  typeAssertionPanic,
} from './runtimeErrors';
import { receive } from './scheduler';
import { boxesByAddress, isPointerShaped, moveToHeap, sizeOf } from './sliceOps';
import { sliceMode, type SliceTracking, type SliceUse } from './slicePass';
import { reachingValue } from './ssaValues';
import {
  BASIC,
  type BasicKind,
  coreType,
  defaultType,
  describeType,
  type FuncType,
  identical,
  integerBits,
  isBasic,
  isBoolean,
  isComparable,
  isComplex,
  isFloat,
  isForeignUnexported,
  isInteger,
  isInterface,
  isNumeric,
  isOrdered,
  isString,
  isUnsigned,
  isUntyped,
  lookupFieldOrMethod,
  type MissingMethod,
  missingMethod,
  type NamedType,
  NO_VALUE,
  RUNE,
  type Type,
  type TypeParamType,
  typeString,
  underlying,
} from './types';
import {
  Cell,
  type Channel,
  Complex,
  CONSTANT_IFACES,
  copyValue,
  GoArray,
  type GoFunc,
  type GoMap,
  GoStruct,
  Iface,
  Pointer,
  Slice,
  SliceArrayPointer,
  type Value,
  writeInPlace,
} from './values';

/** Compiles expressions, checking their types as Go's compiler does. */
export abstract class ExpressionCompiler extends CompilerBase {
  protected abstract compileCall(expression: Extract<Expression, { kind: 'call' }>): Operand;
  protected abstract compileFuncLiteral(expression: Extract<Expression, { kind: 'funcLiteral' }>): Operand;
  protected abstract composite(expression: CompositeLiteral, elided: Type | undefined): Operand;

  protected invalid(span: Span): Operand {
    return { mode: 'value', type: BASIC.invalid, span, eval: () => {} };
  }

  protected isInvalid(operand: Operand): boolean {
    return operand.type === BASIC.invalid;
  }

  /**
   * The values of the statement being compiled that `hoistingCalls` evaluates first, in the order of their keys, and
   * the number of values that their own expressions put there so far.
   */
  private hoisted:
    | { fn: FunctionContext | undefined; values: { slot: number; evaluate: Eval; key: number }[]; count: number }
    | undefined;

  /**
   * Compiles a statement's expressions in Go's compiler's two passes (walk/order.go): the first evaluates the calls into
   * temporaries, in order with each call after the calls among its operands, and the second the rest of the
   * operands, such as variable reads, the checks of assignment destinations, and the stores. Besides calls, the first
   * pass copies slice expressions, && and || expressions, type assertions to types that are not pointer-shaped, map
   * literals, conversions of strings to byte or rune slices, keys of maps without fast access, and values that are
   * not variables converted to interfaces through their addresses. The values wait in hidden slots, which garbage collection follows, until the
   * statement ends.
   */
  protected hoistingCalls<T>(compile: () => T): {
    result: T;
    run: (frame: Frame, rest: () => void) => void;
    hoists: boolean;
  } {
    const outer = this.hoisted;
    const hoisted: NonNullable<typeof this.hoisted> = { fn: this.fn, values: [], count: 0 };
    this.hoisted = hoisted;
    let result: T;
    try {
      result = compile();
    } finally {
      this.hoisted = outer;
    }
    if (hoisted.values.length === 0) return { result, run: (_, rest) => rest(), hoists: false };
    const values = hoisted.values.toSorted((a, b) => a.key - b.key);
    return {
      result,
      hoists: true,
      run: (frame, rest) => {
        try {
          for (const { slot, evaluate } of values) frame.locals[slot] = evaluate(frame) as Value;
          rest();
        } finally {
          for (const { slot } of values) frame.locals[slot] = UNASSIGNED;
        }
      },
    };
  }

  /**
   * Evaluates a value in the first pass of the statement being compiled, if any: after the values already there, or
   * where an operand compiled earlier stands, given by its `firstPass`.
   */
  private hoist(evaluate: Eval, firstPass?: number): Eval {
    const hoisted = this.hoisted;
    if (!hoisted || hoisted.fn !== this.fn) return evaluate;
    const slot = this.hiddenSlot();
    const key = firstPass === undefined ? hoisted.count++ : firstPass - 0.5;
    if (this.hoists) {
      this.hoists.push({
        slot,
        *run(frame) {
          return evaluate(frame);
        },
      });
    } else hoisted.values.push({ slot, evaluate, key });
    return (frame) => frame.locals[slot] as Value;
  }

  /** Converts a value to an interface, in the first pass where Go's compiler copies it to take its address. */
  private boxing(value: Operand): Eval {
    const box = toInterface(value.type);
    const read = value.eval;
    if (value.mode === 'constant') {
      // Go's compiler places a converted constant in read-only data, shared by every evaluation.
      const constantIface = box(read({} as Frame)) as Iface;
      CONSTANT_IFACES.add(constantIface);
      return () => constantIface;
    }
    // Go's compiler converts a value it resolves to a constant (a local or an inlined call's result) as it converts
    // the constant itself.
    const constant = value.static?.constant;
    const boxed: Eval = constant
      ? (frame) => {
          const iface = box(read(frame)) as Iface;
          if (constant(frame)) CONSTANT_IFACES.add(iface);
          return iface;
        }
      : (frame) => box(read(frame));
    if (value.mode === 'variable' || value.callResult || !boxesByAddress(value.type)) return boxed;
    return this.hoist(boxed, value.firstPass);
  }

  /** Compiles a value whose calls run first when it is read, as Go's compiler orders the expression of a statement. */
  protected orderedValue(expression: Expression): Operand {
    const { result: operand, run, hoists } = this.hoistingCalls(() => this.value(expression));
    if (!hoists) return operand;
    const read = operand.eval;
    return {
      ...operand,
      eval: (frame) => {
        let value: Value;
        run(frame, () => {
          value = read(frame) as Value;
        });
        return value;
      },
    };
  }

  /** The arguments of a deferred builtin call, which `capture` makes read the values the defer statement took. */
  protected deferredArguments: { args: ReadonlySet<Expression>; capture: (operand: Operand) => Operand } | undefined;

  expression(expression: Expression): Operand {
    const deferred = this.deferredArguments;
    if (deferred?.args.has(expression)) {
      this.deferredArguments = undefined;
      try {
        return deferred.capture(this.expression(expression));
      } finally {
        this.deferredArguments = deferred;
      }
    }
    const hoisted = this.hoisted;
    if (!hoisted || hoisted.fn !== this.fn) return this.compileExpression(expression);
    const tracked = this.withRuntimeCallTracking(() => this.compileExpression(expression));
    let operand = tracked.result;
    if (operand.mode === 'value' && !this.isInvalid(operand) && this.copiedInFirstPass(expression, operand)) {
      operand = operand.commaOk
        ? this.hoistCommaOk(operand, operand.commaOk)
        : { ...operand, eval: this.hoist(operand.eval) };
    }
    return { ...operand, firstPass: hoisted.count };
  }

  /** Copies a type assertion in the first pass in the form its statement uses: one value, which may panic, or `v, ok`. */
  private hoistCommaOk(operand: Operand, commaOk: NonNullable<Operand['commaOk']>): Operand {
    const single = operand.eval;
    let pair = false;
    const read = this.hoist((frame) => (pair ? (commaOk(frame) as unknown as Value) : single(frame)));
    return {
      ...operand,
      eval: read,
      commaOk: (frame) => read(frame) as unknown as [Value, boolean],
      useCommaOk: () => {
        pair = true;
      },
    };
  }

  private copiedInFirstPass(expression: Expression, operand: Operand): boolean {
    switch (expression.kind) {
      case 'call': {
        return operand.isCall === true;
      }
      case 'slice': {
        return true;
      }
      case 'binary': {
        return expression.operator === '&&' || expression.operator === '||';
      }
      case 'typeAssert': {
        return !isPointerShaped(operand.type);
      }
      case 'composite': {
        return underlying(operand.type).kind === 'map';
      }
      default: {
        return false;
      }
    }
  }

  // code-gauge-allow functionNcss 40 -- Keeps Go operand validation, evaluation order and result storage together for this expression.
  private compileExpression(expression: Expression): Operand {
    if (this.fn) this.fn.inlineCost++;
    switch (expression.kind) {
      case 'name': {
        return this.name(expression, true);
      }
      case 'int': {
        return this.constant({ kind: 'int', value: expression.value }, BASIC.untypedInt, expression);
      }
      case 'float': {
        return this.literalConstant(
          expression,
          () => ({ kind: 'float', value: parseFloatLiteral(expression.text) }),
          BASIC.untypedFloat
        );
      }
      case 'imaginary': {
        return this.literalConstant(
          expression,
          () => ({ kind: 'complex', re: { num: 0n, den: 1n }, im: imaginaryPart(expression.text.slice(0, -1)) }),
          BASIC.untypedComplex
        );
      }
      case 'rune': {
        return this.constant({ kind: 'int', value: BigInt(expression.value) }, BASIC.untypedRune, expression);
      }
      case 'string': {
        return this.constant({ kind: 'string', value: expression.value }, BASIC.untypedString, expression);
      }
      case 'composite': {
        return this.composite(expression, undefined);
      }
      case 'funcLiteral': {
        return this.compileFuncLiteral(expression);
      }
      case 'paren': {
        const inner = this.expression(expression.expression);
        return { ...inner, span: expression };
      }
      case 'selector': {
        return this.selector(expression);
      }
      case 'index': {
        return this.index(expression);
      }
      case 'slice': {
        return this.sliceExpression(expression);
      }
      case 'typeAssert': {
        return this.typeAssertion(expression);
      }
      case 'call': {
        return this.compileCall(expression);
      }
      case 'unary': {
        return this.unary(expression);
      }
      case 'binary': {
        return this.binary(expression);
      }
      case 'type': {
        const type = this.resolveType(expression.type);
        return { mode: 'type', type, span: expression, eval: () => {} };
      }
    }
  }

  private literalConstant(span: Span, make: () => Constant, type: Type): Operand {
    try {
      return this.constant(make(), type, span);
    } catch (error) {
      if (!(error instanceof ConstantOverflow)) throw error;
      this.error(span, '定数が大きすぎます。');
      return this.invalid(span);
    }
  }

  protected constant(written: Constant, type: Type, span: Span): Operand {
    // A typed floating-point or complex constant holds a value of its type's precision, as Go's compiler rounds it.
    let constant = written;
    if (!isUntyped(type) && (isFloat(type) || isComplex(type))) {
      const represented = represent(written, type);
      if ('constant' in represented) constant = represented.constant;
    }
    const runtimeType = defaultType(type);
    const value = this.representsDefault(constant, runtimeType);
    return { mode: 'constant', type, span, constant, eval: () => value, ssaConstant: always, static: STATIC_CONSTANT };
  }

  private representsDefault(constant: Constant, type: Type): Value {
    if (type.kind === 'basic' && type.basic === 'untypedNil') return undefined;
    return constantValue(constant, type);
  }

  /** Compiles an expression that must be a single value, rejecting types, packages, and calls without results. */
  value(expression: Expression): Operand {
    return this.asValue(this.expression(expression));
  }

  protected asValue(operand: Operand): Operand {
    switch (operand.mode) {
      case 'type': {
        this.error(operand.span, `${describeType(operand.type)} は型なので、値としては使えません。`);
        return this.invalid(operand.span);
      }
      case 'builtin': {
        this.error(operand.span, `${operand.builtin} は呼び出さないと使えません。`);
        return this.invalid(operand.span);
      }
      case 'package': {
        // Go's compiler does not count this use, so it also reports the import as unused.
        if (operand.package) operand.package.used = false;
        this.error(
          operand.span,
          `パッケージ ${operand.package?.name} は、${operand.package?.name}.名前 の形で使ってください。`
        );
        return this.invalid(operand.span);
      }
      case 'novalue': {
        this.error(operand.span, '結果を返さない関数の呼び出しは、値としては使えません。');
        return this.invalid(operand.span);
      }
      case 'method': {
        return this.methodValue(operand);
      }
      default: {
        if (operand.type.kind === 'tuple') {
          this.error(operand.span, `複数の値を返す関数の呼び出しは、1つの値としては使えません。`);
          return this.invalid(operand.span);
        }
        return operand;
      }
    }
  }

  // Names ---------------------------------------------------------------------------------------------------------

  /** Compiles a name; `use` is false for the left side of a plain assignment, which does not count as a use. */
  protected name(expression: Extract<Expression, { kind: 'name' }>, use: boolean): Operand {
    const { name } = expression;
    if (name === '_') {
      this.error(expression, '_ は値としては使えません。');
      return this.invalid(expression);
    }
    const entity = this.lookup(name);
    if (!entity && name === 'iota') {
      if (this.iota !== undefined)
        return this.constant({ kind: 'int', value: BigInt(this.iota) }, BASIC.untypedInt, expression);
      this.error(expression, 'iota は定数の宣言の中でしか使えません。');
      return this.invalid(expression);
    }
    if (!entity) {
      this.error(expression, `${name} は宣言されていません。`);
      return this.invalid(expression);
    }
    if (entity.kind === 'var' && entity.slice && entity.owner === this.fn) {
      const sliceUse: SliceUse = {};
      entity.slice.uses.push(sliceUse);
      this.sliceUses.set(expression, { tracking: entity.slice, use: sliceUse });
    }
    return this.entityOperand(entity, expression, use);
  }

  /** Each mention of a local slice variable that Go's slice optimization pass tracks, by its name expression. */
  private readonly sliceUses = new WeakMap<Expression, { tracking: SliceTracking; use: SliceUse }>();

  /** The tracked slice variable an expression names, unless it is something else. */
  protected sliceUseOf(syntax: Expression): { tracking: SliceTracking; use: SliceUse } | undefined {
    return this.sliceUses.get(stripParens(syntax));
  }

  /** Records that the slice optimization pass understands a mention of a tracked slice variable. */
  protected understandSlice(syntax: Expression, understood: () => boolean = always): SliceTracking | undefined {
    const found = this.sliceUseOf(syntax);
    if (found) found.use.understood = understood;
    return found?.tracking;
  }

  /**
   * A use of a tracked slice variable that lets its array be shared, before which Go's compiler moves the array out of
   * the stack buffer; `applies` tells whether the use is a transition, which for a call depends on inlining.
   */
  protected sliceTransition(syntax: Expression, operand: Operand, applies: () => boolean = always): Operand {
    const found = this.sliceUseOf(syntax);
    const { store } = operand;
    if (!found || !store) return operand;
    found.use.understood = always;
    const { tracking } = found;
    tracking.transitions.push({ loopDepth: (this.fn as FunctionContext).loopDepth, applies });
    const read = operand.eval;
    const move = this.moveSliceToHeap(operand.type, tracking, applies);
    return {
      ...operand,
      eval: (frame) => {
        const value = read(frame);
        const moved = move(frame, value);
        if (moved !== value) store(frame, moved);
        return moved;
      },
    };
  }

  /** Go's move2heap, which a transition of a variable in the `move` mode applies to the variable's slice. */
  protected moveSliceToHeap(
    type: Type,
    tracking: SliceTracking,
    applies: () => boolean
  ): (frame: Frame, value: Value) => Value {
    const { element } = underlying(type) as Extract<Type, { kind: 'slice' }>;
    const zero = this.zeroOf(element);
    return (frame, value) => {
      if (sliceMode(tracking) !== 'move' || !applies()) return value;
      return moveToHeap(value as Slice | undefined, element, zero, (count) => frame.runtime.allocate(count));
    };
  }

  // code-gauge-allow functionNcss 31 -- Keeps Go operand validation, evaluation order and result storage together for this expression.
  protected entityOperand(entity: Entity, span: Span, use: boolean): Operand {
    switch (entity.kind) {
      case 'var': {
        if (use) entity.used = true;
        entity.pending?.();
        this.fn?.references.add(entity);
        return this.variableOperand(entity, span);
      }
      case 'const': {
        entity.pending?.();
        entity.used = true;
        if (entity.type === BASIC.invalid) return this.invalid(span);
        return this.constant(entity.value, entity.type, span);
      }
      case 'type': {
        this.useType(entity);
        if (entity.generic) {
          this.error(span, `型 ${entity.name} を使うには、型引数を書いてください。`);
          return this.invalid(span);
        }
        return { mode: 'type', type: entity.type, span, eval: () => {} };
      }
      case 'func': {
        this.fn?.references.add(entity);
        if (entity.generic) {
          return { mode: 'value', type: entity.generic.type, span, eval: () => {}, func: entity };
        }
        return {
          mode: 'value',
          type: entity.type,
          span,
          eval: () => entity.value(),
          func: entity,
          static: entity.summary && { callee: { summary: entity.summary, holds: always } },
        };
      }
      case 'builtin': {
        return { mode: 'builtin', type: NO_VALUE, span, builtin: entity.name, eval: () => {} };
      }
      case 'package': {
        return { mode: 'package', type: NO_VALUE, span, package: entity, eval: () => {} };
      }
      case 'nil': {
        return { mode: 'value', type: BASIC.untypedNil, span, eval: () => {} };
      }
    }
  }

  protected variableOperand(entity: VarEntity, span: Span): Operand {
    const { slot } = entity;
    const markUsed = (): void => {
      entity.used = true;
    };
    if (entity.library) {
      const prepareLibraryStore = (): ((value: Value) => void) => {
        const cell = libraryCell(entity);
        return (value) => {
          cell.v = writeInPlace(cell.v, value);
        };
      };
      return {
        mode: 'variable',
        type: entity.type,
        span,
        variable: { markUsed },
        eval: () => libraryCell(entity).v,
        prepareStore: prepareLibraryStore,
        store: (_frame, value) => prepareLibraryStore()(value),
        addressOf: () => () => new Pointer(libraryCell(entity), 'v'),
      };
    }
    if (!entity.owner) {
      const prepareStore = (frame: Frame): ((value: Value) => void) => {
        const cell = frame.runtime.globals[slot];
        return (value) => {
          cell.v = writeInPlace(cell.v, value);
        };
      };
      return {
        mode: 'variable',
        type: entity.type,
        span,
        ...(this.inAllocatedSlice ? {} : this.reachingOperand(entity)),
        variable: { markUsed },
        ssaVariable: entity,
        eval: (frame) => frame.runtime.globals[slot].v,
        prepareStore,
        store: (frame, value) => prepareStore(frame)(value),
        addressOf: () => (frame) => new Pointer(frame.runtime.globals[slot], 'v'),
      };
    }
    if (entity.owner === this.fn) {
      return {
        mode: 'variable',
        type: entity.type,
        span,
        ...this.reachingOperand(entity),
        static: staticValueOf(entity, true),
        variable: { markUsed, entity },
        ssaVariable: entity,
        backingVars: [entity],
        addressStorage: { backingVars: [entity] },
        ssaRoot: entity,
        addressTaken: () => {
          entity.addressTaken = true;
        },
        eval: (frame) => readLocal(frame, slot),
        prepareStore: (frame) => (value) => writeLocal(frame, slot, value),
        store: (frame, value) => writeLocal(frame, slot, value),
        addressOf: () => {
          entity.boxed = true;
          return (frame) => new Pointer(frame.locals[slot] as Cell, 'v');
        },
      };
    }
    const index = this.capture(entity, this.fn as NonNullable<typeof this.fn>);
    const prepareStore = (frame: Frame): ((value: Value) => void) => {
      const cell = frame.cells[index];
      return (value) => {
        cell.v = writeInPlace(cell.v, value);
      };
    };
    return {
      mode: 'variable',
      type: entity.type,
      span,
      ssaConstant: (params) => params?.constantCapture?.(entity) ?? false,
      ssaFields: keyedFields(entity, entity.type),
      static: staticValueOf(entity, false),
      variable: { markUsed, entity },
      backingVars: [entity],
      addressStorage: { backingVars: [entity] },
      ssaRoot: entity,
      addressTaken: () => {
        entity.addressTaken = true;
      },
      eval: (frame) => frame.cells[index].v,
      prepareStore,
      store: (frame, value) => prepareStore(frame)(value),
      addressOf: () => (frame) => new Pointer(frame.cells[index], 'v'),
    };
  }

  /** What Go's SSA form knows of a variable's value at this use, from the definition that reaches it. */
  private reachingOperand(
    entity: VarEntity
  ): Pick<Operand, 'product' | 'ssaConstant' | 'ssaFields' | 'ssaVersion' | 'negation' | 'partNegations'> {
    const { constant, factors, fields, version, negation, partNegations } = reachingValue(this.fn, entity);
    return {
      product: factors && {
        left: (frame) => frame.locals[factors.left] as Value,
        right: (frame) => frame.locals[factors.right] as Value,
        enabled: factors.enabled,
        constant,
        source: factors.source,
      },
      ssaConstant: constant,
      ssaFields: fields,
      ssaVersion: version,
      negation,
      partNegations,
    };
  }

  protected escapeOperand(operand: Storage): void {
    if (operand.backingVars) {
      for (const entity of operand.backingVars) markEscapes(entity);
    }
    if (operand.nonEscaping) operand.nonEscaping.escapes = true;
  }

  /** Records that the program may write the elements of the array a slice value refers to. */
  protected writeOperand(operand: Storage): void {
    if (operand.backingVars) {
      for (const entity of operand.backingVars) markWritten(entity);
    }
    if (operand.nonEscaping) operand.nonEscaping.written = true;
  }

  /** Makes the local storage a value refers to share what happens to the variable `target` that holds it. */
  protected recordLocalEscapeAlias(operand: Storage, target: VarEntity): void {
    if (operand.backingVars) {
      for (const source of operand.backingVars) linkEscapeSource(source, target);
    }
    if (operand.nonEscaping) linkTemporary(operand.nonEscaping, target);
  }

  // Conversions -----------------------------------------------------------------------------------------------------

  /**
   * Converts an operand for storing into a value of `target`: an untyped constant takes the type, a concrete value
   * enters an interface, and structs and arrays are copied. Reports the mismatch as `context` says. The value escapes
   * unless `holder` is the local variable that receives it or links it to where it goes.
   */
  // code-gauge-allow functionCognitiveComplexity 26 -- Keeps Go operand validation, evaluation order and result storage together for this expression.
  // code-gauge-allow functionNcss 36 -- Keeps Go operand validation, evaluation order and result storage together for this expression.
  protected assign(
    operand: Operand,
    target: Type,
    context: string,
    holder?: VarEntity | ((value: Operand) => void)
  ): Eval {
    if (this.isInvalid(operand) || target === BASIC.invalid) return () => {};
    let value = this.asValue(operand);
    if (this.isInvalid(value)) return () => {};
    if (typeof holder === 'function') holder(value);
    else if (holder?.owner === undefined) this.escapeOperand(value);
    else this.recordLocalEscapeAlias(value, holder);
    if (value.resolveUntyped) {
      value = value.resolveUntyped(isInterface(target) ? defaultType(value.type) : target);
      if (this.isInvalid(value)) return () => {};
    }
    if (value.mode === 'constant' && value.constant && isUntyped(value.type)) {
      return this.assignConstant(value, target, context);
    }
    // An untyped boolean from a comparison takes a boolean target's type, or bool otherwise.
    if (value.type === BASIC.untypedBool) value = { ...value, type: isBoolean(target) ? target : BASIC.bool };
    if (value.type.kind === 'basic' && value.type.basic === 'untypedNil') {
      if (assignFailure(value.type, target)) {
        this.error(value.span, `nil は ${describeType(target)} 型の${context}には使えません。`);
      }
      return () => {};
    }
    const failure = assignFailure(value.type, target);
    if (failure) {
      const detail = failure.kind === 'missingMethod' ? describeMissingMethod(value.type, failure.missing) : '';
      this.error(
        value.span,
        `${describeType(value.type)} 型の値は、${describeType(target)} 型の${context}には使えません${detail}。`
      );
      return () => {};
    }
    if (isInterface(target) && !isInterface(value.type)) return this.boxing(value);
    if (isValueType(target)) {
      const read = value.eval;
      return (frame) => copyValue(read(frame));
    }
    return value.eval;
  }

  private assignConstant(operand: Operand, target: Type, context: string): Eval {
    const constant = operand.constant as Constant;
    if (isInterface(target) || target.kind === 'typeParam') {
      const type = defaultType(operand.type);
      if (target.kind === 'typeParam') {
        // A type parameter's value must work for every type it allows, which the generic check verifies.
        if (!fitsTypeParam(constant, target))
          this.error(operand.span, `定数は ${target.name} 型の${context}には使えません。`);
        return () => {};
      }
      const representation = represent(constant, type);
      if ('error' in representation) {
        this.reportRepresentation(operand, type, representation.error, context);
        return () => {};
      }
      const failure = assignFailure(type, target);
      if (failure) {
        this.error(
          operand.span,
          `${describeType(type)} 型の値は、${describeType(target)} 型の${context}には使えません。`
        );
        return () => {};
      }
      const value = new Iface(type, constantValue(representation.constant, type));
      CONSTANT_IFACES.add(value);
      return () => value;
    }
    const representation = represent(constant, target);
    if ('error' in representation) {
      this.reportRepresentation(operand, target, representation.error, context);
      return () => {};
    }
    const value = constantValue(representation.constant, target);
    return () => value;
  }

  protected reportRepresentation(
    operand: Operand,
    target: Type,
    error: 'overflows' | 'truncated' | 'mismatch',
    context: string
  ): void {
    const text = describeConstant(operand.constant as Constant);
    if (error === 'overflows') this.error(operand.span, `定数 ${text} は ${describeType(target)} 型に収まりません。`);
    else if (error === 'truncated')
      this.error(operand.span, `定数 ${text} は ${describeType(target)} 型では小数部分や虚部が失われます。`);
    else
      this.error(
        operand.span,
        `${describeType(operand.type)} の定数 ${text} は、${describeType(target)} 型の${context}には使えません。`
      );
  }

  /** Gives an untyped value its default type, as a variable declared without a type takes. */
  protected defaulted(operand: Operand): Operand {
    if (!isUntyped(operand.type)) return operand;
    if (operand.type.kind === 'basic' && operand.type.basic === 'untypedNil') {
      this.error(operand.span, 'nil の型を決められません。');
      return this.invalid(operand.span);
    }
    const type = defaultType(operand.type);
    if (operand.resolveUntyped) return operand.resolveUntyped(type);
    if (operand.mode !== 'constant' || !operand.constant) return { ...operand, type };
    const representation = represent(operand.constant, type);
    if ('error' in representation) {
      this.reportRepresentation(operand, type, representation.error, '値');
      return this.invalid(operand.span);
    }
    const value = constantValue(representation.constant, type);
    return { ...operand, type, constant: representation.constant, eval: () => value };
  }

  /** Converts an untyped operand to the type of the other operand of a binary operator. */
  // code-gauge-allow functionCognitiveComplexity 19 -- Keeps Go operand validation, evaluation order and result storage together for this expression.
  private convertUntyped(operand: Operand, target: Type): Operand {
    if (!isUntyped(operand.type) || isUntyped(target) || this.isInvalid(operand)) return operand;
    if (operand.type.kind === 'basic' && operand.type.basic === 'untypedNil') return { ...operand, type: target };
    if (operand.resolveUntyped) {
      return operand.resolveUntyped(isInterface(target) ? defaultType(operand.type) : target);
    }
    if (operand.mode === 'constant' && operand.constant) {
      if (isInterface(target)) return this.defaulted(operand);
      if (target.kind === 'typeParam') {
        if (fitsTypeParam(operand.constant, target)) return { ...operand, type: target, eval: () => {} };
        this.error(operand.span, `定数は ${target.name} 型のオペランドには使えません。`);
        return this.invalid(operand.span);
      }
      const representation = represent(operand.constant, target);
      if ('error' in representation) {
        this.reportRepresentation(operand, target, representation.error, 'オペランド');
        return this.invalid(operand.span);
      }
      return { ...operand, ...this.constant(representation.constant, target, operand.span) };
    }
    // An untyped boolean from a comparison.
    return { ...operand, type: isBoolean(target) ? target : BASIC.bool };
  }

  // Operators ------------------------------------------------------------------------------------------------------

  /** Compiles a channel that a receive uses, which a send-only channel cannot be. */
  protected receivableChannel(expression: Expression): { eval: Eval; element: Type } | undefined {
    const operand = this.value(expression);
    if (this.isInvalid(operand)) return undefined;
    const type = coreType(operand.type);
    if (type?.kind !== 'chan') {
      this.error(expression, `${describeType(operand.type)} 型の値はチャネルではないので、<- で受信できません。`);
      return undefined;
    }
    if (type.dir === 'send') {
      this.error(expression, '送信専用のチャネルからは受信できません。');
      return undefined;
    }
    return { eval: operand.eval, element: type.element };
  }

  /**
   * `<-ch`: the value received, or with `commaOk`, also whether a send gave it rather than the channel's closing, as
   * `v, ok := <-ch` takes them.
   */
  protected receive(expression: Extract<Expression, { kind: 'unary' }>, commaOk: boolean): Operand {
    this.runtimeCallCount++;
    const channel = this.receivableChannel(expression.operand);
    if (!channel) return this.invalid(expression);
    const type = channel.element;
    const run = function* (frame: Frame): Suspending<Value> {
      const [value, ok] = yield* receive(channel.eval(frame) as Channel | undefined);
      return (commaOk ? [value, ok] : value) as Value;
    };
    const evaluate = this.suspending(run, (frame) => runToEnd(run(frame)));
    if (!commaOk) return { mode: 'value', type, span: expression, eval: evaluate, isCall: true };
    return {
      mode: 'value',
      type,
      span: expression,
      eval: (frame) => (evaluate(frame) as unknown as [Value, boolean])[0],
      commaOk: (frame) => evaluate(frame) as unknown as [Value, boolean],
      isCall: true,
    };
  }

  /** `Box[int]` written where an expression may stand, as in a conversion: the instance of a generic type. */
  private genericTypeIndex(expression: Extract<Expression, { kind: 'index' }>): Operand | undefined {
    const operand = expression.operand;
    let entity;
    if (operand.kind === 'name') entity = this.scope.lookup(operand.name);
    else if (operand.kind === 'selector' && operand.operand.kind === 'name') {
      const pkg = this.scope.lookup(operand.operand.name);
      if (pkg?.kind === 'package') entity = pkg.package.members.get(operand.field);
    }
    if (entity?.kind !== 'type' || !entity.generic) return undefined;
    const syntax = typeSyntaxOf(expression);
    if (!syntax) {
      this.error(expression, '型引数には型を書いてください。');
      return this.invalid(expression);
    }
    const type = this.resolveType(syntax);
    if (type === BASIC.invalid) return this.invalid(expression);
    return { mode: 'type', type, span: expression, eval: () => {} };
  }

  /**
   * `f[int, string]`: a generic function with written type arguments, which is an ordinary function when it has all
   * of them; with fewer, a call infers the rest.
   */
  private instantiation(expression: Extract<Expression, { kind: 'index' }>, base: Operand): Operand {
    const entity = base.func as FuncEntity;
    const generic = entity.generic as NonNullable<FuncEntity['generic']>;
    const args: Type[] = [];
    for (const index of expression.indices) {
      const syntax = typeSyntaxOf(index);
      const type = syntax ? this.resolveType(syntax) : undefined;
      if (!syntax) this.error(index, 'ここには型を書いてください。');
      if (type === undefined || type === BASIC.invalid) return this.invalid(expression);
      args.push(type);
    }
    if (args.length > generic.typeParams.length) {
      this.error(
        expression,
        `${entity.name} の型引数が多すぎます（${generic.typeParams.length} 個ですが、${args.length} 個書かれています）。`
      );
      return this.invalid(expression);
    }
    if (args.length < generic.typeParams.length) return { ...base, span: expression, typeArgs: args };
    if (!this.checkTypeArguments(generic.typeParams, args, expression)) return this.invalid(expression);
    const mapping = new Map<number, Type>(generic.typeParams.map((param, index) => [param.id, args[index]]));
    const type = substitute(generic.type, mapping, (named: NamedType, typeArgs: Type[]) =>
      this.instantiateNamed(named, typeArgs)
    ) as FuncType;
    if (args.some((arg) => containsTypeParam(arg))) return { mode: 'value', type, span: expression, eval: () => {} };
    const instance = generic.instantiate(args);
    const func: FuncEntity = {
      kind: 'func',
      name: entity.name,
      type,
      value: () => instance,
      direct: (values, row, stackBuffers) => instance.call(values, row, undefined, stackBuffers),
      directResume:
        instance.resume &&
        ((values, row, stackBuffers) =>
          (instance.resume as NonNullable<GoFunc['resume']>)(values, row, undefined, stackBuffers)),
    };
    return { mode: 'value', type, span: expression, eval: () => instance, func };
  }

  private unary(expression: Extract<Expression, { kind: 'unary' }>): Operand {
    const { operator } = expression;
    if (operator === '&') return this.addressOf(expression);
    if (operator === '<-') return this.receive(expression, false);
    if (operator === '*') {
      const target = this.expression(expression.operand);
      // `*T` where T is a type is the pointer type, as in the conversion `(*T)(p)`.
      if (target.mode === 'type')
        return {
          mode: 'type',
          type: { kind: 'pointer', element: target.type },
          span: expression,
          eval: () => {},
        };
      const pointer = this.asValue(target);
      return this.isInvalid(pointer) ? pointer : this.dereference(expression, pointer);
    }
    const operand = this.value(expression.operand);
    if (this.isInvalid(operand)) return operand;
    const unaryOp = operator as '+' | '-' | '!' | '^';
    if (operand.resolveUntyped) {
      const resolveOperand = operand.resolveUntyped;
      return {
        mode: 'value',
        type: operand.type,
        span: expression,
        eval: () => {},
        resolveUntyped: (target) => {
          const resolved = resolveOperand(target);
          return this.isInvalid(resolved) ? resolved : this.applyUnary(expression, unaryOp, resolved);
        },
      };
    }
    return this.applyUnary(expression, unaryOp, operand);
  }

  // code-gauge-allow functionCognitiveComplexity 24 -- Keeps Go operand validation, evaluation order and result storage together for this expression.
  private applyUnary(span: Span, operator: '+' | '-' | '!' | '^', operand: Operand): Operand {
    const type = operand.type;
    const allowed = operator === '!' ? isBoolean(type) : operator === '^' ? isInteger(type) : isNumeric(type);
    if (!allowed) {
      this.error(span, `演算子 ${operator} は ${describeType(type)} 型の値には使えません。`);
      return this.invalid(span);
    }
    if (operand.mode === 'constant' && operand.constant) {
      const unsignedBits =
        operator === '^' && isUnsigned(type) && !isUntyped(type) ? integerBits(basicKind(type)).bits : undefined;
      const constant = unaryConstant(operator, operand.constant, unsignedBits);
      if (!isUntyped(type)) {
        const representation = represent(constant, type);
        if ('error' in representation) {
          this.error(span, `定数 ${describeConstant(constant)} は ${describeType(type)} 型に収まりません。`);
          return this.invalid(span);
        }
        return this.constant(representation.constant, type, span);
      }
      return this.constant(constant, type, span);
    }
    const read = operand.eval;
    if (operator === '+') return { mode: 'value', type, span, eval: read, product: operand.product };
    // -(x*y) stays a product for fusing, as Go's compiler rewrites it to FNMUL.
    if (operator === '-' && operand.product) {
      const { left, right } = operand.product;
      const negated: Eval = (frame) => -(left(frame) as number);
      const apply = negate(type);
      return {
        mode: 'value',
        type,
        span,
        eval: (frame) => apply(read(frame)),
        product: { ...operand.product, left: negated, right, negated: toggled(operand.product.negated) },
      };
    }
    if (this.hasTypeParam(type)) return { mode: 'value', type, span, eval: () => {} };
    if (operator === '!') return { mode: 'value', type, span, eval: (frame) => !read(frame) };
    const apply = operator === '-' ? negate(type) : bitwiseNot(type);
    return {
      mode: 'value',
      type,
      span,
      eval: (frame) => apply(read(frame)),
      ssaConstant: operand.ssaConstant,
      // Go's compiler negates a negation again (FNEGD) rather than cancelling the two.
      ...(operator === '-' && isFloat(type) ? { negation: always } : {}),
      ...(operator === '-' && isComplex(type) ? { partNegations: [always, always] as const } : {}),
    };
  }

  protected hasTypeParam(type: Type): boolean {
    return type.kind === 'typeParam';
  }

  private addressOf(expression: Extract<Expression, { kind: 'unary' }>): Operand {
    let inner = expression.operand;
    while (inner.kind === 'paren') inner = inner.expression;
    if (inner.kind === 'composite') {
      const literal = this.composite(inner, undefined);
      const read = literal.eval;
      return {
        mode: 'value',
        type: { kind: 'pointer', element: literal.type },
        span: expression,
        backingVars: literal.backingVars,
        createsObject: true,
        eval: (frame) => new Pointer(new Cell(read(frame)), 'v'),
      };
    }
    const operand = this.expression(inner);
    if (this.isInvalid(operand)) return operand;
    if (operand.mode !== 'variable' || !operand.addressOf) {
      this.error(
        expression,
        'この式のアドレスは取れません（変数・フィールド・配列やスライスの要素だけに & を付けられます）。'
      );
      return this.invalid(expression);
    }
    operand.variable?.markUsed();
    operand.addressTaken?.();
    return {
      mode: 'value',
      type: { kind: 'pointer', element: operand.type },
      span: expression,
      backingVars: operand.addressStorage?.backingVars,
      nonEscaping: operand.addressStorage?.nonEscaping,
      eval: operand.addressOf(),
    };
  }

  private dereference(span: Span, operand: Operand): Operand {
    const under = coreType(operand.type);
    if (under?.kind !== 'pointer') {
      this.error(span, `${describeType(operand.type)} 型の値はポインタではないので、* を付けられません。`);
      return this.invalid(span);
    }
    const read = operand.eval;
    const pointer = (frame: Frame): Pointer => {
      const value = read(frame);
      if (!(value instanceof Pointer)) nilPointerPanic();
      return value;
    };
    const locatePointer = (frame: Frame): (() => Pointer) => {
      const value = read(frame);
      return () => {
        if (!(value instanceof Pointer)) nilPointerPanic();
        return value;
      };
    };
    return {
      mode: 'variable',
      type: under.element,
      span,
      eval: (frame) => pointer(frame).load(),
      locate: (frame) => {
        const target = locatePointer(frame);
        return () => target().load();
      },
      prepareStore: (frame) => {
        const target = locatePointer(frame);
        return (value) => target().store(value);
      },
      store: (frame, value) => pointer(frame).store(value),
      addressOf: () => pointer,
      addressStorage: operand,
    };
  }

  private binary(expression: Extract<Expression, { kind: 'binary' }>): Operand {
    const { operator } = expression;
    if ((operator === '&&' || operator === '||') && this.hoists) return this.blockingLogical(expression);
    if (expression.operator === '&&' || expression.operator === '||') {
      // Each operand orders its own calls, as the right one runs only when it is needed.
      return this.binaryOfOperands(
        expression,
        expression.operator,
        this.orderedValue(expression.left),
        this.orderedValue(expression.right)
      );
    }
    return this.binaryOfOperands(
      expression,
      expression.operator,
      this.value(expression.left),
      this.value(expression.right)
    );
  }

  /**
   * `a && b` and `a || b` in a statement that may block: the computations that may block in `b` run only when `a`
   * does not decide the result, so the whole operation runs with them.
   */
  private blockingLogical(expression: Extract<Expression, { kind: 'binary' }>): Operand {
    const left = this.value(expression.left);
    const right = this.part(() => this.value(expression.right));
    const result = this.binaryOfOperands(expression, expression.operator, left, right.value);
    const hoists = right.hoists;
    if (!hoists || this.isInvalid(result) || result.mode === 'constant') return result;
    const readLeft = left.eval;
    const readRight = right.value.eval;
    const decides = expression.operator === '||';
    const run = function* (frame: Frame): Suspending<Value> {
      if ((readLeft(frame) as boolean) === decides) return decides;
      yield* runHoists(frame, hoists);
      try {
        return readRight(frame);
      } finally {
        clearHoists(frame, hoists);
      }
    };
    return { ...result, eval: this.suspending(run, result.eval) };
  }

  /** Applies a binary operator to compiled operands, as `x op= y` also does. */
  // code-gauge-allow functionNcss 60 -- Keeps Go operand validation, evaluation order and result storage together for this expression.
  protected binaryOfOperands(span: Span, operator: string, leftOperand: Operand, rightOperand: Operand): Operand {
    const expression = {
      ...span,
      kind: 'binary',
      operator,
      left: leftOperand.span,
      right: rightOperand.span,
    } as unknown as Extract<Expression, { kind: 'binary' }>;
    let left = leftOperand;
    let right = rightOperand;
    if (this.isInvalid(left) || this.isInvalid(right)) return this.invalid(expression);
    if (operator === '<<' || operator === '>>') return this.shiftExpression(expression, left, right);
    if (operator === '&&' || operator === '||') return this.logical(expression, left, right);
    // Untyped operands take the other operand's type, or the larger untyped kind; nil stays nil for comparisons.
    const hasNil = left.type === BASIC.untypedNil || right.type === BASIC.untypedNil;
    if (!hasNil && isUntyped(left.type) && !isUntyped(right.type)) left = this.convertUntyped(left, right.type);
    else if (!hasNil && isUntyped(right.type) && !isUntyped(left.type)) right = this.convertUntyped(right, left.type);
    if (this.isInvalid(left) || this.isInvalid(right)) return this.invalid(expression);
    const isComparison = ['==', '!=', '<', '<=', '>', '>='].includes(operator);
    if (isComparison) return this.comparison(expression, left, right);
    if (
      !identical(left.type, right.type) &&
      !(isUntyped(left.type) && isUntyped(right.type) && sameUntypedFamily(left.type, right.type))
    ) {
      this.error(
        expression,
        `${describeType(left.type)} 型と ${describeType(right.type)} 型の値には、演算子 ${operator} を使えません（型が違います）。`
      );
      return this.invalid(expression);
    }
    const type = isUntyped(left.type) && isUntyped(right.type) ? largerUntyped(left.type, right.type) : left.type;
    if (isUntyped(type) && (left.resolveUntyped || right.resolveUntyped)) {
      return {
        mode: 'value',
        type,
        span: expression,
        eval: () => {},
        resolveUntyped: (target) => {
          const resolvedLeft = this.convertUntyped(left, target);
          const resolvedRight = this.convertUntyped(right, target);
          return this.binaryOfOperands(span, operator, resolvedLeft, resolvedRight);
        },
      };
    }
    if (!allowsBinaryOperator(operator, type)) {
      this.error(expression, `演算子 ${operator} は ${describeType(type)} 型の値には使えません。`);
      return this.invalid(expression);
    }
    if (left.mode === 'constant' && right.mode === 'constant' && left.constant && right.constant) {
      return this.foldBinary(expression, operator, left.constant, right.constant, type);
    }
    const constantDivisor = (operator === '/' || operator === '%') && right.mode === 'constant' && right.constant;
    if (constantDivisor && isInteger(type) && exactInteger(right.constant as Constant) === 0n) {
      this.error(expression.right, '0 で割っています。');
      return this.invalid(expression);
    }
    if (this.hasTypeParam(type)) return { mode: 'value', type, span: expression, eval: () => {} };
    const fused = this.fusedMultiplyAdd(expression, operator, left, right, type);
    if (fused) return fused;
    if (operator === '*' && isComplex(type) && !isUntyped(type))
      return this.complexProduct(expression, left, right, type);
    const apply = arithmetic(operator, type);
    const readLeft = left.eval;
    const readRight = right.eval;
    const ssaConstant = allConstant(left, right);
    const factors = isFloat(type) && !isUntyped(type) ? fusableFactors(operator, left, right) : undefined;
    if (factors) {
      return {
        mode: 'value',
        type,
        span: expression,
        eval: (frame) => apply(readLeft(frame), readRight(frame)),
        product: {
          ...factors,
          constant: ssaConstant,
          negated: () => (left.negation?.() ?? false) || (right.negation?.() ?? false),
          source: this.productSource(operator, left, right),
        },
        ssaConstant,
      };
    }
    if (isString(type)) {
      return {
        mode: 'value',
        type,
        span: expression,
        eval: (frame) => {
          const result = (readLeft(frame) as string) + (readRight(frame) as string);
          frame.runtime.checkStringLength(result.length);
          frame.runtime.spend(Math.floor(result.length / 64));
          return result;
        },
      };
    }
    return {
      mode: 'value',
      type,
      span: expression,
      eval: (frame) => apply(readLeft(frame), readRight(frame)),
      ssaConstant,
    };
  }

  /** A complex product, whose imaginary part is a float64 sum of two products like those `fusedMultiplyAdd` fuses. */
  private complexProduct(span: Span, left: Operand, right: Operand, type: Type): Operand {
    const fn = this.fn;
    const ssaConstant = allConstant(left, right);
    if (fn) fn.sumsOfProducts.push(() => !ssaConstant?.(undefined));
    const contexts = this.functionContexts;
    const single = isBasic(type, 'complex64');
    const readLeft = left.eval;
    const readRight = right.eval;
    const [xRe, xIm] = left.partNegations ?? [];
    const [yRe, yIm] = right.partNegations ?? [];
    const negations = (): ComplexNegations => ({
      xRe: xRe?.() ?? false,
      xIm: xIm?.() ?? false,
      yRe: yRe?.() ?? false,
      yIm: yIm?.() ?? false,
    });
    return {
      mode: 'value',
      type,
      span,
      eval: (frame) => {
        const x = readLeft(frame) as Complex;
        const y = readRight(frame) as Complex;
        if (ssaConstant?.(frame)) return foldedComplexProduct(x, y, single);
        return complexProduct(x, y, fn !== undefined && sumsGrouped(contexts, fn, frame), single, negations());
      },
      ssaConstant,
    };
  }

  /**
   * Fuses `a + x*y`, `a - x*y`, and `x*y - a` into one rounding, as Go's compiler does on arm64.
   */
  // code-gauge-allow functionNcss 42 -- Keeps Go operand validation, evaluation order and result storage together for this expression.
  private fusedMultiplyAdd(
    span: Span,
    operator: string,
    left: Operand,
    right: Operand,
    type: Type
  ): Operand | undefined {
    if ((operator !== '+' && operator !== '-') || !isFloat(type) || isUntyped(type)) return undefined;
    const round = isBasic(type, 'float32') ? Math.fround : (value: number): number => value;
    const fused = (
      a: Eval,
      product: NonNullable<Operand['product']>,
      productFirst: boolean,
      negateProduct: boolean,
      negateAddend: boolean
    ): Operand => ({
      mode: 'value',
      type,
      span,
      eval: (frame) => {
        // The operands are evaluated in the order they are written.
        const addendFirst = productFirst ? 0 : (a(frame) as number);
        const x = product.left(frame) as number;
        const y = product.right(frame) as number;
        const addend = productFirst ? (a(frame) as number) : addendFirst;
        return round(fma(negateProduct ? -x : x, y, negateAddend ? -addend : addend));
      },
    });
    const leftProduct = left.product;
    const rightProduct = right.product;
    if (!leftProduct && !rightProduct) return undefined;
    const apply = arithmetic(operator, type);
    const readLeft = left.eval;
    const readRight = right.eval;
    const plain: Eval = (frame) => apply(readLeft(frame), readRight(frame));
    const fuseLeft = leftProduct && fused(readRight, leftProduct, true, false, operator === '-').eval;
    const fuseRight = rightProduct && fused(readLeft, rightProduct, false, operator === '-', false).eval;
    const fn = this.fn;
    if (operator === '+' && leftProduct && rightProduct && isBasic(type, 'float64') && fn) {
      fn.sumsOfProducts.push(() => fuses(leftProduct, undefined) && fuses(rightProduct, undefined));
    }
    // Go's arm64 rules try `a - x*y` before `x*y - a`, and an addition's second operand before its first. Its generic
    // common subexpression elimination reorders the operands of an addition of two products only when another such
    // float64 addition ends up in the same function after inlining: it then puts second, and so fuses, a product
    // computed more than once, or else the product computed first.
    const contexts = this.functionContexts;
    const prefersLeft = (frame: Frame): boolean => {
      if (operator === '-' || !leftProduct || !rightProduct || !fn || !sumsGrouped(contexts, fn, frame)) return false;
      const { source: a } = leftProduct;
      const { source: b } = rightProduct;
      if (a.count > 1 !== b.count > 1) return a.count > 1;
      return a.order <= b.order;
    };
    return {
      mode: 'value',
      type,
      span,
      eval: (frame) => {
        const leftFuses = leftProduct !== undefined && fuses(leftProduct, frame);
        const rightFuses = rightProduct !== undefined && fuses(rightProduct, frame);
        // Go's arm64 rules fuse a product of plain factors (FMULD) before one with a negated factor (FNMULD).
        const leftPlain = leftFuses && !leftProduct.negated?.();
        const rightPlain = rightFuses && !rightProduct.negated?.();
        if (leftPlain !== rightPlain ? leftPlain : leftFuses && (!rightFuses || prefersLeft(frame)))
          return (fuseLeft as Eval)(frame);
        if (rightFuses) return (fuseRight as Eval)(frame);
        return plain(frame);
      },
      ssaConstant: allConstant(left, right),
    };
  }

  /**
   * The value Go's common subexpression elimination gives a product, where the same variables or constants
   * multiplied again are the same value.
   */
  private productSource(operator: string, left: Operand, right: Operand): ProductSource {
    const products = this.fn?.products ?? new Map<string, ProductSource>();
    const a = productKeyOf(left);
    const b = productKeyOf(right);
    const key = a !== undefined && b !== undefined ? [operator, ...[a, b].toSorted()].join(' ') : `#${products.size}`;
    const existing = products.get(key);
    if (existing) {
      existing.count++;
      return existing;
    }
    const source = { order: products.size, count: 1 };
    products.set(key, source);
    return source;
  }

  private foldBinary(span: Span, operator: string, a: Constant, b: Constant, type: Type): Operand {
    try {
      const folded = binaryConstant(operator, a, b, isInteger(type));
      if (!isUntyped(type)) {
        const representation = represent(folded, type);
        if ('error' in representation) {
          this.error(span, `定数 ${describeConstant(folded)} は ${describeType(type)} 型に収まりません。`);
          return this.invalid(span);
        }
        return this.constant(representation.constant, type, span);
      }
      return this.constant(folded, type, span);
    } catch (error) {
      if (error instanceof ConstantDivisionByZero) this.error(span, '0 で割っています。');
      else if (error instanceof ConstantOverflow) this.error(span, '定数が大きすぎます。');
      else throw error;
      return this.invalid(span);
    }
  }

  private logical(span: Span, left: Operand, right: Operand): Operand {
    const operator = (span as Extract<Expression, { kind: 'binary' }>).operator;
    if (!isBoolean(left.type) || !isBoolean(right.type)) {
      this.error(span, `演算子 ${operator} は真偽値にしか使えません。`);
      return this.invalid(span);
    }
    let l = left;
    let r = right;
    if (isUntyped(l.type) && !isUntyped(r.type)) l = this.convertUntyped(l, r.type);
    if (isUntyped(r.type) && !isUntyped(l.type)) r = this.convertUntyped(r, l.type);
    if (!identical(l.type, r.type) && !(isUntyped(l.type) && isUntyped(r.type))) {
      this.error(
        span,
        `${describeType(l.type)} 型と ${describeType(r.type)} 型の値には、演算子 ${operator} を使えません（型が違います）。`
      );
      return this.invalid(span);
    }
    const type = isUntyped(l.type) ? BASIC.untypedBool : l.type;
    if (l.mode === 'constant' && r.mode === 'constant' && l.constant && r.constant) {
      return this.constant(binaryConstant(operator, l.constant, r.constant, false), type, span);
    }
    const readLeft = l.eval;
    const readRight = r.eval;
    return {
      mode: 'value',
      type,
      span,
      eval:
        operator === '&&'
          ? (frame) => (readLeft(frame) as boolean) && (readRight(frame) as boolean)
          : (frame) => (readLeft(frame) as boolean) || (readRight(frame) as boolean),
    };
  }

  // code-gauge-allow functionNcss 56 -- Keeps Go operand validation, evaluation order and result storage together for this expression.
  private comparison(
    expression: Extract<Expression, { kind: 'binary' }>,
    leftOperand: Operand,
    rightOperand: Operand
  ): Operand {
    const { operator } = expression;
    let left = leftOperand;
    let right = rightOperand;
    let type = left.type;
    if (isNil(left)) type = right.type;
    const mismatch = (): Operand => {
      this.error(
        expression,
        `${describeType(left.type)} 型と ${describeType(right.type)} 型の値は比べられません（型が違います）。`
      );
      return this.invalid(expression);
    };
    if (isNil(left) || isNil(right)) {
      const other = isNil(left) ? right : left;
      if (isNil(left) && isNil(right)) {
        this.error(expression, 'nil どうしは比べられません。');
        return this.invalid(expression);
      }
      if (assignFailure(BASIC.untypedNil, other.type)) return mismatch();
    } else if (isUntyped(left.type) && isUntyped(right.type)) {
      if (!sameUntypedFamily(left.type, right.type)) return mismatch();
      if (left.resolveUntyped || right.resolveUntyped) {
        const common = defaultType(largerUntyped(left.type, right.type));
        left = this.convertUntyped(left, common);
        right = this.convertUntyped(right, common);
        if (this.isInvalid(left) || this.isInvalid(right)) return this.invalid(expression);
        type = common;
      } else {
        type = largerUntyped(left.type, right.type);
      }
    } else if (!identical(left.type, right.type)) {
      const leftToRight = !assignFailure(left.type, right.type);
      const rightToLeft = !assignFailure(right.type, left.type);
      if (!leftToRight && !rightToLeft) return mismatch();
      if (isInterface(left.type) !== isInterface(right.type)) {
        return this.mixedInterfaceComparison(expression, left, right, isInterface(right.type) && leftToRight);
      }
      type = leftToRight ? right.type : left.type;
    }
    const ordered = operator !== '==' && operator !== '!=';
    if (ordered && !isOrdered(type)) {
      this.error(expression, `${describeType(type)} 型の値は大小を比べられません。`);
      return this.invalid(expression);
    }
    if (!ordered && !isNil(left) && !isNil(right) && !isComparable(type)) {
      this.error(expression, incomparableMessage(type));
      return this.invalid(expression);
    }
    if (left.mode === 'constant' && right.mode === 'constant' && left.constant && right.constant) {
      return this.constant(
        binaryConstant(operator, left.constant, right.constant, false),
        BASIC.untypedBool,
        expression
      );
    }
    const readLeft = left.eval;
    const readRight = right.eval;
    if (ordered) {
      const compare = ordering(operator);
      return {
        mode: 'value',
        type: BASIC.untypedBool,
        span: expression,
        eval: (frame) => compare(readLeft(frame), readRight(frame)),
      };
    }
    const equal = isNil(left) || isNil(right) ? (a: Value, b: Value) => a === b : equalityOf(type);
    const negated = operator === '!=';
    return {
      mode: 'value',
      type: BASIC.untypedBool,
      span: expression,
      eval: (frame) => equal(readLeft(frame), readRight(frame)) !== negated,
    };
  }

  private mixedInterfaceComparison(
    span: Extract<Expression, { kind: 'binary' }>,
    left: Operand,
    right: Operand,
    leftToRight: boolean
  ): Operand {
    if (span.operator !== '==' && span.operator !== '!=') {
      this.error(span, `インターフェースの値は大小を比べられません。`);
      return this.invalid(span);
    }
    const concrete = leftToRight ? left : right;
    if (!isComparable(concrete.type)) {
      this.error(span, `${describeType(concrete.type)} 型の値は比べられません。`);
      return this.invalid(span);
    }
    const box = toInterface(concrete.type);
    const readConcrete = concrete.eval;
    const readInterface = (leftToRight ? right : left).eval;
    const equal = equalityOf(leftToRight ? right.type : left.type);
    const negated = span.operator === '!=';
    return {
      mode: 'value',
      type: BASIC.untypedBool,
      span,
      eval: (frame) => {
        const a = leftToRight ? box(readConcrete(frame)) : readInterface(frame);
        const b = leftToRight ? readInterface(frame) : box(readConcrete(frame));
        return equal(a, b) !== negated;
      },
    };
  }

  // code-gauge-allow functionNcss 59 -- Keeps Go operand validation, evaluation order and result storage together for this expression.
  private shiftExpression(
    expression: Extract<Expression, { kind: 'binary' }>,
    leftOperand: Operand,
    rightOperand: Operand
  ): Operand {
    const operator = expression.operator as '<<' | '>>';
    let left = leftOperand;
    let right = rightOperand;
    if (right.resolveUntyped) {
      right = right.resolveUntyped(BASIC.uint);
      if (this.isInvalid(right)) return right;
    }
    if (
      !isInteger(right.type) &&
      !(
        right.mode === 'constant' &&
        right.constant &&
        // Go's type checker shifts two constants before it checks the count's type.
        (isUntyped(right.type) || left.mode === 'constant') &&
        exactInteger(right.constant) !== undefined
      )
    ) {
      this.error(expression.right, `シフトする量には整数を書いてください。`);
      return this.invalid(expression);
    }
    if (right.mode === 'constant' && right.constant) {
      const count = exactInteger(right.constant) as bigint;
      if (count < 0n) {
        this.error(expression.right, 'シフトする量に負の数は使えません。');
        return this.invalid(expression);
      }
      if (left.mode === 'constant' && left.constant) {
        const value = exactInteger(left.constant);
        if (value === undefined || !(isInteger(left.type) || isUntyped(left.type))) {
          this.error(expression.left, `シフトできるのは整数だけです。`);
          return this.invalid(expression);
        }
        const type = isUntyped(left.type) && !isInteger(left.type) ? BASIC.untypedInt : left.type;
        try {
          const shifted = shiftConstant(operator, value, count);
          if (!isUntyped(type)) {
            const representation = represent(shifted, type);
            if ('error' in representation) {
              this.error(expression, `定数 ${describeConstant(shifted)} は ${describeType(type)} 型に収まりません。`);
              return this.invalid(expression);
            }
          }
          return this.constant(shifted, type, expression);
        } catch (error) {
          if (!(error instanceof ConstantOverflow)) throw error;
          this.error(expression, 'シフトの結果の定数が大きすぎます。');
          return this.invalid(expression);
        }
      }
    }
    if (isUntyped(right.type) && !(right.mode === 'constant' && right.constant)) {
      right = this.defaulted(right);
      if (this.isInvalid(right)) return right;
    }
    const readRight =
      right.mode === 'constant' && right.constant
        ? (() => {
            const count = exactInteger(right.constant as Constant) as bigint;
            return () => count;
          })()
        : right.eval;
    if (isUntyped(left.type) && ((left.mode === 'constant' && left.constant) || left.resolveUntyped)) {
      if (left.constant && (left.constant.kind === 'bool' || left.constant.kind === 'string')) {
        this.error(expression.left, 'シフトできるのは整数だけです。');
        return this.invalid(expression);
      }
      const untypedLeft = left;
      return {
        mode: 'value',
        type: left.type,
        span: expression,
        eval: () => {},
        resolveUntyped: (target) => this.resolveUntypedShift(expression, operator, untypedLeft, readRight, target),
      };
    }
    if (isUntyped(left.type)) left = this.defaulted(left);
    if (this.isInvalid(left)) return left;
    if (!isInteger(left.type)) {
      this.error(
        expression.left,
        `シフトできるのは整数だけです（${describeType(left.type)} 型の値が書かれています）。`
      );
      return this.invalid(expression);
    }
    const readLeft = left.eval;
    if (this.hasTypeParam(left.type)) return { mode: 'value', type: left.type, span: expression, eval: () => {} };
    const apply = shift(operator, left.type);
    return {
      mode: 'value',
      type: left.type,
      span: expression,
      eval: (frame) => apply(readLeft(frame) as bigint, readRight(frame) as bigint),
    };
  }

  // code-gauge-allow functionCognitiveComplexity 17 -- Keeps Go operand validation, evaluation order and result storage together for this expression.
  // code-gauge-allow functionNcss 34 -- Keeps Go operand validation, evaluation order and result storage together for this expression.
  private resolveUntypedShift(
    expression: Extract<Expression, { kind: 'binary' }>,
    operator: '<<' | '>>',
    untypedLeft: Operand,
    readRight: Eval,
    target: Type
  ): Operand {
    if (target === BASIC.invalid) return this.invalid(expression);
    if (untypedLeft.resolveUntyped) {
      const resolvedInner = untypedLeft.resolveUntyped(target);
      if (this.isInvalid(resolvedInner)) return resolvedInner;
      if (this.hasTypeParam(resolvedInner.type)) {
        return { mode: 'value', type: resolvedInner.type, span: expression, eval: () => {} };
      }
      const apply = shift(operator, resolvedInner.type);
      const readInner = resolvedInner.eval;
      return {
        mode: 'value',
        type: resolvedInner.type,
        span: expression,
        eval: (frame) => apply(readInner(frame) as bigint, readRight(frame) as bigint),
      };
    }
    const leftConstant = untypedLeft.constant as Constant;
    if (target.kind === 'typeParam') {
      if (!isInteger(target)) {
        this.error(expression.left, `シフトできるのは整数だけです（${describeType(target)} 型の値が書かれています）。`);
        return this.invalid(expression);
      }
      for (const term of target.constraint.typeSet?.terms ?? []) {
        const rep = represent(leftConstant, term.type);
        if ('error' in rep) {
          this.reportRepresentation(untypedLeft, term.type, rep.error, 'オペランド');
          return this.invalid(expression);
        }
      }
      return { mode: 'value', type: target, span: expression, eval: () => {} };
    }
    const resolvedTarget = isInterface(target) ? defaultType(untypedLeft.type) : target;
    if (!isInteger(resolvedTarget)) {
      this.error(
        expression.left,
        `シフトできるのは整数だけです（${describeType(resolvedTarget)} 型の値が書かれています）。`
      );
      return this.invalid(expression);
    }
    const representation = represent(leftConstant, resolvedTarget);
    if ('error' in representation) {
      this.reportRepresentation(untypedLeft, resolvedTarget, representation.error, 'オペランド');
      return this.invalid(expression);
    }
    const leftValue = constantValue(representation.constant, resolvedTarget) as bigint;
    const apply = shift(operator, resolvedTarget);
    return {
      mode: 'value',
      type: resolvedTarget,
      span: expression,
      eval: (frame) => apply(leftValue, readRight(frame) as bigint),
    };
  }

  // Selectors -----------------------------------------------------------------------------------------------------

  protected selector(expression: Extract<Expression, { kind: 'selector' }>): Operand {
    if (expression.operand.kind === 'name') {
      const entity = this.lookup(expression.operand.name);
      if (entity?.kind === 'package') {
        const member = this.packageMember(entity, expression.field, expression);
        if (!member) return this.invalid(expression);
        return this.entityOperand(member, expression, true);
      }
    }
    const base = this.expression(expression.operand);
    if (this.isInvalid(base)) return base;
    if (base.mode === 'type') return this.methodExpression(expression, base.type, expression.field);
    const operand = this.asValue(base);
    if (this.isInvalid(operand)) return operand;
    return this.selectMember(expression, operand, expression.field);
  }

  /** `v.M` used as a value: a function that calls the method with the receiver evaluated now. */
  protected abstract methodValue(operand: Operand): Operand;
  /** `T.M`: a function that takes the receiver as its first argument. */
  protected abstract methodExpression(span: Span, type: Type, name: string): Operand;

  protected selectMember(span: Span, operand: Operand, field: string): Operand {
    const type = operand.type;
    if (isBasic(type, 'untypedNil')) {
      this.error(span, `nil には ${field} がありません。`);
      return this.invalid(span);
    }
    const lookupType = type.kind === 'pointer' && underlying(type.element).kind === 'pointer' ? BASIC.invalid : type;
    const selection = lookupFieldOrMethod(lookupType, field);
    if (selection.kind === 'notFound') {
      const named = type.kind === 'pointer' ? type.element : type;
      if (named.kind === 'named' && named.unsupported?.has(field)) {
        this.unsupported(span, `${typeString(named)}.${field}`);
        return this.invalid(span);
      }
      const hint = this.capitalizationHint(type, field);
      this.error(span, `${describeType(type)} 型には ${field} というフィールドやメソッドがありません${hint}。`);
      return this.invalid(span);
    }
    if (selection.kind === 'ambiguous') {
      this.error(span, `${field} は埋め込んだ複数の型にあるので、どれか決められません。`);
      return this.invalid(span);
    }
    if (selection.kind === 'field' && isForeignUnexported(field, selection.pkg)) {
      this.error(
        span,
        `${field} は ${selection.pkg} パッケージの外から使えないフィールドです（大文字で始まる名前だけを使えます）。`
      );
      return this.invalid(span);
    }
    operand.variable?.markUsed();
    if (selection.kind !== 'field') {
      return { mode: 'method', type: NO_VALUE, span, eval: () => {}, method: { receiver: operand, selection } };
    }
    return this.fieldOperand(span, operand, selection.path, selection.type);
  }

  private capitalizationHint(type: Type, field: string): string {
    const other =
      field[0] === field[0].toUpperCase()
        ? field[0].toLowerCase() + field.slice(1)
        : field[0].toUpperCase() + field.slice(1);
    return lookupFieldOrMethod(type, other).kind === 'notFound' ? '' : `（${other} ならあります）`;
  }

  /** A field reached through embedded fields, following pointers, which may be nil. */
  // code-gauge-allow functionCognitiveComplexity 30 -- Keeps Go operand validation, evaluation order and result storage together for this expression.
  // code-gauge-allow functionNcss 49 -- Keeps Go operand validation, evaluation order and result storage together for this expression.
  protected fieldOperand(span: Span, operand: Operand, path: number[], type: Type): Operand {
    const read = operand.eval;
    const steps = path.slice(0, -1);
    const last = path.at(-1) as number;
    const container = (frame: Frame): GoStruct => {
      let value = read(frame);
      if (value instanceof Pointer) value = value.load();
      else if (value === undefined) nilPointerPanic();
      for (const index of steps) {
        value = (value as GoStruct).fields[index];
        if (value instanceof Pointer) value = value.load();
        else if (value === undefined) nilPointerPanic();
      }
      if (value === undefined) nilPointerPanic();
      return value as GoStruct;
    };
    const lastPointer = lastPointerAt(operand.type, steps);
    // A destination's last pointer is dereferenced at its store, and everything before it when its operands are
    // evaluated, as Go's compiler orders an assignment.
    const locateContainer = (frame: Frame): (() => GoStruct) => {
      if (lastPointer < 0) {
        const base = operand.locate?.(frame) ?? constantly(read(frame));
        return () => fieldPath(base(), steps);
      }
      let value = read(frame);
      for (const index of steps.slice(0, lastPointer)) value = (dereferenced(value) as GoStruct).fields[index];
      const pointer = value;
      return () => fieldPath(dereferenced(pointer), steps.slice(lastPointer));
    };
    const throughPointer = lastPointer >= 0;
    const viaPointer = underlying(operand.type).kind === 'pointer';
    const addressable = operand.mode === 'variable' || throughPointer;
    let addressStorage: Storage | undefined;
    if (!throughPointer) addressStorage = operand.addressStorage;
    else if (viaPointer && steps.length === 0) {
      addressStorage = operand;
    }
    return {
      mode: addressable ? 'variable' : 'value',
      type,
      span,
      eval: (frame) => container(frame).fields[last],
      locate: addressable
        ? (frame) => {
            const target = locateContainer(frame);
            return () => target().fields[last];
          }
        : undefined,
      prepareStore: addressable
        ? (frame) => {
            const locateTarget = locateContainer(frame);
            return (value) => {
              const target = locateTarget();
              target.fields[last] = writeInPlace(target.fields[last], value);
            };
          }
        : undefined,
      store: addressable
        ? (frame, value) => {
            const target = container(frame);
            target.fields[last] = writeInPlace(target.fields[last], value);
          }
        : undefined,
      addressOf: addressable ? () => (frame) => new Pointer(container(frame).fields, last) : undefined,
      ...(throughPointer || viaPointer ? {} : ssaFieldAt(operand, path)),
      addressStorage,
      backingVars: throughPointer ? undefined : operand.backingVars,
      ssaRoot: throughPointer ? undefined : operand.ssaRoot,
      addressTaken: throughPointer ? undefined : operand.addressTaken,
      onWrite: throughPointer ? undefined : operand.onWrite,
    };
  }

  // Index and slice -------------------------------------------------------------------------------------------------

  /** Converts an index to a number, checking it as Go does: an integer, non-negative if constant. */
  // code-gauge-allow functionCognitiveComplexity 21 -- Keeps Go operand validation, evaluation order and result storage together for this expression.
  // code-gauge-allow functionNcss 31 -- Keeps Go operand validation, evaluation order and result storage together for this expression.
  protected indexValue(expression: Expression, length?: number): ((frame: Frame) => number) | undefined {
    let operand = this.value(expression);
    if (this.isInvalid(operand)) return undefined;
    if (operand.resolveUntyped) {
      operand = operand.resolveUntyped(BASIC.int);
      if (this.isInvalid(operand)) return undefined;
    }
    if (operand.mode === 'constant' && operand.constant) {
      const value = exactInteger(operand.constant);
      if (value === undefined || !(isInteger(operand.type) || isUntyped(operand.type))) {
        this.error(expression, '添字には整数を書いてください。');
        return undefined;
      }
      if (value < 0n) {
        this.error(expression, `添字 ${value} は負の数です。`);
        return undefined;
      }
      if (length !== undefined && value >= BigInt(length)) {
        this.error(expression, `添字 ${value} は範囲の外です（長さは ${length} です）。`);
        return undefined;
      }
      if ('error' in represent(operand.constant, BASIC.int)) {
        this.error(expression, `定数 ${describeConstant(operand.constant)} は int 型に収まりません。`);
        return undefined;
      }
      const index = Number(value);
      return () => index;
    }
    if (!isInteger(operand.type)) {
      this.error(expression, `添字には整数を書いてください（${describeType(operand.type)} 型の値が書かれています）。`);
      return undefined;
    }
    const read = operand.eval;
    return (frame) => {
      const value = read(frame) as bigint;
      // An index beyond 2^53 is out of range; it stays a bigint, which compares as such and prints exactly in the panic.
      return value > 1n << 53n || value < -(1n << 53n) ? (value as unknown as number) : Number(value);
    };
  }

  // code-gauge-allow functionCognitiveComplexity 21 -- Keeps Go operand validation, evaluation order and result storage together for this expression.
  // code-gauge-allow functionNcss 31 -- Keeps Go operand validation, evaluation order and result storage together for this expression.
  private index(expression: Extract<Expression, { kind: 'index' }>): Operand {
    const genericType = this.genericTypeIndex(expression);
    if (genericType) return genericType;
    const base = this.expression(expression.operand);
    if (this.isInvalid(base)) return base;
    if (base.mode === 'value' && base.func?.generic) return this.instantiation(expression, base);
    if (base.mode === 'method' && base.method?.selection.kind === 'method' && base.method.selection.method.typeParams) {
      const typeArgs: Type[] = [];
      for (const index of expression.indices) {
        const syntax = typeSyntaxOf(index);
        const type = syntax ? this.resolveType(syntax) : undefined;
        if (!syntax) this.error(index, 'ここには型を書いてください。');
        if (type === undefined || type === BASIC.invalid) return this.invalid(expression);
        typeArgs.push(type);
      }
      return { ...base, span: expression, typeArgs };
    }
    if (base.mode === 'type') {
      this.error(expression, `${describeType(base.type)} は型引数を持たない型です。`);
      return this.invalid(expression);
    }
    const operand = this.asValue(base);
    if (this.isInvalid(operand)) return operand;
    if (expression.indices.length !== 1) {
      this.error(expression, '添字は1つだけ書いてください。');
      return this.invalid(expression);
    }
    const [indexExpression] = expression.indices;
    return this.indexOperand(expression, operand, indexExpression);
  }

  // code-gauge-allow functionNcss 43 -- Keeps Go operand validation, evaluation order and result storage together for this expression.
  private indexOperand(
    expression: Extract<Expression, { kind: 'index' }>,
    operand: Operand,
    indexExpression: Expression
  ): Operand {
    const parameter = this.indexTypeParameter(expression, operand, indexExpression);
    if (parameter) return parameter;
    const { type, read, viaPointer } = throughArrayPointer(operand);
    if (type.kind === 'map') return this.mapIndex(expression, operand, type.key, type.value);
    if (isString(type) && type.kind === 'basic') return this.stringIndex(expression, operand, indexExpression);
    if (type.kind === 'array') {
      const { length } = type;
      const index = this.indexValue(indexExpression, length);
      if (!index) return this.invalid(expression);
      const pointer = operand.eval;
      const locateElement = (frame: Frame): (() => [Value[], number]) => {
        const array = viaPointer ? constantly(pointer(frame)) : (operand.locate?.(frame) ?? constantly(read(frame)));
        const at = index(frame);
        return () => {
          const { elements } = (viaPointer ? dereferenced(array()) : array()) as GoArray;
          if (at < 0 || at >= length) indexPanic(at, length);
          return [elements, at];
        };
      };
      return elementOperand(
        expression,
        type.element,
        operand,
        operand.mode === 'variable' || viaPointer,
        locateElement,
        {
          storage: viaPointer ? operand : operand.addressStorage,
          backingVars: viaPointer ? undefined : operand.backingVars,
          ssaRoot: viaPointer ? undefined : operand.ssaRoot,
          addressTaken: viaPointer ? undefined : operand.addressTaken,
          onWrite: viaPointer ? undefined : operand.onWrite,
        }
      );
    }
    if (type.kind === 'slice') {
      const index = this.indexValue(indexExpression);
      if (!index) return this.invalid(expression);
      const locateElement = (frame: Frame): (() => [Value[], number]) => {
        const slice = read(frame) as Slice | undefined;
        const at = index(frame);
        return () => {
          const length = slice?.length ?? 0;
          if (at < 0 || at >= length) indexPanic(at, length);
          return [(slice as Slice).array, (slice as Slice).offset + at];
        };
      };
      const tracked = this.understandSlice(expression.operand);
      return elementOperand(expression, type.element, operand, true, locateElement, {
        storage: operand,
        // The pointer may write the element, and Go's slice optimization pass gives up on a slice whose element's
        // address the program takes.
        addressTaken: () => {
          this.writeOperand(operand);
          if (tracked) this.understandSlice(expression.operand, never);
        },
        onWrite: () => this.writeOperand(operand),
      });
    }
    this.error(expression, `${describeType(operand.type)} 型の値には添字を付けられません。`);
    return this.invalid(expression);
  }

  private indexTypeParameter(
    expression: Extract<Expression, { kind: 'index' }>,
    operand: Operand,
    indexExpression: Expression
  ): Operand | undefined {
    if (operand.type.kind !== 'typeParam') return undefined;
    const terms = operand.type.constraint.typeSet?.terms;
    if (!terms || terms.length === 0) return undefined;
    const results = terms.map((term) =>
      this.indexOperand(expression, { ...operand, type: term.type }, indexExpression)
    );
    const first = results[0];
    const maps = terms.map((term) => underlying(term.type));
    const firstMap = maps[0];
    if (firstMap.kind === 'map' && maps.some((type) => type.kind !== 'map' || !identical(type.key, firstMap.key))) {
      this.error(expression, '型集合の map のキーはすべて同じ型でなければなりません。');
      return this.invalid(expression);
    }
    if (results.some((result) => this.isInvalid(result))) return this.invalid(expression);
    if (
      results.some(
        (result) => !identical(result.type, first.type) || (result.mode === 'mapIndex') !== (first.mode === 'mapIndex')
      )
    ) {
      this.error(expression, '型集合のすべての型で添字と要素の型が同じでなければなりません。');
      return this.invalid(expression);
    }
    if (results.some((result) => result.mode === 'value'))
      return { mode: 'value', type: first.type, span: expression, eval: first.eval };
    return first;
  }

  /** `s[i]`, a byte of a string, which is never a constant even when both are constants. */
  private stringIndex(span: Span, operand: Operand, indexExpression: Expression): Operand {
    const text =
      operand.mode === 'constant' && operand.constant?.kind === 'string' ? operand.constant.value : undefined;
    const index = this.indexValue(indexExpression, text?.length);
    if (!index) return this.invalid(span);
    const constantIndex = text === undefined ? undefined : this.constantExpression(indexExpression).value;
    if (text !== undefined && constantIndex !== undefined) {
      const byteValue = BigInt(text.charCodeAt(Number(constantIndex)));
      return { mode: 'value', type: BASIC.uint8, span, eval: () => byteValue, ssaConstant: always };
    }
    const read = operand.eval;
    return {
      mode: 'value',
      type: BASIC.uint8,
      span,
      eval: (frame) => {
        const value = read(frame) as string;
        const at = index(frame);
        if (at < 0 || at >= value.length) indexPanic(at, value.length);
        return BigInt(value.charCodeAt(at));
      },
    };
  }

  // code-gauge-allow functionCognitiveComplexity 21 -- Keeps Go operand validation, evaluation order and result storage together for this expression.
  // code-gauge-allow functionNcss 41 -- Keeps Go operand validation, evaluation order and result storage together for this expression.
  private mapIndex(span: Span, operand: Operand, keyType: Type, valueType: Type): Operand {
    const expression = span as Extract<Expression, { kind: 'index' }>;
    const keyOperand = this.expression(expression.indices[0]);
    const convertedKey = this.assign(keyOperand, keyType, 'map のキー');
    const key =
      keyOperand.mode === 'constant' || hasFastMapAccess(keyType, valueType) ? convertedKey : this.hoist(convertedKey);
    const read = operand.eval;
    const keyOf = mapKeyOf(keyType);
    const zero = this.zeroOf(valueType);
    const lookup = (frame: Frame): [Value, boolean] => {
      const map = read(frame) as GoMap | undefined;
      const keyValue = key(frame);
      if (!map || map.entries.size === 0) {
        checkKeyHashable(keyType, keyValue);
        return [zero(), false];
      }
      const entry = map.entries.get(keyOf(keyValue));
      return entry ? [entry.value, true] : [zero(), false];
    };
    const prepareStore = (frame: Frame): ((value: Value) => void) => {
      const map = read(frame) as GoMap | undefined;
      const keyValue = key(frame);
      return (value) => {
        if (!map) plainPanic('assignment to entry in nil map');
        const existing = map.entries.get(keyOf(keyValue));
        if (existing) existing.value = writeInPlace(existing.value, value);
        else {
          frame.runtime.allocate(2);
          map.entries.set(keyOf(keyValue), { key: keyValue, value });
        }
      };
    };
    return {
      mode: 'mapIndex',
      type: valueType,
      span,
      variable: operand.variable,
      eval: (frame) => lookup(frame)[0],
      commaOk: lookup,
      prepareStore,
      store: (frame, value) => prepareStore(frame)(value),
      mapUpdate: (frame, change) => {
        const map = read(frame) as GoMap | undefined;
        const keyValue = key(frame);
        const hashed = keyOf(keyValue);
        const existing = map?.entries.get(hashed);
        const next = change(existing ? existing.value : zero());
        if (!map) plainPanic('assignment to entry in nil map');
        if (existing) existing.value = writeInPlace(existing.value, next);
        else {
          frame.runtime.allocate(2);
          map.entries.set(hashed, { key: keyValue, value: next });
        }
      },
    };
  }

  private sliceExpression(expression: Extract<Expression, { kind: 'slice' }>): Operand {
    const operand = this.value(expression.operand);
    if (this.isInvalid(operand)) return operand;
    return this.sliceOperand(expression, operand);
  }

  // code-gauge-allow functionNcss 47 -- Keeps Go operand validation, evaluation order and result storage together for this expression.
  private sliceOperand(expression: Extract<Expression, { kind: 'slice' }>, operand: Operand): Operand {
    const parameter = this.sliceTypeParameter(expression, operand);
    if (parameter) return parameter;
    const { type, read, viaPointer } = throughArrayPointer(operand);
    if (type.kind === 'array' && !viaPointer && operand.mode !== 'variable') {
      this.error(expression, 'アドレスを取れない配列はスライスにできません。');
      return this.invalid(expression);
    }
    const low = expression.low ? this.indexValue(expression.low) : () => 0;
    const high = expression.high ? this.indexValue(expression.high) : undefined;
    const max = expression.max ? this.indexValue(expression.max) : undefined;
    if (!low || (expression.high && !high) || (expression.max && !max)) return this.invalid(expression);
    this.checkConstantBounds(
      expression,
      type.kind === 'array'
        ? type.length
        : operand.constant?.kind === 'string'
          ? operand.constant.value.length
          : undefined
    );
    if (max) return this.fullSliceExpression(expression, operand, low, high as NonNullable<typeof high>, max);
    const bounds = (frame: Frame, length: number, limit: number, limitName: string): [number, number] => {
      const from = low(frame);
      const to = high ? high(frame) : length;
      // Go's runtime leaves out the other bound, and the length or capacity, for a negative bound.
      if (to < 0) boundsPanic(`slice bounds out of range [:${to}]`);
      if (to > limit) boundsPanic(`slice bounds out of range [:${to}] with ${limitName} ${limit}`);
      if (from < 0) boundsPanic(`slice bounds out of range [${from}:]`);
      if (from > to) boundsPanic(`slice bounds out of range [${from}:${to}]`);
      return [from, to];
    };
    if (isString(type) && type.kind === 'basic') {
      const resultType = isUntyped(operand.type) ? BASIC.string : operand.type;
      return {
        mode: 'value',
        type: resultType,
        span: expression,
        eval: (frame) => {
          const text = read(frame) as string;
          return text.slice(...bounds(frame, text.length, text.length, 'length'));
        },
      };
    }
    if (type.kind === 'array') {
      const { length } = type;
      return {
        mode: 'value',
        type: { kind: 'slice', element: type.element },
        span: expression,
        backingVars: viaPointer ? undefined : operand.backingVars,
        eval: (frame) => {
          const array = read(frame) as GoArray;
          const [from, to] = bounds(frame, length, length, 'length');
          return new Slice(array.elements, from, to - from, length - from);
        },
      };
    }
    if (type.kind === 'slice') {
      return {
        mode: 'value',
        type: operand.type,
        span: expression,
        backingVars: operand.backingVars,
        nonEscaping: operand.nonEscaping,
        eval: (frame) => {
          const slice = read(frame) as Slice | undefined;
          const capacity = slice?.capacity ?? 0;
          const [from, to] = bounds(frame, slice?.length ?? 0, capacity, 'capacity');
          return slice && new Slice(slice.array, slice.offset + from, to - from, capacity - from);
        },
      };
    }
    this.error(expression, `${describeType(operand.type)} 型の値はスライスにできません。`);
    return this.invalid(expression);
  }

  private sliceTypeParameter(
    expression: Extract<Expression, { kind: 'slice' }>,
    operand: Operand
  ): Operand | undefined {
    if (operand.type.kind !== 'typeParam') return undefined;
    const terms = operand.type.constraint.typeSet?.terms;
    if (!terms || terms.length === 0) return undefined;
    const types = terms.map((term) => underlying(term.type));
    const normalized = types.map((type): Type => (isString(type) ? { kind: 'slice', element: BASIC.uint8 } : type));
    if (!normalized.every((type) => identical(type, normalized[0]))) {
      this.error(expression, '型集合のすべての型でスライス式の型が同じでなければなりません。');
      return this.invalid(expression);
    }
    const representative = types.find((type) => isString(type)) ?? types[0];
    const result = this.sliceOperand(expression, { ...operand, type: representative });
    return this.isInvalid(result) ? result : { ...result, type: operand.type };
  }

  /** `a[low:high:max]`, whose result has the capacity max - low; strings cannot take a third index. */
  // code-gauge-allow functionCognitiveComplexity 20 -- Keeps Go operand validation, evaluation order and result storage together for this expression.
  private fullSliceExpression(
    expression: Extract<Expression, { kind: 'slice' }>,
    operand: Operand,
    low: (frame: Frame) => number,
    high: (frame: Frame) => number,
    max: (frame: Frame) => number
  ): Operand {
    const { type, read } = throughArrayPointer(operand);
    if (type.kind !== 'array' && type.kind !== 'slice') {
      this.error(expression, `${describeType(operand.type)} 型の値には、3つの添字のスライス式を使えません。`);
      return this.invalid(expression);
    }
    const resultType: Type = type.kind === 'array' ? { kind: 'slice', element: type.element } : operand.type;
    return {
      mode: 'value',
      type: resultType,
      span: expression,
      eval: (frame) => {
        const value = read(frame) as GoArray | Slice | undefined;
        const array = value instanceof GoArray ? value.elements : (value?.array ?? []);
        const offset = value instanceof Slice ? value.offset : 0;
        const capacity = value instanceof GoArray ? value.elements.length : (value?.capacity ?? 0);
        const from = low(frame);
        const to = high(frame);
        const limit = max(frame);
        if (limit < 0 || limit > capacity)
          boundsPanic(`slice bounds out of range [::${limit}] with capacity ${capacity}`);
        if (to < 0 || to > limit) boundsPanic(`slice bounds out of range [:${to}:${limit}]`);
        if (from < 0 || from > to) boundsPanic(`slice bounds out of range [${from}:${to}:]`);
        if (value === undefined) return;
        return new Slice(array, offset + from, to - from, limit - from);
      },
    };
  }

  private checkConstantBounds(expression: Extract<Expression, { kind: 'slice' }>, limit?: number): void {
    const low = expression.low ? this.constantExpression(expression.low).value : undefined;
    const high = expression.high ? this.constantExpression(expression.high).value : undefined;
    const max = expression.max ? this.constantExpression(expression.max).value : undefined;
    for (const [bound, syntax] of [
      [low, expression.low],
      [high, expression.high],
      [max, expression.max],
    ] as const) {
      if (limit !== undefined && bound !== undefined && syntax && bound > BigInt(limit))
        this.error(syntax, `添字 ${bound} は範囲の外です（長さは ${limit} です）。`);
    }
    if (low !== undefined && high !== undefined && low > high) {
      this.error(expression, `スライスの範囲が逆になっています（${low} > ${high}）。`);
    } else if (high !== undefined && max !== undefined && high > max) {
      this.error(expression, `スライスの範囲が逆になっています（${high} > ${max}）。`);
    } else if (low !== undefined && max !== undefined && low > max) {
      this.error(expression, `スライスの範囲が逆になっています（${low} > ${max}）。`);
    }
  }

  // Type assertions -------------------------------------------------------------------------------------------------

  // code-gauge-allow functionCognitiveComplexity 18 -- Keeps Go operand validation, evaluation order and result storage together for this expression.
  // code-gauge-allow functionNcss 37 -- Keeps Go operand validation, evaluation order and result storage together for this expression.
  private typeAssertion(expression: Extract<Expression, { kind: 'typeAssert' }>): Operand {
    const operand = this.value(expression.operand);
    if (this.isInvalid(operand)) return operand;
    if (!isInterface(operand.type)) {
      this.error(
        expression.operand,
        `${describeType(operand.type)} 型の値はインターフェースではないので、型の表明は使えません。`
      );
      return this.invalid(expression);
    }
    const target = this.resolveType(expression.type);
    if (target === BASIC.invalid) return this.invalid(expression);
    const ifaceType = underlying(operand.type);
    if (!isInterface(target) && ifaceType.kind === 'interface') {
      const missing = missingMethod(target, ifaceType);
      if (missing) {
        this.error(
          expression,
          `${describeType(target)} 型は ${describeType(operand.type)} を実装していないので、この型の表明は必ず失敗します（メソッド ${missing.name} がありません）。`
        );
        return this.invalid(expression);
      }
    }
    const read = operand.eval;
    const test = this.assertionTest(target);
    const zero = this.zeroOf(target);
    const sourceName = typeString(operand.type);
    const targetName = typeString(target);
    // Go's runtime names the asserted interface's type only when the target is concrete (assertE2I passes none).
    const nilMessage = `${isInterface(target) ? 'interface' : sourceName} is nil, not ${targetName}`;
    const commaOk = (frame: Frame): [Value, boolean] => {
      const value = read(frame) as Iface | undefined;
      const result = value === undefined ? undefined : test(value);
      return result === undefined ? [zero(), false] : [result.value, true];
    };
    return {
      mode: 'value',
      type: target,
      span: expression,
      commaOk,
      eval: (frame) => {
        const value = read(frame) as Iface | undefined;
        if (value === undefined) typeAssertionPanic(nilMessage);
        const result = test(value);
        if (result !== undefined) return result.value;
        if (isInterface(target)) {
          const missing = missingMethod(value.type, underlying(target) as never);
          typeAssertionPanic(`${typeString(value.type)} is not ${targetName}: missing method ${missing?.name}`);
        }
        typeAssertionPanic(`${sourceName} is ${typeString(value.type)}, not ${targetName}`);
      },
    };
  }

  /** How a type assertion tests a non-nil interface value: the value it yields, or undefined when it fails. */
  protected assertionTest(target: Type): (value: Iface) => { value: Value } | undefined {
    if (isInterface(target)) {
      const iface = underlying(target);
      return (value) => (iface.kind === 'interface' && !missingMethod(value.type, iface) ? { value } : undefined);
    }
    return (value) => (identical(value.type, target) ? { value: copyValue(value.value) } : undefined);
  }

  // Values ----------------------------------------------------------------------------------------------------------

  protected zeroSlotCount(type: Type, seen = new Set<Type>()): number {
    if (seen.has(type)) return 0;
    const under = underlying(type);
    if (under.kind === 'struct') {
      seen.add(type);
      let total = under.fields.length;
      for (const field of under.fields) {
        total += this.zeroSlotCount(field.type, seen);
        if (total > LIMITS.maxSlots + 1) return LIMITS.maxSlots + 1;
      }
      seen.delete(type);
      return total;
    }
    if (under.kind === 'array') {
      if (under.length === 0) return 0;
      seen.add(type);
      const inner = this.zeroSlotCount(under.element, seen);
      seen.delete(type);
      const total = under.length + under.length * inner;
      return total > LIMITS.maxSlots + 1 ? LIMITS.maxSlots + 1 : total;
    }
    return 0;
  }

  /** Creates the zero value of a type each time it is called, since structs and arrays are mutable. */
  protected zeroOf(type: Type): () => Value {
    const slots = this.zeroSlotCount(type);
    const build = this.buildZeroOf(type);
    if (slots === 0) return build;
    return () => {
      const runtime = currentRuntime();
      runtime.allocate(slots);
      runtime.spend(Math.floor(slots / 64));
      return build();
    };
  }

  private buildZeroOf(type: Type): () => Value {
    const under = underlying(type);
    switch (under.kind) {
      case 'basic': {
        if (isBoolean(under)) return () => false;
        if (isString(under)) return () => '';
        if (isInteger(under)) return () => 0n;
        if (isFloat(under)) return () => 0;
        if (isComplex(under)) return () => new Complex(0, 0);
        return () => {};
      }
      case 'struct': {
        const zeros = under.fields.map((field) => this.buildZeroOf(field.type));
        return () => new GoStruct(zeros.map((zero) => zero()));
      }
      case 'array': {
        const zero = this.buildZeroOf(under.element);
        const { length } = under;
        return () => new GoArray(Array.from({ length }, zero));
      }
      default: {
        return () => {};
      }
    }
  }

  /** The value of a constant expression of integer type, for array lengths and literal keys. */
  protected constantExpression(expression: Expression): { value: bigint | undefined; type: Type } {
    const operand = this.value(expression);
    if (this.isInvalid(operand)) return { value: undefined, type: BASIC.invalid };
    if (operand.mode !== 'constant' || !operand.constant) return { value: undefined, type: operand.type };
    if (!isInteger(operand.type) && !isUntyped(operand.type)) return { value: undefined, type: operand.type };
    return { value: exactInteger(operand.constant), type: operand.type };
  }

  /** Converts an operand with `T(x)`, which the call compiler routes here. */
  // code-gauge-allow functionNcss 56 -- Keeps Go operand validation, evaluation order and result storage together for this expression.
  protected convert(span: Span, target: Type, rawOperand: Operand): Operand {
    let operand = rawOperand;
    if (this.isInvalid(operand)) return operand;
    if (operand.resolveUntyped) {
      operand = operand.resolveUntyped(isInterface(target) ? defaultType(operand.type) : target);
      if (this.isInvalid(operand)) return operand;
    }
    if (operand.mode === 'constant' && operand.constant && target.kind !== 'typeParam') {
      const result = this.convertConstant(span, target, operand);
      if (result) return result;
    }
    if (operand.type.kind === 'basic' && operand.type.basic === 'untypedNil') {
      if (assignFailure(operand.type, target)) {
        this.error(span, `nil は ${describeType(target)} 型に変換できません。`);
        return this.invalid(span);
      }
      return { mode: 'value', type: target, span, eval: () => {} };
    }
    const source = isUntyped(operand.type) ? this.defaulted(operand) : operand;
    if (this.isInvalid(source)) return source;
    if (!convertible(source.type, target)) {
      this.error(span, `${describeType(source.type)} 型の値は ${describeType(target)} 型に変換できません。`);
      return this.invalid(span);
    }
    if (this.hasTypeParam(source.type) || this.hasTypeParam(target))
      return { mode: 'value', type: target, span, eval: () => {} };
    if (underlying(source.type).kind === 'slice' && underlying(target).kind === 'pointer') {
      const length = (underlying((underlying(target) as { element: Type }).element) as { length: number }).length;
      const read = source.eval;
      return {
        mode: 'value',
        type: target,
        span,
        eval: (frame) => {
          const slice = read(frame) as Slice | undefined;
          if (slice === undefined) return length === 0 ? undefined : sliceToArrayPanic(0, length);
          if (slice.length < length) sliceToArrayPanic(slice.length, length);
          return new SliceArrayPointer(slice.array, slice.offset, length);
        },
      };
    }
    const targetUnder = underlying(target);
    const toRunes = targetUnder.kind === 'slice' && isBasic(targetUnder.element, 'int32');
    const toBytes = targetUnder.kind === 'slice' && isBasic(targetUnder.element, 'uint8');
    if (isString(source.type) && (toRunes || toBytes)) {
      if (operand.mode === 'constant' && operand.constant?.kind === 'string') {
        const text = operand.constant.value;
        const convertConstant = toRunes ? stringToRunesWithMode('constant') : stringToBytesWithMode('exact');
        return {
          mode: 'value',
          type: target,
          span,
          eval: (frame) => convertConstant(text, frame.runtime),
          ssaConstant: always,
        };
      }
      // Go's compiler allocates the elements on the stack while they stay in the function, and for bytes the program
      // only reads, reuses the string's own bytes.
      const nonEscaping: Temporary = { escapes: false, written: false };
      const heap = toRunes ? stringToRunesWithMode('heap') : stringToBytesWithMode('heap');
      const stack = toRunes ? stringToRunesWithMode('stack') : stringToBytesWithMode('stack');
      const exact = toRunes ? stack : stringToBytesWithMode('exact');
      const read = source.eval;
      return {
        mode: 'value',
        type: target,
        span,
        nonEscaping,
        eval: this.hoist((frame) => {
          const convert = !staysLocal(nonEscaping, frame) ? heap : nonEscaping.written ? stack : exact;
          return convert(read(frame), frame.runtime);
        }),
        ssaConstant: source.ssaConstant,
      };
    }
    if (isInterface(target) && !isInterface(source.type)) {
      return { mode: 'value', type: target, span, eval: this.boxing(source), ssaConstant: source.ssaConstant };
    }
    const apply = conversion(source.type, target);
    const read = source.eval;
    return {
      mode: 'value',
      type: target,
      span,
      eval: (frame) => apply(read(frame), frame.runtime),
      ssaConstant: source.ssaConstant,
    };
  }

  // code-gauge-allow functionCognitiveComplexity 21 -- Keeps Go operand validation, evaluation order and result storage together for this expression.
  private convertConstant(span: Span, target: Type, operand: Operand): Operand | undefined {
    const constant = operand.constant as Constant;
    const under = underlying(target);
    if (under.kind !== 'basic') return undefined;
    if (isString(target) && constant.kind === 'int' && (isInteger(operand.type) || isUntyped(operand.type))) {
      const rune = constant.value < 0n || constant.value > 0x10_ff_ffn ? 0xff_fdn : constant.value;
      return this.constant({ kind: 'string', value: encodeRuneText(Number(rune)) }, target, span);
    }
    if (isNumeric(target) && (constant.kind === 'int' || constant.kind === 'float' || constant.kind === 'complex')) {
      const representation = represent(constant, target);
      if ('error' in representation) {
        const text = describeConstant(constant);
        if (representation.error === 'truncated')
          this.error(span, `定数 ${text} は ${describeType(target)} 型に変換すると小数部分や虚部が失われます。`);
        else if (representation.error === 'overflows')
          this.error(span, `定数 ${text} は ${describeType(target)} 型に収まりません。`);
        else this.error(span, `定数 ${text} は ${describeType(target)} 型に変換できません。`);
        return this.invalid(span);
      }
      return this.constant(representation.constant, target, span);
    }
    if ((isString(target) && constant.kind === 'string') || (isBoolean(target) && constant.kind === 'bool')) {
      return this.constant(constant, target, span);
    }
    return undefined;
  }
}

/** The error for comparing values of a type that is not comparable. */
export function incomparableMessage(type: Type): string {
  const under = underlying(type);
  if (under.kind === 'slice') return 'スライスは nil としか比べられません。';
  if (under.kind === 'map') return 'map は nil としか比べられません。';
  if (under.kind === 'func') return '関数は nil としか比べられません。';
  return `${describeType(type)} 型の値は、比べられないフィールドや要素を含むので比べられません。`;
}

function encodeRuneText(rune: number): string {
  const text = String.fromCodePoint(rune);
  let bytes = '';
  for (const byte of new TextEncoder().encode(text)) bytes += String.fromCharCode(byte);
  return bytes;
}

/** Reads through a pointer to an array, which indexing and slicing accept in place of the array. */
function throughArrayPointer(operand: Operand): { type: Type; read: Eval; viaPointer: boolean } {
  const type = coreType(operand.type) ?? operand.type;
  if (type.kind !== 'pointer' || underlying(type.element).kind !== 'array')
    return { type, read: operand.eval, viaPointer: false };
  const readPointer = operand.eval;
  return {
    type: underlying(type.element),
    read: (frame) => {
      const pointer = readPointer(frame);
      if (!(pointer instanceof Pointer)) nilPointerPanic();
      return pointer.load();
    },
    viaPointer: true,
  };
}

/**
 * An element of an array or slice: `locateElement` evaluates the operands and returns what checks the index and gives
 * the container and the index there.
 */
function elementOperand(
  span: Span,
  type: Type,
  operand: Operand,
  addressable: boolean,
  locateElement: (frame: Frame) => () => [Value[], number],
  address: {
    storage?: Storage;
    backingVars?: VarEntity[];
    ssaRoot?: VarEntity;
    addressTaken?: () => void;
    onWrite?: () => void;
  }
): Operand {
  const element = (frame: Frame): [Value[], number] => locateElement(frame)();
  return {
    mode: addressable ? 'variable' : 'value',
    type,
    span,
    variable: operand.variable,
    eval: (frame) => {
      const [elements, at] = element(frame);
      return elements[at];
    },
    locate: addressable
      ? (frame) => {
          const target = locateElement(frame);
          return () => {
            const [elements, at] = target();
            return elements[at];
          };
        }
      : undefined,
    prepareStore: addressable
      ? (frame) => {
          const target = locateElement(frame);
          return (value) => {
            const [elements, at] = target();
            elements[at] = writeInPlace(elements[at], value);
          };
        }
      : undefined,
    store: addressable
      ? (frame, value) => {
          const [elements, at] = element(frame);
          elements[at] = writeInPlace(elements[at], value);
        }
      : undefined,
    addressOf: addressable ? () => (frame) => new Pointer(...element(frame)) : undefined,
    addressStorage: address.storage,
    backingVars: address.backingVars,
    ssaRoot: address.ssaRoot,
    addressTaken: address.addressTaken,
    onWrite: address.onWrite,
  };
}

/**
 * Whether Go's compiler passes the keys of such maps by value to its fast map routines (mapfast in
 * cmd/compile/internal/walk): keys compared as 4 or 8 bytes of memory, or strings, with values of at most 128 bytes.
 */
function hasFastMapAccess(key: Type, value: Type): boolean {
  if (sizeOf(value) > 128) return false;
  if (isBasic(key, 'string')) return true;
  const size = sizeOf(key);
  return (size === 4 || size === 8) && comparesAsMemory(key);
}

function comparesAsMemory(type: Type): boolean {
  const under = underlying(type);
  switch (under.kind) {
    case 'basic': {
      return isInteger(under) || isBoolean(under);
    }
    case 'pointer': {
      return true;
    }
    case 'array': {
      return comparesAsMemory(under.element);
    }
    case 'struct': {
      const fieldsSize = under.fields.reduce((total, field) => total + sizeOf(field.type), 0);
      return fieldsSize === sizeOf(under) && under.fields.every((field) => comparesAsMemory(field.type));
    }
    default: {
      return false;
    }
  }
}

/** The index in a field path after which the last pointer is dereferenced: 0 for the operand itself, or -1 for none. */
function lastPointerAt(type: Type, steps: readonly number[]): number {
  let last = -1;
  let current = underlying(type);
  for (let at = 0; ; at++) {
    if (current.kind === 'pointer') {
      last = at;
      current = underlying(current.element);
    }
    if (at === steps.length || current.kind !== 'struct') return last;
    current = underlying(current.fields[steps[at]].type);
  }
}

/** The struct reached from a struct through fields of struct type. */
function fieldPath(struct: Value, steps: readonly number[]): GoStruct {
  let current = struct as GoStruct;
  for (const index of steps) current = current.fields[index] as GoStruct;
  return current;
}

/** The value a pointer points to, or the value itself when it is not a pointer, panicking for a nil pointer. */
function dereferenced(value: Value): Value {
  if (value instanceof Pointer) return value.load();
  if (value === undefined) nilPointerPanic();
  return value;
}

function constantly(value: Value): () => Value {
  return () => value;
}

/** What tells apart the factors of products, for finding the same product again: a variable's definition or a constant. */
function productKeyOf(operand: Operand): string | undefined {
  const entity = operand.variable?.entity;
  if (entity && operand.type === entity.type) return `v${entity.slot}:${entity.name}:${operand.ssaVersion}`;
  if (operand.mode === 'constant') return `c${describeConstant(operand.constant as Constant)}`;
  return undefined;
}

/**
 * The factors of a float operation that Go's compiler turns into a multiplication it can fuse: `x*y`, except by 2, 1,
 * or -1, which become `x+x`, `x`, or `-x`, and `x/c` for a constant c whose reciprocal is exact, which becomes
 * `x*(1/c)`.
 */
function fusableFactors(operator: string, left: Operand, right: Operand): { left: Eval; right: Eval } | undefined {
  if (operator === '*') {
    if (isTrivialFactor(constantFactor(left)) || isTrivialFactor(constantFactor(right))) return undefined;
    return { left: left.eval, right: right.eval };
  }
  if (operator !== '/') return undefined;
  const divisor = constantFactor(right);
  if (divisor === undefined || divisor === 0 || !Number.isFinite(divisor)) return undefined;
  const reciprocal = 1 / divisor;
  // A reciprocal is exact for powers of two, which a normal double holds exactly.
  if (Math.abs(divisor) !== 2 ** Math.round(Math.log2(Math.abs(divisor))) || !Number.isFinite(reciprocal))
    return undefined;
  if (isTrivialFactor(reciprocal)) return undefined;
  return { left: left.eval, right: () => reciprocal };
}

function constantFactor(operand: Operand): number | undefined {
  return operand.mode === 'constant' ? (operand.eval({} as Frame) as number) : undefined;
}

const STATIC_CONSTANT = { constant: always };
const SSA_MAX_BYTES = 32;
const SSA_MAX_STRUCT_FIELDS = 4;

/** Multiplying by these, Go's compiler adds, copies, or negates instead, which leaves nothing to fuse. */
function isTrivialFactor(value: number | undefined): boolean {
  return value === 2 || value === 1 || value === -1;
}

const groupedSums = new WeakMap<FunctionContext, number>();

/**
 * Whether the function running in the frame shares its float64 additions of two products with another, once Go's
 * compiler inlines it into its callers and its callees into it, which makes common subexpression elimination order
 * their operands.
 */
function sumsGrouped(contexts: ReadonlyMap<FunctionInfo, FunctionContext>, fn: FunctionContext, frame: Frame): boolean {
  let root = fn;
  const { frames } = frame.runtime;
  for (let index = frames.lastIndexOf(frame) - 1; index >= 0 && inlinable(root); index--) {
    const caller = contexts.get(frames[index].info);
    const { summary } = root;
    if (!caller?.callees.some((callee) => callee.summary === summary && callee.holds())) break;
    root = caller;
  }
  let count = groupedSums.get(root);
  if (count === undefined) {
    count = countSums(root, new Set());
    groupedSums.set(root, count);
  }
  return count > 1;
}

/** The float64 additions of two products in a function, counting each call inlined into it once per call. */
function countSums(fn: FunctionContext, inlining: ReadonlySet<FunctionContext>): number {
  let count = fn.sumsOfProducts.filter((sum) => sum()).length;
  for (const callee of fn.callees) {
    const { context } = callee.summary;
    if (context && !inlining.has(context) && callee.holds() && inlinable(context)) {
      count += countSums(context, new Set([...inlining, fn]));
    }
  }
  return count;
}

function inlinable(fn: FunctionContext): boolean {
  return fn.summary?.inlinable() ?? false;
}

/**
 * Whether a product reaches the addition as a multiplication: through a variable only where its definition reaches
 * the use, and not when both factors are constants, which Go's compiler multiplies before the program runs.
 */
function fuses(product: NonNullable<Operand['product']>, frame: Frame | undefined): boolean {
  const { enabled = always, constant = never } = product;
  return enabled() && !constant(frame);
}

/**
 * What Go's compiler knows of a field reached in a struct value: it keeps a struct in SSA form, field by field, only
 * when the struct is small (ssa.CanSSA) and a variable holding it never has its address taken.
 */
function ssaFieldAt(struct: Operand, path: number[]): SsaFacts {
  if (!canSsa(struct.type)) return {};
  const facts = ssaFactsAt(struct, path);
  const variable = struct.ssaRoot;
  return facts ? gateFacts(facts, () => !variable?.addressTaken) : {};
}

/** Whether Go's compiler may keep a value of the type in SSA values rather than memory (ssa.CanSSA). */
function canSsa(type: Type): boolean {
  const under = underlying(type);
  if (sizeOf(under) > SSA_MAX_BYTES) return false;
  if (under.kind === 'array') return under.length <= 1 && canSsa(under.element);
  if (under.kind === 'struct')
    return under.fields.length <= SSA_MAX_STRUCT_FIELDS && under.fields.every((field) => canSsa(field.type));
  return true;
}

/** A negated product: Go's arm64 rules turn FMULD into FNMULD and FNMULD back into FMULD. */
function toggled(negated: Negation | undefined): Negation {
  return () => !(negated?.() ?? false);
}

function isNil(operand: Operand): boolean {
  return operand.type === BASIC.untypedNil;
}

function isValueType(type: Type): boolean {
  const kind = underlying(type).kind;
  return kind === 'struct' || kind === 'array';
}

function basicKind(type: Type): BasicKind {
  const under = underlying(type);
  return under.kind === 'basic' ? under.basic : 'int';
}

export function sameUntypedFamily(a: Type, b: Type): boolean {
  const fa = untypedFamily(a);
  return fa !== 'other' && fa === untypedFamily(b);
}

function untypedFamily(type: Type): string {
  if (isNumeric(type)) return 'numeric';
  if (isString(type)) return 'string';
  if (isBoolean(type)) return 'bool';
  return 'other';
}

function allowsBinaryOperator(operator: string, type: Type): boolean {
  if (type.kind === 'typeParam') {
    const terms = type.constraint.typeSet?.terms;
    return terms !== undefined && terms.length > 0 && terms.every((term) => allowsBinaryOperator(operator, term.type));
  }
  if (operator === '+') return isNumeric(type) || isString(type);
  if (operator === '%' || operator === '&' || operator === '|' || operator === '^' || operator === '&^') {
    return isInteger(type);
  }
  return isNumeric(type);
}

export function largerUntyped(a: Type, b: Type): Type {
  return untypedRank(a) >= untypedRank(b) ? a : b;
}

function untypedRank(type: Type): number {
  return (
    ({ untypedInt: 0, untypedRune: 1, untypedFloat: 2, untypedComplex: 3 } as Record<string, number>)[
      (type as { basic: string }).basic
    ] ?? 0
  );
}

/** Whether every type a type parameter allows represents the constant, as converting the constant to it requires. */
function fitsTypeParam(constant: Constant, target: TypeParamType): boolean {
  const terms = target.constraint.typeSet?.terms;
  return terms !== undefined && terms.length > 0 && terms.every((term) => 'constant' in represent(constant, term.type));
}

/** Why a type does not implement an interface, in parentheses for a message. */
export function describeMissingMethod(type: Type, missing: MissingMethod): string {
  if (missing.pointerOnly) {
    return `（メソッド ${missing.name} はポインタのレシーバを持つので、${describeType(type)} ではなく *${describeType(type)} が実装しています）`;
  }
  if (missing.wrongType) return `（メソッド ${missing.name} の型が違います）`;
  return `（メソッド ${missing.name} がありません）`;
}

/** How Go's compiler writes a constant in messages. */
export function describeConstant(constant: Constant): string {
  switch (constant.kind) {
    case 'bool': {
      return String(constant.value);
    }
    case 'string': {
      return JSON.stringify(utf8Decode(constant.value));
    }
    case 'int': {
      return constant.value.toString();
    }
    case 'float': {
      const { num, den, exp } = constant.value;
      if (exp === undefined && den === 1n) return num.toString();
      return String(rationalToFloat(constant.value));
    }
    case 'complex': {
      return `(${rationalToFloat(constant.re)} + ${rationalToFloat(constant.im)}i)`;
    }
  }
}

export type { FuncType };
export { RUNE };

/** The value of an imaginary literal's number, whose digits alone are decimal even after a leading 0, as Go keeps. */
function imaginaryPart(text: string): Rational {
  if (/^[\d_]+$/.test(text)) return { num: BigInt(text.replaceAll('_', '')), den: 1n };
  const digits = text.replaceAll('_', '');
  return /^0(?:[xX][\da-fA-F]+|[bB][01]+|[oO][0-7]+)$/.test(digits)
    ? { num: BigInt(digits), den: 1n }
    : parseFloatLiteral(text);
}

/** The type that an expression names, such as a type argument `[]int` or `Pair[int, string]`, if it names one. */
function typeSyntaxOf(expression: Expression): TypeExpression | undefined {
  switch (expression.kind) {
    case 'name': {
      return { kind: 'name', row: expression.row, column: expression.column, name: expression.name, typeArguments: [] };
    }
    case 'selector': {
      if (expression.operand.kind !== 'name') return undefined;
      return {
        kind: 'name',
        row: expression.row,
        column: expression.column,
        package: expression.operand.name,
        name: expression.field,
        typeArguments: [],
      };
    }
    case 'index': {
      const base = typeSyntaxOf(expression.operand);
      if (base?.kind !== 'name') return undefined;
      const args = expression.indices.map((index) => typeSyntaxOf(index));
      if (args.includes(undefined)) return undefined;
      return { ...base, typeArguments: args as TypeExpression[] };
    }
    case 'type': {
      return expression.type;
    }
    case 'paren': {
      return typeSyntaxOf(expression.expression);
    }
    case 'unary': {
      if (expression.operator !== '*') return undefined;
      const element = typeSyntaxOf(expression.operand);
      return element && { kind: 'pointer', row: expression.row, column: expression.column, element };
    }
    default: {
      return undefined;
    }
  }
}

function sliceToArrayPanic(length: number, wanted: number): never {
  return runtimeErrorPanic(
    `cannot convert slice with length ${length} to array or pointer to array with length ${wanted}`
  );
}
