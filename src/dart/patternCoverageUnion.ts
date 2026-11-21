import type { Pattern } from './ast';
import { nullPatternComparison } from './astWalk';
import type { PatternCompiler } from './patternCompiler';
import {
  coreTypes,
  type DartType,
  DYNAMIC,
  interfaceType,
  isSubtype,
  makeNullable,
  nonNullable,
  sameType,
} from './types';

type ListPattern = Extract<Pattern, { kind: 'list' }>;
interface ListArm {
  list: ListPattern;
  nullable: boolean;
  properties: readonly Pattern[];
}

const listShapes = new WeakSet<ListPattern>();
const listIntersections = new WeakMap<Pattern, ListArm>();
const MAX_INTERSECTION_PAIRS = 256;
const UNKNOWN_INTERSECTION = Symbol('unknown intersection');
type Intersection = Pattern | typeof UNKNOWN_INTERSECTION | undefined;

export function isCoverageListShape(pattern: ListPattern): boolean {
  return listShapes.has(pattern);
}

export function coverageDisjuncts(compiler: PatternCompiler, pattern: Pattern): readonly Pattern[] | undefined {
  if (!hasCoverageAlternatives(pattern.kind)) return undefined;
  let arms = compiler.coverageUnions.get(pattern);
  if (!arms) {
    arms = normalize(compiler, pattern, undefined);
    compiler.coverageUnions.set(pattern, arms);
  }
  return arms.length === 1 && arms[0] === pattern ? undefined : arms;
}

function hasCoverageAlternatives(kind: Pattern['kind']): boolean {
  return kind === 'or' || kind === 'and' || kind === 'nullCheck' || kind === 'nullAssert';
}

function normalize(
  compiler: PatternCompiler,
  pattern: Pattern,
  check: Extract<Pattern, { kind: 'nullCheck' }> | undefined
): readonly Pattern[] {
  switch (pattern.kind) {
    case 'parenthesized': {
      return normalize(compiler, pattern.pattern, check);
    }
    case 'or': {
      const left = normalize(compiler, pattern.left, check);
      const right = normalize(compiler, pattern.right, check);
      return union(compiler, [...left, ...right]);
    }
    case 'and': {
      if (listIntersections.has(pattern)) return [pattern];
      const parts = intersection(compiler, pattern, check);
      if (parts) return parts;
      break;
    }
    case 'nullCheck': {
      const arms = normalize(compiler, pattern.pattern, pattern);
      return arms.some(listArm) ? arms : [pattern];
    }
    case 'nullAssert': {
      if (listArm(pattern)) return [pattern];
      const nonNull = { ...pattern, kind: 'nullCheck' as const };
      const arms = normalize(compiler, pattern.pattern, nonNull);
      if (!arms.some(listArm)) break;
      const { row, column, start, end } = pattern;
      const span = { row, column, start, end };
      return union(compiler, [...arms, { ...span, kind: 'constant', value: { ...span, kind: 'null' } }]);
    }
    case 'list':
    case 'object': {
      return [pattern];
    }
    default: {
      break;
    }
  }
  return [check ? { ...check, pattern } : pattern];
}

function union(compiler: PatternCompiler, arms: readonly Pattern[]): readonly Pattern[] {
  const restrictions = new Map<number, DartType[]>();
  let nullSpace: Pattern | undefined;
  const spaces: Pattern[] = [];
  for (const arm of arms) {
    const list = listArm(arm);
    if (list) {
      if (list.properties.length > 0 || addListRestriction(compiler, restrictions, list)) spaces.push(arm);
    } else if (nullPatternComparison(arm) === '==') {
      nullSpace ??= arm;
    } else {
      spaces.push(arm);
    }
  }
  if (!nullSpace) return spaces;
  const only = spaces.length === 1 ? listArm(spaces[0]) : undefined;
  if (!only || only.properties.length > 0) return [...spaces, nullSpace];
  if (only.nullable) return spaces;

  // Dart 3.13.7 collapses a list and null into one nullable restriction without list-position properties.
  return [listWithProperties(compiler, { ...only, nullable: true }, [])];
}

function listArm(pattern: Pattern): ListArm | undefined {
  if (pattern.kind === 'list') return { list: pattern, nullable: false, properties: [] };
  if (pattern.kind === 'nullAssert' && pattern.pattern.kind === 'list' && isCoverageListShape(pattern.pattern)) {
    return { list: pattern.pattern, nullable: true, properties: [] };
  }
  return listIntersections.get(pattern);
}

function addListRestriction(
  compiler: PatternCompiler,
  restrictions: Map<number, DartType[]>,
  { list, nullable }: ListArm
): boolean {
  const { hasRest, size } = listLengthRestriction(list);
  const key = 4 * size + 2 * Number(hasRest) + Number(nullable);
  const elementType = elementTypeOf(compiler, list);
  // SingleSpace equality omits indexed and rest properties, but distinguishes nullable restrictions.
  const types = restrictions.get(key) ?? [];
  if (types.some((type) => sameType(type, elementType))) return false;
  types.push(elementType);
  restrictions.set(key, types);
  return true;
}

function intersection(
  compiler: PatternCompiler,
  pattern: Extract<Pattern, { kind: 'and' }>,
  check: Extract<Pattern, { kind: 'nullCheck' }> | undefined
): readonly Pattern[] | undefined {
  const left = normalize(compiler, pattern.left, check);
  const right = normalize(compiler, pattern.right, check);
  if ((!left.some(listArm) && !right.some(listArm)) || left.length * right.length > MAX_INTERSECTION_PAIRS)
    return undefined;
  const parts: Pattern[] = [];
  let unknown = false;
  for (const a of left) {
    for (const b of right) {
      const part = intersectListPair(compiler, a, b);
      if (part === undefined) return undefined;
      if (part === UNKNOWN_INTERSECTION) unknown = true;
      else parts.push(part);
    }
  }
  if (unknown) parts.push({ ...pattern, kind: 'assignedVariable', name: '_' });
  return union(compiler, parts);
}

function intersectListPair(compiler: PatternCompiler, a: Pattern, b: Pattern): Intersection {
  const left = listArm(a);
  const right = listArm(b);
  if (left && right) {
    const narrowed = listRestrictionSubtype(compiler, left, right)
      ? left
      : listRestrictionSubtype(compiler, right, left)
        ? right
        : undefined;
    return narrowed
      ? listWithProperties(compiler, narrowed, [...left.properties, ...right.properties])
      : UNKNOWN_INTERSECTION;
  }
  if (left) return intersectListType(compiler, left, b);
  if (right) return intersectListType(compiler, right, a);
  if (nullPatternComparison(a) === '==' && nullPatternComparison(b) === '==') return a;
  return undefined;
}

function intersectListType(compiler: PatternCompiler, list: ListArm, other: Pattern): Intersection {
  if (nullPatternComparison(other) === '==') return list.nullable ? other : UNKNOWN_INTERSECTION;
  const type = constraintType(compiler, other);
  if (!type) return undefined;
  const subject = restrictedListType(compiler, list);
  if (!isSubtype(subject, type)) {
    const { hasRest, size } = listLengthRestriction(list.list);
    return hasRest && size === 0 && list.properties.length === 0 && isSubtype(type, subject)
      ? other
      : UNKNOWN_INTERSECTION;
  }
  const properties = other.kind === 'object' && other.fields.length > 0 ? [...list.properties, other] : list.properties;
  return listWithProperties(compiler, list, properties);
}

function constraintType(compiler: PatternCompiler, pattern: Pattern): DartType | undefined {
  switch (pattern.kind) {
    case 'variable':
    case 'wildcard': {
      return pattern.type ? compiler.resolveType(pattern.type) : DYNAMIC;
    }
    case 'object': {
      return compiler.objectPatternTypes.get(pattern) ?? compiler.resolveType(pattern.type);
    }
    case 'nullCheck': {
      const type = constraintType(compiler, pattern.pattern);
      return type && nonNullable(type);
    }
    default: {
      return undefined;
    }
  }
}

function listWithProperties(
  compiler: PatternCompiler,
  { list, nullable }: ListArm,
  properties: readonly Pattern[]
): Pattern {
  // Dart 3.13.7 keeps ordinary property constraints when intersecting and discards list-position properties.
  const shape = isCoverageListShape(list) ? list : { ...list };
  listShapes.add(shape);
  compiler.listPatternElementTypes.set(shape, elementTypeOf(compiler, list));
  let pattern: Pattern = nullable ? { ...shape, kind: 'nullAssert', pattern: shape } : shape;
  for (const [index, property] of properties.entries()) {
    pattern = { ...shape, kind: 'and', left: pattern, right: property };
    listIntersections.set(pattern, { list: shape, nullable, properties: properties.slice(0, index + 1) });
  }
  return pattern;
}

function listRestrictionSubtype(compiler: PatternCompiler, from: ListArm, to: ListArm): boolean {
  if (!isSubtype(restrictedListType(compiler, from), restrictedListType(compiler, to))) return false;
  const source = listLengthRestriction(from.list);
  const target = listLengthRestriction(to.list);
  return target.hasRest ? source.size >= target.size : !source.hasRest && source.size === target.size;
}

function restrictedListType(compiler: PatternCompiler, { list, nullable }: ListArm): DartType {
  const type = interfaceType(coreTypes.list, [elementTypeOf(compiler, list)]);
  return nullable ? makeNullable(type) : type;
}

function listLengthRestriction(list: ListPattern): { hasRest: boolean; size: number } {
  const hasRest = list.elements.some((element) => element.kind === 'rest');
  return { hasRest, size: list.elements.length - Number(hasRest) };
}

function elementTypeOf(compiler: PatternCompiler, list: ListPattern): DartType {
  return compiler.listPatternElementTypes.get(list) ?? DYNAMIC;
}
