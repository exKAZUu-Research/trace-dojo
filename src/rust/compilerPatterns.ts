import type { LocalVar, PathRes } from './annotations';
import type { Expr, Pattern } from './ast';
import type { Compiler } from './compiler';
import { derefAll, isRefType } from './compilerCommon';
import { normalize } from './infer';
import { copyValue, needsCopy, valuesEqual } from './ops';
import { type Frame, MOVED, UNASSIGNED } from './runtime';
import { runtimeType } from './runtimeTypes';
import { resolve, shallow, type Type } from './types';
import { CellPlace, ElementPlace, type EnumValue, isPlace, type Place, type StructValue, type Value } from './values';

export type Matcher = (frame: Frame, value: Value, place: (() => Place) | undefined) => boolean;

type PatternOf<K extends Pattern['kind']> = Extract<Pattern, { kind: K }>;

/**
 * Matches a value against a pattern, binding its variables when it matches. `place` gives where the value lives, for
 * bindings that bind by mutable reference.
 */
export function compileMatcher(c: Compiler, pattern: Pattern): Matcher {
  const type = resolve(pattern.ty ?? { kind: 'tuple', elems: [] }, true);
  switch (pattern.kind) {
    case 'wild': {
      return () => true;
    }
    case 'binding': {
      return bindingMatcher(c, pattern, type);
    }
    case 'lit': {
      const literal = c.value(pattern.expr);
      const litType = runtimeType(pattern.expr.ty ?? type);
      return (frame, value) => valuesEqual(litType(frame), derefAll(value), literal(frame));
    }
    case 'tuple': {
      return tupleMatcher(c, pattern);
    }
    case 'tupleStruct':
    case 'struct':
    case 'path': {
      return ctorMatcher(c, pattern, type);
    }
    case 'ref': {
      const inner = compileMatcher(c, pattern.pattern);
      return (frame, value) =>
        inner(frame, isPlace(value) ? value.get() : value, isPlace(value) ? () => value : undefined);
    }
    case 'or': {
      const alternatives = pattern.alternatives.map((alt) => compileMatcher(c, alt));
      return (frame, value, place) => alternatives.some((alt) => alt(frame, value, place));
    }
  }
}

function bindingMatcher(c: Compiler, pattern: PatternOf<'binding'>, type: Type): Matcher {
  const res = c.annotations.paths.get(pattern);
  if (res) return constMatcher(c, res, type);
  const local = c.annotations.bindings.get(pattern);
  if (!local) return () => true;
  const sub = pattern.sub ? compileMatcher(c, pattern.sub) : undefined;
  const copies = local.mode === 'move' && needsCopy(resolve(local.type, true)) && c.isCopy(local.type);
  const localType = normalize(shallow(local.type));
  // Match ergonomics on a `&mut` value gives the parts of the value with `&mut` types, which are their places.
  const bindsPlace = local.mode === 'refMut' || (localType.kind === 'ref' && localType.mutable);
  // Binding a part of a variable by value moves it out, leaving the variable without it, as Rust does.
  const movesOut = local.mode === 'move' && localType.kind !== 'ref' && !c.isCopy(local.type);
  return (frame, value, place) => {
    if (sub && !sub(frame, value, place)) return false;
    const bound = boundValue(value, place, local.mode, bindsPlace, copies);
    frame.locals[local.slot] = bound;
    if (movesOut && place) place().set(MOVED);
    return true;
  };
}

function boundValue(
  value: Value,
  place: (() => Place) | undefined,
  mode: LocalVar['mode'],
  bindsPlace: boolean,
  copies: boolean
): Value {
  if (bindsPlace && !(mode === 'move' && isPlace(value))) return place ? place() : new CellPlace(value);
  if (mode === 'ref' && isPlace(value)) return value.get();
  return copies ? copyValue(value) : value;
}

function tupleMatcher(c: Compiler, pattern: PatternOf<'tuple'>): Matcher {
  const elems = pattern.elems.map((elem) => compileMatcher(c, elem));
  return (frame, value, place) => {
    const tuple = derefAll(value) as Value[];
    const tuplePlace = place;
    return elems.every((elem, index) =>
      elem(
        frame,
        tuple[index],
        tuplePlace || isPlace(value) ? () => new ElementPlace(derefAll(value) as Value[], index) : undefined
      )
    );
  };
}

function ctorMatcher(c: Compiler, pattern: PatternOf<'tupleStruct' | 'struct' | 'path'>, type: Type): Matcher {
  const res = c.annotations.paths.get(pattern);
  if (!res) return () => true;
  if (res.kind !== 'ctor') return constMatcher(c, res, type);
  const variant = res.variant;
  const isEnum = res.def.kind === 'enum';
  const subs = fieldMatchers(c, pattern, res);
  return (frame, value, place) => {
    const target = derefAll(value);
    if (isEnum && (target as EnumValue).variant !== variant) return false;
    const fields = (target as StructValue | EnumValue).fields;
    for (const [index, sub] of subs) {
      const fieldPlace = place || isPlace(value) ? () => new ElementPlace(fields, index) : undefined;
      if (!sub(frame, fields[index], fieldPlace)) return false;
    }
    return true;
  };
}

/** The matchers of a constructor pattern's fields, with the indexes of the fields they match. */
function fieldMatchers(
  c: Compiler,
  pattern: PatternOf<'tupleStruct' | 'struct' | 'path'>,
  res: Extract<PathRes, { kind: 'ctor' }>
): [number, Matcher][] {
  const subs: [number, Matcher][] = [];
  if (pattern.kind === 'tupleStruct') {
    for (const [index, elem] of pattern.elems.entries()) subs.push([index, compileMatcher(c, elem)]);
  } else if (pattern.kind === 'struct') {
    const fields = res.def.variants[res.variant].fields;
    for (const field of pattern.fields) {
      subs.push([fields.findIndex((f) => f.name === field.name), compileMatcher(c, field.pattern)]);
    }
  }
  return subs;
}

function constMatcher(c: Compiler, res: PathRes, type: Type): (frame: Frame, value: Value) => boolean {
  if (res.kind === 'ctor') {
    const variant = res.variant;
    if (res.def.kind === 'struct') return () => true;
    return (_frame, value) => (derefAll(value) as EnumValue).variant === variant;
  }
  if (res.kind === 'const') {
    return (frame, value) => valuesEqual(type, derefAll(value), c.support.constValue(res.def, frame));
  }
  return () => true;
}

/**
 * When a pattern moves every part of the variable it matches (`let (a, b) = pair;`, `Some(t) =>`), the variable is
 * moved as a whole and leaves the trace; otherwise it keeps the parts the pattern leaves.
 */
export function takesWhole(c: Compiler, scrutinee: Expr, pattern: Pattern): ((frame: Frame) => void) | undefined {
  if (scrutinee.kind !== 'path' || !movesAll(c, pattern)) return undefined;
  const res = c.annotations.paths.get(scrutinee);
  if (res?.kind !== 'local' || res.local.mode !== 'move' || isRefType(res.local.type)) return undefined;
  const slot = res.local.slot;
  return (frame) => {
    frame.locals[slot] = UNASSIGNED;
  };
}

function movesAll(c: Compiler, pattern: Pattern): boolean {
  switch (pattern.kind) {
    case 'binding': {
      const local = c.annotations.bindings.get(pattern);
      return local !== undefined && local.mode === 'move' && !isRefType(local.type) && !c.isCopy(local.type);
    }
    case 'tuple':
    case 'tupleStruct': {
      return pattern.elems.length > 0 && pattern.elems.every((elem) => movesAll(c, elem));
    }
    case 'struct': {
      const res = c.annotations.paths.get(pattern);
      const count = res?.kind === 'ctor' ? res.def.variants[res.variant].fields.length : -1;
      return pattern.fields.length === count && pattern.fields.every((field) => movesAll(c, field.pattern));
    }
    default: {
      return false;
    }
  }
}
