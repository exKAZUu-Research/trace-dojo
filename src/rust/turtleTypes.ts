import type { Eval } from './compiler';
import { normalize } from './infer';
import { concreteType, runtimeType } from './runtimeTypes';
import {
  type AdtDef,
  childTypes,
  type FnDef,
  hasParams,
  shallow,
  substitute,
  type Type,
  type TypeParam,
} from './types';
import type { Place } from './values';

export function canReachTurtle(type: Type, bindings?: ReadonlyMap<TypeParam, Type>): boolean {
  return visit(bindings ? concreteType(type, bindings) : type, new Set());
}

export function trackCollectionStorage(read: Eval, type: Type): Eval {
  if (!mayUseCollectionStorage(type)) return read;
  const generic = hasParams(type);
  if (!generic && canReachTurtle(type)) return read;
  const concrete = generic ? runtimeType(type) : undefined;
  return (frame) => {
    const value = read(frame);
    if (!concrete || !canReachTurtle(concrete(frame))) frame.runtime.rememberScalarStorage(value);
    return value;
  };
}

function mayUseCollectionStorage(type: Type): boolean {
  const t = normalize(shallow(type));
  switch (t.kind) {
    case 'var':
    case 'param':
    case 'array':
    case 'slice': {
      return true;
    }
    case 'tuple': {
      return t.elems.length > 0;
    }
    case 'ref': {
      return mayUseCollectionStorage(t.target);
    }
    case 'adt': {
      if (t.def.builtin === 'Box') return mayUseCollectionStorage(t.args[0]);
      return ['Vec', 'VecDeque', 'BinaryHeap', 'HashMap', 'HashSet', 'BTreeMap', 'BTreeSet'].includes(
        t.def.builtin ?? ''
      );
    }
    default: {
      return false;
    }
  }
}

export function turtleCaptureRoots(
  places: readonly Place[],
  captures: readonly { type: Type }[],
  bindings: ReadonlyMap<TypeParam, Type>
): Place[] {
  return places.filter((_place, index) => !captures[index] || canReachTurtle(captures[index].type, bindings));
}

export function nativeArgumentTypes(def: FnDef, args: Type[]): Type[] {
  const types = def.selfMode ? [def.impl?.selfType ?? args[0], ...def.paramTypes] : def.paramTypes;
  const bindings = new Map(def.params.map((param, index) => [param, args[index]]));
  return types.map((type) => substitute(type, bindings));
}

function visit(type: Type, seen: Set<AdtDef>): boolean {
  const t = normalize(shallow(type));
  if (t.kind === 'var' || t.kind === 'param' || t.kind === 'dyn' || t.kind === 'opaque' || t.kind === 'closure')
    return true;
  if (t.kind !== 'adt') return childTypes(t).some((child) => visit(child, seen));
  if (t.def.builtin) {
    return (
      ['Turtle', 'Iter', 'Entry', 'OccupiedEntry'].includes(t.def.builtin) || t.args.some((arg) => visit(arg, seen))
    );
  }
  if (seen.has(t.def)) return t.args.some((arg) => visit(arg, seen));
  seen.add(t.def);
  const bindings = new Map(t.def.params.map((param, index) => [param, t.args[index]]));
  const relevant = t.def.variants.some((variant) =>
    variant.fields.some((field) => visit(substitute(field.type, bindings), seen))
  );
  seen.delete(t.def);
  return relevant;
}
