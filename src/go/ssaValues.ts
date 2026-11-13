/**
 * The value of each variable that reaches a use as Go's SSA form sees it, which decides where its compiler folds
 * constants and fuses products: the single definition reaching the use through straight-line code, forgotten where
 * paths join or a loop may write the variable again. A package-level variable is memory, whose last store Go's
 * compiler forwards to a load past at most three other stores to distinct variables, but not past a call or a store
 * through a pointer.
 */
import type { FunctionContext, ProductSource, VarEntity } from './entities';
import type { SsaConstant } from './operand';

export interface SsaValues {
  definitions: Map<VarEntity, Definition>;
  /** The branching statements and loops being compiled, innermost last. */
  regions: Region[];
  /** The stores to memory so far. */
  stores: number;
  versions: number;
}

export interface Definition {
  constant?: SsaConstant;
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
export interface ReachingValue {
  constant?: SsaConstant;
  factors?: ProductFactors;
  version?: number;
}

const MEMORY = Symbol('memory');
/** The other stores Go's load forwarding rules look through (generic.rules, `Load` of `Store`). */
const FORWARDED_STORES = 3;

export function newSsaValues(): SsaValues {
  return { definitions: new Map(), regions: [], stores: 0, versions: 0 };
}

/** Records a write of a variable, with what Go's compiler knows of the value written. */
export function define(
  fn: FunctionContext | undefined,
  variable: VarEntity,
  value: { constant?: SsaConstant; factors?: ProductFactors } = {}
): void {
  if (variable.defined) variable.reassigned = true;
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

/** Records a store into a local variable's memory, which Go's compiler tells apart from package-level variables. */
export function storeLocalMemory(fn: FunctionContext | undefined): void {
  if (fn) fn.ssa.stores++;
}

export function reachingValue(fn: FunctionContext | undefined, variable: VarEntity): ReachingValue {
  const definition = fn?.ssa.definitions.get(variable);
  if (!fn || !definition) return {};
  const { constant, factors, version } = definition;
  if (!variable.owner && fn.ssa.stores - definition.stores > FORWARDED_STORES) return { version };
  const local = variable.owner !== undefined;
  const loops = fn.ssa.regions.slice(definition.depth).filter((region) => region.loop);
  const reaches = (): boolean =>
    (!local || !variable.boxed || capturedByValue(variable)) &&
    loops.every(({ written }) => !written.has(variable) && (local || !written.has(MEMORY)));
  return {
    constant: constant && ((frame) => reaches() && constant(frame)),
    factors: factors && { ...factors, enabled: () => reaches() && (factors.enabled?.() ?? true) },
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
