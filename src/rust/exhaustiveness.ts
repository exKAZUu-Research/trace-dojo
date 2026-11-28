import type { ExecutionBudget } from '../interpreter/limits';
import type { Annotations } from './annotations';
import type { Pattern } from './ast';
import type { Known } from './constLint';
import { normalize } from './infer';
import { intMax, intMin, type IntName, shallow, type Type } from './types';

/**
 * A pattern reduced to what decides matching: a constructor with subpatterns, or anything (a wildcard or binding).
 * Literals of types with infinitely many values are constructors that never cover their type.
 */
type Pat =
  | { kind: 'any' }
  | { kind: 'ctor'; ctor: string; args: Pat[] }
  | { kind: 'or'; alts: Pat[] }
  /** The integers or `char` code points from `lo` to `hi`, both included. */
  | { kind: 'range'; lo: bigint; hi: bigint }
  /** A slice pattern: its leading and trailing elements, with a `..` between them when `variable`. */
  | { kind: 'slice'; prefix: Pat[]; suffix: Pat[]; variable: boolean };

const ANY: Pat = { kind: 'any' };
const EMPTY_RANGE: Pat = { kind: 'ctor', ctor: 'empty', args: [] };

/** Lowers a checked pattern, using the paths the checker resolved to tell variants from bindings. */
// code-gauge-allow functionCognitiveComplexity -- One case per kind of pattern or type.
// code-gauge-allow functionNcss -- One case per kind of pattern or type.
export function lowerPattern(pattern: Pattern, annotations: Annotations): Pat {
  switch (pattern.kind) {
    case 'wild': {
      return ANY;
    }
    case 'binding': {
      const res = annotations.paths.get(pattern);
      if (res?.kind === 'ctor') return { kind: 'ctor', ctor: `v${res.variant}`, args: [] };
      if (res?.kind === 'const') return lowerConstantValue(annotations.constPatterns.get(pattern));
      return pattern.sub ? lowerPattern(pattern.sub, annotations) : ANY;
    }
    case 'lit': {
      const { expr } = pattern;
      if (expr.kind === 'bool') return { kind: 'ctor', ctor: String(expr.value), args: [] };
      if (expr.kind === 'int') return { kind: 'range', lo: expr.value, hi: expr.value };
      if (expr.kind === 'char') return pointRange(expr.value);
      const value = expr.kind === 'float' || expr.kind === 'str' ? String(expr.value) : '';
      return { kind: 'ctor', ctor: `lit:${value}`, args: [] };
    }
    case 'range': {
      return lowerRange(pattern, annotations);
    }
    case 'slice': {
      return lowerSlice(pattern, annotations);
    }
    case 'rest': {
      return ANY;
    }
    case 'tuple': {
      return { kind: 'ctor', ctor: 'tuple', args: pattern.elems.map((elem) => lowerPattern(elem, annotations)) };
    }
    case 'tupleStruct': {
      const res = annotations.paths.get(pattern);
      const variant = res?.kind === 'ctor' ? res.variant : 0;
      return { kind: 'ctor', ctor: `v${variant}`, args: pattern.elems.map((elem) => lowerPattern(elem, annotations)) };
    }
    case 'struct': {
      const res = annotations.paths.get(pattern);
      if (res?.kind !== 'ctor') return ANY;
      const variant = res.def.variants[res.variant];
      const args = variant.fields.map((field) => {
        const sub = pattern.fields.find((f) => f.name === field.name);
        return sub ? lowerPattern(sub.pattern, annotations) : ANY;
      });
      return { kind: 'ctor', ctor: `v${res.variant}`, args };
    }
    case 'path': {
      const res = annotations.paths.get(pattern);
      if (res?.kind === 'ctor') return { kind: 'ctor', ctor: `v${res.variant}`, args: [] };
      if (res?.kind === 'const') return lowerConstantValue(annotations.constPatterns.get(pattern));
      return ANY;
    }
    case 'ref': {
      // References are transparent: types are matched through them.
      return lowerPattern(pattern.pattern, annotations);
    }
    case 'or': {
      return { kind: 'or', alts: pattern.alternatives.map((alt) => lowerPattern(alt, annotations)) };
    }
  }
}

function pointRange(char: string): Pat {
  const code = BigInt(char.codePointAt(0) ?? 0);
  return { kind: 'range', lo: code, hi: code };
}

/** A range pattern over integers or `char`s, or the constructor of a float range, which never covers its type. */
function lowerRange(pattern: Extract<Pattern, { kind: 'range' }>, annotations: Annotations): Pat {
  const type = normalize(shallow(pattern.ty ?? { kind: 'tuple', elems: [] }));
  const domain = rangeDomain(type);
  if (!domain) return { kind: 'ctor', ctor: `range:${pattern.span.row}:${pattern.span.col}`, args: [] };
  const lo = pattern.start ? endValue(pattern.start, annotations) : domain[0][0];
  let hi = pattern.end ? endValue(pattern.end, annotations) : (domain.at(-1) as [bigint, bigint])[1];
  if (lo === undefined || hi === undefined) return { kind: 'ctor', ctor: 'const', args: [] };
  if (pattern.end && !pattern.inclusive) hi -= 1n;
  return lo > hi ? EMPTY_RANGE : { kind: 'range', lo, hi };
}

/** The integer or code point an end of a range pattern stands for. */
export function endValue(end: Pattern, annotations: Annotations): bigint | undefined {
  if (end.kind === 'lit') {
    if (end.expr.kind === 'int') return end.expr.value;
    if (end.expr.kind === 'char') return BigInt(end.expr.value.codePointAt(0) ?? 0);
    return undefined;
  }
  const value = annotations.constPatterns.get(end);
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string' && /^.$/su.test(value)) return BigInt(value.codePointAt(0) ?? 0);
  return undefined;
}

function lowerSlice(pattern: Extract<Pattern, { kind: 'slice' }>, annotations: Annotations): Pat {
  const elems = pattern.elems.map((elem) => lowerPattern(elem, annotations));
  const rest = pattern.restIndex;
  let t = normalize(shallow(pattern.ty ?? { kind: 'tuple', elems: [] }));
  while (t.kind === 'ref') t = normalize(shallow(t.target));
  if (rest === undefined) return { kind: 'slice', prefix: elems, suffix: [], variable: false };
  const prefix = elems.slice(0, rest);
  const suffix = elems.slice(rest + 1);
  if (t.kind === 'array') {
    const fill = Array.from({ length: Math.max(0, t.len - prefix.length - suffix.length) }, () => ANY);
    return { kind: 'slice', prefix: [...prefix, ...fill, ...suffix], suffix: [], variable: false };
  }
  return { kind: 'slice', prefix, suffix, variable: true };
}

/**
 * The values of an integer type or of `char`, as disjoint ranges in order, or undefined for other types. `usize` and
 * `isize` reach one past their `MAX` (and `isize` one below its `MIN`), as rustc treats their ends as open, so only a
 * range pattern without that end covers it.
 */
function rangeDomain(type: Type): [bigint, bigint][] | undefined {
  let t = normalize(shallow(type));
  while (t.kind === 'ref') t = normalize(shallow(t.target));
  if (t.kind === 'int') {
    const [min, max] = [intMin(t.name), intMax(t.name)];
    return [isPointerSized(t.name) ? [min === 0n ? 0n : min - 1n, max + 1n] : [min, max]];
  }
  if (t.kind === 'char') {
    return [
      [0n, 0xd7_ffn],
      [0xe0_00n, 0x10_ff_ffn],
    ];
  }
  return undefined;
}

function lowerConstantValue(value: Known | undefined): Pat {
  if (typeof value === 'bigint') return { kind: 'range', lo: value, hi: value };
  if (typeof value === 'object' && value.ctor) {
    return { kind: 'ctor', ctor: value.ctor, args: [...value.fields.values()].map(lowerConstantValue) };
  }
  const ctor =
    typeof value === 'boolean'
      ? String(value)
      : value === undefined || typeof value === 'object'
        ? 'const'
        : `lit:${value}`;
  return { kind: 'ctor', ctor, args: [] };
}

/** The constructors of a type and their arities, or undefined for types with infinitely many values. */
function constructorsOf(type: Type): { ctor: string; types: Type[] }[] | undefined {
  const t = normalize(shallow(type));
  switch (t.kind) {
    case 'bool': {
      return [
        { ctor: 'true', types: [] },
        { ctor: 'false', types: [] },
      ];
    }
    case 'tuple': {
      return [{ ctor: 'tuple', types: t.elems }];
    }
    case 'ref': {
      // A reference is a value even when what it points to has none (`&Infallible`), as rustc treats it.
      const target = constructorsOf(t.target);
      return target?.length === 0 ? undefined : target;
    }
    case 'adt': {
      // std's enums are matched by their variants, but for the `#[non_exhaustive]` ones, which need a `_` arm.
      const opaque =
        t.def.kind === 'enum' ? NON_EXHAUSTIVE_STD_ENUMS.has(t.def.builtin ?? '') : t.def.builtin !== 'Reverse';
      if (t.def.builtin && opaque) return undefined;
      const subst = new Map(t.def.params.map((param, index) => [param, t.args[index]]));
      return t.def.variants.map((variant) => ({
        ctor: `v${variant.index}`,
        types: variant.fields.map((field) => substituteParams(field.type, subst)),
      }));
    }
    default: {
      return undefined;
    }
  }
}

function substituteParams(type: Type, subst: Map<unknown, Type>): Type {
  const t = shallow(type);
  if (t.kind === 'param') return subst.get(t.param) ?? t;
  if (t.kind === 'tuple') return { kind: 'tuple', elems: t.elems.map((elem) => substituteParams(elem, subst)) };
  if (t.kind === 'ref') return { kind: 'ref', mutable: t.mutable, target: substituteParams(t.target, subst) };
  if (t.kind === 'adt') return { kind: 'adt', def: t.def, args: t.args.map((arg) => substituteParams(arg, subst)) };
  if (t.kind === 'array' || t.kind === 'slice') return { ...t, elem: substituteParams(t.elem, subst) };
  return t;
}

/** Expands or-patterns at the head of a row. */
function expandRow(row: Pat[]): Pat[][] {
  const [head, ...rest] = row;
  if (head?.kind === 'or') return head.alts.flatMap((alt) => expandRow([alt, ...rest]));
  return [row];
}

/** Whether a vector of patterns matches some value that no row matches (Maranget's usefulness). */
// code-gauge-allow functionCognitiveComplexity -- One case per kind of pattern or type.
// code-gauge-allow functionNcss -- One case per kind of pattern or type.
function useful(rows: Pat[][], vector: Pat[], types: Type[], budget: ExecutionBudget, depth = 0): Pat[] | undefined {
  if (depth > 64) return undefined;
  // Or-patterns in several positions multiply the cases to try, so the search counts against the compile limits.
  budget.spend();
  if (vector.length === 0) return rows.length === 0 ? [] : undefined;
  const expanded = rows.flatMap(expandRow);
  const [head, ...rest] = vector;
  const [type, ...restTypes] = types;
  if (head.kind === 'or') {
    for (const alt of head.alts) {
      const witness = useful(expanded, [alt, ...rest], types, budget, depth + 1);
      if (witness) return witness;
    }
    return undefined;
  }
  const domain = rangeDomain(type);
  if (domain && (head.kind === 'range' || head.kind === 'any')) {
    return usefulInRanges(expanded, head, domain, budget, (covered) =>
      useful(covered, rest, restTypes, budget, depth + 1)
    );
  }
  const sliceElem = sliceElementType(type);
  if (sliceElem && (head.kind === 'slice' || head.kind === 'any')) {
    return usefulInSlices(expanded, head, sliceElem, arrayLength(type), rest, restTypes, budget, depth);
  }
  const ctors = constructorsOf(type);
  if (head.kind === 'ctor') {
    const arity = head.args.length;
    const subTypes = ctors?.find((c) => c.ctor === head.ctor)?.types ?? head.args.map(() => type);
    const specialized = specialize(expanded, head.ctor, arity);
    const witness = useful(specialized, [...head.args, ...rest], [...subTypes, ...restTypes], budget, depth + 1);
    return witness && [{ kind: 'ctor', ctor: head.ctor, args: witness.slice(0, arity) }, ...witness.slice(arity)];
  }
  // A wildcard: useful if some constructor is missing from the rows' heads, or useful under one constructor.
  const heads = new Set(expanded.flatMap((row) => (row[0]?.kind === 'ctor' ? [row[0].ctor] : [])));
  if (ctors && ctors.every((c) => heads.has(c.ctor)))
    return usefulUnderSome(expanded, ctors, rest, restTypes, budget, depth);
  const defaults = expanded.filter((row) => row[0]?.kind === 'any').map((row) => row.slice(1));
  const witness = useful(defaults, rest, restTypes, budget, depth + 1);
  if (!witness) return undefined;
  const missing = ctors?.find((c) => !heads.has(c.ctor));
  return [missing ? { kind: 'ctor', ctor: missing.ctor, args: missing.types.map(() => ANY) } : ANY, ...witness];
}

/** Whether a wildcard is useful under one of the constructors, all of which the rows' heads cover. */
function usefulUnderSome(
  rows: Pat[][],
  ctors: NonNullable<ReturnType<typeof constructorsOf>>,
  rest: Pat[],
  restTypes: Type[],
  budget: ExecutionBudget,
  depth: number
): Pat[] | undefined {
  for (const ctor of ctors) {
    const arity = ctor.types.length;
    const specialized = specialize(rows, ctor.ctor, arity);
    const vector = [...ctor.types.map(() => ANY), ...rest];
    const witness = useful(specialized, vector, [...ctor.types, ...restTypes], budget, depth + 1);
    if (witness) return [{ kind: 'ctor', ctor: ctor.ctor, args: witness.slice(0, arity) }, ...witness.slice(arity)];
  }
  return undefined;
}

/**
 * Usefulness over the values of an integer type or `char`: the ends of the rows' ranges split the values into segments
 * that each row covers whole or not at all, and each segment the head covers is a constructor of its own.
 */
function usefulInRanges(
  rows: Pat[][],
  head: Pat,
  domain: [bigint, bigint][],
  budget: ExecutionBudget,
  usefulRest: (rows: Pat[][]) => Pat[] | undefined
): Pat[] | undefined {
  const cuts = rangeCuts(rows);
  for (const [lo, hi] of segments(head, domain, cuts, budget)) {
    const covered = rows.filter(
      ([first]) => first?.kind === 'any' || (first?.kind === 'range' && first.lo <= lo && hi <= first.hi)
    );
    const witness = usefulRest(covered.map((row) => row.slice(1)));
    if (witness) return [head.kind === 'any' && cuts.length === 0 ? ANY : { kind: 'range', lo, hi }, ...witness];
  }
  return undefined;
}

/** Where the rows' ranges start and end (one past their last value), in order. */
function rangeCuts(rows: Pat[][]): bigint[] {
  const cuts = new Set<bigint>();
  for (const [first] of rows) {
    if (first?.kind !== 'range') continue;
    cuts.add(first.lo);
    cuts.add(first.hi + 1n);
  }
  return [...cuts].toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The segments of the domain that the head covers, split at the cuts. */
function* segments(
  head: Pat,
  domain: [bigint, bigint][],
  cuts: bigint[],
  budget: ExecutionBudget
): Generator<[bigint, bigint]> {
  for (const [domainLo, domainHi] of domain) {
    let lo = head.kind === 'range' && head.lo > domainLo ? head.lo : domainLo;
    const hi = head.kind === 'range' && head.hi < domainHi ? head.hi : domainHi;
    while (lo <= hi) {
      budget.spend();
      const next = cuts.find((cut) => cut > lo && cut <= hi);
      const segmentHi = next === undefined ? hi : next - 1n;
      yield [lo, segmentHi];
      lo = segmentHi + 1n;
    }
  }
}

function arrayLength(type: Type): number | undefined {
  let t = normalize(shallow(type));
  while (t.kind === 'ref') t = normalize(shallow(t.target));
  return t.kind === 'array' ? t.len : undefined;
}

function sliceElementType(type: Type): Type | undefined {
  let t = normalize(shallow(type));
  while (t.kind === 'ref') t = normalize(shallow(t.target));
  return t.kind === 'slice' || t.kind === 'array' ? t.elem : undefined;
}

/**
 * Usefulness over slices: each length up to the longest fixed pattern, and every longer length together, is a
 * constructor whose arguments are the elements; a pattern with `..` matches each length it fits in.
 */
// code-gauge-allow functionCognitiveComplexity -- Enumerates the lengths that tell the slice patterns apart.
// code-gauge-allow functionNcss -- Splits slice patterns by length as rustc exhaustiveness does.
// code-gauge-allow functionParameterCount -- Splits slice patterns by length as rustc exhaustiveness does.
function usefulInSlices(
  rows: Pat[][],
  head: Pat,
  elem: Type,
  fixedLength: number | undefined,
  rest: Pat[],
  restTypes: Type[],
  budget: ExecutionBudget,
  depth: number
): Pat[] | undefined {
  let longest = 0;
  for (const pattern of [head, ...rows.map((row) => row[0])]) {
    if (pattern?.kind !== 'slice') continue;
    const length = pattern.prefix.length + pattern.suffix.length;
    longest = Math.max(longest, pattern.variable ? length : length + 1);
  }
  const lengths: { length: number; orLonger: boolean }[] = [];
  if (fixedLength !== undefined) {
    lengths.push({ length: fixedLength, orLonger: false });
  } else if (head.kind === 'slice' && !head.variable) {
    lengths.push({ length: head.prefix.length, orLonger: false });
  } else {
    const first = head.kind === 'slice' ? head.prefix.length + head.suffix.length : 0;
    for (let length = first; length < longest; length++) lengths.push({ length, orLonger: false });
    lengths.push({ length: Math.max(longest, first), orLonger: true });
  }
  for (const { length, orLonger } of lengths) {
    const fits = (pattern: Extract<Pat, { kind: 'slice' }>): boolean =>
      pattern.variable
        ? pattern.prefix.length + pattern.suffix.length <= length
        : !orLonger && pattern.prefix.length === length;
    const elements = (pattern: Pat): Pat[] => {
      if (pattern.kind !== 'slice') return Array.from({ length }, () => ANY);
      const fill = Array.from({ length: length - pattern.prefix.length - pattern.suffix.length }, () => ANY);
      return [...pattern.prefix, ...fill, ...pattern.suffix];
    };
    const specialized = rows.flatMap((row) => {
      const first = row[0];
      if (first?.kind === 'any' || (first?.kind === 'slice' && fits(first)))
        return [[...elements(first), ...row.slice(1)]];
      return [];
    });
    const elemTypes = Array.from({ length }, () => elem);
    const witness = useful(specialized, [...elements(head), ...rest], [...elemTypes, ...restTypes], budget, depth + 1);
    if (witness) {
      const args = witness.slice(0, length);
      return [{ kind: 'slice', prefix: args, suffix: [], variable: orLonger }, ...witness.slice(length)];
    }
  }
  return undefined;
}

function specialize(rows: Pat[][], ctor: string, arity: number): Pat[][] {
  const result: Pat[][] = [];
  for (const row of rows) {
    const [head, ...rest] = row;
    if (head.kind === 'any') result.push([...Array.from({ length: arity }, () => ANY), ...rest]);
    else if (head.kind === 'ctor' && head.ctor === ctor) result.push([...head.args, ...rest]);
  }
  return result;
}

/** A pattern no arm matches, described for a message, or undefined when the arms cover every value. */
export function missingPattern(patterns: Pat[], type: Type, budget: ExecutionBudget): string | undefined {
  const witness = useful(
    patterns.map((pattern) => [pattern]),
    [ANY],
    [type],
    budget
  );
  if (!witness) return undefined;
  return describe(witness[0], type);
}

/** Whether a pattern matches every value of its type, as `let` requires. */
export function isIrrefutable(pattern: Pat, type: Type, budget: ExecutionBudget): boolean {
  return missingPattern([pattern], type, budget) === undefined;
}

// code-gauge-allow functionCognitiveComplexity -- One case per kind of pattern in a missing-pattern message.
function describe(pattern: Pat, type: Type): string {
  let t = normalize(shallow(type));
  while (t.kind === 'ref') t = normalize(shallow(t.target));
  if (pattern.kind === 'range') return describeRange(pattern, t);
  if (pattern.kind === 'slice') {
    const elem = sliceElementType(t) ?? t;
    const parts = pattern.prefix.map((part) => describe(part, elem));
    return `[${[...parts, ...(pattern.variable ? ['..'] : [])].join(', ')}]`;
  }
  if (pattern.kind !== 'ctor') return '_';
  if (pattern.ctor === 'true' || pattern.ctor === 'false') return pattern.ctor;
  const ctors = constructorsOf(t);
  const types = ctors?.find((c) => c.ctor === pattern.ctor)?.types ?? [];
  const args = pattern.args.map((arg, index) => describe(arg, types[index] ?? t));
  if (pattern.ctor === 'tuple') return `(${args.join(', ')})`;
  if (pattern.ctor === 'ref') return `&${args[0]}`;
  if (t.kind === 'adt' && pattern.ctor.startsWith('v')) {
    const variant = t.def.variants[Number(pattern.ctor.slice(1))];
    const name =
      t.def.kind === 'enum' && !['Option', 'Result'].includes(t.def.builtin ?? '')
        ? `${t.def.name}::${variant.name}`
        : variant.name;
    if (variant.shape === 'tuple') return `${name}(${args.join(', ')})`;
    if (variant.shape === 'named') return `${name} { .. }`;
    return name;
  }
  return '_';
}

function describeRange(pattern: Extract<Pat, { kind: 'range' }>, type: Type): string {
  const show = (value: bigint): string => {
    if (type.kind === 'char') return `'${String.fromCodePoint(Number(value))}'`;
    if (type.kind === 'int' && value === intMin(type.name)) return `${type.name}::MIN`;
    if (type.kind === 'int' && value === intMax(type.name)) return `${type.name}::MAX`;
    return `${value}_${type.kind === 'int' ? type.name : ''}`;
  };
  const open = type.kind === 'int' && isPointerSized(type.name) ? openEnded(pattern, type.name, show) : undefined;
  if (open) return open;
  if (pattern.lo === pattern.hi) return show(pattern.lo);
  return `${show(pattern.lo)}..=${show(pattern.hi)}`;
}

/** A range of `usize` or `isize` that reaches past `MAX` or below `MIN`, shown as open: `6_usize..`, `..isize::MIN`. */
function openEnded(
  pattern: Extract<Pat, { kind: 'range' }>,
  name: IntName,
  show: (value: bigint) => string
): string | undefined {
  const [min, max] = [intMin(name), intMax(name)];
  if (pattern.hi > max) return `${show(pattern.lo > max ? max : pattern.lo)}..`;
  if (pattern.lo < min) return pattern.hi < min ? `..${show(min)}` : `..=${show(pattern.hi)}`;
  return undefined;
}

function isPointerSized(name: string): boolean {
  return name === 'usize' || name === 'isize';
}

const NON_EXHAUSTIVE_STD_ENUMS = new Set(['IoErrorKind', 'IntErrorKind']);
