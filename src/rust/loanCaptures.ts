import type { Annotations, LocalVar } from './annotations';
import type { Expr } from './ast';
import { forEachDirect } from './astWalk';
import { normalize } from './infer';
import { derefSteps, typeAfter } from './regions';
import { shallow, type Type } from './types';

interface Projection {
  proj: string[];
  type: Type;
}

// code-gauge-allow functionNcss 34 -- Tracking projections uses the same local and checked call information for the whole walk.
// code-gauge-allow functionCognitiveComplexity 27 -- Tracking projections uses the same local and checked call information for the whole walk.
export function capturedPlaces(
  annotations: Annotations,
  body: Expr,
  local: LocalVar,
  typedReferenceReads: Set<Expr>
): Projection[] {
  const places: Projection[] = [];
  visit(body);
  if (places.length === 0 || places.some(({ proj }) => proj.length === 0)) return [{ proj: [], type: local.type }];
  return places.filter(
    ({ proj }) =>
      !places.some(({ proj: other }) => other.length < proj.length && other.every((part, i) => proj[i] === part))
  );

  function visit(expr: Expr): void {
    if (expr.kind === 'methodCall') {
      const projection = receiverProjection(annotations, expr, local);
      if (projection) {
        places.push(projection);
        const params = annotations.callParams.get(expr);
        for (const [index, arg] of expr.args.entries()) visitArg(arg, params?.[index]);
        return;
      }
    }
    if (expr.kind === 'call') {
      const params = annotations.callParams.get(expr);
      visit(expr.callee);
      for (const [index, arg] of expr.args.entries()) visitArg(arg, params?.[index]);
      return;
    }
    const proj = fieldChain(annotations, expr, local);
    if (!proj) {
      forEachDirect(expr, visit);
      return;
    }
    places.push({ proj: typedReferenceReads.has(expr) ? [...proj, '*'] : proj, type: expr.ty ?? local.type });
    if (expr.kind === 'index') visit(expr.index);
  }

  function visitArg(arg: Expr, type: Type | undefined): void {
    const base = fieldChain(annotations, arg, local);
    if (base && isReference(arg.ty) && isReference(type)) places.push({ proj: [...base, '*'], type: arg.ty! });
    else visit(arg);
  }
}

function receiverProjection(
  annotations: Annotations,
  expr: Extract<Expr, { kind: 'methodCall' }>,
  local: LocalVar
): Projection | undefined {
  const base = fieldChain(annotations, expr.receiver, local);
  if (!base) return undefined;
  const method = annotations.methods.get(expr);
  const receiver = method?.receiver;
  const proj = [...base, ...derefSteps(receiver?.derefs)];
  if (receiver?.autoref === 'none' && (method?.fn.selfMode === 'ref' || method?.fn.selfMode === 'mutRef'))
    proj.push('*');
  return { proj, type: typeAfter(expr.receiver.ty, receiver?.derefs ?? []) ?? local.type };
}

function fieldChain(annotations: Annotations, expr: Expr, local: LocalVar): string[] | undefined {
  if (expr.kind === 'path') {
    const res = annotations.paths.get(expr);
    return res?.kind === 'capture' && res.local === local ? [] : undefined;
  }
  if (expr.kind === 'unary' && expr.op === '*') {
    const base = fieldChain(annotations, expr.operand, local);
    return base && [...base, isReference(expr.operand.ty) ? '*' : '#'];
  }
  if (expr.kind !== 'field' && expr.kind !== 'index') return undefined;
  const base = fieldChain(annotations, expr.operand, local);
  if (!base) return undefined;
  if (expr.kind === 'index') return [...base, ...derefSteps(annotations.indexes.get(expr)?.derefs), '[]'];
  return [...base, ...derefSteps(annotations.fields.get(expr)?.derefs), expr.name];
}

function isReference(type: Type | undefined): boolean {
  return type !== undefined && normalize(shallow(type)).kind === 'ref';
}
