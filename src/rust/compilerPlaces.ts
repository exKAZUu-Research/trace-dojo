import type { Expr, Span } from './ast';
import type { Compiler, Eval, PlaceEval } from './compiler';
import { LocalPlace } from './compilerCommon';
import { normalize } from './infer';
import { RustPanic } from './runtime';
import { runtimeType } from './runtimeTypes';
import { shallow } from './types';
import {
  AccessorPlace,
  CellPlace,
  ElementPlace,
  type MapValue,
  type Place,
  type RangeValue,
  sliceBase,
  sliceGet,
  sliceLength,
  SliceView,
  type StructValue,
  textOf,
  type Value,
} from './values';

type ExprOf<K extends Expr['kind']> = Extract<Expr, { kind: K }>;
type Derefs = ('ref' | 'mutRef' | 'own')[];

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
  return undefined;
}

function fieldPlace(c: Compiler, expr: ExprOf<'field'>): PlaceEval | undefined {
  const field = c.annotations.fields.get(expr);
  if (!field) return undefined;
  const base = placeThrough(c, expr.operand, field.derefs);
  const { index } = field;
  if (field.range) return rangeFieldPlace(base, index);
  return (frame) => {
    const owner = base(frame).get();
    const fields = Array.isArray(owner) ? owner : (owner as StructValue).fields;
    return new ElementPlace(fields, index);
  };
}

function rangeFieldPlace(base: PlaceEval, index: number): PlaceEval {
  return (frame) => {
    const range = base(frame).get() as RangeValue;
    return new AccessorPlace(
      () => (index === 0 ? range.start : range.end),
      (value) => {
        if (index === 0) range.start = value;
        else range.end = value;
      }
    );
  };
}

function derefPlace(c: Compiler, expr: ExprOf<'unary'>): PlaceEval {
  const operandType = normalize(shallow(expr.operand.ty!));
  if (operandType.kind === 'ref' && operandType.mutable) {
    const operand = c.read(expr.operand);
    return (frame) => operand(frame) as Place;
  }
  if (operandType.kind === 'ref') {
    const operand = c.read(expr.operand);
    return (frame) => new CellPlace(operand(frame));
  }
  // A Box is its value.
  return compilePlace(c, expr.operand);
}

function indexPlace(c: Compiler, expr: ExprOf<'index'>): PlaceEval {
  const res = c.annotations.indexes.get(expr);
  if (!res) throw new Error('Unresolved index');
  const base = placeThrough(c, expr.operand, res.derefs);
  const index = c.value(expr.index);
  const span = res.overloaded ? expr.bracketSpan : expr.span;
  if (res.range) {
    const read = compileIndex(c, expr);
    return (frame) => new CellPlace(read(frame));
  }
  return (frame) => {
    const container = base(frame).get();
    return frame.runtime.withRoots([container], () => {
      const position = index(frame) as bigint;
      const length = sliceLength(container);
      if (position >= length) throw new RustPanic(indexPanic(res.container, length, position), span);
      const { base: array, start } = sliceBase(container);
      return new ElementPlace(array, start + Number(position));
    });
  };
}

/** The place an operand reaches through derefs: through `&mut` references and owners (`Box`, `Vec`, `String`). */
export function placeThrough(c: Compiler, operand: Expr, derefs: Derefs): PlaceEval {
  if (derefs.some((step) => step === 'ref')) {
    // Through a shared reference only reads happen, so a place over the value serves.
    const read = valueThrough(c, operand, derefs);
    return (frame) => new CellPlace(read(frame));
  }
  const base = compilePlace(c, operand);
  if (!derefs.includes('mutRef')) return base;
  return (frame) => {
    let place = base(frame);
    for (const step of derefs) if (step === 'mutRef') place = place.get() as Place;
    return place;
  };
}

/** An operand's value after derefs, reading through `&mut` references. */
export function valueThrough(c: Compiler, operand: Expr, derefs: Derefs): Eval {
  const read = c.read(operand);
  if (!derefs.includes('mutRef')) return read;
  return (frame) => {
    let value = read(frame);
    for (const step of derefs) if (step === 'mutRef') value = (value as Place).get();
    return value;
  };
}

export function compileField(c: Compiler, expr: ExprOf<'field'>): Eval {
  const field = c.annotations.fields.get(expr);
  if (!field) throw new Error('Unresolved field');
  const base = valueThrough(c, expr.operand, field.derefs);
  const { index } = field;
  if (field.range) {
    return (frame) => {
      const range = base(frame) as RangeValue;
      return index === 0 ? range.start : range.end;
    };
  }
  return (frame) => {
    const owner = base(frame);
    if (Array.isArray(owner)) return owner[index];
    return (owner as StructValue).fields[index];
  };
}

export function compileIndex(c: Compiler, expr: ExprOf<'index'>): Eval {
  const res = c.annotations.indexes.get(expr);
  if (!res) throw new Error('Unresolved index');
  const base = valueThrough(c, expr.operand, res.derefs);
  const index = c.value(expr.index);
  // A range goes through the `Index` impls, which report their panics at the `[`, as `Vec`'s indexes do.
  const span = res.overloaded || res.range ? expr.bracketSpan : expr.span;
  if (res.container === 'map') {
    const keyType = runtimeType(expr.index.ty!);
    return (frame) => {
      const map = base(frame) as MapValue;
      return frame.runtime.withRoots([map], () => {
        const key = index(frame);
        const entry = map.entries.get(map.entries.key(keyType(frame), key));
        if (!entry) throw new RustPanic('no entry found for key', span);
        return entry[1];
      });
    };
  }
  if (res.range) return rangeIndex(c, base, index, res.container === 'str', span);
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

function rangeIndex(c: Compiler, base: Eval, index: Eval, isStr: boolean, span: Span): Eval {
  return (frame) => {
    const container = base(frame);
    return frame.runtime.withRoots([container], () => {
      const range = index(frame) as RangeValue | undefined;
      return isStr ? c.support.strSlice(textOf(container), range, span) : sliceRange(container, range, span);
    });
  };
}

/** `&v[a..b]`: a window on a slice, panicking as Rust does when the range is out of order or bounds. */
export function sliceRange(container: Value, range: RangeValue | undefined, span: Span): Value {
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
  return new SliceView(base, offset + Number(start), offset + Number(end));
}

/** The message of an index past the end; `VecDeque`'s says less. */
function indexPanic(container: string | undefined, length: number, index: bigint): string {
  if (container === 'vecDeque') return 'out of bounds access';
  return `index out of bounds: the len is ${length} but the index is ${index}`;
}
