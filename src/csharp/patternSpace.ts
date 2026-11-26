import type { BoundExpression, BoundPattern } from './bound';
import { nullableUnderlying, sameType, specialOf, type SpecialType, type Type } from './types';

/**
 * The values a pattern matches, as a union of atoms, for finding the switch cases and arms that earlier ones already
 * handle (CS8120, CS8510). The analysis must never report a reachable case, so an earlier case counts for the values
 * it surely matches (`under`) and a later one for every value it might match (`over`).
 */
export type Space = Atom[];

type Atom =
  | { kind: 'null' }
  | { kind: 'type'; type: Type; values: ValueSet }
  | { kind: 'tuple'; type: Type; elements: Space[] };

/** The values of one type: all of them, or some numbers, constants, and NaN. */
type ValueSet =
  | 'all'
  | { kind: 'integers'; ranges: [bigint, bigint][] }
  | { kind: 'reals'; ranges: RealRange[]; hasNaN: boolean }
  | { kind: 'constants'; values: (string | boolean)[] };

interface RealRange {
  low: number;
  high: number;
  lowInclusive: boolean;
  highInclusive: boolean;
}

export class PatternSpaces {
  /** `isSubtype(a, b)`: whether every value of type `a` is a value of type `b`, by identity, reference, or boxing. */
  constructor(private readonly isSubtype: (sub: Type, sup: Type) => boolean) {}

  /** Whether the earlier spaces together hold every value that a pattern might match. */
  isSubsumed(earlier: Space, pattern: BoundPattern): boolean {
    return this.over(pattern).every((atom) => this.covers(earlier, atom));
  }

  /** The values a pattern surely matches. */
  under(pattern: BoundPattern): Space {
    switch (pattern.kind) {
      case 'any': {
        return everything(pattern.inputType);
      }
      case 'type': {
        return [{ kind: 'type', type: underlyingOf(pattern.testType), values: 'all' }];
      }
      case 'constant':
      case 'relational': {
        return this.exact(pattern) ?? [];
      }
      case 'or': {
        return [...this.under(pattern.left), ...this.under(pattern.right)];
      }
      case 'and': {
        return this.intersect(this.under(pattern.left), this.under(pattern.right)) ?? [];
      }
      case 'not': {
        return this.complement(this.over(pattern.pattern), pattern.inputType) ?? [];
      }
      case 'recursive': {
        return this.recursiveSpace(pattern, (sub) => this.under(sub)) ?? [];
      }
      case 'list': {
        // Which lengths list patterns together cover is left out, so a list pattern covers no value for sure.
        return [];
      }
    }
  }

  /** The values a pattern might match. */
  over(pattern: BoundPattern): Space {
    switch (pattern.kind) {
      case 'any': {
        return everything(pattern.inputType);
      }
      case 'type': {
        return [{ kind: 'type', type: underlyingOf(pattern.testType), values: 'all' }];
      }
      case 'constant':
      case 'relational': {
        return this.exact(pattern) ?? everything(pattern.inputType);
      }
      case 'or': {
        return [...this.over(pattern.left), ...this.over(pattern.right)];
      }
      case 'and': {
        const left = this.over(pattern.left);
        const right = this.over(pattern.right);
        return this.intersect(left, right) ?? (isEverything(left, pattern.inputType) ? right : left);
      }
      case 'not': {
        return this.complement(this.under(pattern.pattern), pattern.inputType) ?? everything(pattern.inputType);
      }
      case 'recursive': {
        const type = underlyingOf(pattern.testType ?? pattern.narrowedType);
        return this.recursiveSpace(pattern, (sub) => this.over(sub)) ?? [{ kind: 'type', type, values: 'all' }];
      }
      case 'list': {
        return [{ kind: 'type', type: underlyingOf(pattern.inputType), values: 'all' }];
      }
    }
  }

  /** A constant or relational pattern's values, or undefined for one this analysis cannot describe. */
  private exact(pattern: Extract<BoundPattern, { kind: 'constant' | 'relational' }>): Space | undefined {
    const { value } = pattern;
    if (value.kind !== 'constant') return undefined;
    if (pattern.kind === 'constant' && value.value === undefined) return [{ kind: 'null' }];
    const type = underlyingOf(pattern.kind === 'constant' ? pattern.type : value.type);
    const domain = domainOf(type);
    if (!domain) return undefined;
    const values =
      pattern.kind === 'constant' ? valueSetOf(domain, '==', value) : valueSetOf(domain, pattern.operator, value);
    return values ? [{ kind: 'type', type, values }] : undefined;
  }

  /** A recursive pattern's values: its type's, when its subpatterns hold all values, or a tuple's elements'. */
  private recursiveSpace(
    pattern: Extract<BoundPattern, { kind: 'recursive' }>,
    spaceOf: (sub: BoundPattern) => Space
  ): Space | undefined {
    const type = underlyingOf(pattern.testType ?? pattern.narrowedType);
    const isAll = (sub: BoundPattern): boolean => isEverything(spaceOf(sub), sub.inputType);
    const propertiesAll = pattern.properties.every((sub) => isAll(sub.pattern));
    if (pattern.isTuple && propertiesAll && pattern.positional.length > 0)
      return [{ kind: 'tuple', type, elements: pattern.positional.map(spaceOf) }];
    if (!pattern.isITuple && propertiesAll && pattern.positional.every(isAll))
      return [{ kind: 'type', type, values: 'all' }];
    return undefined;
  }

  /** The intersection of two spaces of one type's value sets, or undefined when it is not one of those. */
  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one pair of value sets that intersect simply.
  private intersect(left: Space, right: Space): Space | undefined {
    if (left.length === 1 && right.length === 1) {
      const [a, b] = [left[0], right[0]];
      if (a.kind === 'type' && b.kind === 'type') {
        if (a.values === 'all' && this.isSubtype(b.type, a.type)) return right;
        if (b.values === 'all' && this.isSubtype(a.type, b.type)) return left;
        if (sameType(a.type, b.type) && a.values !== 'all' && b.values !== 'all') {
          const values = intersectValues(a.values, b.values);
          return values ? [{ kind: 'type', type: a.type, values }] : undefined;
        }
      }
    }
    return undefined;
  }

  /** The values of the input type outside a space of one value set of it, or undefined when that is unknown. */
  private complement(space: Space, inputType: Type): Space | undefined {
    const input = underlyingOf(inputType);
    const canBeNull = isNullable(inputType);
    const nonNull = space.filter((atom) => atom.kind !== 'null');
    const hasNull = nonNull.length < space.length;
    const nullPart: Space = canBeNull && !hasNull ? [{ kind: 'null' }] : [];
    if (nonNull.length === 0) return [...nullPart, { kind: 'type', type: input, values: 'all' }];
    if (nonNull.length !== 1) return undefined;
    const [atom] = nonNull;
    if (atom.kind !== 'type' || !sameType(atom.type, input)) return undefined;
    if (atom.values === 'all') return nullPart;
    const domain = domainOf(input);
    const values = domain ? complementValues(domain, atom.values) : undefined;
    return values ? [...nullPart, { kind: 'type', type: input, values }] : undefined;
  }

  /** Whether a space holds every value of an atom. */
  private covers(space: Space, atom: Atom): boolean {
    if (atom.kind === 'null') return space.some((other) => other.kind === 'null');
    const wholeTypes = space.filter(
      (other): other is Extract<Atom, { kind: 'type' }> =>
        other.kind === 'type' && other.values === 'all' && this.isSubtype(atom.type, other.type)
    );
    if (wholeTypes.length > 0) return true;
    if (atom.kind === 'tuple') {
      return space.some(
        (other) =>
          other.kind === 'tuple' &&
          other.elements.length === atom.elements.length &&
          atom.elements.every((element, index) => element.every((part) => this.covers(other.elements[index], part)))
      );
    }
    const values = atom.values === 'all' ? wholeValues(atom.type) : atom.values;
    if (values === 'all') return false;
    const sameTyped = space.filter(
      (other): other is Extract<Atom, { kind: 'type' }> => other.kind === 'type' && sameType(other.type, atom.type)
    );
    return includesValues(
      sameTyped.map((other) => other.values),
      values
    );
  }
}

/**
 * All values of a type as a value set that earlier cases may cover piece by piece, as `< 0` and `>= 0` cover an int
 * and `true` and `false` a bool, or 'all' for a type whose values no union of pieces covers.
 */
function wholeValues(type: Type): ValueSet {
  if (specialOf(type) === 'bool') return { kind: 'constants', values: [true, false] };
  if (domainOf(type)?.kind === 'reals')
    return {
      kind: 'reals',
      ranges: [{ low: -Infinity, high: Infinity, lowInclusive: true, highInclusive: true }],
      hasNaN: true,
    };
  const domain = domainOf(type);
  return domain?.kind === 'integers' ? { kind: 'integers', ranges: [[domain.min, domain.max]] } : 'all';
}

/** The space of every value of a type, with null when the type has it. */
function everything(type: Type): Space {
  const all: Atom = { kind: 'type', type: underlyingOf(type), values: 'all' };
  return isNullable(type) ? [{ kind: 'null' }, all] : [all];
}

function isEverything(space: Space, type: Type): boolean {
  const input = underlyingOf(type);
  const hasAll = space.some((atom) => atom.kind === 'type' && atom.values === 'all' && sameType(atom.type, input));
  return hasAll && (!isNullable(type) || space.some((atom) => atom.kind === 'null'));
}

function underlyingOf(type: Type): Type {
  return nullableUnderlying(type) ?? type;
}

/** Whether a type has null, which a type parameter may unless it is constrained to a value type. */
function isNullable(type: Type): boolean {
  if (nullableUnderlying(type)) return true;
  if (type.kind === 'typeParameter') return !type.symbol.hasValueConstraint;
  return !(type.kind === 'named' && type.symbol.isValueType);
}

type Domain = { kind: 'integers'; min: bigint; max: bigint } | { kind: 'reals' } | { kind: 'constants' };

const INTEGER_RANGES: Partial<Record<SpecialType, [bigint, bigint]>> = {
  sbyte: [-128n, 127n],
  byte: [0n, 255n],
  short: [-32_768n, 32_767n],
  ushort: [0n, 65_535n],
  char: [0n, 65_535n],
  int: [-2_147_483_648n, 2_147_483_647n],
  uint: [0n, 4_294_967_295n],
  long: [-9_223_372_036_854_775_808n, 9_223_372_036_854_775_807n],
  ulong: [0n, 18_446_744_073_709_551_615n],
};

/** How the values of a type are described, or undefined for a type whose values this analysis does not split. */
function domainOf(type: Type): Domain | undefined {
  if (type.kind !== 'named') return undefined;
  const special =
    type.symbol.kind === 'enum'
      ? type.symbol.enumUnderlying
        ? specialOf(type.symbol.enumUnderlying)
        : 'int'
      : specialOf(type);
  const range = special ? INTEGER_RANGES[special] : undefined;
  if (range) return { kind: 'integers', min: range[0], max: range[1] };
  if (special === 'double' || special === 'float') return { kind: 'reals' };
  if (special === 'bool' || special === 'string') return { kind: 'constants' };
  return undefined;
}

function valueSetOf(
  domain: Domain,
  operator: '==' | '<' | '<=' | '>' | '>=',
  value: BoundExpression
): ValueSet | undefined {
  const raw = (value as Extract<BoundExpression, { kind: 'constant' }>).value;
  if (domain.kind === 'constants') {
    if (operator !== '==' || (typeof raw !== 'string' && typeof raw !== 'boolean')) return undefined;
    return { kind: 'constants', values: [raw] };
  }
  if (domain.kind === 'integers') {
    if (typeof raw !== 'number' && typeof raw !== 'bigint') return undefined;
    const number = BigInt(raw);
    const ranges: Record<typeof operator, [bigint, bigint]> = {
      '==': [number, number],
      '<': [domain.min, number - 1n],
      '<=': [domain.min, number],
      '>': [number + 1n, domain.max],
      '>=': [number, domain.max],
    };
    const [low, high] = ranges[operator];
    return { kind: 'integers', ranges: low <= high ? [[low, high]] : [] };
  }
  if (typeof raw !== 'number') return undefined;
  if (Number.isNaN(raw)) return operator === '==' ? { kind: 'reals', ranges: [], hasNaN: true } : realsOf([]);
  const range: Record<typeof operator, RealRange> = {
    '==': { low: raw, high: raw, lowInclusive: true, highInclusive: true },
    '<': { low: -Infinity, high: raw, lowInclusive: true, highInclusive: false },
    '<=': { low: -Infinity, high: raw, lowInclusive: true, highInclusive: true },
    '>': { low: raw, high: Infinity, lowInclusive: false, highInclusive: true },
    '>=': { low: raw, high: Infinity, lowInclusive: true, highInclusive: true },
  };
  return realsOf([range[operator]]);
}

function realsOf(ranges: RealRange[]): ValueSet {
  return { kind: 'reals', ranges, hasNaN: false };
}

function intersectValues(a: Exclude<ValueSet, 'all'>, b: Exclude<ValueSet, 'all'>): ValueSet | undefined {
  if (a.kind === 'integers' && b.kind === 'integers')
    return { kind: 'integers', ranges: pairwise(a.ranges, b.ranges, intersectIntegers) };
  if (a.kind === 'reals' && b.kind === 'reals')
    return { kind: 'reals', ranges: pairwise(a.ranges, b.ranges, intersectReal), hasNaN: a.hasNaN && b.hasNaN };
  return undefined;
}

/** The nonempty intersections of each range of one set with each of another. */
function pairwise<T>(a: T[], b: T[], intersect: (x: T, y: T) => T | undefined): T[] {
  return a.flatMap((x) => b.map((y) => intersect(x, y)).filter((range): range is T => range !== undefined));
}

function intersectIntegers(
  [lowA, highA]: [bigint, bigint],
  [lowB, highB]: [bigint, bigint]
): [bigint, bigint] | undefined {
  const low = lowA > lowB ? lowA : lowB;
  const high = highA < highB ? highA : highB;
  return low <= high ? [low, high] : undefined;
}

function intersectReal(a: RealRange, b: RealRange): RealRange | undefined {
  const [low, lowInclusive] =
    a.low > b.low
      ? [a.low, a.lowInclusive]
      : b.low > a.low
        ? [b.low, b.lowInclusive]
        : [a.low, a.lowInclusive && b.lowInclusive];
  const [high, highInclusive] =
    a.high < b.high
      ? [a.high, a.highInclusive]
      : b.high < a.high
        ? [b.high, b.highInclusive]
        : [a.high, a.highInclusive && b.highInclusive];
  if (low > high || (low === high && !(lowInclusive && highInclusive))) return undefined;
  return { low, high, lowInclusive, highInclusive };
}

function complementValues(domain: Domain, values: Exclude<ValueSet, 'all'>): ValueSet | undefined {
  if (domain.kind !== 'integers' || values.kind !== 'integers') return undefined;
  const ranges: [bigint, bigint][] = [];
  let next = domain.min;
  for (const [low, high] of mergeIntegers(values.ranges)) {
    if (low > next) ranges.push([next, low - 1n]);
    next = high + 1n;
  }
  if (next <= domain.max) ranges.push([next, domain.max]);
  return { kind: 'integers', ranges };
}

/** Whether the union of value sets holds every value of another. */
function includesValues(union: ValueSet[], values: Exclude<ValueSet, 'all'>): boolean {
  if (union.includes('all')) return true;
  const sets = union as Exclude<ValueSet, 'all'>[];
  if (values.kind === 'integers') {
    const merged = mergeIntegers(sets.flatMap((set) => (set.kind === 'integers' ? set.ranges : [])));
    return values.ranges.every(([low, high]) => merged.some(([from, to]) => from <= low && high <= to));
  }
  if (values.kind === 'constants') {
    const known = new Set(sets.flatMap((set) => (set.kind === 'constants' ? set.values : [])));
    return values.values.every((value) => known.has(value));
  }
  const reals = sets.filter((set): set is Extract<ValueSet, { kind: 'reals' }> => set.kind === 'reals');
  if (values.hasNaN && !reals.some((set) => set.hasNaN)) return false;
  const merged = mergeReals(reals.flatMap((set) => set.ranges));
  return values.ranges.every((range) => merged.some((other) => containsReal(other, range)));
}

function mergeIntegers(ranges: [bigint, bigint][]): [bigint, bigint][] {
  const sorted = ranges.toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const merged: [bigint, bigint][] = [];
  for (const [low, high] of sorted) {
    const last = merged.at(-1);
    if (last && low <= last[1] + 1n) last[1] = high > last[1] ? high : last[1];
    else merged.push([low, high]);
  }
  return merged;
}

function mergeReals(ranges: RealRange[]): RealRange[] {
  const sorted = ranges.toSorted((a, b) => a.low - b.low || Number(b.lowInclusive) - Number(a.lowInclusive));
  const merged: RealRange[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    const touches =
      last && (range.low < last.high || (range.low === last.high && (range.lowInclusive || last.highInclusive)));
    if (last && touches) {
      if (range.high > last.high || (range.high === last.high && range.highInclusive)) {
        last.high = range.high;
        last.highInclusive = range.highInclusive;
      }
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function containsReal(outer: RealRange, inner: RealRange): boolean {
  const lowOk = outer.low < inner.low || (outer.low === inner.low && (outer.lowInclusive || !inner.lowInclusive));
  const highOk =
    outer.high > inner.high || (outer.high === inner.high && (outer.highInclusive || !inner.highInclusive));
  return lowOk && highOk;
}
