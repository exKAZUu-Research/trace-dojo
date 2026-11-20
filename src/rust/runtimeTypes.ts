import { deepNormalize } from './infer';
import type { Frame } from './runtime';
import { hasParams, resolve, shallow, type Subst, substitute, type TraitRef, type Type, type TypeParam } from './types';

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

const typeIdentities = new WeakMap<object, number>();
let nextTypeIdentity = 0;

export function typeIdentity(definition: object): number {
  const existing = typeIdentities.get(definition);
  if (existing !== undefined) return existing;
  const identity = nextTypeIdentity++;
  typeIdentities.set(definition, identity);
  return identity;
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
      return `${t.def.path}#${typeIdentity(t.def)}<${t.args.map(typeKey).join(',')}>`;
    }
    case 'param': {
      return `P${t.param.id}`;
    }
    case 'dyn': {
      return `dyn ${concreteTraitKey(t.trait)}`;
    }
    case 'fn': {
      return signatureKey(t);
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

function concreteTraitKey(ref: TraitRef): string {
  const item = ref.item ? `Item=${typeKey(ref.item)}` : '';
  const signature = ref.fnSig ? signatureKey(ref.fnSig) : '';
  return `${ref.trait.path}#${typeIdentity(ref.trait)}<${ref.args.map(typeKey).join(',')}|${item}|${signature}>`;
}

function signatureKey(signature: { params: Type[]; ret: Type }): string {
  return `fn(${signature.params.map(typeKey).join(',')})->${typeKey(signature.ret)}`;
}

/** Matches a type pattern with type parameters against a concrete type, binding the parameters. */
// code-gauge-allow functionNcss 41 -- One case per kind of type.
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
  const match = (a: Type, b: Type): boolean => matchConcrete(a, b, params, subst);
  switch (p.kind) {
    case 'int':
    case 'float': {
      return p.name === (c as typeof p).name;
    }
    case 'tuple': {
      return matchTypeList(p.elems, (c as typeof p).elems, match);
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
      return p.def === other.def && matchTypeList(p.args, other.args, match);
    }
    case 'param': {
      return p.param === (c as typeof p).param;
    }
    case 'dyn': {
      return matchTraitRef(p.trait, (c as typeof p).trait, match);
    }
    case 'fn': {
      return matchSignature(p, c as typeof p, match);
    }
    case 'closure': {
      return p.closure.id === (c as typeof p).closure.id;
    }
    default: {
      return true;
    }
  }
}

function matchTraitRef(a: TraitRef, b: TraitRef, match: (a: Type, b: Type) => boolean): boolean {
  if (a.trait !== b.trait || !matchTypeList(a.args, b.args, match)) return false;
  if (a.item && b.item ? !match(a.item, b.item) : a.item !== b.item) return false;
  return a.fnSig && b.fnSig ? matchSignature(a.fnSig, b.fnSig, match) : a.fnSig === b.fnSig;
}

function matchSignature(
  a: { params: Type[]; ret: Type },
  b: { params: Type[]; ret: Type },
  match: (a: Type, b: Type) => boolean
): boolean {
  return matchTypeList(a.params, b.params, match) && match(a.ret, b.ret);
}

function matchTypeList(a: Type[], b: Type[], match: (a: Type, b: Type) => boolean): boolean {
  return a.length === b.length && a.every((type, index) => match(type, b[index]));
}
