import type { Annotations, LocalVar } from './annotations';
import type { Expr, Pattern } from './ast';
import { forEachDirect, patternBindingParts } from './astWalk';
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

export function capturedStoragePlaces(annotations: Annotations, body: Expr, local: LocalVar): Projection[] {
  const storage = new Map<string, Projection>();
  for (const { proj } of capturedPlaces(annotations, body, local)) {
    const deref = proj.findIndex((part) => part === '*' || part === '#' || part === '[]');
    const path = deref === -1 ? proj : proj.slice(0, deref);
    if (path.length === 0) return [{ proj: [], type: local.type }];
    storage.set(path.join('.'), { proj: path, type: projectionPrefixType(local.type, path) });
  }
  const places = [...storage.values()];
  return places.filter(
    ({ proj }) => !places.some(({ proj: other }) => other.length < proj.length && covers(other, proj))
  );
}

export function captureLayout(
  annotations: Annotations,
  body: Expr,
  local: LocalVar,
  modeOf: (place: Expr, binding?: LocalVar) => CaptureMode,
  fallback: CaptureMode
): Type[] {
  const observations: (Projection & { mode: CaptureMode })[] = [];
  forEachCapture(annotations, body, local, (place, { proj, type }, binding) => {
    const mode = modeOf(place, binding);
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

// code-gauge-allow functionCognitiveComplexity 30 -- Expression projections and pattern projections share one checked walk.
// code-gauge-allow functionNcss 36 -- Keeps source places and their evaluated index inputs together.
function forEachCapture(
  annotations: Annotations,
  body: Expr,
  local: LocalVar,
  capture: (expr: Expr, projection: Projection, binding?: LocalVar) => void
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
      forEachDirect(expr, visit, capturePattern);
      return;
    }
    const reborrows = annotations.reborrows.has(expr);
    capture(expr, { proj: reborrows ? [...proj, '*'] : proj, type: expr.ty ?? local.type });
    if (expr.kind === 'index') visit(expr.index);
  }

  function capturePattern(pattern: Pattern, source: Expr): boolean {
    const base = fieldChain(annotations, source, local);
    if (!base) return false;
    const parts = projectedBindings(pattern, annotations);
    if (!parts?.length) return false;
    for (const part of parts) {
      const path = part.path.split('.').slice(1);
      if (part.throughRef) {
        capture(source, { proj: base, type: source.ty ?? local.type }, part.local);
        continue;
      }
      const type = normalize(shallow(part.local.type));
      const projected = part.local.mode !== 'move' && type.kind === 'ref' ? type.target : type;
      capture(source, { proj: [...base, ...path], type: projected }, part.local);
    }
    if (source.kind === 'index') visit(source.index);
    return true;
  }
}

export function projectedBindings(
  pattern: Pattern,
  annotations: Annotations
): ReturnType<typeof patternBindingParts> | undefined {
  const aggregate = pattern.kind === 'tuple' || pattern.kind === 'struct' || pattern.kind === 'tupleStruct';
  return aggregate && canProjectPattern(pattern) ? patternBindingParts(pattern, annotations) : undefined;
}

function canProjectPattern(pattern: Pattern): boolean {
  switch (pattern.kind) {
    case 'binding': {
      return !pattern.sub;
    }
    case 'wild': {
      return true;
    }
    case 'tuple': {
      return pattern.elems.every(canProjectPattern);
    }
    case 'tupleStruct':
    case 'struct': {
      const type = pattern.ty && normalize(shallow(pattern.ty));
      if (type?.kind !== 'adt' || type.def.kind !== 'struct') return false;
      const fields = pattern.kind === 'struct' ? pattern.fields.map((field) => field.pattern) : pattern.elems;
      return fields.every(canProjectPattern);
    }
    default: {
      return false;
    }
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
  const steps = receiver?.derefs ?? [];
  const beforeLast = steps.at(-1) === 'own' ? typeAfter(expr.receiver.ty, steps.slice(0, -1)) : undefined;
  const storageSteps = beforeLast?.kind === 'array' ? steps.slice(0, -1) : steps;
  const proj = [...base, ...derefSteps(storageSteps)];
  if (receiver?.autoref === 'none' && (method?.fn.selfMode === 'ref' || method?.fn.selfMode === 'mutRef'))
    proj.push('*');
  return { proj, type: typeAfter(expr.receiver.ty, storageSteps) ?? local.type };
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
