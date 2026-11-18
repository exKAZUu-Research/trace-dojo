import { compileError } from './errors';
import type { Name } from './syntax';

export function checkTypeParams(params: Name[]): Set<string> {
  const names = new Set<string>();
  for (const param of params) {
    if (names.has(param.name)) throw compileError(param.span, `型変数 ${param.name} が重複しています。`);
    names.add(param.name);
  }
  return names;
}
