import type { FunctionContext, ProductSource, VarEntity } from './entities';
import { gateFacts, type Operand, type SsaConstant, type SsaFields, type StaticValue } from './operand';
import { isFloat } from './types';

/**
 * The value of each variable that reaches a use as Go's SSA form sees it, which decides where its compiler folds
 * constants and fuses products: the single definition reaching the use through straight-line code, forgotten where
 * paths join or a loop may write the variable again. A package-level variable is memory, whose last store Go's
 * compiler forwards to a load past at most three other stores to distinct variables, but not past a call or a store
 * through a pointer.
 */

export interface SsaValues {
  definitions: Map<VarEntity, Definition>;
  /** The branching statements and loops being compiled, innermost last. */
  regions: Region[];
  /** The stores to memory so far. */
  stores: number;
  versions: number;
  labelJoins: Map<string, LabelJoin>;
}

interface LabelJoin {
  incoming: Map<VarEntity, Definition>[];
}

export interface Definition extends Negations {
  sources?: () => readonly (Definition | undefined)[];
  constant?: SsaConstant;
  fields?: SsaFields;
  /** The hidden slots holding the factors of the multiplication the value is, which an addition using it fuses. */
  factors?: ProductFactors;
  /** The number of regions the definition lies in. */
  depth: number;
  stores: number;
  /** Tells definitions apart, as Go's common subexpression elimination tells values apart. */
  version: number;
}

export interface ProductFactors {
  left: number;
  right: number;
  source: ProductSource;
  /** Whether the product still reaches the use, decided once the whole function is compiled. */
  enabled?: () => boolean;
}

interface Region {
  loop: boolean;
  /** The variables the region writes, and MEMORY when it stores to memory or calls a function. */
  written: Set<VarEntity | typeof MEMORY>;
}

/** The value a use of a variable sees. */
export interface ReachingValue extends Negations {
  constant?: SsaConstant;
  fields?: SsaFields;
  factors?: ProductFactors;
  version?: number;
}

/** Which of a value's parts Go's compiler computes as negations, which makes a product of them FNMULD. */
type Negations = Pick<Operand, 'negation' | 'partNegations'>;

const MEMORY = Symbol('memory');
/** The other stores Go's load forwarding rules look through (generic.rules, `Load` of `Store`). */
const FORWARDED_STORES = 3;

export function newSsaValues(): SsaValues {
  return { definitions: new Map(), regions: [], stores: 0, versions: 0, labelJoins: new Map() };
}

export function recordGoto(fn: FunctionContext | undefined, label: string): void {
  if (!fn) return;
  labelJoin(fn.ssa, label).incoming.push(new Map(fn.ssa.definitions));
}

export function enterLabel(fn: FunctionContext | undefined, label: string, fallsThrough: boolean): boolean {
  if (!fn) return fallsThrough;
  const ssa = fn.ssa;
  const join = labelJoin(ssa, label);
  if (fallsThrough) join.incoming.push(new Map(ssa.definitions));
  const chosen = join.incoming[0] ?? ssa.definitions;
  ssa.definitions = new Map(
    [...chosen].map(([variable, definition]) => [variable, labelDefinition(ssa, join, variable, definition)])
  );
  return join.incoming.length > 0;
}

function labelJoin(ssa: SsaValues, label: string): LabelJoin {
  let join = ssa.labelJoins.get(label);
  if (!join) {
    join = { incoming: [] };
    ssa.labelJoins.set(label, join);
  }
  return join;
}

function labelDefinition(ssa: SsaValues, join: LabelJoin, variable: VarEntity, fallback: Definition): Definition {
  const sources = (): (Definition | undefined)[] => join.incoming.map((source) => source.get(variable));
  const resolve = (): Definition | undefined => uniqueDefinition(sources());
  const unresolvedVersion = ++ssa.versions;
  let checking = false;
  const check = (run: (definition: Definition) => boolean): boolean => {
    if (checking) return false;
    checking = true;
    try {
      const definition = resolve();
      return definition ? run(definition) : false;
    } finally {
      checking = false;
    }
  };
  const factors: ProductFactors | undefined = isFloat(variable.type)
    ? {
        get left() {
          return resolve()?.factors?.left ?? -1;
        },
        get right() {
          return resolve()?.factors?.right ?? -1;
        },
        source: {
          get order() {
            return resolve()?.factors?.source.order ?? 0;
          },
          get count() {
            return resolve()?.factors?.source.count ?? 0;
          },
        },
        enabled: () =>
          check((definition) => definition.factors !== undefined && (definition.factors.enabled?.() ?? true)),
      }
    : undefined;
  return {
    ...fallback,
    sources,
    depth: ssa.regions.length,
    get version() {
      return resolve()?.version ?? unresolvedVersion;
    },
    constant: (params) => check((definition) => definition.constant?.(params) ?? false),
    factors,
    fields:
      fallback.fields &&
      gateFacts({ ssaFields: fallback.fields }, () => resolve()?.version === fallback.version).ssaFields,
    negation: () => check((definition) => definition.negation?.() ?? false),
    partNegations: fallback.partNegations?.map(
      (_, index) => () => check((definition) => definition.partNegations?.[index]?.() ?? false)
    ) as Negations['partNegations'],
  };
}

function uniqueDefinition(sources: readonly (Definition | undefined)[]): Definition | undefined {
  const stack = [...sources];
  const seen = new Set<Definition>();
  let result: Definition | undefined;
  while (stack.length > 0) {
    const definition = stack.pop();
    if (!definition) return undefined;
    if (seen.has(definition)) continue;
    seen.add(definition);
    if (definition.sources) {
      for (const source of definition.sources()) stack.push(source);
    } else if (result && result.version !== definition.version) return undefined;
    else result = definition;
  }
  return result;
}

/**
 * Records a write of a variable, with what Go's compiler knows of the value written: what its SSA form sees, and for
 * the first definition, what it resolves the value to (`static`).
 */
export function define(
  fn: FunctionContext | undefined,
  variable: VarEntity,
  {
    static: resolved,
    ...value
  }: Negations & {
    constant?: SsaConstant;
    fields?: SsaFields;
    factors?: ProductFactors;
    static?: StaticValue;
  } = {}
): void {
  if (variable.defined) variable.reassigned = true;
  else variable.static = resolved;
  variable.defined = true;
  if (!fn) return;
  const ssa = fn.ssa;
  if (!variable.owner) ssa.stores++;
  for (const region of ssa.regions) {
    region.written.add(variable);
    if (!variable.owner) region.written.add(MEMORY);
  }
  ssa.definitions.set(variable, { ...value, depth: ssa.regions.length, stores: ssa.stores, version: ++ssa.versions });
}

/** Records a call or a store that may change any package-level variable. */
export function clobberMemory(fn: FunctionContext | undefined): void {
  if (!fn) return;
  for (const variable of fn.ssa.definitions.keys()) if (!variable.owner) fn.ssa.definitions.delete(variable);
  for (const region of fn.ssa.regions) region.written.add(MEMORY);
}

/**
 * Records a store into part of a local variable, which Go's compiler tells apart from package-level variables; the
 * constants the variable held no longer reach later uses.
 */
export function storeLocalMemory(fn: FunctionContext | undefined, variable: VarEntity): void {
  if (!fn) return;
  fn.ssa.stores++;
  const definition = fn.ssa.definitions.get(variable);
  if (!definition?.constant && !definition?.fields) return;
  fn.ssa.definitions.set(variable, { ...definition, constant: undefined, fields: undefined });
  for (const region of fn.ssa.regions) region.written.add(variable);
}

// code-gauge-allow functionCognitiveComplexity 17 -- Keeps reaching definitions, joins and lazy fact gates in one compiler analysis.
export function reachingValue(fn: FunctionContext | undefined, variable: VarEntity): ReachingValue {
  const definition = fn?.ssa.definitions.get(variable);
  if (!fn || !definition) return {};
  const { constant, factors, fields, version, negation, partNegations } = definition;
  if (!variable.owner && fn.ssa.stores - definition.stores > FORWARDED_STORES) return { version };
  const local = variable.owner !== undefined;
  const loops = fn.ssa.regions.slice(definition.depth).filter((region) => region.loop);
  const reaches = (): boolean =>
    (!local || !variable.boxed || capturedByValue(variable)) &&
    loops.every(({ written }) => !written.has(variable) && (local || !written.has(MEMORY)));
  return {
    constant: constant && ((frame) => reaches() && constant(frame)),
    factors: factors && {
      get left() {
        return factors.left;
      },
      get right() {
        return factors.right;
      },
      get source() {
        return factors.source;
      },
      enabled: () => reaches() && (factors.enabled?.() ?? true),
    },
    fields: fields && gateFacts({ ssaFields: fields }, reaches).ssaFields,
    negation: negation && ((): boolean => reaches() && negation()),
    partNegations: partNegations?.map(
      (part) => part && ((): boolean => reaches() && part())
    ) as Negations['partNegations'],
    version,
  };
}

/**
 * Whether closures capture a copy of the variable, which stays out of memory: Go's compiler captures a variable that
 * the program never assigns after its declaration or takes the address of by value (capturevars in escape analysis).
 */
function capturedByValue(variable: VarEntity): boolean {
  return variable.captured === true && !variable.addressTaken && !variable.reassigned;
}

/**
 * Compiles a statement whose paths join afterwards: the branches of an `if` or `switch`, or a loop, which may run its
 * body again with the values written there. `compile` receives a function that starts another branch from the
 * values reaching the statement, or for a branch other branches fall into, from those values the region does not write. Afterwards, a variable written in the statement has no single definition.
 */
export function joining<T>(
  fn: FunctionContext | undefined,
  loop: boolean,
  compile: (branch: (fallsInto?: boolean) => void) => T
): T {
  if (!fn) return compile(() => {});
  const ssa = fn.ssa;
  const region: Region = { loop, written: new Set() };
  ssa.regions.push(region);
  const saved = new Map(ssa.definitions);
  const branch = (fallsInto = false): void => {
    ssa.definitions = new Map(saved);
    // A branch that another falls into joins the values written before.
    if (fallsInto) forgetWritten(ssa, region);
  };
  try {
    return compile(branch);
  } finally {
    ssa.regions.pop();
    forgetWritten(ssa, region);
  }
}

function forgetWritten(ssa: SsaValues, region: Region): void {
  for (const variable of region.written) {
    if (variable === MEMORY) {
      for (const other of ssa.definitions.keys()) if (!other.owner) ssa.definitions.delete(other);
    } else if (variable.owner) {
      ssa.definitions.set(variable, { depth: ssa.regions.length, stores: ssa.stores, version: ++ssa.versions });
    }
  }
}
