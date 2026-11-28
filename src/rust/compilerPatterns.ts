import type { LocalVar, PathRes } from './annotations';
import type { Expr, Pattern } from './ast';
import { patternBindingParts } from './astWalk';
import type { Compiler } from './compiler';
import { derefAll, isPlaceExpr, isRefType, stripRefs } from './compilerCommon';
import { holdTemporary } from './compilerTemporaries';
import { normalize } from './infer';
import { projectedBindings } from './loanCaptures';
import { derefOnce } from './methods';
import { compareValues, copyValue, needsCopy, valuesEqual } from './ops';
import { type Frame, MOVED } from './runtime';
import { runtimeType } from './runtimeTypes';
import { resolve, shallow, type Type } from './types';
import {
  CellPlace,
  ElementPlace,
  type EnumValue,
  isPlace,
  type Place,
  sliceBase,
  sliceLength,
  SliceView,
  type StructValue,
  type Value,
} from './values';

export type Matcher = (frame: Frame, value: Value, place: (() => Place) | undefined) => boolean;

/** A step of binding a pattern's variables; `movesOut` marks one that leaves a moved part in the matched value. */
type Binding = (() => void) & { movesOut?: boolean };

type PatternProbe = (frame: Frame, value: Value, place: (() => Place) | undefined, bindings: Binding[]) => boolean;

type PatternOf<K extends Pattern['kind']> = Extract<Pattern, { kind: K }>;

/**
 * The value a pattern matches and the place it lives in. A `*` or an index through the program's `Deref` or `Index`
 * reaches it through `deref` or `index`, as rustc does, unless a pattern binds part of it by `ref mut`.
 */
export function compilePatternInput(
  c: Compiler,
  expr: Expr,
  patterns: Pattern[]
): (frame: Frame) => { value: Value; place: Place } {
  const overloaded = readsThroughUserImpl(c, expr) && !patterns.some((pattern) => bindsByRefMut(c, pattern));
  if (overloaded || (expr.kind === 'index' && c.annotations.indexes.get(expr)?.container === 'map')) {
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
  // A value that no variable holds is a temporary, which goes with what the patterns leave of it.
  const dropped = isPlaceExpr(expr, c.annotations) ? undefined : c.droppedType(expr.ty);
  return (frame) => {
    const evaluated = place(frame);
    if (dropped) holdTemporary(frame, evaluated, dropped(frame));
    return { value: evaluated.get(), place: evaluated };
  };
}

/**
 * Whether a place is reached through the program's `Deref` or `Index`, where reading it calls `deref` or `index` and
 * only writing it calls `deref_mut` or `index_mut`.
 */
export function readsThroughUserImpl(c: Compiler, expr: Expr): boolean {
  for (let part = expr; part.kind === 'index' || part.kind === 'field' || part.kind === 'unary'; part = part.operand) {
    if (part.kind === 'unary' && part.op !== '*') return false;
    if (stepsThroughUserImpl(c, part)) return true;
  }
  return false;
}

function stepsThroughUserImpl(c: Compiler, part: Extract<Expr, { kind: 'index' | 'field' | 'unary' }>): boolean {
  if (part.kind === 'index') {
    const index = c.annotations.indexes.get(part);
    return index?.container === 'user' || index?.derefs.includes('user') === true;
  }
  if (part.kind === 'field') return c.annotations.fields.get(part)?.derefs.includes('user') === true;
  return derefOnce(c.program, normalize(shallow(part.operand.ty!)))?.kind === 'user';
}

function bindsByRefMut(c: Compiler, pattern: Pattern): boolean {
  return patternBindingParts(pattern, c.annotations).some(({ local, refMut }) => refMut || local.mode === 'refMut');
}

/**
 * Matches a value against a pattern, binding its variables when it matches. `place` gives where the value lives, for
 * bindings that bind by mutable reference.
 */
export function compileMatcher(c: Compiler, pattern: Pattern): Matcher {
  const matcher = compileGuardedMatcher(c, pattern);
  return (frame, value, place) => {
    const moveOut = matcher(frame, value, place);
    moveOut?.();
    return moveOut !== undefined;
  };
}

/**
 * Matches a value against a pattern as {@link compileMatcher} does, but leaves the parts that bindings move out of the
 * value in place until the returned function runs, as a match arm's guard sees them before the arm takes them.
 */
export function compileGuardedMatcher(
  c: Compiler,
  pattern: Pattern
): (frame: Frame, value: Value, place: (() => Place) | undefined) => (() => void) | undefined {
  const probe = compileProbe(c, pattern);
  return (frame, value, place) => {
    const bindings: Binding[] = [];
    if (!probe(frame, value, place, bindings)) return;
    for (const bind of bindings) if (!bind.movesOut) bind();
    return () => {
      for (const bind of bindings) if (bind.movesOut) bind();
    };
  };
}

function compileProbe(c: Compiler, pattern: Pattern): PatternProbe {
  if (projectedBindings(pattern, c.annotations)?.length === 0) return () => true;
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
    case 'range': {
      return rangeMatcher(c, pattern, type);
    }
    case 'slice': {
      return sliceMatcher(c, pattern);
    }
    case 'rest': {
      return () => true;
    }
  }
}

// code-gauge-allow functionCognitiveComplexity -- Compares both ends of a range pattern.
function rangeMatcher(c: Compiler, pattern: PatternOf<'range'>, type: Type): PatternProbe {
  const endValue = (end: Pattern | undefined): ((frame: Frame) => Value) | undefined => {
    if (!end) return undefined;
    if (end.kind === 'lit') return c.value(end.expr);
    const res = c.annotations.paths.get(end);
    if (res?.kind === 'builtinConst') {
      const value = c.support.builtinConst(res.name);
      return () => value;
    }
    return res?.kind === 'const' ? compileConstant(c, res) : undefined;
  };
  const start = endValue(pattern.start);
  const end = endValue(pattern.end);
  const valueType = stripRefs(type);
  const inclusive = pattern.inclusive;
  return (frame, value) => {
    const target = derefAll(value);
    if (start && !((compareValues(valueType, start(frame), target, true) ?? 1) <= 0)) return false;
    if (!end) return true;
    const order = compareValues(valueType, target, end(frame), true);
    return order !== undefined && (inclusive ? order <= 0 : order < 0);
  };
}

// code-gauge-allow functionCognitiveComplexity -- Matches elements before and after the rest element.
function sliceMatcher(c: Compiler, pattern: PatternOf<'slice'>): PatternProbe {
  const rest = pattern.restIndex;
  const elems = pattern.elems.map((elem, index) => (index === rest ? undefined : compileProbe(c, elem)));
  const fixed = pattern.elems.length - (rest === undefined ? 0 : 1);
  const restBinder = rest === undefined ? undefined : compileRestBinder(c, pattern.elems[rest]);
  // An element after the `..` counts from the end.
  const offsetOf = (index: number, after: number): number =>
    rest !== undefined && index > rest ? index - 1 + after : index;
  return (frame, value, place, bindings) => {
    const target = derefAll(value);
    const { base, start } = sliceBase(target);
    const length = sliceLength(target);
    if (rest === undefined ? length !== fixed : length < fixed) return false;
    const after = length - fixed;
    for (const [index, elem] of elems.entries()) {
      const position = start + offsetOf(index, after);
      const elemPlace = place || isPlace(value) ? () => new ElementPlace(base, position) : undefined;
      if (elem && !elem(frame, base[position], elemPlace, bindings)) return false;
    }
    const from = start + (rest ?? 0);
    restBinder?.(frame, target, from, from + after, place !== undefined || isPlace(value), bindings);
    return true;
  };
}

type RestBinder = (
  frame: Frame,
  target: Value,
  from: number,
  to: number,
  hasPlace: boolean,
  bindings: Binding[]
) => void;

/** Binds `rest @ ..` to the elements from `from` to `to`, moving them out of an array it takes by value. */
function compileRestBinder(c: Compiler, restBinding: Pattern): RestBinder | undefined {
  const restLocal = c.annotations.bindings.get(restBinding);
  if (!restLocal) return undefined;
  const restType = normalize(shallow(restLocal.type));
  const restMode = restType.kind !== 'ref' ? 'value' : restType.mutable ? 'mut' : 'ref';
  const movesOut = restMode === 'value' && !c.isCopy(restLocal.type);
  return (frame, target, from, to, hasPlace, bindings) => {
    const { base } = sliceBase(target);
    bindings.push(() => (frame.locals[restLocal.slot] = sliceRest(target, base, from, to, restMode)));
    if (movesOut && hasPlace) bindings.push(movingOut(base, from, to));
  };
}

function movingOut(base: Value[], from: number, to: number): (() => void) & { movesOut: true } {
  const moveOut = (): void => {
    base.fill(MOVED, from, to);
  };
  return Object.assign(moveOut, { movesOut: true as const });
}

/**
 * What `rest @ ..` binds: a view of the elements, the place of that view for a `&mut [T]` (as `&mut v[a..b]` makes),
 * or for a pattern on an array by value, an array of them.
 */
function sliceRest(target: Value, base: Value[], from: number, to: number, mode: 'value' | 'ref' | 'mut'): Value {
  if (mode === 'value') return base.slice(from, to);
  const view = new SliceView(base, from, to, target instanceof SliceView ? target.owner : undefined);
  return mode === 'mut' ? new CellPlace(view) : view;
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
  // An explicit `ref mut` borrows what it matches, even a value that is itself a reference.
  const mode = pattern.byRef === 'refMut' ? 'refMut' : local.mode;
  // Match ergonomics on a `&mut` value gives the parts of the value with `&mut` types, which are their places.
  const bindsPlace = mode === 'refMut' || (localType.kind === 'ref' && localType.mutable);
  // Binding a part of a variable by value moves it out, leaving the variable without it, as Rust does.
  const movesOut = local.mode === 'move' && localType.kind !== 'ref' && !c.isCopy(local.type);
  return (frame, value, place, bindings) => {
    if (sub && !sub(frame, value, place, bindings)) return false;
    bindings.push(() => {
      frame.locals[local.slot] = boundValue(value, place, mode, bindsPlace, copies);
    });
    if (movesOut && place) bindings.push(Object.assign(() => place().set(MOVED), { movesOut: true }));
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
  if (res.kind === 'builtinConst') {
    const constant = c.support.builtinConst(res.name);
    return (_frame, value) => valuesEqual(type, derefAll(value), constant);
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
