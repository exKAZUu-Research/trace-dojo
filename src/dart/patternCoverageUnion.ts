import type { Pattern } from './ast';
import { nullPatternComparison } from './astWalk';
import type { PatternCompiler } from './patternCompiler';
import { type DartType, DYNAMIC, sameType } from './types';

type ListPattern = Extract<Pattern, { kind: 'list' }>;
interface ListArm {
  list: ListPattern;
  nullable: boolean;
}

const listShapes = new WeakSet<ListPattern>();

export function isCoverageListShape(pattern: ListPattern): boolean {
  return listShapes.has(pattern);
}

export function coverageDisjuncts(compiler: PatternCompiler, pattern: Pattern): readonly Pattern[] | undefined {
  if (pattern.kind !== 'or' && pattern.kind !== 'nullCheck' && pattern.kind !== 'nullAssert') return undefined;
  let arms = compiler.coverageUnions.get(pattern);
  if (!arms) {
    arms = normalize(compiler, pattern, undefined);
    compiler.coverageUnions.set(pattern, arms);
  }
  return arms.length === 1 && arms[0] === pattern ? undefined : arms;
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
    case 'list': {
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
      if (addListRestriction(compiler, restrictions, list)) spaces.push(arm);
    } else if (nullPatternComparison(arm) === '==') {
      nullSpace ??= arm;
    } else {
      spaces.push(arm);
    }
  }
  if (!nullSpace) return spaces;
  const only = spaces.length === 1 ? listArm(spaces[0]) : undefined;
  if (!only) return [...spaces, nullSpace];
  if (only.nullable) return spaces;

  // Dart 3.13.7 collapses a list and null into one nullable restriction without list-position properties.
  const shape = { ...only.list };
  listShapes.add(shape);
  const elementType = compiler.listPatternElementTypes.get(only.list);
  if (elementType) compiler.listPatternElementTypes.set(shape, elementType);
  return [{ ...shape, kind: 'nullAssert', pattern: shape }];
}

function listArm(pattern: Pattern): ListArm | undefined {
  if (pattern.kind === 'list') return { list: pattern, nullable: false };
  if (pattern.kind === 'nullAssert' && pattern.pattern.kind === 'list' && isCoverageListShape(pattern.pattern)) {
    return { list: pattern.pattern, nullable: true };
  }
  return undefined;
}

function addListRestriction(
  compiler: PatternCompiler,
  restrictions: Map<number, DartType[]>,
  { list, nullable }: ListArm
): boolean {
  const hasRest = list.elements.some((element) => element.kind === 'rest');
  const size = list.elements.length - Number(hasRest);
  const key = 4 * size + 2 * Number(hasRest) + Number(nullable);
  const elementType = compiler.listPatternElementTypes.get(list) ?? DYNAMIC;
  // SingleSpace equality omits indexed and rest properties, but distinguishes nullable restrictions.
  const types = restrictions.get(key) ?? [];
  if (types.some((type) => sameType(type, elementType))) return false;
  types.push(elementType);
  restrictions.set(key, types);
  return true;
}
