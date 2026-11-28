// code-gauge-allow-file fileNcss -- The runtime entry points share one interpreter.
import type { Span } from './ast';
import type { Checker } from './checker';
import { type CallSupport, type ClosureCapture, type CompiledFn, Compiler } from './compiler';
import { derefAll, stripRefs } from './compilerCommon';
import type { WriteChunk } from './debugText';
import { Dropper } from './drops';
import { Formatter, type Spec } from './fmt';
import { normalize } from './infer';
import { compileError, type Module, type Program } from './items';
import { isUserIterator } from './iterTypes';
import { type NativeContext, NATIVES } from './natives';
import { toIterator } from './natives/iterators';
import { receiverIter } from './natives/threads';
import { cloneValue, compareValues, type OrderMethod, setUserImpls, valuesEqual } from './ops';
import {
  ControlSignal,
  FmtFailure,
  Frame,
  type FunctionInfo,
  MOVED,
  OutOfMemory,
  ProcessExit,
  type Runtime,
  RustPanic,
  StackOverflow,
  UnsupportedAtRun,
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
  SharedBox,
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

/** Where a library call that a loop or an adapter makes, not the program, reports a panic it has no place for. */
const NO_SPAN: Span = { row: 0, col: 1 };

export class Interpreter implements CallSupport {
  runtime!: Runtime;
  readonly formatter: Formatter;
  readonly compiler: Compiler;
  readonly restoreOperations: () => void;
  private readonly dispatchCache = new Map<string, Dispatch | undefined>();
  private readonly constValues = new Map<ConstDef, Map<string, Value>>();
  private readonly constFns = new Map<ConstDef, CompiledFn>();
  readonly dropper: Dropper;

  constructor(
    readonly program: Program,
    readonly checker: Checker,
    tracing: boolean,
    private readonly beforeConstant?: (def: ConstDef) => void
  ) {
    this.dropper = new Dropper(
      program,
      (fn, typeArgs, args) => {
        const frame = this.runtime.frames.at(-1) as Frame;
        return this.callFn(fn, typeArgs, args, undefined, { row: 0, col: 1 }, frame);
      },
      (type) => this.revealType(type)
    );
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
      // `self: Pin<&mut Self>` lends the value mutably as `&mut self` does.
      const unwrapped = unwrapDyn(args[0], def.selfMode === 'mutRef' || def.selfWrapper === 'Pin');
      self = unwrapped.type;
      receiverArgs = [unwrapped.receiver, ...args.slice(1)];
    }
    const concrete = [self, ...typeArgs.slice(1)];
    const resolved = this.resolveFunctionInstance(def, concrete);
    if (resolved.fn !== def) return this.callFn(resolved.fn, resolved.typeArgs, receiverArgs, callRow, span, frame);
    if (def.ast?.body) return this.callUser(def, concrete, receiverArgs, callRow);
    return this.callNative(def, concrete, receiverArgs, span, frame);
  }

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

  invoke(
    compiled: CompiledFn,
    typeArgs: ReadonlyMap<TypeParam, Type>,
    args: Value[],
    callRow: number | undefined,
    captures: Place[],
    onEnd?: (frame: Frame, result: Value | undefined) => void
  ): Value {
    const { runtime } = this;
    runtime.dropper ??= this.dropper;
    const frame = new Frame(runtime, compiled.info, callRow, typeArgs, captures);
    runtime.pushFrame(frame);
    const guards = runtime.liveGuards.length;
    let result: Value | undefined;
    let exiting = false;
    try {
      runtime.withRoots(args, () => compiled.bind(frame, args));
      result = compiled.body(frame);
    } catch (error) {
      exiting = error instanceof ProcessExit;
      if (!(error instanceof ControlSignal) || error.kind !== 'return') throw error;
      result = error.value;
    } finally {
      try {
        // The temporaries of the body's tail or `return` value go first (edition 2024), then the body's variables,
        // then the parameters; `process::exit` drops nothing.
        runtime.releaseGuards(frame, guards, result);
        if (!exiting && runtime.dropper) dropFrameLocals(runtime.dropper, frame, compiled);
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
    if (!native) throw new UnsupportedAtRun(`${key} は、この採点環境では使えません。`, span);
    const context: NativeContext = { interp: this, runtime: this.runtime, frame, span, typeArgs };
    const before = receiverText(args[0]);
    const result = this.runtime.withRoots(args, () => {
      if (!this.runtime.world.hasTurtles) return native(args, context);
      const types = nativeArgumentTypes(def, typeArgs);
      const borrowers = args.filter((arg, index) => this.runtime.borrowCandidate(arg, types[index]));
      return this.runtime.withActiveBorrows(borrowers, () => native(args, context));
    });
    releaseConsumed(def, typeArgs, args, result);
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
    while (isPlace(fn) || fn instanceof SharedBox) fn = (fn instanceof SharedBox ? fn.value : fn.get()) as Value;
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
    fn.dropCaptures = () => {
      for (const { place, owned, ownedFields } of captures) {
        for (const { path, type } of ownedFields ?? []) {
          let container = place.get();
          for (const index of path.slice(0, -1)) container = fieldsOf(container)[index];
          const items = fieldsOf(container);
          const value = items[path.at(-1) as number];
          items[path.at(-1) as number] = MOVED;
          this.dropper.drop(value, type);
        }
        if (!owned) continue;
        const value = place.get();
        place.set(MOVED);
        this.dropper.drop(value, owned);
      }
    };
    fn.duplicate = (copy) =>
      this.makeClosure(
        compiled,
        frame,
        captures.map((capture) => capture.duplicate?.(copy) ?? capture)
      ) as FnValue;
    return fn;
  }

  private readonly statics = new Map<ConstDef, Place>();

  staticPlace(def: ConstDef, frame: Frame): Place {
    let place = this.statics.get(def);
    if (!place) {
      place = new CellPlace(this.constValue(def, frame, []));
      this.statics.set(def, place);
    }
    return place;
  }

  toIter(value: Value, from: Type, span: Span = NO_SPAN): Value {
    const type = this.revealType(from);
    if (!(value instanceof IterValue) && isUserIterator(type)) return this.userIterator(value, type);
    const receiver = stripRefs(type);
    if (receiver.kind === 'adt' && receiver.def.builtin === 'Receiver') {
      const frame = this.runtime.frames.at(-1) as Frame;
      const ctx = { interp: this, runtime: this.runtime, frame, span, typeArgs: [] };
      return receiverIter(ctx, value, true);
    }
    return toIterator(value, type);
  }

  /** The program's own iterator (or a `&mut` of one) as an iterator whose `next` calls the impl's `next`. */
  private userIterator(value: Value, type: Type): IterValue {
    const t = normalize(shallow(type));
    const self = t.kind === 'ref' ? t.target : t;
    // A `&mut` receiver of an adapter (`(&mut c).take(2)`) arrives as the place it refers to, typed as the iterator,
    // and one that the call borrows again (`(&mut c).nth(2)`) as a place holding that place.
    const borrowed = t.kind === 'ref' || isPlace(value);
    let place = borrowed && isPlace(value) ? value : new CellPlace(value);
    while (isPlace(place.get())) place = place.get() as Place;
    const next = this.program.traitDef('Iterator').methods.get('next') as FnDef;
    const frame = this.runtime.frames.at(-1) as Frame;
    const iter = new IterValue(
      () => {
        const result = this.callFn(next, [self], [place], undefined, { row: 0, col: 1 }, frame) as EnumValue;
        return result.variant === 1 ? result.fields[0] : DONE;
      },
      undefined,
      undefined,
      [place]
    );
    // An iterator taken by value is the loop's, which drops it when the loop ends however it ends.
    if (!borrowed) {
      iter.releases = [
        () => {
          const owned = place.get();
          place.set(MOVED);
          this.dropper.drop(owned, self);
        },
      ];
    }
    return iter;
  }

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

export function fieldTypes(def: AdtDef, args: Type[], variant: number): Type[] {
  const fields = def.variants[variant]?.fields ?? [];
  if (def.params.length === 0) return fields.map((field) => field.type);
  const subst = new Map(def.params.map((param, index) => [param, args[index]]));
  return fields.map((field) => substitute(field.type, subst));
}

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

/**
 * What a library function takes by value and does not keep goes when it returns: a closure's captured values
 * (`Option::map(move |x| ..)`), and what an iterator it consumes holds (`collect`); an iterator adaptor that keeps them
 * (`map`) lets them go when it goes.
 */
function releaseConsumed(def: FnDef, typeArgs: Type[], args: Value[], result: Value): void {
  if (KEEPS_CLOSURE.has(def.nativeKey ?? '') || !args.some((arg) => releaseOf(arg))) return;
  const types = nativeArgumentTypes(def, typeArgs);
  for (const [index, arg] of args.entries()) {
    const release = releaseOf(arg);
    const type = types[index] as Type | undefined;
    // A method's receiver is taken by value only for `self`.
    const borrowed = (index === 0 && def.selfMode !== undefined && def.selfMode !== 'value') || !type;
    if (!release || arg === result || borrowed || normalize(shallow(type)).kind === 'ref') continue;
    if (result instanceof IterValue) (result.releases ??= []).push(release);
    else if (!keepsParam(def, index)) release();
  }
}

/** Natives that keep a closure to run later, which then drop its captured values themselves. */
const KEEPS_CLOSURE = new Set(['std::thread::spawn', 'Scope::spawn']);

function releaseOf(value: Value): (() => void) | undefined {
  if (value instanceof FnValue && value.dropCaptures) return value.dropCaptures;
  if (value instanceof IterValue && value.releases) return () => value.release();
  return undefined;
}

/**
 * Whether a function can keep its argument: in its result, or in what another argument lends it mutably (`Vec::push`,
 * `mem::replace`), as their types name the argument's type parameter.
 */
function keepsParam(def: FnDef, index: number): boolean {
  const params = def.selfMode ? [def.impl?.selfType, ...def.paramTypes] : def.paramTypes;
  const param = params[index] && shallow(params[index]);
  if (param?.kind !== 'param') return false;
  if (mentions(def.ret, param.param)) return true;
  return params.some((other, position) => {
    if (position === index || !other) return false;
    const t = shallow(other);
    const lentMutably = position === 0 && def.selfMode ? def.selfMode === 'mutRef' : t.kind === 'ref' && t.mutable;
    return lentMutably && mentions(t, param.param);
  });
}

function mentions(type: Type, param: TypeParam): boolean {
  const t = shallow(type);
  if (t.kind === 'param') return t.param === param;
  return childTypes(t).some((child) => mentions(child, param));
}

function fieldsOf(value: Value): Value[] {
  return value instanceof StructValue ? value.fields : (value as Value[]);
}

/**
 * Drops a returning frame's variables: the body's, the last declared first, then the parameters, the last declared
 * first, a pattern parameter's leftover after the variables it binds.
 */
function dropFrameLocals(dropper: Dropper, frame: Frame, compiled: CompiledFn): void {
  const bodySlots = compiled.bodySlots ?? [];
  const paramSlots = compiled.paramSlots ?? [];
  const params = new Set(paramSlots.flat());
  const others = compiled.info.locals
    .map((local) => local.slot)
    .filter((slot) => !bodySlots.includes(slot) && !params.has(slot));
  dropper.dropSlots(frame, [...others.toSorted((a, b) => a - b), ...bodySlots]);
  for (let index = paramSlots.length - 1; index >= 0; index--) {
    dropper.dropSlots(frame, paramSlots[index]);
    frame.paramLeftovers.get(index)?.();
  }
}
