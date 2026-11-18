import { compileError } from './errors';
import type { Name, QName, TypeExpr } from './syntax';
import { chargeTypeWork } from './typeWorkBudget';

export function checkTypeParams(params: Name[]): Set<string> {
  const names = new Set<string>();
  for (const param of params) {
    if (names.has(param.name)) throw compileError(param.span, `型変数 ${param.name} が重複しています。`);
    names.add(param.name);
  }
  return names;
}

export function typeConstructorNames(type: TypeExpr): QName[] {
  const names: QName[] = [];
  const work = [type];
  while (work.length > 0) {
    chargeTypeWork();
    const node = work.pop()!;
    if (node.kind === 'tcon') names.push(node.name);
    else if (node.kind === 'tapp') work.push(node.arg, node.fn);
    else if (node.kind === 'tfun') work.push(node.to, node.from);
    else if (node.kind === 'tlist') work.push(node.elem);
    else if (node.kind === 'ttuple') work.push(...node.elems.toReversed());
  }
  return names;
}
