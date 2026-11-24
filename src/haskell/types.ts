import { ExecutionLimitError, LIMITS } from '../interpreter/limits';
import type { ClassEntity, TypeEntity } from './entities';
import { mapGraph, walkGraph, walkGraphPairs } from './typeGraph';
import { chargeTypeWork } from './typeWorkBudget';

export type Kind = { tag: 'star' | 'constraint' } | { tag: 'arrow'; from: Kind; to: Kind } | KindVar;

export interface KindVar {
  tag: 'kvar';
  id: number;
  ref?: Kind;
}

export const STAR: Kind = { tag: 'star' };
export const CONSTRAINT: Kind = { tag: 'constraint' };

export function kindArrow(from: Kind, to: Kind): Kind {
  chargeTypeWork();
  return { tag: 'arrow', from, to };
}

export function simpleKind(arity: number): Kind {
  let kind: Kind = STAR;
  for (let index = 0; index < arity; index++) kind = kindArrow(STAR, kind);
  return kind;
}

let nextKindVar = 0;

export function freshKindVar(): KindVar {
  chargeTypeWork();
  return { tag: 'kvar', id: nextKindVar++ };
}

export function parameterKinds(initial: Kind): Kind[] {
  const kinds: Kind[] = [];
  let kind = pruneKind(initial);
  while (kind.tag === 'arrow') {
    kinds.push(kind.from);
    kind = pruneKind(kind.to);
  }
  return kinds;
}

export function pruneKind(kind: Kind): Kind {
  if (kind.tag !== 'kvar' || !kind.ref) return kind;
  const path: KindVar[] = [];
  while (kind.tag === 'kvar' && kind.ref) {
    chargeTypeWork();
    path.push(kind);
    kind = kind.ref;
  }
  for (const variable of path) variable.ref = kind;
  return kind;
}

/** Replaces the kind variables nothing determined with `*`, as Haskell 98 defaults them. */
export function defaultKind(kind: Kind): Kind {
  return mapGraph<Kind>(kind, pruneKind, kindChildren, (node, mapped) => {
    if (node.tag === 'kvar') {
      node.ref = STAR;
      return STAR;
    }
    return node.tag === 'arrow' ? kindArrow(mapped[0], mapped[1]) : node;
  });
}

export function unifyKinds(a: Kind, b: Kind): boolean {
  for (const [x, y] of walkGraphPairs(a, b, pruneKind, kindChildren)) {
    if (x === y) continue;
    if (x.tag === 'kvar') {
      if (occursKind(x, y)) return false;
      x.ref = y;
    } else if (y.tag === 'kvar') {
      if (occursKind(y, x)) return false;
      y.ref = x;
    } else if (x.tag !== y.tag) return false;
  }
  return true;
}

function occursKind(variable: KindVar, kind: Kind): boolean {
  for (const node of walkGraph(kind, pruneKind, kindChildren)) if (node === variable) return true;
  return false;
}

function kindChildren(kind: Kind): Kind[] {
  return kind.tag === 'arrow' ? [kind.from, kind.to] : [];
}

export function showKind(kind: Kind): string {
  return printKind(kind, 0);
}

function printKind(kind: Kind, depth: number): string {
  chargeTypeWork();
  if (depth > LIMITS.maxCallDepth) throw new ExecutionLimitError('operations');
  const pruned = pruneKind(kind);
  switch (pruned.tag) {
    case 'star': {
      return '*';
    }
    case 'constraint': {
      return 'Constraint';
    }
    case 'kvar': {
      return 'k';
    }
    case 'arrow': {
      const from = pruneKind(pruned.from);
      const left = from.tag === 'arrow' ? `(${printKind(from, depth + 1)})` : printKind(from, depth + 1);
      return `${left} -> ${printKind(pruned.to, depth + 1)}`;
    }
  }
}

export type Type = TVar | TCon | TAp | TGen;

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

export interface TGen {
  tag: 'tgen';
  index: number;
}

let nextTypeVar = 0;

export function freshTypeVar(kind: Kind, level: number, name?: string): TVar {
  chargeTypeWork();
  return { tag: 'tvar', id: nextTypeVar++, kind, level, name };
}

export function freshSkolem(kind: Kind, level: number, name: string): TVar {
  chargeTypeWork();
  return { tag: 'tvar', id: nextTypeVar++, kind, level, name, skolem: true };
}

export function tcon(entity: TypeEntity): TCon {
  chargeTypeWork();
  return { tag: 'tcon', entity };
}

export function tap(fn: Type, ...args: Type[]): Type {
  let type = fn;
  for (const arg of args) {
    chargeTypeWork();
    type = { tag: 'tap', fn: type, arg };
  }
  return type;
}

export function prune(type: Type): Type {
  if (type.tag !== 'tvar' || !type.ref) return type;
  const path: TVar[] = [];
  let rigid = false;
  while (type.tag === 'tvar' && type.ref) {
    chargeTypeWork();
    // A rigid variable stands for a type only while a GADT match assumes it, so paths through it stay as they are.
    if (type.skolem) rigid = true;
    path.push(type);
    type = type.ref;
  }
  if (!rigid) for (const variable of path) variable.ref = type;
  return type;
}

export function zonk(type: Type): Type {
  return mapType(type, (node) => node);
}

export function mapType(type: Type, leaf: (node: Type) => Type): Type {
  return mapGraph(type, prune, typeChildren, (node, mapped) => {
    if (node.tag !== 'tap') return leaf(node);
    const [fn, arg] = mapped;
    return fn === node.fn && arg === node.arg ? node : { tag: 'tap', fn, arg };
  });
}

export function splitApp(type: Type): { head: Type; args: Type[] } {
  const args: Type[] = [];
  let head = prune(type);
  while (head.tag === 'tap') {
    chargeTypeWork();
    args.push(head.arg);
    head = prune(head.fn);
  }
  return { head, args: args.toReversed() };
}

export function kindOfType(type: Type): Kind {
  let node = prune(type);
  let applications = 0;
  while (node.tag === 'tap') {
    chargeTypeWork();
    applications++;
    node = prune(node.fn);
  }
  let kind = node.tag === 'tvar' ? node.kind : node.tag === 'tcon' ? node.entity.kind : STAR;
  for (let index = 0; index < applications; index++) {
    const fn = pruneKind(kind);
    kind = fn.tag === 'arrow' ? fn.to : STAR;
  }
  return kind;
}

export function typeVarsOf(type: Type, into = new Set<TVar>()): Set<TVar> {
  for (const node of walkGraph(type, prune, typeChildren)) if (node.tag === 'tvar') into.add(node);
  return into;
}

export function occursIn(variable: TVar, type: Type): boolean {
  for (const node of walkGraph(type, prune, typeChildren)) if (node === variable) return true;
  return false;
}

export function typeChildren(type: Type): Type[] {
  return type.tag === 'tap' ? [type.fn, type.arg] : [];
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
  /**
   * The variables a visible type application instantiates, in order, as `TGen` indices: those a signature names, in
   * the order GHC specifies them. A scheme that inference found has none.
   */
  specified?: number[];
  preds: Pred[];
  type: Type;
}

export function instantiateType(type: Type, args: readonly Type[]): Type {
  return mapType(type, (node) => (node.tag === 'tgen' ? args[node.index] : node));
}

export function quantifyType(type: Type, vars: readonly TVar[]): Type {
  const indices = new Map(vars.map((variable, index) => [variable, index]));
  return mapType(type, (node) => {
    const index = node.tag === 'tvar' ? indices.get(node) : undefined;
    return index === undefined ? node : { tag: 'tgen', index };
  });
}

type UnificationFailure = 'mismatch' | 'occurs' | 'kind' | 'escape';
type BindVariable = (variable: TVar, type: Type) => undefined | Exclude<UnificationFailure, 'mismatch'>;

export function unifyTypes(a: Type, b: Type, bind: BindVariable): UnificationFailure | undefined {
  for (const [x, y] of walkGraphPairs(a, b, prune, typeChildren)) {
    const failure = unifyTypeNode(x, y, bind);
    if (failure) return failure;
  }
  return undefined;
}

function unifyTypeNode(x: Type, y: Type, bind: BindVariable): UnificationFailure | undefined {
  if (x === y) return undefined;
  if (x.tag === 'tvar' && !x.skolem) return bind(x, y);
  if (y.tag === 'tvar' && !y.skolem) return bind(y, x);
  if (x.tag === 'tcon' && y.tag === 'tcon') return x.entity === y.entity ? undefined : 'mismatch';
  return x.tag === 'tap' && y.tag === 'tap' ? undefined : 'mismatch';
}

export function typesEqual(a: Type, b: Type): boolean {
  for (const [x, y] of walkGraphPairs(a, b, prune, typeChildren)) {
    if (x === y) continue;
    if (x.tag === 'tcon' && y.tag === 'tcon' && x.entity === y.entity) continue;
    if (x.tag === 'tgen' && y.tag === 'tgen' && x.index === y.index) continue;
    if (x.tag !== 'tap' || y.tag !== 'tap') return false;
  }
  return true;
}

/**
 * Matches a pattern type (with `TGen` variables) against a type, extending `bindings`, without binding any variable
 * of the type: a one-way match, as instance selection needs.
 */
export function matchType(pattern: Type, type: Type, bindings: (Type | undefined)[]): boolean {
  for (const [p, t] of walkGraphPairs(pattern, type, prune, typeChildren)) {
    if (!matchTypeNode(p, t, bindings)) return false;
  }
  return true;
}

function matchTypeNode(pattern: Type, type: Type, bindings: (Type | undefined)[]): boolean {
  if (pattern.tag === 'tgen') {
    const bound = bindings[pattern.index];
    if (bound) return typesEqual(bound, type);
    bindings[pattern.index] = type;
    return true;
  }
  if (pattern.tag === 'tcon') return type.tag === 'tcon' && type.entity === pattern.entity;
  if (pattern.tag === 'tap') return type.tag === 'tap';
  return pattern === type;
}

export function couldMatch(pattern: Type, type: Type): boolean {
  for (const [p, t] of walkGraphPairs(pattern, type, prune, typeChildren)) {
    if (p.tag === 'tgen' || t.tag === 'tvar') continue;
    if (p.tag === 'tcon' && t.tag === 'tcon' && p.entity === t.entity) continue;
    if (p.tag !== 'tap' || t.tag !== 'tap') return false;
  }
  return (
    unifyTypes(freshMatchType(pattern), freshMatchType(type), (variable, target) => {
      if (occursIn(variable, target)) return 'occurs';
      variable.ref = target;
      return;
    }) === undefined
  );
}

function freshMatchType(root: Type): Type {
  const generics = new Map<number, TVar>();
  return mapType(root, (node) => {
    if (node.tag === 'tvar') return freshTypeVar(node.kind, 0);
    if (node.tag !== 'tgen') return node;
    let variable = generics.get(node.index);
    if (!variable) {
      variable = freshTypeVar(STAR, 0);
      generics.set(node.index, variable);
    }
    return variable;
  });
}
