import type { Pattern } from './ast';
import type { PatternCompiler } from './patternCompiler';
import { type DartType, DYNAMIC, sameType } from './types';

interface Alternative {
  pattern: Pattern;
  nonNull: boolean;
}

export function coverageDisjuncts(compiler: PatternCompiler, pattern: Pattern): readonly Pattern[] {
  while (pattern.kind === 'parenthesized') pattern = pattern.pattern;
  if (pattern.kind !== 'or') return [pattern];
  const cached = compiler.coverageUnions.get(pattern);
  if (cached) return cached;
  const pending: Alternative[] = [{ pattern, nonNull: false }];
  const arms: Pattern[] = [];
  for (let next = pending.pop(); next; next = pending.pop()) {
    addCoverageAlternative(next, pending, arms);
  }
  const selected = uniqueListSpaces(compiler, arms);
  compiler.coverageUnions.set(pattern, selected);
  return selected;
}

function addCoverageAlternative({ pattern, nonNull }: Alternative, pending: Alternative[], arms: Pattern[]): void {
  switch (pattern.kind) {
    case 'parenthesized': {
      pending.push({ pattern: pattern.pattern, nonNull });
      break;
    }
    case 'or': {
      pending.push({ pattern: pattern.right, nonNull }, { pattern: pattern.left, nonNull });
      break;
    }
    case 'nullAssert': {
      const { row, column, start, end } = pattern;
      const span = { row, column, start, end };
      // Dart adds a distinct null space for an assertion before deduplicating the list restrictions.
      arms.push({ ...span, kind: 'constant', value: { ...span, kind: 'null' } });
      pending.push({ pattern: pattern.pattern, nonNull: true });
      break;
    }
    case 'nullCheck': {
      pending.push({ pattern: pattern.pattern, nonNull: true });
      break;
    }
    default: {
      arms.push(nonNull && pattern.kind !== 'list' ? { ...pattern, kind: 'nullCheck', pattern } : pattern);
    }
  }
}

function uniqueListSpaces(compiler: PatternCompiler, arms: readonly Pattern[]): readonly Pattern[] {
  const seen = new Map<number, DartType[]>();
  return arms.filter((arm) => {
    if (arm.kind !== 'list') return true;
    const hasRest = arm.elements.some((element) => element.kind === 'rest');
    const size = arm.elements.length - Number(hasRest);
    const key = 2 * size + Number(hasRest);
    const elementType = compiler.listPatternElementTypes.get(arm) ?? DYNAMIC;
    // Dart 3.13.7's SingleSpace equality omits list element and rest properties in a union.
    const types = seen.get(key) ?? [];
    if (types.some((type) => sameType(type, elementType))) return false;
    types.push(elementType);
    seen.set(key, types);
    return true;
  });
}
