import { ExecutionLimitError, LIMITS } from '../interpreter/limits';
import type { ClassEntity, TypeEntity } from './entities';
import { instantiateKind } from './kindTemplates';
import { mapGraph, walkGraph, walkGraphPairs } from './typeGraph';
import { chargeTypeWork } from './typeWorkBudget';

export type Kind =
  | { tag: 'star' | 'constraint' }
  | { tag: 'arrow'; from: Kind; to: Kind }
  /** A data type used as a kind, as DataKinds promotes it: `Bool`, `Symbol`, `[k]`. */
  | { tag: 'data'; entity: TypeEntity; args: Kind[] }
  | KindVar;

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
  return defaultKindExcept(kind, new Set());
}

/** Defaults the kind variables of a kind as {@link defaultKind} does, but those in `keep`. */
export function defaultKindExcept(kind: Kind, keep: ReadonlySet<Kind>): Kind {
  return mapGraph<Kind>(kind, pruneKind, kindChildren, (node, mapped) => {
    if (node.tag === 'kvar' && keep.has(node)) return node;
    if (node.tag === 'kvar') {
      node.ref = STAR;
      return STAR;
    }
    if (node.tag === 'data') return { tag: 'data', entity: node.entity, args: mapped };
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
    else if (x.tag === 'data' && (y as typeof x).entity !== x.entity) return false;
  }
  return true;
}

function occursKind(variable: KindVar, kind: Kind): boolean {
  for (const node of walkGraph(kind, pruneKind, kindChildren)) if (node === variable) return true;
  return false;
}

function kindChildren(kind: Kind): Kind[] {
  return kind.tag === 'arrow' ? [kind.from, kind.to] : kind.tag === 'data' ? kind.args : [];
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
    case 'data': {
      if (pruned.entity.special === 'list' && pruned.args.length === 1)
        return `[${printKind(pruned.args[0], depth + 1)}]`;
      return [pruned.entity.name, ...pruned.args.map((arg) => printKind(arg, depth + 1))].join(' ');
    }
    case 'arrow': {
      const from = pruneKind(pruned.from);
      const left = from.tag === 'arrow' ? `(${printKind(from, depth + 1)})` : printKind(from, depth + 1);
      return `${left} -> ${printKind(pruned.to, depth + 1)}`;
    }
  }
}

export type Type = TVar | TCon | TAp | TGen | TForall;

/**
 * A polymorphic type inside another type, `forall a. C a => t`, as RankNTypes allows: an argument or a field that
 * must be polymorphic. Its variables are rigid variables marked `bound`, which only its own parts refer to.
 */
export interface TForall {
  tag: 'forall';
  vars: TVar[];
  preds: Pred[];
  body: Type;
}

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
  /** Whether the variable is one a `TForall` binds, which is no free variable of the types around it. */
  bound?: boolean;
  /** Whether its `TForall` binds it as `{a}`, which visible type applications skip. */
  inferred?: boolean;
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
  return mapGraph(type, prune, typeParts, (node, mapped) => {
    if (node.tag === 'forall') {
      const [body, ...predTypes] = mapped;
      if (body === node.body && predTypes.every((predType, index) => predType === node.preds[index].type)) return node;
      return {
        tag: 'forall',
        vars: node.vars,
        preds: node.preds.map((pred, index) => ({ cls: pred.cls, type: predTypes[index] })),
        body,
      };
    }
    if (node.tag !== 'tap') return leaf(node);
    const [fn, arg] = mapped;
    return fn === node.fn && arg === node.arg ? node : { tag: 'tap', fn, arg };
  });
}

/** The types inside a type, including the parts of a `TForall`, which unification compares apart. */
export function typeParts(type: Type): Type[] {
  if (type.tag === 'tap') return [type.fn, type.arg];
  if (type.tag === 'forall') return [type.body, ...type.preds.map((pred) => pred.type)];
  return [];
}

/** Replaces the variables a `TForall` binds, as instantiating or comparing it does. */
export function substituteBound(type: TForall, replacements: readonly Type[]): { body: Type; preds: Pred[] } {
  const indices = new Map(type.vars.map((variable, index) => [variable, index]));
  const replace = (inner: Type): Type =>
    mapType(inner, (node) => {
      const index = node.tag === 'tvar' ? indices.get(node) : undefined;
      return index === undefined ? node : replacements[index];
    });
  return { body: replace(type.body), preds: type.preds.map((pred) => ({ cls: pred.cls, type: replace(pred.type) })) };
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
  // A type constructor of a polymorphic kind has a kind of its own at each use.
  let kind =
    node.tag === 'tvar' ? node.kind : node.tag === 'tcon' ? instantiateKind(node.entity, node.entity.kind).kind : STAR;
  for (let index = 0; index < applications; index++) {
    const fn = pruneKind(kind);
    kind = fn.tag === 'arrow' ? fn.to : STAR;
  }
  return kind;
}

export function typeVarsOf(type: Type, into = new Set<TVar>()): Set<TVar> {
  for (const node of walkGraph(type, prune, typeParts)) if (node.tag === 'tvar' && !node.bound) into.add(node);
  return into;
}

export function occursIn(variable: TVar, type: Type): boolean {
  for (const node of walkGraph(type, prune, typeParts)) if (node === variable) return true;
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
  /** The variables of `forall a ->` binders, as `TGen` indices, which only `(type t)` arguments instantiate. */
  required?: number[];
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

/**
 * Unifies two types. A pair where either side applies a type family goes to `family`, which reduces or defers it,
 * instead of being compared by its parts.
 */
let multiplicityArrows: { fun: TypeEntity; arrow: TypeEntity; many: TypeEntity } | undefined;

/** Registers LinearTypes' arrow `FUN m a b`, which unifies with the ordinary arrow when `m` is `Many`. */
export function setMultiplicityArrows(fun: TypeEntity, arrow: TypeEntity, many: TypeEntity): void {
  multiplicityArrows = { fun, arrow, many };
}

/** The parts of a function type: its argument, its result, and, for an arrow of LinearTypes, its multiplicity. */
export function functionParts(type: Type): { param: Type; result: Type; multiplicity?: Type } | undefined {
  const { head, args } = splitApp(prune(type));
  if (head.tag !== 'tcon') return undefined;
  if (head.entity === multiplicityArrows?.arrow && args.length === 2) return { param: args[0], result: args[1] };
  if (head.entity === multiplicityArrows?.fun && args.length === 3) {
    const multiplicity = prune(args[0]);
    if (multiplicity.tag === 'tcon' && multiplicity.entity === multiplicityArrows.many) {
      return { param: args[1], result: args[2] };
    }
    return { param: args[1], result: args[2], multiplicity };
  }
  return undefined;
}

/** For a function type of LinearTypes against an ordinary one, the pairs that must unify: `m ~ Many` and the rest. */
function multiplicityPairs(x: Type, y: Type): [Type, Type][] | undefined {
  if (!multiplicityArrows) return undefined;
  const left = splitApp(x);
  const right = splitApp(y);
  const isFun = (side: { head: Type; args: Type[] }): boolean =>
    side.head.tag === 'tcon' && side.head.entity === multiplicityArrows?.fun && side.args.length === 3;
  const isArrow = (side: { head: Type; args: Type[] }): boolean =>
    side.head.tag === 'tcon' && side.head.entity === multiplicityArrows?.arrow && side.args.length === 2;
  const many: Type = { tag: 'tcon', entity: multiplicityArrows.many };
  if (isFun(left) && isArrow(right)) {
    return [
      [left.args[0], many],
      [left.args[1], right.args[0]],
      [left.args[2], right.args[1]],
    ];
  }
  if (isArrow(left) && isFun(right)) return multiplicityPairs(y, x);
  return undefined;
}

export function unifyTypes(
  a: Type,
  b: Type,
  bind: BindVariable,
  family?: (x: Type, y: Type) => UnificationFailure | undefined
): UnificationFailure | undefined {
  const seen = new Map<Type, Set<Type>>();
  const work: [Type, Type][] = [[a, b]];
  while (work.length > 0) {
    const [left, right] = work.pop()!;
    const x = prune(left);
    const y = prune(right);
    if (x === y) continue;
    let matches = seen.get(x);
    if (matches?.has(y)) continue;
    chargeTypeWork();
    if (!matches) {
      matches = new Set();
      seen.set(x, matches);
    }
    matches.add(y);
    if (family && (isFamilyApplication(x) || isFamilyApplication(y))) {
      const failure = family(x, y);
      if (failure) return failure;
      continue;
    }
    const pairs = x.tag === 'tap' && y.tag === 'tap' ? multiplicityPairs(x, y) : undefined;
    if (pairs) {
      work.push(...pairs);
      continue;
    }
    const failure = x.tag === 'forall' && y.tag === 'forall' ? unifyForalls(x, y, bind) : unifyTypeNode(x, y, bind);
    if (failure) return failure;
    if (x.tag === 'tap' && y.tag === 'tap') work.push([x.arg, y.arg], [x.fn, y.fn]);
  }
  return undefined;
}

/** Whether a type applies a type family to all its parameters, which only its equations may reduce. */
export function isFamilyApplication(type: Type): boolean {
  const { head, args } = splitApp(type);
  return head.tag === 'tcon' && head.entity.sort === 'family' && args.length >= head.entity.arity;
}

/** Unifies two polymorphic types, which must bind the same number of variables and agree with them replaced alike. */
function unifyForalls(x: TForall, y: TForall, bind: BindVariable): UnificationFailure | undefined {
  if (x.vars.length !== y.vars.length || x.preds.length !== y.preds.length) return 'mismatch';
  const shared = x.vars.map((variable) => freshSkolem(variable.kind, Number.MAX_SAFE_INTEGER, variable.name ?? 'a'));
  const left = substituteBound(x, shared);
  const right = substituteBound(y, shared);
  for (const [index, pred] of left.preds.entries()) {
    if (pred.cls !== right.preds[index].cls) return 'mismatch';
    const failure = unifyTypes(pred.type, right.preds[index].type, bind);
    if (failure) return failure;
  }
  return unifyTypes(left.body, right.body, bind);
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
    if (x.tag === 'forall' && y.tag === 'forall') {
      if (x.vars.length !== y.vars.length || x.preds.length !== y.preds.length) return false;
      const shared = x.vars.map((variable) => freshTypeVar(variable.kind, 0));
      const left = substituteBound(x, shared);
      const right = substituteBound(y, shared);
      // The contexts are part of the type, as unification compares them too.
      const samePreds = left.preds.every(
        (pred, index) => pred.cls === right.preds[index].cls && typesEqual(pred.type, right.preds[index].type)
      );
      if (!samePreds || !typesEqual(left.body, right.body)) return false;
      continue;
    }
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
