import type { Annotations, LocalVar } from './annotations';
import type { Expr } from './ast';
import { forEachDirect } from './astWalk';
import { normalize } from './infer';
import { derefSteps, typeAfter } from './regions';
import { ref, shallow, substitute, type Type } from './types';

interface Projection {
  proj: string[];
  type: Type;
}

// code-gauge-allow functionCognitiveComplexity 27 -- Tracking projections uses the same local and checked call information for the whole walk.
export function capturedPlaces(annotations: Annotations, body: Expr, local: LocalVar): Projection[] {
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
        for (const arg of expr.args) visit(arg);
        return;
      }
    }
    const proj = fieldChain(annotations, expr, local);
    if (!proj) {
      forEachDirect(expr, visit);
      return;
    }
    const reborrows = annotations.reborrows.has(expr);
    places.push({ proj: reborrows ? [...proj, '*'] : proj, type: expr.ty ?? local.type });
    if (expr.kind === 'index') visit(expr.index);
  }
}

export function captureLayout(
  annotations: Annotations,
  body: Expr,
  local: LocalVar,
  mode: 'ref' | 'mut' | 'value'
): Type[] {
  const captures = new Map<string, { path: string[]; type: Type }>();
  for (const { proj, type } of capturedPlaces(annotations, body, local)) {
    const boundary = proj.findIndex((part) => part === '[]' || (mode === 'value' && (part === '#' || part === '*')));
    if (boundary === -1) captures.set(JSON.stringify(proj), { path: proj, type });
    else {
      const prefix = proj.slice(0, boundary);
      captures.set(JSON.stringify(prefix), { path: prefix, type: projectionPrefixType(local.type, prefix) });
    }
  }
  const paths = [...captures.values()];
  return paths
    .filter(
      ({ path }) =>
        !paths.some(({ path: other }) => other.length < path.length && other.every((part, i) => part === path[i]))
    )
    .map(({ type }) => (mode === 'value' ? type : ref(type, mode === 'mut')));
}

function projectionPrefixType(base: Type, path: string[]): Type {
  let current = base;
  for (const part of path) {
    const type = normalize(shallow(current));
    if (part === '*' || part === '#') current = typeAfter(type, [part === '*' ? 'ref' : 'own']) ?? type;
    else if (type.kind === 'tuple') current = type.elems[Number(part)] ?? type;
    else if (type.kind === 'adt') {
      const field = type.def.variants[0]?.fields.find(({ name }) => name === part);
      if (!field) return type;
      current = substitute(field.type, new Map(type.def.params.map((param, index) => [param, type.args[index]])));
    }
  }
  return current;
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
