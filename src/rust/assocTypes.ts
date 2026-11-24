import type { PathAst, Span } from './ast';
import { compileError, lowerType, type Module, resolveTraitPath, type TypeScope } from './items';
import { intoIterItem, iterationBound } from './iterTypes';
import {
  adt,
  type AdtDef,
  allSupertraits,
  type AssocTypeDef,
  freshVar,
  newTypeParam,
  shallow,
  substituteTraitRef,
  type TraitDef,
  type TraitRef,
  type Type,
  type TypeParam,
  typeToString,
} from './types';

export function lowerAssocItemPath(path: PathAst, names: string[], owner: TypeParam, scope: TypeScope): Type {
  const last = path.segments.at(-1)!;
  if (last.args) compileError(path.span, `${names.join('::')} には型引数を書けません。`);
  return assocTypeOf({ kind: 'param', param: owner }, last.name, undefined, scope, path.span);
}

/** `<T as Trait>::Name` or `<T>::Name`. */
export function lowerQualifiedPath(
  path: PathAst,
  qualified: NonNullable<PathAst['segments'][number]['qualified']>,
  scope: TypeScope
): Type {
  if (path.segments.length !== 2) compileError(path.span, '<T as Trait>:: の後には、関連型の名前を1つ書いてください。');
  const self = lowerType(qualified.self, scope);
  const trait = qualified.trait && resolveTraitPath(qualified.trait, scope, self);
  return assocTypeOf(self, path.segments[1].name, trait, scope, path.span);
}

export const ITERATION_TRAITS = new Set(['Iterator', 'IntoIterator', 'DoubleEndedIterator', 'ExactSizeIterator']);

/**
 * The associated type `name` of a type, of the trait given or else of the bounds or the impl it has: what a bound sets
 * (`T: Add<Output = T>`), a type parameter added for it in a signature, or the projection `<T as Trait>::Name`, which
 * resolves once the type is known.
 */
export function assocTypeOf(self: Type, name: string, trait: TraitRef | undefined, scope: TypeScope, span: Span): Type {
  const t = shallow(self);
  const bound = trait ?? boundWithAssoc(self, name, scope, span);
  const iteration = ITERATION_TRAITS.has(bound.trait.builtin ?? '');
  if (name === 'Item' && iteration && t.kind === 'param' && !t.param.isSelf) {
    const item = assocItem(t.param, scope);
    if (item) return item;
  }
  if (bound.item && name === 'Item') return bound.item;
  const set = bound.assoc?.get(name);
  if (set) return set;
  const assoc = bound.trait.assocTypes.get(name);
  if (!assoc) {
    if (name === 'Item' && iteration) return intoIterItem(self) ?? freshVar();
    return compileError(span, `トレイト ${bound.trait.name} に関連型 ${name} がありません。`);
  }
  const ownParam = t.kind === 'param' && !t.param.isSelf && scope.ownParams?.includes(t.param) !== false;
  if (ownParam && scope.assocParams && t.param.bounds.includes(bound)) {
    return assocParam(t.param, bound, assoc, scope.assocParams);
  }
  return projectionOf(bound.trait, name, self, bound.args);
}

/** The one bound of the type (or the impl's trait for `Self`) whose trait has the associated type. */
function boundWithAssoc(self: Type, name: string, scope: TypeScope, span: Span): TraitRef {
  const t = shallow(self);
  const ofSelf = scope.implTrait && ((t.kind === 'param' && t.param.isSelf) || sameSelf(self, scope.selfType));
  const bounds = ofSelf ? [scope.implTrait as TraitRef] : t.kind === 'param' ? t.param.bounds : [];
  const candidates = allSupertraits(bounds, self).filter(
    (candidate) =>
      candidate.trait.assocTypes.has(name) || (name === 'Item' && ITERATION_TRAITS.has(candidate.trait.builtin ?? ''))
  );
  if (new Set(candidates.map((candidate) => candidate.trait)).size > 1)
    compileError(span, `関連型 ${name} が、複数のトレイトにあります（<T as Trait>::${name} と書いてください）。`);
  if (!candidates[0]) compileError(span, `${typeToString(self)} に関連型 ${name} がありません。`);
  return candidates[0];
}

/** In a signature, the associated type of a parameter's bound becomes a parameter of its own that callers infer. */
function assocParam(owner: TypeParam, bound: TraitRef, assoc: AssocTypeDef, assocParams: TypeParam[]): Type {
  const { name } = assoc;
  const param = newTypeParam(`${owner.name}::${name}`);
  assocParams.push(param);
  (bound as { assoc?: Map<string, Type> }).assoc = new Map([...(bound.assoc ?? []), [name, { kind: 'param', param }]]);
  param.bounds = assoc.bounds.map((ref) =>
    substituteTraitRef(ref, new Map([[bound.trait.self, { kind: 'param', param: owner }]]))
  );
  return { kind: 'param', param };
}

function sameSelf(a: Type, b: Type | undefined): boolean {
  return b !== undefined && shallow(a) === shallow(b);
}

/** The pseudo-type that stands for an associated type of a trait on a type. */
export function projectionDef(trait: TraitDef, name: string, module: Module): AdtDef {
  return {
    name: `${trait.name}::${name}`,
    path: `${trait.path}::${name}`,
    kind: 'struct',
    params: [],
    variants: [],
    derives: new Set(),
    span: trait.span ?? { row: 0, col: 1 },
    builtin: 'Projection',
    projection: { trait, name },
    module,
  };
}

export function projectionOf(trait: TraitDef, name: string, self: Type, args?: Type[]): Type {
  const assoc = trait.assocTypes.get(name);
  if (!assoc) throw new Error(`Unknown associated type ${trait.name}::${name}`);
  return adt(assoc.projection, [self, ...(args ?? trait.params.map((param): Type => ({ kind: 'param', param })))]);
}

/** `I::Item` of a type parameter bounded by `Iterator` or `IntoIterator`. */
export function assocItem(param: TypeParam, scope: TypeScope): Type | undefined {
  const paramType: Type = { kind: 'param', param };
  const bound = iterationBound(paramType);
  if (!bound) return undefined;
  if (!bound.item && scope.assocParams) {
    const item = newTypeParam(`${param.name}::Item`);
    scope.assocParams.push(item);
    bound.item = { kind: 'param', param: item };
  }
  return bound.item ?? intoIterItem(paramType);
}
