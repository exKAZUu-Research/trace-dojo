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

export type CaptureMode = 'ref' | 'mut' | 'value';
const CAPTURE_STRENGTH: Record<CaptureMode, number> = { ref: 0, mut: 1, value: 2 };

export function capturedPlaces(annotations: Annotations, body: Expr, local: LocalVar): Projection[] {
  const places: Projection[] = [];
  forEachCapture(annotations, body, local, (_, projection) => places.push(projection));
  if (places.length === 0 || places.some(({ proj }) => proj.length === 0)) return [{ proj: [], type: local.type }];
  return places.filter(
    ({ proj }) => !places.some(({ proj: other }) => other.length < proj.length && covers(other, proj))
  );
}

export function captureLayout(
  annotations: Annotations,
  body: Expr,
  local: LocalVar,
  modeOf: (place: Expr) => CaptureMode,
  fallback: CaptureMode
): Type[] {
  const observations: (Projection & { mode: CaptureMode })[] = [];
  forEachCapture(annotations, body, local, (place, { proj, type }) => {
    const mode = modeOf(place);
    const boundary = proj.findIndex((part) => part === '[]' || (mode === 'value' && (part === '#' || part === '*')));
    const path = boundary === -1 ? proj : proj.slice(0, boundary);
    observations.push({ proj: path, type: boundary === -1 ? type : projectionPrefixType(local.type, path), mode });
  });
  if (observations.length === 0) observations.push({ proj: [], type: local.type, mode: fallback });
  const captures: typeof observations = [];
  for (const observation of observations.toSorted((a, b) => a.proj.length - b.proj.length)) {
    const prior = captures.find(({ proj }) => covers(proj, observation.proj));
    if (!prior) captures.push(observation);
    else if (CAPTURE_STRENGTH[observation.mode] > CAPTURE_STRENGTH[prior.mode]) prior.mode = observation.mode;
  }
  return captures.map(({ mode, type }) => (mode === 'value' ? type : ref(type, mode === 'mut')));
}

function covers(prefix: string[], path: string[]): boolean {
  return prefix.length <= path.length && prefix.every((part, index) => path[index] === part);
}

function forEachCapture(
  annotations: Annotations,
  body: Expr,
  local: LocalVar,
  capture: (expr: Expr, projection: Projection) => void
): void {
  visit(body);

  function visit(expr: Expr): void {
    if (expr.kind === 'methodCall') {
      const projection = receiverProjection(annotations, expr, local);
      if (projection) {
        capture(expr.receiver, projection);
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
    capture(expr, { proj: reborrows ? [...proj, '*'] : proj, type: expr.ty ?? local.type });
    if (expr.kind === 'index') visit(expr.index);
  }
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
