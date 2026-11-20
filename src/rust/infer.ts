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

  // code-gauge-allow functionCognitiveComplexity 28 -- One case per kind of type.
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
        if (x.def !== other.def) return this.unifyParseError(x, other) || this.unifyParseError(other, x);
        return x.args.every((arg, i) => this.unify(arg, other.args[i]));
      }
      case 'param': {
        return x.param === (y as typeof x).param;
      }
      case 'fn': {
        return this.unifySignatures(x, y as typeof x);
      }
      case 'closure': {
        return x.closure.id === (y as typeof x).closure.id;
      }
      case 'dyn': {
        const other = y as typeof x;
        if (x.trait.trait !== other.trait.trait) return false;
        if (x.trait.fnSig && other.trait.fnSig) return this.unifySignatures(x.trait.fnSig, other.trait.fnSig);
        return x.trait.args.every((arg, i) => this.unify(arg, other.trait.args[i]));
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
  /** The item and the shape of the iterator that `IntoIterator` makes of a value of a type. */
  intoItem: (type: Type) => Type | undefined;
  intoShape: (type: Type) => Type | undefined;
  /** The error of `TryFrom<source>` for `target`. */
  tryFromError: (source: Type, target: Type) => Type | undefined;
}

/** The types of the standard library's pseudo-types, once their arguments are known. */
let pseudoTypes: PseudoTypes | undefined;

export function setPseudoTypes(types: PseudoTypes): void {
  pseudoTypes = types;
}

/**
 * Replaces `ParseError<F>`, `Unsigned<N>`, `Signed<N>`, `Indexed<I, T>`, and the pseudo-types of iterators with the
 * types they stand for when their first argument is known.
 */
export function normalize(type: Type): Type {
  if (type.kind !== 'adt' || !isPseudo(type.def)) return type;
  const arg = normalize(shallow(type.args[0]));
  if (type.def.builtin === 'Indexed') return indexed(type, arg);
  if (arg.kind === 'var') return type;
  const iterator = iteratorPart(type, arg);
  if (iterator !== false) return iterator ? normalize(shallow(iterator)) : type;
  if (type.def.builtin === 'Unsigned' || type.def.builtin === 'Signed') {
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
  ].includes(def.builtin as string);
}

/** Resolves a type deeply, normalizing pseudo-types. */
export function deepNormalize(type: Type): Type {
  const t = normalize(shallow(type));
  if (t.kind === 'dyn' || t.kind === 'fn') return t;
  return mapChildren(t, deepNormalize);
}
