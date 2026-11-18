import { deepNormalize } from './infer';
import type { Frame } from './runtime';
import { hasParams, resolve, shallow, type Subst, substitute, type Type, type TypeParam } from './types';

/** A type that the compiler resolved, which the running frame completes when it mentions type parameters. */
export type RuntimeType = (frame: Frame) => Type;

/** Finalizes a type the checker inferred, applying literal defaults, and returns how to make it concrete at run time. */
export function runtimeType(type: Type): RuntimeType {
  const resolved = deepNormalize(resolve(type, true));
  if (!hasParams(resolved)) return () => resolved;
  return (frame) => concreteType(resolved, frame.typeArgs);
}

export function concreteType(type: Type, typeArgs: ReadonlyMap<TypeParam, Type>): Type {
  if (typeArgs.size === 0) return type;
  return deepNormalize(substitute(type, typeArgs as Subst));
}

/** A key that equal concrete types share, for caches of impl lookups. */
export function typeKey(type: Type): string {
  const t = shallow(type);
  switch (t.kind) {
    case 'int':
    case 'float': {
      return t.name;
    }
    case 'tuple': {
      return `(${t.elems.map(typeKey).join(',')})`;
    }
    case 'array': {
      return `[${typeKey(t.elem)};${t.len}]`;
    }
    case 'slice': {
      return `[${typeKey(t.elem)}]`;
    }
    case 'ref': {
      return `&${t.mutable ? 'mut ' : ''}${typeKey(t.target)}`;
    }
    case 'adt': {
      return `${t.def.path}#${(t.def as { id?: number }).id ?? ''}<${t.args.map(typeKey).join(',')}>`;
    }
    case 'param': {
      return `P${t.param.id}`;
    }
    case 'dyn': {
      return `dyn ${t.trait.trait.path}`;
    }
    case 'closure': {
      return `closure${t.closure.id}`;
    }
    case 'opaque': {
      return t.opaque.hidden ? typeKey(t.opaque.hidden) : `opaque${t.opaque.id}`;
    }
    case 'var': {
      return t.v.binding ? typeKey(t.v.binding) : '_';
    }
    default: {
      return t.kind;
    }
  }
}

/** Matches a type pattern with type parameters against a concrete type, binding the parameters. */
// code-gauge-allow functionCognitiveComplexity 25 -- One case per kind of type.
export function matchConcrete(
  pattern: Type,
  concrete: Type,
  params: ReadonlySet<TypeParam>,
  subst: Map<TypeParam, Type>
): boolean {
  const p = shallow(pattern);
  const c = shallow(concrete);
  if (p.kind === 'param' && params.has(p.param)) {
    const bound = subst.get(p.param);
    if (bound) return typeKey(bound) === typeKey(c);
    subst.set(p.param, c);
    return true;
  }
  if (c.kind === 'opaque' && c.opaque.hidden) return matchConcrete(p, c.opaque.hidden, params, subst);
  if (p.kind !== c.kind) return false;
  switch (p.kind) {
    case 'int':
    case 'float': {
      return p.name === (c as typeof p).name;
    }
    case 'tuple': {
      const other = c as typeof p;
      return (
        p.elems.length === other.elems.length &&
        p.elems.every((elem, i) => matchConcrete(elem, other.elems[i], params, subst))
      );
    }
    case 'array': {
      const other = c as typeof p;
      return p.len === other.len && matchConcrete(p.elem, other.elem, params, subst);
    }
    case 'slice': {
      return matchConcrete(p.elem, (c as typeof p).elem, params, subst);
    }
    case 'ref': {
      const other = c as typeof p;
      return p.mutable === other.mutable && matchConcrete(p.target, other.target, params, subst);
    }
    case 'adt': {
      const other = c as typeof p;
      return p.def === other.def && p.args.every((arg, i) => matchConcrete(arg, other.args[i], params, subst));
    }
    case 'param': {
      return p.param === (c as typeof p).param;
    }
    case 'dyn': {
      return p.trait.trait === (c as typeof p).trait.trait;
    }
    case 'closure': {
      return p.closure.id === (c as typeof p).closure.id;
    }
    default: {
      return true;
    }
  }
}
