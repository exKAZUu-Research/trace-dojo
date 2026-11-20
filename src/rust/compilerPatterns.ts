import type { LocalVar, PathRes } from './annotations';
import type { Expr, Pattern } from './ast';
import { claimString, moveString } from './capacity';
import type { Compiler } from './compiler';
import { derefAll, isPlaceExpr, isRefType, LocalPlace } from './compilerCommon';
import { normalize } from './infer';
import { copyValue, needsCopy, valuesEqual } from './ops';
import { type Frame, MOVED } from './runtime';
import { runtimeType } from './runtimeTypes';
import { resolve, shallow, type Type } from './types';
import { CellPlace, ElementPlace, type EnumValue, isPlace, type Place, type StructValue, type Value } from './values';

export type Matcher = (frame: Frame, value: Value, place: (() => Place) | undefined) => boolean;

type PatternProbe = (frame: Frame, value: Value, place: (() => Place) | undefined, bindings: (() => void)[]) => boolean;

type PatternOf<K extends Pattern['kind']> = Extract<Pattern, { kind: K }>;

export function compilePatternInput(c: Compiler, expr: Expr): (frame: Frame) => { value: Value; place: Place } {
  if (expr.kind === 'index' && c.annotations.indexes.get(expr)?.container === 'map') {
    const read = c.read(expr);
    return (frame) => {
      const value = read(frame);
      return { value, place: new CellPlace(value) };
    };
  }
  const place = c.place(expr);
  if (expr.kind === 'path' && isPlaceExpr(expr, c.annotations)) {
    const read = c.read(expr);
    return (frame) => ({ value: read(frame), place: place(frame) });
  }
  return (frame) => {
    const evaluated = place(frame);
    return { value: evaluated.get(), place: evaluated };
  };
}

/**
 * Matches a value against a pattern, binding its variables when it matches. `place` gives where the value lives, for
 * bindings that bind by mutable reference.
 */
export function compileMatcher(c: Compiler, pattern: Pattern): Matcher {
  const probe = compileProbe(c, pattern);
  return (frame, value, place) => {
    const bindings: (() => void)[] = [];
    if (!probe(frame, value, place, bindings)) return false;
    for (const bind of bindings) bind();
    return true;
  };
}

function compileProbe(c: Compiler, pattern: Pattern): PatternProbe {
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
      const inner = compileProbe(c, pattern.pattern);
      return (frame, value, _place, bindings) =>
        inner(frame, isPlace(value) ? value.get() : value, isPlace(value) ? () => value : undefined, bindings);
    }
    case 'or': {
      return orMatcher(c, pattern);
    }
  }
}

function orMatcher(c: Compiler, pattern: PatternOf<'or'>): PatternProbe {
  const alternatives = pattern.alternatives.map((alt) => compileProbe(c, alt));
  return (frame, value, place, bindings) => {
    const count = bindings.length;
    for (const alternative of alternatives) {
      if (alternative(frame, value, place, bindings)) return true;
      bindings.length = count;
    }
    return false;
  };
}

function bindingMatcher(c: Compiler, pattern: PatternOf<'binding'>, type: Type): PatternProbe {
  const res = c.annotations.paths.get(pattern);
  if (res) return constMatcher(c, res, type);
  const local = c.annotations.bindings.get(pattern);
  if (!local) return () => true;
  const sub = pattern.sub ? compileProbe(c, pattern.sub) : undefined;
  const copies = local.mode === 'move' && needsCopy(resolve(local.type, true)) && c.isCopy(local.type);
  const localType = normalize(shallow(local.type));
  // Match ergonomics on a `&mut` value gives the parts of the value with `&mut` types, which are their places.
  const bindsPlace = local.mode === 'refMut' || (localType.kind === 'ref' && localType.mutable);
  // Binding a part of a variable by value moves it out, leaving the variable without it, as Rust does.
  const movesOut = local.mode === 'move' && localType.kind !== 'ref' && !c.isCopy(local.type);
  return (frame, value, place, bindings) => {
    if (sub && !sub(frame, value, place, bindings)) return false;
    bindings.push(() => {
      frame.locals[local.slot] = boundValue(value, place, local.mode, bindsPlace, copies);
      if (!movesOut || !place) return;
      moveBinding(frame, local, place());
    });
    return true;
  };
}

function moveBinding(frame: Frame, local: LocalVar, source: Place): void {
  moveString(source);
  source.set(MOVED);
  claimString(new LocalPlace(frame, local.slot));
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

function tupleMatcher(c: Compiler, pattern: PatternOf<'tuple'>): PatternProbe {
  const elems = pattern.elems.map((elem) => compileProbe(c, elem));
  return (frame, value, place, bindings) => {
    const tuple = derefAll(value) as Value[];
    return elems.every((elem, index) =>
      elem(frame, tuple[index], place || isPlace(value) ? () => new ElementPlace(tuple, index) : undefined, bindings)
    );
  };
}

function ctorMatcher(c: Compiler, pattern: PatternOf<'tupleStruct' | 'struct' | 'path'>, type: Type): PatternProbe {
  const res = c.annotations.paths.get(pattern);
  if (!res) return () => true;
  if (res.kind !== 'ctor') return constMatcher(c, res, type);
  const variant = res.variant;
  const isEnum = res.def.kind === 'enum';
  const subs = fieldMatchers(c, pattern, res);
  return (frame, value, place, bindings) => {
    const target = derefAll(value);
    if (isEnum && (target as EnumValue).variant !== variant) return false;
    const fields = (target as StructValue | EnumValue).fields;
    for (const [index, sub] of subs) {
      const fieldPlace = place || isPlace(value) ? () => new ElementPlace(fields, index) : undefined;
      if (!sub(frame, fields[index], fieldPlace, bindings)) return false;
    }
    return true;
  };
}

/** The matchers of a constructor pattern's fields, with the indexes of the fields they match. */
function fieldMatchers(
  c: Compiler,
  pattern: PatternOf<'tupleStruct' | 'struct' | 'path'>,
  res: Extract<PathRes, { kind: 'ctor' }>
): [number, PatternProbe][] {
  const subs: [number, PatternProbe][] = [];
  if (pattern.kind === 'tupleStruct') {
    for (const [index, elem] of pattern.elems.entries()) subs.push([index, compileProbe(c, elem)]);
  } else if (pattern.kind === 'struct') {
    const fields = res.def.variants[res.variant].fields;
    for (const field of pattern.fields) {
      subs.push([fields.findIndex((f) => f.name === field.name), compileProbe(c, field.pattern)]);
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
    const read = compileConstant(c, res);
    return (frame, value) => valuesEqual(type, derefAll(value), read(frame));
  }
  return () => true;
}

export function compileConstant(c: Compiler, res: Extract<PathRes, { kind: 'const' }>): (frame: Frame) => Value {
  const typeArgs = res.typeArgs.map(runtimeType);
  return (frame) =>
    c.support.constValue(
      res.def,
      frame,
      typeArgs.map((type) => type(frame))
    );
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
    frame.locals[slot] = MOVED;
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
