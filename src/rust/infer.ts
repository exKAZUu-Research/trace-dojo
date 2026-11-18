import { type AdtDef, childTypes, intType, mapChildren, shallow, type Type, type TypeVar } from './types';

/** Binds type variables so that types become equal, recording the bindings so that a failed attempt can undo them. */
export class Unifier {
  private readonly trail: TypeVar[] = [];

  snapshot(): number {
    return this.trail.length;
  }

  rollback(snapshot: number): void {
    while (this.trail.length > snapshot) {
      const v = this.trail.pop() as TypeVar;
      v.binding = undefined;
    }
  }

  /** Unifies tentatively, undoing every binding when the types do not unify. */
  tryUnify(a: Type, b: Type): boolean {
    const snapshot = this.snapshot();
    if (this.unify(a, b)) return true;
    this.rollback(snapshot);
    return false;
  }

  private bind(v: TypeVar, type: Type): void {
    v.binding = type;
    this.trail.push(v);
  }

  // code-gauge-allow functionCognitiveComplexity 26 -- One case per kind of type.
  // code-gauge-allow functionNcss 59 -- One case per kind of type.
  unify(a: Type, b: Type): boolean {
    const x = normalize(shallow(a));
    const y = normalize(shallow(b));
    if (x === y) return true;
    if (x.kind === 'var' && y.kind === 'var') {
      if (x.v === y.v) return true;
      if (x.v.literal && y.v.literal && x.v.literal !== y.v.literal) return false;
      if (x.v.literal) this.bind(y.v, x);
      else this.bind(x.v, y);
      return true;
    }
    if (x.kind === 'var') return this.bindVar(x.v, y);
    if (y.kind === 'var') return this.bindVar(y.v, x);
    if (x.kind !== y.kind) return false;
    switch (x.kind) {
      case 'int':
      case 'float': {
        return x.name === (y as typeof x).name;
      }
      case 'tuple': {
        const other = y as typeof x;
        return x.elems.length === other.elems.length && x.elems.every((elem, i) => this.unify(elem, other.elems[i]));
      }
      case 'array': {
        const other = y as typeof x;
        return x.len === other.len && this.unify(x.elem, other.elem);
      }
      case 'slice': {
        return this.unify(x.elem, (y as typeof x).elem);
      }
      case 'ref': {
        const other = y as typeof x;
        return x.mutable === other.mutable && this.unify(x.target, other.target);
      }
      case 'adt': {
        const other = y as typeof x;
        return x.def === other.def && x.args.every((arg, i) => this.unify(arg, other.args[i]));
      }
      case 'param': {
        return x.param === (y as typeof x).param;
      }
      case 'fn': {
        const other = y as typeof x;
        return (
          x.params.length === other.params.length &&
          x.params.every((p, i) => this.unify(p, other.params[i])) &&
          this.unify(x.ret, other.ret)
        );
      }
      case 'closure': {
        return x.closure === (y as typeof x).closure;
      }
      case 'dyn': {
        const other = y as typeof x;
        if (x.trait.trait !== other.trait.trait) return false;
        if (x.trait.fnSig && other.trait.fnSig) {
          const p = x.trait.fnSig;
          const q = other.trait.fnSig;
          return (
            p.params.length === q.params.length &&
            p.params.every((t, i) => this.unify(t, q.params[i])) &&
            this.unify(p.ret, q.ret)
          );
        }
        return x.trait.args.every((arg, i) => this.unify(arg, other.trait.args[i]));
      }
      case 'opaque': {
        return x.opaque === (y as typeof x).opaque;
      }
      default: {
        return true;
      }
    }
  }

  private bindVar(v: TypeVar, type: Type): boolean {
    if (v.literal === 'int' && type.kind !== 'int') return false;
    if (v.literal === 'float' && type.kind !== 'float') return false;
    if (occurs(v, type)) return false;
    this.bind(v, type);
    return true;
  }
}

function occurs(v: TypeVar, type: Type): boolean {
  const t = shallow(type);
  if (t.kind === 'var') return t.v === v;
  if (t.kind === 'closure' || t.kind === 'opaque' || t.kind === 'dyn') return false;
  return childTypes(t).some((child) => occurs(v, child));
}

/** The types of the standard library's pseudo-types, once their arguments are known. */
let pseudoTypes: { parseError: (target: Type) => Type | undefined } | undefined;

export function setPseudoTypes(types: { parseError: (target: Type) => Type | undefined }): void {
  pseudoTypes = types;
}

/** Replaces `ParseError<F>` and `Unsigned<N>` with the types they stand for when their argument is known. */
export function normalize(type: Type): Type {
  if (type.kind !== 'adt' || !isPseudo(type.def)) return type;
  const arg = shallow(type.args[0]);
  if (arg.kind === 'var') return type;
  if (type.def.builtin === 'Unsigned') {
    if (arg.kind !== 'int') return type;
    return intType(arg.name.startsWith('i') ? (`u${arg.name.slice(1)}` as never) : arg.name);
  }
  return pseudoTypes?.parseError(arg) ?? type;
}

function isPseudo(def: AdtDef): boolean {
  return def.builtin === 'ParseError' || def.builtin === 'Unsigned';
}

/** Resolves a type deeply, normalizing pseudo-types. */
export function deepNormalize(type: Type): Type {
  const t = normalize(shallow(type));
  if (t.kind === 'dyn' || t.kind === 'fn') return t;
  return mapChildren(t, deepNormalize);
}
