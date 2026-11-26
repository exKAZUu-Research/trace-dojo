import type { ExecutionBudget } from '../interpreter/limits';
import type { Expr, Span } from './ast';
import { normalize } from './infer';
import type { LoanError } from './loanGraph';
import type { Layout, RVar } from './regions';
import { shallow, type Type } from './types';

/** A lifetime a function's signature names, or a place it leaves out (`'_`, `&self`), given a name of its own. */
interface NamedRegion {
  region: RVar;
  name: string;
  /** Whether the signature leaves it out, so that no name is written. */
  anonymous: boolean;
  /** The lifetimes of the references and types it is inside, which it outlives by the signature's types. */
  within: string[];
  /** For a parameter's lifetime, the parameter: its name and where it is declared. */
  param?: { name: string; span: Span };
}

/** What the lifetime check of a function's signature reads besides the types: its parameters' names and its bounds. */
export interface SignatureNames {
  params: { name: string; span: Span }[];
  bounds: { name: string; outlives: string[] }[];
  span: Span;
}

/** The lifetime check of a function's signature against what its body's borrows require. */
export function signatureLifetimeError(
  names: SignatureNames,
  body: {
    inputs: Layout[];
    inputTypes: Type[];
    receivers: number;
    ret: { layout: Layout; type: Type };
    outlives: readonly (readonly [RVar, RVar])[];
    staticRegion: RVar | undefined;
    body: Expr;
  }
): LoanError | undefined {
  return checkLifetimeRelations({
    inputs: body.inputTypes.map((type, index) => ({
      layout: body.inputs[index],
      type,
      ...(index < body.receivers ? { name: 'self', span: names.span } : names.params[index - body.receivers]),
    })),
    ret: body.ret,
    refSelf: body.inputTypes.slice(0, body.receivers).some((type) => shallow(type).kind === 'ref'),
    bounds: names.bounds,
    outlives: body.outlives,
    staticRegion: body.staticRegion,
    span: bodyResultSpan(body.body),
  });
}

export interface SignatureRegions {
  /** The parameters (`self` first): what each holds, its type, and its name and position. */
  inputs: { layout: Layout; type: Type; name: string; span: Span }[];
  ret: { layout: Layout; type: Type };
  /** Whether the first input is `&self` or `&mut self`, whose lifetime a left-out return lifetime is. */
  refSelf: boolean;
  /** The bounds the generics declare (`'b: 'a`), of the function and of its impl. */
  bounds: { name: string; outlives: string[] }[];
  outlives: readonly (readonly [RVar, RVar])[];
  staticRegion: RVar | undefined;
  span: Span;
}

/**
 * Checks that what the body makes one lifetime of the signature outlive another, the signature declares, as rustc does
 * (E0621, "lifetime may not live long enough"): a reference flowing from a parameter into the return value needs the
 * parameter's lifetime to outlive the return value's.
 */
function checkLifetimeRelations(signature: SignatureRegions): LoanError | undefined {
  let anonymousCount = 0;
  const anonymous = (): string => `'#${anonymousCount++}`;
  const inputs = signature.inputs.flatMap(({ layout, type, name, span }) =>
    namedRegions(layout, type, anonymous).map((named) => ({ ...named, param: { name, span } }))
  );
  const elided = returnElision(signature, inputs);
  const ret = namedRegions(signature.ret.layout, signature.ret.type, () => elided ?? anonymous());
  const named = [...inputs, ...ret];
  const byRegion = new Map(named.map((entry) => [entry.region, entry]));
  const relation = declaredRelation(signature, inputs);
  const edges = outlivesEdges(signature.outlives);
  for (const shorter of named) {
    for (const region of reachedNamed(shorter.region, edges, byRegion, signature.staticRegion)) {
      const longer = byRegion.get(region)!;
      if (!relation(longer.name, shorter.name)) return relationError(longer, shorter, signature.span);
    }
  }
  return undefined;
}

/** The lifetime a return type leaves out: that of `&self`, or else of the only lifetime in the parameters. */
function returnElision(signature: SignatureRegions, inputs: NamedRegion[]): string | undefined {
  if (signature.refSelf) return inputs[0]?.name;
  return inputs.length === 1 ? inputs[0].name : undefined;
}

function namedRegions(layout: Layout, type: Type, anonymous: () => string, within: string[] = []): NamedRegion[] {
  const t = normalize(shallow(type));
  const named = (region: RVar, lifetime: string | undefined): NamedRegion =>
    lifetime && lifetime !== "'_"
      ? { region, name: lifetime, anonymous: false, within }
      : { region, name: anonymous(), anonymous: true, within };
  if (layout.kind === 'ref' && t.kind === 'ref') {
    const outer = named(layout.region, t.lifetime);
    return [outer, ...namedRegions(layout.target, t.target, anonymous, [...within, outer.name])];
  }
  if (layout.kind === 'adt' && t.kind === 'adt') {
    const own = layout.own.map((region, index) => named(region, t.lifetimes?.[index]));
    const inner = [...within, ...own.map(({ name }) => name)];
    return [
      ...own,
      ...layout.args.flatMap((arg, index) => (t.args[index] ? namedRegions(arg, t.args[index], anonymous, inner) : [])),
    ];
  }
  if (layout.kind === 'tuple' && t.kind === 'tuple') {
    return layout.elems.flatMap((elem, index) => namedRegions(elem, t.elems[index], anonymous, within));
  }
  if (layout.kind === 'seq' && (t.kind === 'array' || t.kind === 'slice')) {
    return namedRegions(layout.elem, t.elem, anonymous, within);
  }
  return [];
}

/**
 * Whether `longer: shorter` holds by the declared bounds, by the bounds a parameter's type implies (`&'a T<'b>` needs
 * `'b: 'a`), or by being the same lifetime or `'static`.
 */
// code-gauge-allow functionCognitiveComplexity -- Closes the declared lifetime bounds transitively.
function declaredRelation(
  signature: SignatureRegions,
  inputs: NamedRegion[]
): (longer: string, shorter: string) => boolean {
  const outlives = new Map<string, Set<string>>();
  const add = (longer: string, shorter: string): void => {
    const set = outlives.get(longer) ?? new Set();
    set.add(shorter);
    outlives.set(longer, set);
  };
  for (const { name, outlives: shorter } of signature.bounds) for (const each of shorter) add(name, each);
  for (const { name, within } of inputs) for (const outer of within) add(name, outer);
  return (longer, shorter) => {
    if (longer === shorter || longer === "'static") return true;
    const seen = new Set([longer]);
    for (const current of seen) {
      for (const next of outlives.get(current) ?? []) {
        if (next === shorter) return true;
        seen.add(next);
      }
    }
    return false;
  };
}

/** The named regions that must outlive `start` through regions the body makes, stopping at each named one. */
function reachedNamed(
  start: RVar,
  edges: Map<RVar, RVar[]>,
  named: Map<RVar, NamedRegion>,
  staticRegion: RVar | undefined
): RVar[] {
  const found: RVar[] = [];
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    for (const next of edges.get(queue.pop()!) ?? []) {
      if (seen.has(next) || next === staticRegion) continue;
      seen.add(next);
      if (named.has(next)) found.push(next);
      else queue.push(next);
    }
  }
  return found;
}

function relationError(longer: NamedRegion, shorter: NamedRegion, span: Span): LoanError {
  if (shorter.name === "'static") {
    return {
      span,
      message: `ライフタイムが足りません。${longer.param ? `引数 ${longer.param.name} から借りた参照` : '借りた参照'}を、'static の参照として使っています。`,
    };
  }
  if (longer.anonymous && !shorter.anonymous && longer.param) {
    return {
      span: longer.param.span,
      message: `引数 ${longer.param.name} の型の参照に、ライフタイム ${shorter.name} を書いてください（E0621）。`,
    };
  }
  if (longer.anonymous || shorter.anonymous) {
    return {
      span,
      message:
        'ライフタイムが足りません。返す参照が、戻り値の型が示す引数とは別の引数から借りたものです（ライフタイムを書いて、どの引数から借りるのかを示してください）。',
    };
  }
  return {
    span,
    message: `ライフタイムが足りません。${longer.name} の参照を ${shorter.name} の参照として使っていますが、${longer.name}: ${shorter.name} が宣言されていません。`,
  };
}

/**
 * The error when a reference from a parameter must outlive `'static`, as a `T: 'static` bound or storing it in a trait
 * object without a lifetime (`Box<dyn Trait>`) needs.
 */
export function staticInputError(
  outlives: readonly (readonly [RVar, RVar])[],
  inputRegions: readonly RVar[][],
  staticRegion: RVar | undefined,
  span: Span,
  budget: ExecutionBudget
): LoanError | undefined {
  if (staticRegion === undefined || inputRegions.length === 0) return undefined;
  budget.spend(outlives.length);
  const edges = outlivesEdges(outlives);
  const reachable = new Set([staticRegion]);
  for (const region of reachable) for (const next of edges.get(region) ?? []) reachable.add(next);
  const reached = inputRegions.some((regions) =>
    regions.some((region) => region !== staticRegion && reachable.has(region))
  );
  return reached
    ? {
        span,
        message:
          "ライフタイムが足りません。引数から借りた参照を、'static が必要なところ（T: 'static の制約や、Box<dyn Trait> のようにライフタイムを書いていないトレイトオブジェクト）で使っています。",
      }
    : undefined;
}

/** For each region, the regions that must outlive it. */
function outlivesEdges(outlives: readonly (readonly [RVar, RVar])[]): Map<RVar, RVar[]> {
  const edges = new Map<RVar, RVar[]>();
  for (const [sup, sub] of outlives) {
    const destinations = edges.get(sub);
    if (destinations) destinations.push(sup);
    else edges.set(sub, [sup]);
  }
  return edges;
}

/** Where a body gives its value: its last expression or statement. */
function bodyResultSpan(body: Expr): Span {
  if (body.kind !== 'block') return body.span;
  return body.tail?.span ?? body.stmts.at(-1)?.span ?? body.span;
}
