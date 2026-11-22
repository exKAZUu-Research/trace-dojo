import type { Annotations, LocalVar } from './annotations';
import type { Expr, Pattern } from './ast';
import { forEachDirect, patternBindingParts } from './astWalk';
import { normalize } from './infer';
import { derefSteps, typeAfter } from './regions';
import { shallow, substitute, type Type } from './types';

interface Projection {
  proj: string[];
  type: Type;
}

export type CaptureMode = 'ref' | 'mut' | 'value';
const CAPTURE_STRENGTH: Record<CaptureMode, number> = { ref: 0, mut: 1, value: 2 };

export interface ProjectedCapture extends Projection {
  mode: CaptureMode;
}

export function captureStoragePlaces(captures: ProjectedCapture[], type: Type): ProjectedCapture[] {
  return mergeCaptures(
    captures.map((capture) => {
      const boundary = capture.proj.findIndex((part) => part === '*' || part === '#' || part === '[]');
      if (boundary === -1) return capture;
      const proj = capture.proj.slice(0, boundary);
      return { ...capture, proj, type: projectionPrefixType(type, proj) };
    })
  );
}

export function captureProjections(
  annotations: Annotations,
  body: Expr,
  local: LocalVar,
  modeOf: (place: Expr, binding?: LocalVar) => CaptureMode,
  fallback: CaptureMode
): ProjectedCapture[] {
  const observations: ProjectedCapture[] = [];
  const ignored = forEachCapture(annotations, body, local, (place, { proj, type }, binding) => {
    const mode = modeOf(place, binding);
    const boundary = proj.findIndex((part) => part === '[]' || (mode === 'value' && (part === '#' || part === '*')));
    const path = boundary === -1 ? proj : proj.slice(0, boundary);
    observations.push({ proj: path, type: boundary === -1 ? type : projectionPrefixType(local.type, path), mode });
  });
  if (observations.length === 0 && !ignored) observations.push({ proj: [], type: local.type, mode: fallback });
  return mergeCaptures(observations);
}

function mergeCaptures(observations: ProjectedCapture[]): ProjectedCapture[] {
  const captures: ProjectedCapture[] = [];
  for (const observation of observations.toSorted((a, b) => a.proj.length - b.proj.length)) {
    const prior = captures.find(({ proj }) => covers(proj, observation.proj));
    if (!prior) captures.push({ ...observation });
    else if (CAPTURE_STRENGTH[observation.mode] > CAPTURE_STRENGTH[prior.mode]) prior.mode = observation.mode;
  }
  return captures;
}

function covers(prefix: string[], path: string[]): boolean {
  return prefix.length <= path.length && prefix.every((part, index) => path[index] === part);
}

// code-gauge-allow functionCognitiveComplexity -- Expression projections and pattern projections share one checked walk.
// code-gauge-allow functionNcss -- Evaluates each source and its indexing expressions once.
function forEachCapture(
  annotations: Annotations,
  body: Expr,
  local: LocalVar,
  capture: (expr: Expr, projection: Projection, binding?: LocalVar) => void
): boolean {
  let ignored = false;
  visit(body);
  return ignored;

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
    const projections = projectedPattern(annotations, pattern, source, local);
    if (!projections) return false;
    if (projections.length === 0) ignored = true;
    for (const { place, binding } of projections) capture(source, place, binding);
    if (source.kind === 'index') visit(source.index);
    return true;
  }
}

function projectedPattern(
  annotations: Annotations,
  pattern: Pattern,
  source: Expr,
  local: LocalVar
): { place: Projection; binding: LocalVar }[] | undefined {
  const base = fieldChain(annotations, source, local);
  if (!base) return;
  const parts = projectedBindings(pattern, annotations);
  if (parts?.length === 0 && base.includes('[]')) return;
  return parts?.map(({ path, throughRef, local: binding }) => {
    if (throughRef) return { place: { proj: base, type: source.ty ?? local.type }, binding };
    const type = normalize(shallow(binding.type));
    const value = binding.mode !== 'move' && type.kind === 'ref' ? type.target : type;
    return { place: { proj: [...base, ...path.split('.').slice(1)], type: value }, binding };
  });
}

export function projectedBindings(
  pattern: Pattern,
  annotations: Annotations
): ReturnType<typeof patternBindingParts> | undefined {
  if (pattern.kind === 'wild') return [];
  const aggregate = pattern.kind === 'tuple' || pattern.kind === 'struct' || pattern.kind === 'tupleStruct';
  return aggregate && canProjectPattern(pattern, annotations) ? patternBindingParts(pattern, annotations) : undefined;
}

function canProjectPattern(pattern: Pattern, annotations: Annotations): boolean {
  switch (pattern.kind) {
    case 'binding': {
      return !pattern.sub && !annotations.paths.has(pattern);
    }
    case 'wild': {
      return true;
    }
    case 'tuple': {
      return pattern.elems.every((part) => canProjectPattern(part, annotations));
    }
    case 'tupleStruct':
    case 'struct': {
      const type = pattern.ty && normalize(shallow(pattern.ty));
      if (type?.kind !== 'adt' || type.def.kind !== 'struct') return false;
      const fields = pattern.kind === 'struct' ? pattern.fields.map((field) => field.pattern) : pattern.elems;
      return fields.every((part) => canProjectPattern(part, annotations));
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
