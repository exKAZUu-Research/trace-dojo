import type { Span } from './ast';
import type { Checker } from './checker';
import { type CallSupport, type ClosureCapture, type CompiledFn, Compiler } from './compiler';
import { derefAll } from './compilerCommon';
import type { WriteChunk } from './debugText';
import { Formatter, type Spec } from './fmt';
import { normalize } from './infer';
import { compileError, type Module, type Program } from './items';
import { isUserIterator } from './iterTypes';
import { type NativeContext, NATIVES } from './natives';
import { toIterator } from './natives/iterators';
import { cloneValue, compareValues, type OrderMethod, setUserImpls, valuesEqual } from './ops';
import {
  ControlSignal,
  FmtFailure,
  Frame,
  type FunctionInfo,
  OutOfMemory,
  type Runtime,
  RustPanic,
  StackOverflow,
} from './runtime';
import { concreteType, matchConcrete, typeIdentity, typeKey } from './runtimeTypes';
import { nativeArgumentTypes, turtleCaptureRoots } from './turtleTypes';
import {
  type AdtDef,
  childTypes,
  type ConstDef,
  type FnDef,
  type ImplDef,
  mapChildren,
  resolve,
  shallow,
  substitute,
  substituteTraitRef,
  type TraitDef,
  type Type,
  type TypeParam,
} from './types';
import { decodeUtf8, utf8Reader } from './utf8';
import {
  AccessorPlace,
  CellPlace,
  DONE,
  DynValue,
  EnumValue,
  FnValue,
  FormatterValue,
  isPlace,
  IterValue,
  type Place,
  type RangeValue,
  StringValue,
  StructValue,
  textOf,
  TurtleValue,
  UNIT_VALUE,
  type Value,
} from './values';

interface Dispatch {
  fn: FnDef;
  /** The impl's type parameters bound by matching its self type, or undefined for a trait's own method. */
  implArgs: Type[] | undefined;
}

/** Runs a checked program: calls, trait dispatch, natives, and formatting. */
export class Interpreter implements CallSupport {
  runtime!: Runtime;
  readonly formatter: Formatter;
  readonly compiler: Compiler;
  readonly restoreOperations: () => void;
  private readonly dispatchCache = new Map<string, Dispatch | undefined>();
  private readonly constValues = new Map<ConstDef, Map<string, Value>>();
  private readonly constFns = new Map<ConstDef, CompiledFn>();

  constructor(
    readonly program: Program,
    readonly checker: Checker,
    tracing: boolean,
    private readonly beforeConstant?: (def: ConstDef) => void
  ) {
    this.compiler = new Compiler(program, checker, this, tracing);
    this.formatter = new Formatter({
      userFmt: (trait, type, value, spec, write) => this.userFmt(trait, type, value, spec, write),
      fieldTypes: (def, args, variant) => fieldTypes(def, args, variant),
      concrete: (type) => this.revealType(type),
      allocateString: (length, written) => this.runtime.allocateString(length, written),
      withActiveBorrows: (values, use) => this.runtime.withActiveBorrows(values, use),
    });
    this.restoreOperations = setUserImpls({
      allocate: (count) => this.runtime.allocate(count),
      spend: (count) => this.runtime.spend(count),
      copyScalarStorage: (source, copy) => this.runtime.copyScalarStorage(source, copy),
      withRoots: (values, use) => this.runtime.withRoots(values, use),
      eq: (method, type, a, b, rhs) => {
        const found = this.userTraitMethod('PartialEq', type, method, rhs);
        if (!found) return;
        return this.callDispatched(found, type, [a, b]) as boolean;
      },
      order: (method, type, a, b, rhs) => this.userOrder(method, type, a, b, rhs),
      cmp: (type, a, b, partial, rhs) => this.userCompare(type, a, b, partial, rhs),
      clone: (type, value) => {
        const found = this.userTraitMethod('Clone', type, 'clone');
        if (!found) return;
        return { value: this.callDispatched(found, type, [value]) };
      },
      fieldTypes,
    });
  }

  private userOrder(method: OrderMethod, type: Type, a: Value, b: Value, rhs: Type): boolean | undefined {
    const found = this.userTraitMethod('PartialOrd', type, method, rhs);
    return found ? (this.callDispatched(found, type, [a, b]) as boolean) : undefined;
  }

  private userCompare(
    type: Type,
    a: Value,
    b: Value,
    partial: boolean,
    rhs?: Type
  ): { order: number | undefined } | undefined {
    const compare = partial
      ? this.userTraitMethod('PartialOrd', type, 'partial_cmp', rhs)
      : this.userTraitMethod('Ord', type, 'cmp');
    if (!compare) return;
    const result = this.callDispatched(compare, type, [a, b]) as EnumValue;
    if (!partial) return { order: result.variant - 1 };
    return { order: result.variant === 0 ? undefined : (result.fields[0] as EnumValue).variant - 1 };
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Calls

  /** Calls a function with concrete type arguments: a trait method dispatches on its `Self` type. */
  callFn(def: FnDef, typeArgs: Type[], args: Value[], callRow: number | undefined, span: Span, frame: Frame): Value {
    if (def.trait && def.trait.methods.get(def.name) === def) {
      return this.callTraitMethod(def, typeArgs, args, callRow, span, frame);
    }
    if (def.ast?.body) return this.callUser(def, typeArgs, args, callRow);
    return this.callNative(def, typeArgs, args, span, frame);
  }

  private callTraitMethod(
    def: FnDef,
    typeArgs: Type[],
    args: Value[],
    callRow: number | undefined,
    span: Span,
    frame: Frame
  ): Value {
    let self = this.revealType(typeArgs[0]);
    let receiverArgs = args;
    if (self.kind === 'dyn' && def.selfMode) {
      const unwrapped = unwrapDyn(args[0], def.selfMode === 'mutRef');
      self = unwrapped.type;
      receiverArgs = [unwrapped.receiver, ...args.slice(1)];
    }
    const concrete = [self, ...typeArgs.slice(1)];
    const resolved = this.resolveFunctionInstance(def, concrete);
    if (resolved.fn !== def) return this.callFn(resolved.fn, resolved.typeArgs, receiverArgs, callRow, span, frame);
    if (def.ast?.body) return this.callUser(def, concrete, receiverArgs, callRow);
    return this.callNative(def, concrete, receiverArgs, span, frame);
  }

  /** The impl method that a trait method runs for a concrete type, or the trait's default method. */
  private dispatch(
    trait: TraitDef,
    receiver: Type,
    name: string,
    suppliedArgs: Type[] = [],
    revealing: ReadonlySet<number> = new Set()
  ): Dispatch | undefined {
    const self = this.revealType(receiver, revealing);
    const traitArgs = suppliedArgs.map((type) => this.revealType(type, revealing));
    const argKey = traitArgs.map(typeKey).join(',');
    const key = `${typeIdentity(trait)}|${typeKey(self)}|${name}|${argKey}`;
    if (this.dispatchCache.has(key)) return this.dispatchCache.get(key);
    let result: Dispatch | undefined;
    for (const impl of this.program.impls) {
      if (impl.trait?.trait !== trait) continue;
      const subst = new Map<TypeParam, Type>();
      const params = new Set(impl.params);
      if (!matchConcrete(impl.selfType, self, params, subst)) continue;
      if (!traitArgs.every((arg, index) => matchConcrete(impl.trait!.args[index], arg, params, subst))) continue;
      if (!this.satisfiesImplBounds(subst)) continue;
      const fn = impl.methods.get(name);
      if (fn) result = { fn, implArgs: impl.params.map((param) => subst.get(param) as Type) };
      break;
    }
    this.dispatchCache.set(key, result);
    return result;
  }

  private satisfiesImplBounds(subst: Map<TypeParam, Type>): boolean {
    const { solver, unifier } = this.checker;
    const snapshot = unifier.snapshot();
    try {
      return [...subst].every(([param, type]) =>
        param.bounds.every((bound) => solver.implements(type, substituteTraitRef(bound, subst)) === 'yes')
      );
    } finally {
      unifier.rollback(snapshot);
    }
  }

  /** A program's own impl method of a standard trait for a type, for the type-directed operations. */
  private userTraitMethod(traitName: string, type: Type, method: string, traitArg?: Type): Dispatch | undefined {
    const trait = this.program.builtinTraits.get(traitName);
    if (!trait) return undefined;
    const t = normalize(shallow(type));
    const candidate = this.dispatch(trait, t, method, traitArg ? [traitArg] : []);
    return candidate && !(candidate.fn.module as Module).isStd ? candidate : undefined;
  }

  private callDispatched(dispatch: Dispatch, self: Type, args: Value[]): Value {
    const frame = this.runtime.frames.at(-1) as Frame;
    const typeArgs = dispatch.implArgs ?? [self];
    return this.callFn(dispatch.fn, typeArgs, args, undefined, { row: 0, col: 0 }, frame);
  }

  private callUser(def: FnDef, typeArgs: Type[], args: Value[], callRow: number | undefined): Value {
    const compiled = this.compiler.compileFn(def);
    const typeMap = new Map<TypeParam, Type>();
    for (const [index, param] of def.params.entries()) {
      const arg = typeArgs[index];
      if (arg) typeMap.set(param, arg);
    }
    return this.invoke(compiled, typeMap, args, callRow, []);
  }

  /** Runs a compiled body in a new frame, returning its value or the value of a `return` in it. */
  invoke(
    compiled: CompiledFn,
    typeArgs: ReadonlyMap<TypeParam, Type>,
    args: Value[],
    callRow: number | undefined,
    captures: Place[],
    onEnd?: (frame: Frame, result: Value | undefined) => void
  ): Value {
    const { runtime } = this;
    const frame = new Frame(runtime, compiled.info, callRow, typeArgs, captures);
    runtime.pushFrame(frame);
    let result: Value | undefined;
    try {
      runtime.withRoots(args, () => compiled.bind(frame, args));
      result = compiled.body(frame);
    } catch (error) {
      if (!(error instanceof ControlSignal) || error.kind !== 'return') throw error;
      result = error.value;
    } finally {
      try {
        onEnd?.(frame, result);
      } finally {
        runtime.popFrame();
        if (compiled.info.isAtomic) runtime.steps.completeAtomicCall();
      }
    }
    return result;
  }

  private callNative(def: FnDef, typeArgs: Type[], args: Value[], span: Span, frame: Frame): Value {
    const key = def.nativeKey ?? `${def.name}`;
    const native = NATIVES[key];
    if (!native) throw new RustPanic(`${key} は、この採点環境では使えません。`, span);
    const context: NativeContext = { interp: this, runtime: this.runtime, frame, span, typeArgs };
    const before = receiverText(args[0]);
    const result = this.runtime.withRoots(args, () => {
      if (!this.runtime.world.hasTurtles) return native(args, context);
      const types = nativeArgumentTypes(def, typeArgs);
      const borrowers = args.filter((arg, index) => this.runtime.borrowCandidate(arg, types[index]));
      return this.runtime.withActiveBorrows(borrowers, () => native(args, context));
    });
    // Library functions build `String`s through these two ways out: a result, and a receiver they write to.
    if ((typeof result === 'string' || result instanceof StringValue) && shallow(def.ret).kind !== 'ref') {
      this.runtime.allocateString(textOf(result).length);
    }
    if (before !== undefined) {
      const after = receiverText(args[0]) ?? '';
      if (after.length > before.length) this.runtime.allocateString(after.length, after.length - before.length);
    }
    return result;
  }

  callValue(callee: Value, args: Value[], callRow: number | undefined): Value {
    let fn = callee;
    while (isPlace(fn)) fn = fn.get();
    if (fn instanceof DynValue) fn = fn.value;
    return (fn as FnValue).call(args, callRow);
  }

  makeClosure(compiled: CompiledFn, frame: Frame, captures: ClosureCapture[]): Value {
    const { typeArgs } = frame;
    const places = captures.map(({ place }) => place);
    const roots = turtleCaptureRoots(places, compiled.info.captures, typeArgs);
    const fn = new FnValue(
      (args, callRow) => this.invoke(compiled, typeArgs, args, callRow, places),
      '{closure}',
      roots
    );
    fn.duplicate = (copy) =>
      this.makeClosure(
        compiled,
        frame,
        captures.map((capture) => capture.duplicate?.(copy) ?? capture)
      ) as FnValue;
    return fn;
  }

  toIter(value: Value, from: Type): Value {
    const type = this.revealType(from);
    if (!(value instanceof IterValue) && isUserIterator(type)) return this.userIterator(value, type);
    return toIterator(value, type);
  }

  /** The program's own iterator (or a `&mut` of one) as an iterator whose `next` calls the impl's `next`. */
  private userIterator(value: Value, type: Type): IterValue {
    const t = normalize(shallow(type));
    const self = t.kind === 'ref' ? t.target : t;
    const place = t.kind === 'ref' && isPlace(value) ? value : new CellPlace(value);
    const next = this.program.traitDef('Iterator').methods.get('next') as FnDef;
    const frame = this.runtime.frames.at(-1) as Frame;
    return new IterValue(
      () => {
        const result = this.callFn(next, [self], [place], undefined, { row: 0, col: 1 }, frame) as EnumValue;
        return result.variant === 1 ? result.fields[0] : DONE;
      },
      undefined,
      undefined,
      [place]
    );
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Constants and conversions

  constValue(def: ConstDef, frame: Frame, types: Type[]): Value {
    if (def.trait) {
      const implemented = this.traitConstImpl(def, types);
      if (implemented) return this.constValue(implemented.def, frame, implemented.typeArgs);
    }
    this.beforeConstant?.(def);
    const key = JSON.stringify(types.map(typeKey));
    let instances = this.constValues.get(def);
    if (!instances) {
      instances = new Map();
      this.constValues.set(def, instances);
    }
    if (instances.has(key)) return instances.get(key);
    const value = this.evaluateConst(def, frame, types);
    if (typeof value !== 'object' || def.ast.isStatic) instances.set(key, value);
    return value;
  }

  evaluateCheckedConstant(def: ConstDef, typeArgs: Type[]): Value {
    const frame = new Frame(
      this.runtime,
      { name: '{const}', slotCount: 0, locals: [], captures: [], isAtomic: true },
      undefined,
      new Map()
    );
    try {
      return this.constValue(def, frame, typeArgs);
    } catch (error) {
      if (error instanceof RustPanic)
        compileError(error.span, `定数 ${def.name} の計算中にエラーが起きました。 ${error.message}`);
      if (error instanceof OutOfMemory || error instanceof StackOverflow) {
        compileError(def.ast.span, `定数 ${def.name} の計算に必要なメモリの上限を超えました。`);
      }
      throw error;
    }
  }

  private revealType(type: Type, revealing: ReadonlySet<number> = new Set()): Type {
    const frame = this.runtime.frames.at(-1);
    const current = normalize(shallow(frame ? concreteType(type, frame.typeArgs) : type));
    if (current.kind !== 'opaque') return mapChildren(current, (child) => this.revealType(child, revealing));
    const { id, args, hidden, method } = current.opaque;
    if (revealing.has(id)) return current;
    const next = new Set([...revealing, id]);
    const implementation = method && this.resolveFunctionInstance(method, args, next);
    if (method && implementation && implementation.fn !== method) {
      const { fn, typeArgs } = implementation;
      const bindings = new Map(fn.params.map((param, index) => [param, typeArgs[index]]));
      const result = opaqueProjection(method.ret, concreteType(fn.ret, bindings), id);
      if (result) return this.revealType(result, next);
    }
    return hidden ? this.revealType(resolve(hidden, true), next) : current;
  }

  resolveFunctionInstance(
    fn: FnDef,
    typeArgs: Type[],
    revealing: ReadonlySet<number> = new Set()
  ): { fn: FnDef; typeArgs: Type[] } {
    const trait = fn.trait;
    if (!trait || trait.methods.get(fn.name) !== fn) return { fn, typeArgs };
    const self = this.revealType(typeArgs[0], revealing);
    if (self.kind === 'dyn') return { fn, typeArgs };
    const dispatched = this.dispatch(trait, self, fn.name, typeArgs.slice(1, 1 + trait.params.length), revealing);
    if (!dispatched?.implArgs) return { fn, typeArgs };
    return { fn: dispatched.fn, typeArgs: [...dispatched.implArgs, ...typeArgs.slice(fn.parentParamCount)] };
  }

  /** The constant an impl gives for a trait's constant on the concrete `Self` that `types` starts with. */
  private traitConstImpl(def: ConstDef, types: Type[]): { def: ConstDef; typeArgs: Type[] } | undefined {
    const self = this.revealType(types[0]);
    const traitArgs = types.slice(1).map((type) => this.revealType(type));
    for (const impl of this.program.impls) {
      if (impl.trait?.trait !== def.trait) continue;
      const subst = new Map<TypeParam, Type>();
      const params = new Set(impl.params);
      if (!matchConcrete(impl.selfType, self, params, subst)) continue;
      if (!traitArgs.every((arg, index) => matchConcrete(impl.trait!.args[index], arg, params, subst))) continue;
      const constant = impl.consts.get(def.name);
      return constant && { def: constant, typeArgs: impl.params.map((param) => subst.get(param) as Type) };
    }
    return undefined;
  }

  private evaluateConst(def: ConstDef, frame: Frame, types: Type[]): Value {
    const native = NATIVES[`const:${def.name}`];
    let value: Value;
    if (!def.ast.value) {
      value = native
        ? native([], {
            interp: this,
            runtime: this.runtime,
            frame,
            span: { row: 0, col: 0 },
            typeArgs: [def.type],
          })
        : undefined;
    } else {
      let compiled = this.constFns.get(def);
      if (!compiled) {
        const context = this.checker.fnContexts.get(def);
        if (!context) throw new Error(`No checked initializer for ${def.name}`);
        compiled = this.compiler.compileConst(def.ast.value, context);
        this.constFns.set(def, compiled);
      }
      const params = def.impl?.params ?? (def.trait ? [def.trait.self, ...def.trait.params] : []);
      const typeArgs = new Map(params.map((param, index) => [param, types[index]]));
      value = this.invoke(compiled, typeArgs, [], undefined, []);
    }
    return value;
  }

  builtinConst(name: string): Value {
    const native = NATIVES[`const:${name}`];
    return native
      ? native([], {
          interp: this,
          runtime: this.runtime,
          frame: undefined as never,
          span: { row: 0, col: 0 },
          typeArgs: [],
        })
      : undefined;
  }

  convertError(value: Value, from: Type, to: Type, frame: Frame): Value {
    const target = normalize(shallow(to));
    if (target.kind === 'adt' && target.def.builtin === 'Box') {
      const inner = normalize(shallow(target.args[0]));
      if (inner.kind === 'dyn') {
        const source = normalize(shallow(from));
        if (source.kind === 'ref' || (source.kind === 'adt' && source.def.builtin === 'String')) {
          return new DynValue(this.program.builtinType('String'), textOf(value));
        }
        return new DynValue(from, value);
      }
    }
    return this.convertFrom(value, from, to, frame);
  }

  /** `From::from`: the program's impl, or the standard library's conversion. */
  convertFrom(value: Value, from: Type, to: Type, frame: Frame): Value {
    const dispatch = this.dispatch(this.program.traitDef('From'), normalize(shallow(to)), 'from', [from]);
    const span = { row: 0, col: 0 };
    if (dispatch) return this.callFn(dispatch.fn, dispatch.implArgs ?? [], [value], undefined, span, frame);
    return NATIVES['From::from']([value], {
      interp: this,
      runtime: this.runtime,
      frame,
      span,
      typeArgs: [to, from],
    });
  }

  strSlice(text: string, range: RangeValue | undefined, span: Span): string {
    const writtenEnd = range?.inclusive ? (range.end as bigint) : undefined;
    return strSliceBytes(text, range?.sliceStart(), range?.sliceEnd(), span, writtenEnd);
  }

  turtleNew(args: Value[], span: Span, frame: Frame): Value {
    const [x, y, color] = args;
    const created = this.runtime.world.create(
      x === undefined ? 0 : Number(x as bigint),
      y === undefined ? 0 : Number(y as bigint),
      color as string | undefined
    );
    if ('error' in created) throw new RustPanic(created.error, span);
    void frame;
    return new TurtleValue(created);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Formatting

  private userFmt(
    trait: 'Display' | 'Debug',
    type: Type,
    value: Value,
    spec: Spec,
    write?: WriteChunk
  ): string | undefined {
    const t = normalize(shallow(type));
    if (t.kind !== 'adt') return undefined;
    const module = t.def.module as Module | undefined;
    if (!module || module.isStd) return undefined;
    const traitDef = this.program.builtinTraits.get(trait);
    if (!traitDef) return undefined;
    const dispatch = this.dispatch(traitDef, t, 'fmt');
    if (!dispatch) return undefined;
    const formatter = new FormatterValue(spec, write);
    const frame = this.runtime.frames.at(-1) as Frame;
    const result = this.callFn(
      dispatch.fn,
      dispatch.implArgs ?? [t],
      [value, new CellPlace(formatter)],
      undefined,
      { row: 0, col: 0 },
      frame
    ) as EnumValue;
    if (result.variant !== 0) throw new FmtFailure(formatter.text);
    return formatter.text;
  }
}

function opaqueProjection(declaration: Type, implementation: Type, id: number): Type | undefined {
  const expected = shallow(declaration);
  if (expected.kind === 'opaque') return expected.opaque.id === id ? implementation : undefined;
  const types = childTypes(shallow(implementation));
  for (const [index, child] of childTypes(expected).entries()) {
    if (!types[index]) continue;
    const projected = opaqueProjection(child, types[index], id);
    if (projected) return projected;
  }
  return undefined;
}

/** The types of a variant's fields with a generic type's parameters replaced by its arguments. */
export function fieldTypes(def: AdtDef, args: Type[], variant: number): Type[] {
  const fields = def.variants[variant]?.fields ?? [];
  if (def.params.length === 0) return fields.map((field) => field.type);
  const subst = new Map(def.params.map((param, index) => [param, args[index]]));
  return fields.map((field) => substitute(field.type, subst));
}

/** The concrete type and receiver of a trait object's method call. */
function unwrapDyn(receiver: Value, mutable: boolean): { type: Type; receiver: Value } {
  if (receiver instanceof DynValue) {
    return { type: receiver.type, receiver: mutable ? receiver.value : derefAll(receiver.value) };
  }
  if (isPlace(receiver)) {
    const inner = receiver.get();
    if (inner instanceof DynValue) {
      if (!mutable || isPlace(inner.value)) return unwrapDyn(inner, mutable);
      return {
        type: inner.type,
        receiver: new AccessorPlace(
          () => (receiver.get() as DynValue).value,
          (value) => receiver.set(new DynValue(inner.type, value)),
          receiver
        ),
      };
    }
    return unwrapDyn(inner, mutable);
  }
  throw new Error('A trait object call without a trait object');
}

/** `&s[start..end]` of a string by byte offsets, panicking as Rust does out of bounds or inside a character. */
export function strSliceBytes(
  text: string,
  start: number | bigint | undefined,
  end: number | bigint | undefined,
  span: Span,
  writtenEnd?: bigint
): string {
  // Repeated slices of one long string (a lexer's tokens) read its kept encoding instead of encoding it each time.
  const bytes = utf8Reader.of(text);
  const from = start ?? 0;
  const to = end ?? bytes.length;
  if (from > bytes.length) {
    throw new RustPanic(`start byte index ${from} is out of bounds for string of length ${bytes.length}`, span);
  }
  if (to > bytes.length) {
    throw new RustPanic(
      `end byte index ${writtenEnd ?? to} is out of bounds for string of length ${bytes.length}`,
      span
    );
  }
  if (from > to) throw new RustPanic(`byte range starts at ${from} but ends at ${to}`, span);
  for (const [index, which] of [
    [Number(from), 'start'],
    [Number(to), 'end'],
  ] as const) {
    if (index < bytes.length && (bytes[index] & 0xc0) === 0x80) {
      let charStart = index;
      while (charStart > 0 && (bytes[charStart] & 0xc0) === 0x80) charStart--;
      let charEnd = charStart + 1;
      while (charEnd < bytes.length && (bytes[charEnd] & 0xc0) === 0x80) charEnd++;
      const char = decodeUtf8(bytes.subarray(charStart, charEnd));
      throw new RustPanic(
        `${which} byte index ${index} is not a char boundary; it is inside '${char}' (bytes ${charStart}..${charEnd} of string)`,
        span
      );
    }
  }
  return decodeUtf8(bytes.subarray(Number(from), Number(to)));
}

export { cloneValue, compareValues, valuesEqual, StructValue, EnumValue, UNIT_VALUE };
export type { FunctionInfo, ImplDef };

/** The text of a `String` or a `fmt::Formatter` a method is called on, which it may write to. */
function receiverText(receiver: Value | undefined): string | undefined {
  let value = receiver;
  while (isPlace(value)) value = value.get();
  if (typeof value === 'string' || value instanceof StringValue) return isPlace(receiver) ? textOf(value) : undefined;
  return value instanceof FormatterValue ? value.text : undefined;
}
