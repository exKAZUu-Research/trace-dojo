import type { ClassEntity, TypeEntity } from './entities';

export type Kind = { tag: 'star' } | { tag: 'arrow'; from: Kind; to: Kind } | KindVar;

export interface KindVar {
  tag: 'kvar';
  id: number;
  ref?: Kind;
}

export const STAR: Kind = { tag: 'star' };

export function kindArrow(from: Kind, to: Kind): Kind {
  return { tag: 'arrow', from, to };
}

/** The kind of a type constructor taking `arity` types of kind `*`. */
export function simpleKind(arity: number): Kind {
  let kind: Kind = STAR;
  for (let index = 0; index < arity; index++) kind = kindArrow(STAR, kind);
  return kind;
}

let nextKindVar = 0;

export function freshKindVar(): KindVar {
  return { tag: 'kvar', id: nextKindVar++ };
}

export function pruneKind(kind: Kind): Kind {
  if (kind.tag === 'kvar' && kind.ref) {
    kind.ref = pruneKind(kind.ref);
    return kind.ref;
  }
  return kind;
}

/** Replaces the kind variables nothing determined with `*`, as Haskell 98 defaults them. */
export function defaultKind(kind: Kind): Kind {
  const pruned = pruneKind(kind);
  if (pruned.tag === 'kvar') {
    pruned.ref = STAR;
    return STAR;
  }
  if (pruned.tag === 'arrow') return kindArrow(defaultKind(pruned.from), defaultKind(pruned.to));
  return pruned;
}

export function unifyKinds(a: Kind, b: Kind): boolean {
  const x = pruneKind(a);
  const y = pruneKind(b);
  if (x === y) return true;
  if (x.tag === 'kvar') {
    if (occursKind(x, y)) return false;
    x.ref = y;
    return true;
  }
  if (y.tag === 'kvar') return unifyKinds(y, x);
  if (x.tag === 'star' && y.tag === 'star') return true;
  if (x.tag === 'arrow' && y.tag === 'arrow') return unifyKinds(x.from, y.from) && unifyKinds(x.to, y.to);
  return false;
}

function occursKind(variable: KindVar, kind: Kind): boolean {
  const pruned = pruneKind(kind);
  if (pruned === variable) return true;
  return pruned.tag === 'arrow' && (occursKind(variable, pruned.from) || occursKind(variable, pruned.to));
}

export function showKind(kind: Kind): string {
  const pruned = pruneKind(kind);
  switch (pruned.tag) {
    case 'star': {
      return '*';
    }
    case 'kvar': {
      return 'k';
    }
    case 'arrow': {
      const from = pruneKind(pruned.from);
      const left = from.tag === 'arrow' ? `(${showKind(from)})` : showKind(from);
      return `${left} -> ${showKind(pruned.to)}`;
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------

export type Type = TVar | TCon | TAp | TGen;

/** A type variable: a unification variable, or a rigid one (a skolem) from a signature. */
export interface TVar {
  tag: 'tvar';
  id: number;
  kind: Kind;
  /** The depth of the binding whose generalization may quantify the variable. */
  level: number;
  ref?: Type;
  /** The name a signature gave the variable, for messages. */
  name?: string;
  skolem?: boolean;
}

export interface TCon {
  tag: 'tcon';
  entity: TypeEntity;
}

export interface TAp {
  tag: 'tap';
  fn: Type;
  arg: Type;
}

/** A quantified variable of a type scheme, by its index. */
export interface TGen {
  tag: 'tgen';
  index: number;
}

let nextTypeVar = 0;

export function freshTypeVar(kind: Kind, level: number, name?: string): TVar {
  return { tag: 'tvar', id: nextTypeVar++, kind, level, name };
}

export function freshSkolem(kind: Kind, level: number, name: string): TVar {
  return { tag: 'tvar', id: nextTypeVar++, kind, level, name, skolem: true };
}

export function tcon(entity: TypeEntity): TCon {
  return { tag: 'tcon', entity };
}

export function tap(fn: Type, ...args: Type[]): Type {
  let type = fn;
  for (const arg of args) type = { tag: 'tap', fn: type, arg };
  return type;
}

export function prune(type: Type): Type {
  if (type.tag === 'tvar' && type.ref) {
    type.ref = prune(type.ref);
    return type.ref;
  }
  return type;
}

/** The type with every bound variable replaced by what it stands for. */
export function zonk(type: Type): Type {
  const pruned = prune(type);
  if (pruned.tag === 'tap') {
    const fn = zonk(pruned.fn);
    const arg = zonk(pruned.arg);
    return fn === pruned.fn && arg === pruned.arg ? pruned : { tag: 'tap', fn, arg };
  }
  return pruned;
}

/** Splits an application into its head and arguments: `Either a b` into `Either` and `[a, b]`. */
export function splitApp(type: Type): { head: Type; args: Type[] } {
  const args: Type[] = [];
  let head = prune(type);
  while (head.tag === 'tap') {
    args.unshift(head.arg);
    head = prune(head.fn);
  }
  return { head, args };
}

export function kindOfType(type: Type): Kind {
  const pruned = prune(type);
  switch (pruned.tag) {
    case 'tvar': {
      return pruned.kind;
    }
    case 'tcon': {
      return pruned.entity.kind;
    }
    case 'tap': {
      const fnKind = pruneKind(kindOfType(pruned.fn));
      return fnKind.tag === 'arrow' ? fnKind.to : STAR;
    }
    case 'tgen': {
      return STAR;
    }
  }
}

export function typeVarsOf(type: Type, into = new Set<TVar>()): Set<TVar> {
  const pruned = prune(type);
  if (pruned.tag === 'tvar') into.add(pruned);
  else if (pruned.tag === 'tap') {
    typeVarsOf(pruned.fn, into);
    typeVarsOf(pruned.arg, into);
  }
  return into;
}

export function occursIn(variable: TVar, type: Type): boolean {
  const pruned = prune(type);
  if (pruned === variable) return true;
  return pruned.tag === 'tap' && (occursIn(variable, pruned.fn) || occursIn(variable, pruned.arg));
}

export interface Pred {
  cls: ClassEntity;
  type: Type;
}

/** A type scheme: `forall vars. preds => type`, where the type refers to its variables by `TGen` index. */
export interface Scheme {
  kinds: Kind[];
  /** The names the variables had in the source, for messages. */
  names?: string[];
  preds: Pred[];
  type: Type;
}

export function monoScheme(type: Type): Scheme {
  return { kinds: [], preds: [], type };
}

export function instantiateType(type: Type, args: readonly Type[]): Type {
  const pruned = prune(type);
  switch (pruned.tag) {
    case 'tgen': {
      return args[pruned.index];
    }
    case 'tap': {
      return { tag: 'tap', fn: instantiateType(pruned.fn, args), arg: instantiateType(pruned.arg, args) };
    }
    default: {
      return pruned;
    }
  }
}

/** Replaces the given variables by `TGen` indices, for building a scheme. */
export function quantifyType(type: Type, vars: readonly TVar[]): Type {
  const pruned = prune(type);
  if (pruned.tag === 'tvar') {
    const index = vars.indexOf(pruned);
    return index === -1 ? pruned : { tag: 'tgen', index };
  }
  if (pruned.tag === 'tap')
    return { tag: 'tap', fn: quantifyType(pruned.fn, vars), arg: quantifyType(pruned.arg, vars) };
  return pruned;
}

/** Whether two types are the same after resolving bound variables. */
export function typesEqual(a: Type, b: Type): boolean {
  const x = prune(a);
  const y = prune(b);
  if (x === y) return true;
  if (x.tag === 'tcon' && y.tag === 'tcon') return x.entity === y.entity;
  if (x.tag === 'tap' && y.tag === 'tap') return typesEqual(x.fn, y.fn) && typesEqual(x.arg, y.arg);
  if (x.tag === 'tgen' && y.tag === 'tgen') return x.index === y.index;
  return false;
}

/**
 * Matches a pattern type (with `TGen` variables) against a type, extending `bindings`, without binding any variable
 * of the type: a one-way match, as instance selection needs.
 */
export function matchType(pattern: Type, type: Type, bindings: (Type | undefined)[]): boolean {
  const p = prune(pattern);
  const t = prune(type);
  if (p.tag === 'tgen') {
    const bound = bindings[p.index];
    if (bound) return typesEqual(bound, t);
    bindings[p.index] = t;
    return true;
  }
  if (p.tag === 'tcon') return t.tag === 'tcon' && t.entity === p.entity;
  if (p.tag === 'tap') return t.tag === 'tap' && matchType(p.fn, t.fn, bindings) && matchType(p.arg, t.arg, bindings);
  return p === t;
}

/** Whether a pattern type could match the type once the type's variables are known. */
export function couldMatch(pattern: Type, type: Type): boolean {
  const p = prune(pattern);
  const t = prune(type);
  if (p.tag === 'tgen' || t.tag === 'tvar') return true;
  if (p.tag === 'tcon') return t.tag === 'tcon' && t.entity === p.entity;
  if (p.tag === 'tap') return t.tag === 'tap' && couldMatch(p.fn, t.fn) && couldMatch(p.arg, t.arg);
  return false;
}
