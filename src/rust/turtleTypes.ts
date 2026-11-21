import { normalize } from './infer';
import { concreteType } from './runtimeTypes';
import { type AdtDef, childTypes, type FnDef, shallow, substitute, type Type, type TypeParam } from './types';

export function canReachTurtle(type: Type, bindings?: ReadonlyMap<TypeParam, Type>): boolean {
  return visit(bindings ? concreteType(type, bindings) : type, new Set());
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
