import type { IndexRes } from './annotations';
import type { Expr, Span } from './ast';
import { madeString, stringCapacity } from './capacity';
import type { Compiler, Eval, PlaceEval } from './compiler';
import { derefAll, evaluateValues, LocalPlace } from './compilerCommon';
import { dropsBorrowedTemporary } from './compilerTemporaries';
import { floatBits, floatFromBits } from './floatBits';
import { normalize } from './infer';
import { derefOnce } from './methods';
import { type Frame, MOVED, RustPanic } from './runtime';
import { runtimeType } from './runtimeTypes';
import { type DerefKind, intBits, resolve, shallow, substitute, type Type } from './types';
import { decodeUtf8 } from './utf8';
import {
  AccessorPlace,
  CellPlace,
  ElementPlace,
  type MapValue,
  type Place,
  type RangeValue,
  type RawPtr,
  sliceBase,
  sliceGet,
  sliceLength,
  SliceView,
  type StructValue,
  textOf,
  type Value,
} from './values';

type ExprOf<K extends Expr['kind']> = Extract<Expr, { kind: K }>;
type Derefs = DerefKind[];

/** The place a place expression denotes, which assignments and `&mut` borrows write through. */
export function compilePlace(c: Compiler, expr: Expr): PlaceEval {
  const place = directPlace(c, expr);
  if (place) return place;
  const value = c.value(expr);
  return (frame) => new CellPlace(value(frame));
}

function directPlace(c: Compiler, expr: Expr): PlaceEval | undefined {
  switch (expr.kind) {
    case 'path': {
      return pathPlace(c, expr);
    }
    case 'field': {
      return fieldPlace(c, expr);
    }
    case 'index': {
      return indexPlace(c, expr);
    }
    case 'unary': {
      return expr.op === '*' ? derefPlace(c, expr) : undefined;
    }
    default: {
      return undefined;
    }
  }
}

function pathPlace(c: Compiler, expr: ExprOf<'path'>): PlaceEval | undefined {
  const res = c.annotations.paths.get(expr);
  if (res?.kind === 'local') {
    const slot = res.local.slot;
    if (res.local.mode === 'refMut') return (frame) => frame.locals[slot] as Place;
    return (frame) => new LocalPlace(frame, slot);
  }
  if (res?.kind === 'capture') {
    const index = res.index;
    const local = res.local;
    if (local.mode === 'refMut') return (frame) => frame.captures[index].get() as Place;
    return (frame) => frame.captures[index];
  }
  if (res?.kind === 'const' && res.def.ast.isMutable) {
    const def = res.def;
    return (frame) => c.support.staticPlace(def, frame);
  }
  return undefined;
}

function fieldPlace(c: Compiler, expr: ExprOf<'field'>): PlaceEval | undefined {
  const field = c.annotations.fields.get(expr);
  if (!field) return undefined;
  const through = placeThrough(c, expr.operand, field.derefs);
  const base = field.derefs.length === 0 ? (dropsBorrowedTemporary(c, expr.operand, through) as PlaceEval) : through;
  const { index } = field;
  if (field.range) return rangeFieldPlace(base, rangeEndpoint(expr.name));
  const union = unionFields(expr);
  if (union) {
    return (frame) => {
      const fields = (base(frame).get() as StructValue).fields;
      return new AccessorPlace(
        () => readUnionField(fields, union, index, expr.span),
        (value) => {
          // A union's fields share one place, so writing one leaves the others without a value of their own.
          fields.fill(MOVED);
          fields[index] = value;
        }
      );
    };
  }
  return (frame) => {
    const place = base(frame);
    const value = place.get();
    const fields = Array.isArray(value) ? value : (value as StructValue).fields;
    return new ElementPlace(fields, index, temporaryOwner(place));
  };
}

function rangeFieldPlace(base: PlaceEval, endpoint: 'start' | 'end'): PlaceEval {
  return (frame) => {
    const range = base(frame).get() as RangeValue;
    return new AccessorPlace(
      () => range[endpoint],
      (value) => {
        range[endpoint] = value;
      }
    );
  };
}

function rangeEndpoint(name: string): 'start' | 'end' {
  if (name === 'start' || name === 'end') return name;
  throw new Error(`Unknown range endpoint ${name}`);
}

function derefPlace(c: Compiler, expr: ExprOf<'unary'>): PlaceEval {
  const operandType = normalize(shallow(expr.operand.ty!));
  if (operandType.kind === 'adt' && (operandType.def.builtin === 'ConstPtr' || operandType.def.builtin === 'MutPtr')) {
    const operand = c.value(expr.operand);
    return (frame) => pointee(derefAll(operand(frame)) as RawPtr, expr.span);
  }
  if (derefOnce(c.program, operandType)?.kind === 'user') {
    const base = compilePlace(c, expr.operand);
    const call = userDerefCall(c, operandType, true, expr.span);
    return (frame) => call(frame, base(frame)) as Place;
  }
  if (operandType.kind === 'ref' && operandType.mutable) {
    const operand = c.read(expr.operand);
    return (frame) => operand(frame) as Place;
  }
  if (operandType.kind === 'ref') {
    const operand = c.read(expr.operand);
    return (frame) => readOnlyPlace(operand(frame));
  }
  // A Box is its value.
  return compilePlace(c, expr.operand);
}

function indexPlace(c: Compiler, expr: ExprOf<'index'>): PlaceEval {
  const res = c.annotations.indexes.get(expr);
  if (!res) throw new Error('Unresolved index');
  const base = placeThrough(c, expr.operand, res.derefs);
  const index = c.value(expr.index);
  const span = res.overloaded || res.range ? expr.bracketSpan : expr.span;
  if (res.container === 'user') return userIndexCall(c, expr, res, 'IndexMut', 'index_mut', base) as PlaceEval;
  if (res.container === 'map') {
    const read = mapEntryAt(c, expr, index, span);
    return (frame) => new ElementPlace(read(frame), 1);
  }
  if (res.range) {
    if (res.container === 'str') return strRangePlace(c, base, index, span);
    const read = compileIndex(c, expr);
    return (frame) => new CellPlace(read(frame));
  }
  return (frame) => {
    const place = base(frame);
    const container = place.get();
    return frame.runtime.withRoots([container], () => {
      const position = index(frame) as bigint;
      const length = sliceLength(container);
      if (position >= length) throw new RustPanic(indexPanic(res.container, length, position), span);
      const { base: array, start } = sliceBase(container);
      return new ElementPlace(array, start + Number(position), temporaryOwner(place));
    });
  };
}

function strRangePlace(c: Compiler, base: PlaceEval, index: Eval, span: Span): PlaceEval {
  return (frame) => {
    const owner = base(frame);
    const text = textOf(owner);
    const range = index(frame) as RangeValue | undefined;
    const part = c.support.strSlice(text, range, span);
    const offset = Number(range?.sliceStart() ?? 0n);
    const start = offset === 0 ? 0 : decodeUtf8(new TextEncoder().encode(text).subarray(0, offset)).length;
    const end = start + part.length;
    return new AccessorPlace(
      () => textOf(owner).slice(start, end),
      (value) => {
        const whole = textOf(owner);
        const updated = whole.slice(0, start) + textOf(value) + whole.slice(end);
        owner.set(madeString(updated, stringCapacity(owner)));
      }
    );
  };
}

function temporaryOwner(place: Place): CellPlace | ElementPlace | undefined {
  return place instanceof CellPlace || place instanceof ElementPlace ? place : undefined;
}

/** The place an operand reaches through derefs: through `&mut` references and owners (`Box`, `Vec`, `String`). */
export function placeThrough(c: Compiler, operand: Expr, derefs: Derefs): PlaceEval {
  if (derefs.some((step) => step === 'ref')) {
    // Through a shared reference only reads happen, so a place over the value serves.
    const read = valueThrough(c, operand, derefs);
    return (frame) => readOnlyPlace(read(frame));
  }
  const base = compilePlace(c, operand);
  if (!derefs.includes('mutRef') && !derefs.includes('user')) return base;
  const calls = userDerefs(c, operand, derefs, true);
  return (frame) => {
    let place = base(frame);
    for (const [index, step] of derefs.entries()) {
      if (step === 'mutRef') place = place.get() as Place;
      else if (step === 'user') place = calls[index]!(frame, place) as Place;
    }
    return place;
  };
}

/** For each `user` step of derefs, the call of the program's `deref` (or `deref_mut`) on the value it derefs. */
function userDerefs(
  c: Compiler,
  operand: Expr,
  derefs: Derefs,
  mutable: boolean
): (((frame: Frame, value: Value) => Value) | undefined)[] {
  let type = operand.ty!;
  return derefs.map((step) => {
    const self = type;
    type = derefOnce(c.program, type)?.type ?? type;
    return step === 'user' ? userDerefCall(c, self, mutable, operand.span) : undefined;
  });
}

/** Calls the program's `Deref::deref`, or `DerefMut::deref_mut` for a place, on a value of a type. */
export function userDerefCall(
  c: Compiler,
  self: Type,
  mutable: boolean,
  span: Span
): (frame: Frame, value: Value) => Value {
  const fn = c.program.traitDef(mutable ? 'DerefMut' : 'Deref').methods.get(mutable ? 'deref_mut' : 'deref')!;
  const type = runtimeType(normalize(shallow(self)));
  return (frame, value) => c.support.callFn(fn, [type(frame)], [value], undefined, span, frame);
}

/** A place over what `read` gives, for code that only reads it. */
export function readPlace(read: Eval): PlaceEval {
  return (frame) => readOnlyPlace(read(frame));
}

function readOnlyPlace(value: Value): Place {
  return new AccessorPlace(
    () => value,
    () => {}
  );
}

/** An operand's value after derefs, reading through `&mut` references. */
export function valueThrough(c: Compiler, operand: Expr, derefs: Derefs): Eval {
  const read = c.read(operand);
  if (!derefs.includes('mutRef') && !derefs.includes('user')) return read;
  const calls = userDerefs(c, operand, derefs, false);
  return (frame) => {
    let value = read(frame);
    for (const [index, step] of derefs.entries()) {
      if (step === 'mutRef') value = (value as Place).get();
      else if (step === 'user') value = calls[index]!(frame, derefAll(value));
    }
    return value;
  };
}

export function compileField(c: Compiler, expr: ExprOf<'field'>): Eval {
  const field = c.annotations.fields.get(expr);
  if (!field) throw new Error('Unresolved field');
  const through = valueThrough(c, expr.operand, field.derefs);
  // A field of a value no variable holds (`make().0`) leaves that value a temporary, which goes later.
  const base = field.derefs.length === 0 ? dropsBorrowedTemporary(c, expr.operand, through) : through;
  const { index } = field;
  if (field.range) {
    const endpoint = rangeEndpoint(expr.name);
    return (frame) => (base(frame) as RangeValue)[endpoint];
  }
  const union = unionFields(expr);
  if (union) return (frame) => readUnionField((base(frame) as StructValue).fields, union, index, expr.span);
  return (frame) => {
    const owner = base(frame);
    if (Array.isArray(owner)) return owner[index];
    return (owner as StructValue).fields[index];
  };
}

/** The types of the fields of the union a field expression reads, or undefined for a field of another type. */
function unionFields(expr: ExprOf<'field'>): Type[] | undefined {
  let t = normalize(shallow(expr.operand.ty!));
  while (t.kind === 'ref') t = normalize(shallow(t.target));
  if (t.kind !== 'adt' || !t.def.isUnion) return undefined;
  const subst = new Map(t.def.params.map((param, index) => [param, t.args[index]]));
  return t.def.variants[0].fields.map((field) => resolve(substitute(field.type, subst), true));
}

/**
 * A union's field, reading the bits another field wrote as its type where both are numbers of one size (as the
 * union's one place holds them); reading other types differently depends on the target's layout.
 */
function readUnionField(fields: Value[], types: Type[], index: number, span: Span): Value {
  if (fields[index] !== MOVED) return fields[index];
  const written = fields.findIndex((value) => value !== MOVED);
  if (written === -1) throw new RustPanic('共用体のフィールドに値がありません。', span);
  const bits = scalarBits(fields[written], types[written]);
  const value = bits && fromBits(bits.bits, bits.width, types[index]);
  if (value === undefined) {
    throw new RustPanic('共用体の別のフィールドとして読むことは、この採点環境では使えません。', span);
  }
  return value;
}

function scalarBits(value: Value, type: Type): { bits: bigint; width: number } | undefined {
  const t = normalize(shallow(type));
  if (t.kind === 'int') return { bits: BigInt.asUintN(intBits(t.name), value as bigint), width: intBits(t.name) };
  if (t.kind === 'float') {
    const width = t.name === 'f32' ? 32 : 64;
    return { bits: floatBits(value, width), width };
  }
  if (t.kind === 'bool') return { bits: value ? 1n : 0n, width: 8 };
  if (t.kind === 'char') return { bits: BigInt((value as string).codePointAt(0) ?? 0), width: 32 };
  return undefined;
}

function fromBits(bits: bigint, width: number, type: Type): Value | undefined {
  const t = normalize(shallow(type));
  if (t.kind === 'int' && intBits(t.name) === width) {
    return t.name.startsWith('i') ? BigInt.asIntN(width, bits) : bits;
  }
  if (t.kind === 'float' && (t.name === 'f32' ? 32 : 64) === width) return floatFromBits(bits, width as 32 | 64);
  return undefined;
}

export function compileIndex(c: Compiler, expr: ExprOf<'index'>): Eval {
  const res = c.annotations.indexes.get(expr);
  if (!res) throw new Error('Unresolved index');
  const base = valueThrough(c, expr.operand, res.derefs);
  const index = c.value(expr.index);
  if (res.container === 'user') return userIndexCall(c, expr, res, 'Index', 'index', base);
  // A range goes through the `Index` impls, which report their panics at the `[`, as `Vec`'s indexes do.
  const span = res.overloaded || res.range ? expr.bracketSpan : expr.span;
  if (res.container === 'map') {
    const read = mapEntryAt(c, expr, index, span);
    return (frame) => read(frame)[1];
  }
  if (res.range) {
    if (res.container === 'str') return strRangeIndex(c, base, index, span);
    return sliceRangeIndex(placeThrough(c, expr.operand, res.derefs), index, span);
  }
  return (frame) => {
    const container = base(frame);
    return frame.runtime.withRoots([container], () => {
      const position = index(frame) as bigint;
      const length = sliceLength(container);
      if (position >= length) throw new RustPanic(indexPanic(res.container, length, position), span);
      return sliceGet(container, Number(position));
    });
  };
}

/**
 * `x[i]` by the program's `Index` impl, `*x.index(i)`, or, where it is written to, `*x.index_mut(i)`, whose `&mut`
 * result is the place.
 */
function userIndexCall(
  c: Compiler,
  expr: ExprOf<'index'>,
  res: IndexRes,
  traitName: 'Index' | 'IndexMut',
  method: string,
  base: Eval
): Eval {
  const fn = c.program.traitDef(traitName).methods.get(method)!;
  const [self, indexType] = res.implTypes!;
  const typeArgs = [runtimeType(self), runtimeType(indexType)];
  const index = c.value(expr.index);
  const callRow = expr.span.row;
  return (frame) => {
    const values = evaluateValues(frame, [base, index]);
    return c.support.callFn(
      fn,
      typeArgs.map((arg) => arg(frame)),
      values,
      callRow,
      expr.bracketSpan,
      frame
    );
  };
}

function mapEntryAt(c: Compiler, expr: ExprOf<'index'>, index: Eval, span: Span): (frame: Frame) => [Value, Value] {
  const res = c.annotations.indexes.get(expr)!;
  const base = valueThrough(c, expr.operand, res.derefs);
  const keyType = runtimeType(expr.index.ty!);
  return (frame) => {
    const map = base(frame) as MapValue;
    return frame.runtime.withRoots([map], () => {
      const key = index(frame);
      return frame.runtime.withRoots([key], () => {
        const entry = map.entries.get(map.entries.key(keyType(frame), key));
        if (!entry) throw new RustPanic('no entry found for key', span);
        return entry;
      });
    });
  };
}

function strRangeIndex(c: Compiler, base: Eval, index: Eval, span: Span): Eval {
  return (frame) => {
    const container = base(frame);
    return frame.runtime.withRoots([container], () => {
      const range = index(frame) as RangeValue | undefined;
      return c.support.strSlice(textOf(container), range, span);
    });
  };
}

function sliceRangeIndex(base: PlaceEval, index: Eval, span: Span): Eval {
  return (frame) => {
    const place = base(frame);
    const container = place.get();
    return frame.runtime.withRoots([container], () => {
      const range = index(frame) as RangeValue | undefined;
      return sliceRange(container, range, span, temporaryOwner(place));
    });
  };
}

/** `&v[a..b]`: a window on a slice, panicking as Rust does when the range is out of order or bounds. */
export function sliceRange(container: Value, range: RangeValue | undefined, span: Span, owner?: Place): SliceView {
  const length = sliceLength(container);
  const start = range?.sliceStart() ?? 0n;
  const end = range?.sliceEnd() ?? BigInt(length);
  if (start > length) {
    throw new RustPanic(`range start index ${start} out of range for slice of length ${length}`, span);
  }
  if (start > end) throw new RustPanic(`slice index starts at ${start} but ends at ${end}`, span);
  if (end > length) {
    const index = range?.inclusive ? (range.end as bigint) : end;
    throw new RustPanic(`range end index ${index} out of range for slice of length ${length}`, span);
  }
  const { base, start: offset } = sliceBase(container);
  return new SliceView(
    base,
    offset + Number(start),
    offset + Number(end),
    owner ?? (container instanceof SliceView ? container.owner : undefined)
  );
}

/** The message of an index past the end; `VecDeque`'s says less. */
function indexPanic(container: string | undefined, length: number, index: bigint): string {
  if (container === 'vecDeque') return 'out of bounds access';
  return `index out of bounds: the len is ${length} but the index is ${index}`;
}

/** The place a raw pointer points to; following a null pointer panics, as debug builds check. */
export function pointee(pointer: RawPtr, span: Span): Place {
  if (!pointer.place) throw new RustPanic('null pointer dereference occurred', span);
  return pointer.place;
}
