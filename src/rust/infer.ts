import {
  type AdtDef,
  childTypes,
  constValueType,
  intType,
  mapChildren,
  sameAutoTraits,
  shallow,
  type Type,
  type TypeVar,
} from './types';

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

  /**
   * `ParseError<F>`, the error of `str::parse::<F>` while `F` is unknown, may be any parse error; rustc does not infer
   * `F` from it, so `F` must still come from elsewhere (a type annotation).
   */
  private unifyParseError(pseudo: Type & { kind: 'adt' }, error: Type & { kind: 'adt' }): boolean {
    if (pseudo.def.builtin !== 'ParseError' || shallow(pseudo.args[0]).kind !== 'var') return false;
    return ['ParseIntError', 'ParseFloatError', 'ParseBoolError', 'ParseCharError'].includes(
      error.def.builtin as string
    );
  }

  // code-gauge-allow functionNcss -- One case per kind of type.
  unify(a: Type, b: Type): boolean {
    const x = normalize(shallow(a));
    const y = normalize(shallow(b));
    if (x === y) return true;
    if (x.kind === 'var' && y.kind === 'var') return this.unifyVars(x, y);
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
        return this.unifyArrays(x, y as typeof x);
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
        if (x.def !== other.def) return this.unifyParseError(x, other) || this.unifyParseError(other, x);
        return x.args.every((arg, i) => this.unify(arg, other.args[i]));
      }
      case 'param': {
        return x.param === (y as typeof x).param;
      }
      case 'fn': {
        return this.unifyFns(x, y as typeof x);
      }
      case 'closure': {
        return x.closure.id === (y as typeof x).closure.id;
      }
      case 'dyn': {
        return this.unifyDyn(x, y as typeof x);
      }
      case 'opaque': {
        const other = (y as typeof x).opaque;
        return x.opaque.id === other.id && x.opaque.args.every((arg, i) => this.unify(arg, other.args[i]));
      }
      default: {
        return true;
      }
    }
  }

  private unifyVars(x: Type & { kind: 'var' }, y: Type & { kind: 'var' }): boolean {
    if (x.v === y.v) return true;
    if (x.v.literal && y.v.literal && x.v.literal !== y.v.literal) return false;
    if (x.v.literal || (x.v.fallback && !y.v.literal)) this.bind(y.v, x);
    else this.bind(x.v, y);
    return true;
  }

  /** Arrays of the same length, which a const parameter or a variable may give. */
  private unifyArrays(x: Type & { kind: 'array' }, y: Type & { kind: 'array' }): boolean {
    if (!x.lenType && !y.lenType) return x.len === y.len && this.unify(x.elem, y.elem);
    const lengths = this.unify(x.lenType ?? constValueType(x.len), y.lenType ?? constValueType(y.len));
    return lengths && this.unify(x.elem, y.elem);
  }

  /**
   * Functions of the same signature; an `unsafe fn` item becomes only an `unsafe fn` pointer, and a safe one either.
   * Pointers are the same type only when both or neither are `unsafe` (a coercion makes a safe one `unsafe`).
   */
  private unifyFns(x: Type & { kind: 'fn' }, y: Type & { kind: 'fn' }): boolean {
    if ((unsafeItem(x) && isSafePointer(y)) || (unsafeItem(y) && isSafePointer(x))) return false;
    if (!x.item && !y.item && (x.isUnsafe ?? false) !== (y.isUnsafe ?? false)) return false;
    return this.unifySignatures(x, y);
  }

  private unifyDyn(a: Extract<Type, { kind: 'dyn' }>, b: Extract<Type, { kind: 'dyn' }>): boolean {
    if (a.trait.trait !== b.trait.trait || !sameAutoTraits(a, b)) return false;
    const callable = a.trait.fnSig;
    const otherCallable = b.trait.fnSig;
    if (callable || otherCallable)
      return !!callable && !!otherCallable && this.unifySignatures(callable, otherCallable);
    const item = a.trait.item;
    const otherItem = b.trait.item;
    if ((item || otherItem) && (!item || !otherItem || !this.unify(item, otherItem))) return false;
    return a.trait.args.every((arg, i) => this.unify(arg, b.trait.args[i]));
  }

  private unifySignatures(p: { params: Type[]; ret: Type }, q: { params: Type[]; ret: Type }): boolean {
    return (
      p.params.length === q.params.length &&
      p.params.every((t, i) => this.unify(t, q.params[i])) &&
      this.unify(p.ret, q.ret)
    );
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

interface PseudoTypes {
  parseError: (target: Type) => Type | undefined;
  intoItem: (type: Type) => Type | undefined;
  intoShape: (type: Type) => Type | undefined;
  tryFromError: (source: Type, target: Type) => Type | undefined;
  projection: (type: Type & { kind: 'adt' }) => Type | undefined;
}

let pseudoTypes: PseudoTypes | undefined;

export function setPseudoTypes(types: PseudoTypes): void {
  pseudoTypes = types;
}

/**
 * Replaces `ParseError<F>`, `Unsigned<N>`, `Signed<N>`, `Indexed<I, T>`, and the pseudo-types of iterators with the
 * types they stand for when their first argument is known.
 */
// code-gauge-allow functionCognitiveComplexity -- Each pseudo-type has its own normalization rules.
export function normalize(type: Type): Type {
  if (type.kind !== 'adt' || !isPseudo(type.def)) return type;
  if (type.def.builtin === 'Projection') {
    const projected = pseudoTypes?.projection(type);
    return projected ? normalize(shallow(projected)) : type;
  }
  const arg = normalize(shallow(type.args[0]));
  if (type.def.builtin === 'Indexed') return indexed(type, arg);
  if (arg.kind === 'var') return type;
  const iterator = iteratorPart(type, arg);
  if (iterator !== false) return iterator ? normalize(shallow(iterator)) : type;
  if (type.def.builtin === 'Unsigned' || type.def.builtin === 'Signed') {
    if (type.def.builtin === 'Unsigned' && arg.kind === 'float') return intType(arg.name === 'f32' ? 'u32' : 'u64');
    if (arg.kind !== 'int') return type;
    return intType(`${type.def.builtin === 'Unsigned' ? 'u' : 'i'}${arg.name.slice(1)}` as never);
  }
  return pseudoTypes?.parseError(arg) ?? type;
}

/**
 * `IterItem<I>`, `IterShape<I>`, `IterTarget<I>`, `IntoItem<T>`, `IntoShape<T>`, `TryFromError<S, T>`; false for other
 * pseudo-types.
 */
function iteratorPart(type: Type & { kind: 'adt' }, arg: Type): Type | undefined | false {
  const name = type.def.builtin as string;
  switch (name) {
    case 'IterItem':
    case 'IterShape':
    case 'IterTarget': {
      if (arg.kind !== 'adt' || arg.def.builtin !== 'Iter') return undefined;
      if (name === 'IterShape') return arg.args[1];
      const item = normalize(shallow(arg.args[0]));
      if (name === 'IterItem') return item;
      return item.kind === 'ref' ? item.target : undefined;
    }
    case 'IntoItem': {
      return pseudoTypes?.intoItem(arg);
    }
    case 'IntoShape': {
      return pseudoTypes?.intoShape(arg);
    }
    case 'TryFromError': {
      const target = normalize(shallow(type.args[1]));
      return target.kind === 'var' ? undefined : pseudoTypes?.tryFromError(arg, target);
    }
    default: {
      return false;
    }
  }
}

/** `Indexed<I, T>`: an element for an index, which an untyped number is as a `usize`, or a slice for a range. */
function indexed(type: Type & { kind: 'adt' }, index: Type): Type {
  const isNumber = index.kind === 'int' || (index.kind === 'var' && index.v.literal === 'int');
  if (isNumber) return normalize(shallow(type.args[1]));
  if (index.kind === 'adt') return { kind: 'slice', elem: type.args[1] };
  return type;
}

export function isPseudo(def: AdtDef): boolean {
  return [
    'ParseError',
    'Unsigned',
    'Signed',
    'Indexed',
    'IterItem',
    'IterShape',
    'IterTarget',
    'IntoItem',
    'IntoShape',
    'TryFromError',
    'Projection',
  ].includes(def.builtin as string);
}

export function deepNormalize(type: Type): Type {
  const t = normalize(shallow(type));
  if (t.kind === 'dyn' || t.kind === 'fn') return t;
  return mapChildren(t, deepNormalize);
}

function unsafeItem(t: Type & { kind: 'fn' }): boolean {
  return !!(t.item && 'ast' in t.item && t.item.ast?.isUnsafe);
}

function isSafePointer(t: Type & { kind: 'fn' }): boolean {
  return !t.item && !t.isUnsafe;
}
