import type { Expr, Span } from './ast';
import type { Checker } from './checker';
import { type CallSupport, type CompiledFn, Compiler } from './compiler';
import { Formatter, type Spec } from './fmt';
import { normalize } from './infer';
import type { Module, Program } from './items';
import { type NativeContext, NATIVES } from './natives';
import { toIterator } from './natives/iterators';
import { cloneValue, compareValues, setUserImpls, valuesEqual } from './ops';
import { ControlSignal, FmtFailure, Frame, type FunctionInfo, type Runtime, RustPanic } from './runtime';
import { concreteType, matchConcrete, typeKey } from './runtimeTypes';
import {
  type AdtDef,
  type FnDef,
  type ImplDef,
  resolve,
  shallow,
  substitute,
  type TraitDef,
  type Type,
  type TypeParam,
} from './types';
import {
  AccessorPlace,
  CellPlace,
  DynValue,
  EnumValue,
  FnValue,
  FormatterValue,
  isPlace,
  type Place,
  StructValue,
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
  private readonly dispatchCache = new Map<string, Dispatch | undefined>();
  private readonly constValues = new Map<unknown, Value>();
  private readonly constFns = new Map<unknown, CompiledFn>();

  constructor(
    readonly program: Program,
    readonly checker: Checker,
    tracing: boolean
  ) {
    this.compiler = new Compiler(program, checker, this, tracing);
    this.formatter = new Formatter({
      userFmt: (trait, type, value, spec) => this.userFmt(trait, type, value, spec),
      fieldTypes: (def, args, variant) => fieldTypes(def, args, variant),
      concrete: (type) => {
        const frame = this.runtime.frames.at(-1);
        let t = shallow(frame ? concreteType(type, frame.typeArgs) : type);
        // An `impl Trait` value formats as the type it hides.
        while (t.kind === 'opaque' && t.opaque.hidden) t = shallow(resolve(t.opaque.hidden, true));
        return t;
      },
    });
    setUserImpls({
      eq: (type, a, b, rhs) => {
        const found = this.userTraitMethod('PartialEq', type, 'eq', rhs);
        if (!found) return;
        return this.callDispatched(found, type, [a, b]) as boolean;
      },
      cmp: (type, a, b) => {
        const ord = this.userTraitMethod('Ord', type, 'cmp');
        if (ord) return (this.callDispatched(ord, type, [a, b]) as EnumValue).variant - 1;
        const partial = this.userTraitMethod('PartialOrd', type, 'partial_cmp');
        if (!partial) return;
        const result = this.callDispatched(partial, type, [a, b]) as EnumValue;
        return result.variant === 0 ? undefined : (result.fields[0] as EnumValue).variant - 1;
      },
      clone: (type, value) => {
        const found = this.userTraitMethod('Clone', type, 'clone');
        if (!found) return;
        return { value: this.callDispatched(found, type, [value]) };
      },
      fieldTypes,
    });
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
    let self = normalize(shallow(typeArgs[0]));
    let receiverArgs = args;
    if (self.kind === 'dyn' && def.selfMode) {
      const unwrapped = unwrapDyn(args[0]);
      self = unwrapped.type;
      receiverArgs = [unwrapped.receiver, ...args.slice(1)];
    }
    const trait = def.trait as TraitDef;
    const dispatch = this.dispatch(trait, self, def.name);
    if (dispatch) {
      const own = typeArgs.slice(def.parentParamCount);
      const fnArgs = dispatch.implArgs ? [...dispatch.implArgs, ...own] : [self, ...typeArgs.slice(1)];
      return this.callFn(dispatch.fn, fnArgs, receiverArgs, callRow, span, frame);
    }
    const concrete = [self, ...typeArgs.slice(1)];
    if (def.ast?.body) return this.callUser(def, concrete, receiverArgs, callRow);
    return this.callNative(def, concrete, receiverArgs, span, frame);
  }

  /** The impl method that a trait method runs for a concrete type, or the trait's default method. */
  private dispatch(trait: TraitDef, self: Type, name: string, traitArg?: Type): Dispatch | undefined {
    const argKey = traitArg ? typeKey(traitArg) : '';
    const key = `${trait.path}#${(trait as { id?: number }).id ?? ''}|${typeKey(self)}|${name}|${argKey}`;
    if (this.dispatchCache.has(key)) return this.dispatchCache.get(key);
    let result: Dispatch | undefined;
    for (const impl of this.program.impls) {
      if (impl.trait?.trait !== trait) continue;
      const subst = new Map<TypeParam, Type>();
      const params = new Set(impl.params);
      if (!matchConcrete(impl.selfType, self, params, subst)) continue;
      const implArg = impl.trait.args[0];
      if (traitArg && implArg && !matchConcrete(implArg, traitArg, params, subst)) continue;
      const fn = impl.methods.get(name);
      if (fn) result = { fn, implArgs: impl.params.map((param) => subst.get(param) as Type) };
      break;
    }
    this.dispatchCache.set(key, result);
    return result;
  }

  /** A program's own impl method of a standard trait for a type, for the type-directed operations. */
  private userTraitMethod(traitName: string, type: Type, method: string, traitArg?: Type): Dispatch | undefined {
    const trait = this.program.builtinTraits.get(traitName);
    if (!trait) return undefined;
    const t = normalize(shallow(type));
    if (t.kind !== 'adt' || (t.def.module as Module | undefined)?.isStd) return undefined;
    return this.dispatch(trait, t, method, traitArg);
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
    onEnd?: (frame: Frame) => void
  ): Value {
    const { runtime } = this;
    const frame = new Frame(runtime, compiled.info, callRow, typeArgs, captures);
    runtime.pushFrame(frame);
    try {
      compiled.bind(frame, args);
      let result: Value;
      try {
        result = compiled.body(frame);
      } catch (error) {
        if (error instanceof ControlSignal && error.kind === 'return') result = error.value;
        else throw error;
      }
      onEnd?.(frame);
      return result;
    } finally {
      runtime.popFrame();
      if (compiled.info.isAtomic) runtime.steps.completeAtomicCall();
    }
  }

  private callNative(def: FnDef, typeArgs: Type[], args: Value[], span: Span, frame: Frame): Value {
    const key = def.nativeKey ?? `${def.name}`;
    const native = NATIVES[key];
    if (!native) throw new RustPanic(`${key} は、この採点環境では使えません。`, span);
    const context: NativeContext = { interp: this, runtime: this.runtime, frame, span, typeArgs };
    return native(args, context);
  }

  callValue(callee: Value, args: Value[], callRow: number | undefined): Value {
    let fn = callee;
    while (isPlace(fn)) fn = fn.get();
    if (fn instanceof DynValue) fn = fn.value;
    return (fn as FnValue).call(args, callRow);
  }

  makeClosure(compiled: CompiledFn, frame: Frame, captures: Place[], byValue: boolean[]): Value {
    const { typeArgs } = frame;
    const fn = new FnValue(
      (args, callRow) => this.invoke(compiled, typeArgs, args, callRow, captures),
      '{closure}',
      captures
    );
    fn.duplicate = (copy) => {
      const places = captures.map((place, index) => (byValue[index] ? new CellPlace(copy(place.get(), index)) : place));
      return this.makeClosure(compiled, frame, places, byValue) as FnValue;
    };
    return fn;
  }

  toIter(value: Value, from: Type): Value {
    return toIterator(this, value, from);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Constants and conversions

  constValue(def: unknown, frame: Frame): Value {
    if (this.constValues.has(def)) return this.constValues.get(def);
    const constDef = def as { ast: { value?: Expr; name: string }; type: Type };
    const native = NATIVES[`const:${constDef.ast.name}`];
    let value: Value;
    if (!constDef.ast.value) {
      value = native
        ? native([], {
            interp: this,
            runtime: this.runtime,
            frame,
            span: { row: 0, col: 0 },
            typeArgs: [constDef.type],
          })
        : undefined;
    } else {
      let compiled = this.constFns.get(def);
      if (!compiled) {
        const context = {
          name: 'const',
          locals: [],
          slotCount: 0,
          captures: [],
          parent: undefined,
          isClosure: false,
          isAtomic: true,
          isMove: false,
          closureKind: 'Fn' as const,
        };
        compiled = this.compiler.compileConst(constDef.ast.value, context);
        this.constFns.set(def, compiled);
      }
      value = this.invoke(compiled, new Map(), [], undefined, []);
    }
    this.constValues.set(def, value);
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
          return new DynValue(this.program.builtinType('String'), String(value));
        }
        return new DynValue(from, value);
      }
    }
    return this.convertFrom(value, from, to, frame);
  }

  /** `From::from`: the program's impl, or the standard library's conversion. */
  convertFrom(value: Value, from: Type, to: Type, frame: Frame): Value {
    const trait = this.program.traitDef('From');
    const target = normalize(shallow(to));
    for (const impl of this.program.impls) {
      if (impl.trait?.trait !== trait) continue;
      const subst = new Map<TypeParam, Type>();
      if (!matchConcrete(impl.selfType, target, new Set(impl.params), subst)) continue;
      if (!matchConcrete(impl.trait.args[0], from, new Set(impl.params), subst)) continue;
      const fn = impl.methods.get('from');
      if (fn)
        return this.callFn(
          fn,
          impl.params.map((param) => subst.get(param) as Type),
          [value],
          undefined,
          { row: 0, col: 0 },
          frame
        );
    }
    return NATIVES['From::from']([value], {
      interp: this,
      runtime: this.runtime,
      frame,
      span: { row: 0, col: 0 },
      typeArgs: [to, from],
    });
  }

  strSlice(text: string, start: number | undefined, end: number | undefined, span: Span): string {
    return strSliceBytes(text, start, end, span);
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

  private userFmt(trait: 'Display' | 'Debug', type: Type, value: Value, spec: Spec): string | undefined {
    const t = normalize(shallow(type));
    if (t.kind !== 'adt') return undefined;
    const module = t.def.module as Module | undefined;
    if (!module || module.isStd) return undefined;
    const traitDef = this.program.builtinTraits.get(trait);
    if (!traitDef) return undefined;
    const dispatch = this.dispatch(traitDef, t, 'fmt');
    if (!dispatch) return undefined;
    const formatter = new FormatterValue(spec);
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

/** The types of a variant's fields with a generic type's parameters replaced by its arguments. */
export function fieldTypes(def: AdtDef, args: Type[], variant: number): Type[] {
  const fields = def.variants[variant]?.fields ?? [];
  if (def.params.length === 0) return fields.map((field) => field.type);
  const subst = new Map(def.params.map((param, index) => [param, args[index]]));
  return fields.map((field) => substitute(field.type, subst));
}

/** The concrete type and receiver of a trait object's method call. */
function unwrapDyn(receiver: Value): { type: Type; receiver: Value } {
  if (receiver instanceof DynValue) {
    return { type: receiver.type, receiver: receiver.value };
  }
  if (isPlace(receiver)) {
    const inner = receiver.get();
    if (inner instanceof DynValue) {
      if (isPlace(inner.value)) return { type: inner.type, receiver: inner.value };
      return {
        type: inner.type,
        receiver: new AccessorPlace(
          () => (receiver.get() as DynValue).value,
          (value) => receiver.set(new DynValue(inner.type, value))
        ),
      };
    }
    return unwrapDyn(inner);
  }
  throw new Error('A trait object call without a trait object');
}

/** `&s[start..end]` of a string by byte offsets, panicking as Rust does out of bounds or inside a character. */
export function strSliceBytes(text: string, start: number | undefined, end: number | undefined, span: Span): string {
  const bytes = new TextEncoder().encode(text);
  const from = start ?? 0;
  const to = end ?? bytes.length;
  if (to > bytes.length) {
    throw new RustPanic(`end byte index ${to} is out of bounds for string of length ${bytes.length}`, span);
  }
  if (from > bytes.length) {
    throw new RustPanic(`start byte index ${from} is out of bounds for string of length ${bytes.length}`, span);
  }
  if (from > to) throw new RustPanic(`byte range starts at ${from} but ends at ${to}`, span);
  for (const [index, which] of [
    [from, 'start'],
    [to, 'end'],
  ] as const) {
    if (index < bytes.length && (bytes[index] & 0xc0) === 0x80) {
      let charStart = index;
      while (charStart > 0 && (bytes[charStart] & 0xc0) === 0x80) charStart--;
      let charEnd = charStart + 1;
      while (charEnd < bytes.length && (bytes[charEnd] & 0xc0) === 0x80) charEnd++;
      const char = new TextDecoder().decode(bytes.slice(charStart, charEnd));
      throw new RustPanic(
        `${which} byte index ${index} is not a char boundary; it is inside '${char}' (bytes ${charStart}..${charEnd} of string)`,
        span
      );
    }
  }
  return new TextDecoder().decode(bytes.slice(from, to));
}

export { cloneValue, compareValues, valuesEqual, StructValue, EnumValue, UNIT_VALUE };
export type { FunctionInfo, ImplDef };
