import type { Pattern } from './ast';
import type { PatternCompiler } from './patternCompiler';
import { type DartType, DYNAMIC, sameType } from './types';

export function coverageDisjuncts(compiler: PatternCompiler, pattern: Pattern): readonly Pattern[] {
  while (pattern.kind === 'parenthesized') pattern = pattern.pattern;
  if (pattern.kind !== 'or') return [pattern];
  const cached = compiler.coverageUnions.get(pattern);
  if (cached) return cached;
  const pending: Pattern[] = [pattern];
  const arms: Pattern[] = [];
  for (let arm = pending.pop(); arm; arm = pending.pop()) {
    while (arm.kind === 'parenthesized') arm = arm.pattern;
    if (arm.kind === 'or') pending.push(arm.right, arm.left);
    else arms.push(arm);
  }
  const selected = uniqueListSpaces(compiler, arms);
  compiler.coverageUnions.set(pattern, selected);
  return selected;
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
