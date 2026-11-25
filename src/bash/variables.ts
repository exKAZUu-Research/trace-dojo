// code-gauge-allow-file fileNcss -- Encapsulates VariableStore scopes, private cells, transactional writes, eager subshell fork, PRNG, and dynamic read descriptors in one single-writer module.
import {
  ASSOCIATIVE_BUCKETS,
  AssociativeTable,
  type CompoundElement,
  IndexedTable,
  isIdentifier,
  isValidFunctionName,
  maxElementIndex,
  readAssociativePair,
  type ReadonlyAssociativeTable,
  type ReadonlyIndexedTable,
  sortedElements,
  unpackIndexedElement,
} from './associativeTable';
import { chargeStoreCopy, chargeStoreString } from './budget';
import {
  type Attribute,
  ATTRIBUTE_ORDER,
  DYNAMIC_VARIABLES,
  ENVIRONMENT_VARIABLES,
  type ExistingCellShape,
  rejectSelfReferencingCompound,
  rejectUnsupportedNamerefDeclaration,
  rejectUnsupportedNamerefDereference,
  rejectUnsupportedNamerefMutation,
  rejectUnsupportedNamerefShadowing,
  rejectUnsupportedNamerefTarget,
  rejectUnsupportedPrefixListing,
  rejectUnsupportedSpecialVariable,
  rejectUnsupportedVariableMutation,
  rejectUnsupportedVariableRead,
  SCALAR_DYNAMIC_VARIABLES,
  UNSUPPORTED_SPECIAL_VARIABLES,
} from './capabilities';
import type { StoreFailure, StoreOutcome } from './failurePolicy';
import { BASH_VERSION, type FunctionDefinition, type Runtime } from './runtime';

export {
  ASSOCIATIVE_BUCKETS,
  AssociativeTable,
  type CompoundElement,
  IndexedTable,
  isIdentifier,
  isValidFunctionName,
  maxElementIndex,
  readAssociativePair,
  type ReadonlyAssociativeTable,
  type ReadonlyIndexedTable,
  sortedElements,
  unpackIndexedElement,
};
export { type Attribute, ATTRIBUTE_ORDER, DYNAMIC_VARIABLES, ENVIRONMENT_VARIABLES, SCALAR_DYNAMIC_VARIABLES };

type CellValue =
  | { kind: 'scalar'; value: string }
  | { kind: 'indexed'; elements: IndexedTable }
  | { kind: 'associative'; table: AssociativeTable };

interface Cell {
  readonly name: string;
  value: CellValue | undefined;
  attributes: Set<Attribute>;
  isSystem: boolean;
  userAssigned: boolean;
  nullReference: boolean;
}

interface ScopeEntry {
  readonly kind: 'global' | 'function' | 'temp';
  readonly map: Map<string, Cell>;
}

export interface CallFrameEntry {
  readonly name: string;
  readonly line: number;
}

/** Immutable read-only snapshot of a variable cell or synthesized dynamic descriptor. */
export interface VariableView {
  readonly name: string;
  readonly attributes: ReadonlySet<Attribute>;
  readonly kind: 'unset' | 'scalar' | 'indexed' | 'associative';
  readonly scalar?: string;
  readonly indexed?: ReadonlyIndexedTable;
  readonly associative?: ReadonlyAssociativeTable;
  readonly isSystem: boolean;
  readonly userAssigned: boolean;
  readonly nullReference: boolean;
  readonly isCurrentLocal: boolean;
}

export type DestinationIntent = 'local' | 'global' | 'visible';

export type IntEvaluator = (expression: string) => bigint | undefined;

export interface NamedWriteOptions {
  readonly intent?: DestinationIntent;
  readonly append?: boolean;
  readonly evalInt: IntEvaluator;
  readonly reportedName?: string;
}

export interface CompoundWriteHooks {
  readonly append: boolean;
  readonly reportedName?: string;
  readonly evalIndex: (resolvedName: string, rawKey: string) => bigint | undefined;
  readonly evalInt: IntEvaluator;
  readonly onItemError: (message: string) => void;
}

export interface CompoundWriteRequest {
  readonly resolvedName: string;
  readonly intent: DestinationIntent;
  readonly isAssoc: boolean;
  readonly preAttrs: ReadonlySet<Attribute>;
  readonly postReadonly: boolean;
  readonly elements: CompoundElement[];
  readonly hooks: CompoundWriteHooks;
}

export interface ScalarDeclarationRequest {
  readonly builtin: string;
  readonly targetName: string;
  readonly intent: DestinationIntent;
  readonly effectiveSet: ReadonlySet<Attribute>;
  readonly value: string | undefined;
  readonly append: boolean;
  readonly evalInt: IntEvaluator;
}

class RandomStream {
  constructor(
    private seed = initialRandomSeed(),
    private lastValue = 0,
    private subshellDraws = 0
  ) {}

  next(): number {
    let current = this.seed;
    let value: number;
    do {
      current = current === 0 ? 123_459_876 : current;
      const high = Math.trunc(current / 127_773);
      const low = current % 127_773;
      current = 16_807 * low - 2836 * high;
      if (current < 0) current += 0x7f_ff_ff_ff;
      value = ((current >>> 16) ^ (current & 0xff_ff)) & 0x7f_ff;
    } while (value === this.lastValue);
    this.seed = current;
    this.lastValue = value;
    return value;
  }

  reseed(uint32Seed: number): void {
    this.seed = uint32Seed;
    this.lastValue = 0;
    this.subshellDraws = 0;
  }

  fork(childSubshellLevel: number): RandomStream {
    const childIndex = ++this.subshellDraws;
    return new RandomStream(deriveSubshellSeed(this.seed, childIndex, childSubshellLevel), 0, 0);
  }
}

function initialRandomSeed(): number {
  return Math.floor(Math.random() * 0x7f_ff_ff_fe) + 1;
}

function deriveSubshellSeed(parentSeed: number, subshellIndex: number, subshellLevel: number): number {
  let h =
    (Math.imul(parentSeed, 0x9e_37_79_b1) ^
      Math.imul(subshellIndex, 0x85_eb_ca_6b) ^
      Math.imul(subshellLevel, 0xc2_b2_ae_35)) >>>
    0;
  h = Math.imul(h ^ (h >>> 16), 0x7f_eb_35_2d) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return (h % 0x7f_ff_ff_fe) + 1;
}

/**
 * Single owner and single writer of Bash scopes, private variable cells, functions, positional parameters,
 * call stack metadata, regex captures, active compound-initializer guards, and PRNG streams.
 */
export class VariableStore {
  private readonly scopes: ScopeEntry[];
  private readonly functions: Map<string, FunctionDefinition>;
  private readonly positional: string[][];
  private readonly calls: CallFrameEntry[];
  private readonly compoundGuards: { name: string; blockReads: boolean }[] = [];
  private rematch: string[] | undefined;
  private readonly prng: RandomStream;
  lastStatus = 0;
  lastArgument: string | undefined;
  private readonly subshellLevel: number;

  constructor(
    private readonly runtime: Runtime,
    private currentLine: () => number,
    forked?: {
      scopes: ScopeEntry[];
      functions: Map<string, FunctionDefinition>;
      positional: string[][];
      calls: CallFrameEntry[];
      rematch: string[] | undefined;
      prng: RandomStream;
      lastStatus: number;
      lastArgument: string | undefined;
      subshellLevel: number;
    }
  ) {
    if (forked) {
      this.scopes = forked.scopes;
      this.functions = forked.functions;
      this.positional = forked.positional;
      this.calls = forked.calls;
      this.rematch = forked.rematch;
      this.prng = forked.prng;
      this.lastStatus = forked.lastStatus;
      this.lastArgument = forked.lastArgument;
      this.subshellLevel = forked.subshellLevel;
      return;
    }
    this.scopes = [{ kind: 'global', map: new Map() }];
    this.functions = new Map();
    this.positional = [[]];
    this.calls = [];
    this.rematch = undefined;
    this.prng = new RandomStream();
    this.subshellLevel = 0;
    this.initSystemVariables();
  }

  setLineReader(reader: () => number): void {
    this.currentLine = reader;
  }

  private initSystemVariables(): void {
    const defineSystem = (name: string, value: CellValue, attrs: Attribute[] = []): void => {
      this.scopes[0].map.set(name, createCell(name, value, attrs, true, false));
    };
    defineSystem('IFS', { kind: 'scalar', value: ' \t\n' });
    defineSystem('PS4', { kind: 'scalar', value: '+ ' });
    defineSystem('OPTIND', { kind: 'scalar', value: '1' });
    defineSystem('OPTERR', { kind: 'scalar', value: '1' });
    defineSystem('BASH_VERSION', { kind: 'scalar', value: BASH_VERSION });
    defineSystem(
      'BASH_VERSINFO',
      {
        kind: 'indexed',
        elements: new IndexedTable(
          ['5', '3', '0', '1', 'release', 'x86_64-pc-linux-gnu'].map((v, i) => [BigInt(i), v])
        ),
      },
      ['a', 'r']
    );
  }

  // ---------------------------------------------------------------- eager metered fork & scopes

  /** Creates an isolated child `VariableStore` for `$(...)` via an eager metered full copy of all scopes and containers. */
  fork(childLineReader: () => number): VariableStore {
    const spend = (cost?: number): void => this.runtime.spend(cost);
    const alloc = (count: number): void => this.runtime.allocateSlots(count);
    const clonedScopes: ScopeEntry[] = this.scopes.map((entry) => {
      const map = new Map<string, Cell>();
      for (const [name, cell] of entry.map) {
        map.set(name, cloneCellEager(cell, spend, alloc));
      }
      return { kind: entry.kind, map };
    });
    chargeStoreCopy(this.functions.size + this.calls.length + (this.rematch?.length ?? 0), spend, alloc);
    const positional = this.positional.map((args) => {
      chargeStoreCopy(args.length, spend, alloc);
      return [...args];
    });
    const nextLevel = this.subshellLevel + 1;
    return new VariableStore(this.runtime, childLineReader, {
      scopes: clonedScopes,
      functions: new Map(this.functions),
      positional,
      calls: this.calls.map((c) => ({ ...c })),
      rematch: this.rematch ? [...this.rematch] : undefined,
      prng: this.prng.fork(nextLevel),
      lastStatus: this.lastStatus,
      lastArgument: this.lastArgument,
      subshellLevel: nextLevel,
    });
  }

  get isInFunction(): boolean {
    return this.currentFunctionScopeIndex() !== undefined;
  }

  get topScopeIndex(): number {
    return this.scopes.length - 1;
  }

  compoundGuardDepth(): number {
    return this.compoundGuards.length;
  }

  enterCompoundGuard(resolvedName: string, blockReads = true): number {
    this.guardCompoundMutation(resolvedName);
    const saved = this.compoundGuards.length;
    this.compoundGuards.push({ name: resolvedName, blockReads });
    return saved;
  }

  leaveCompoundGuards(savedDepth: number): void {
    this.compoundGuards.length = savedDepth;
  }

  guardCompoundRead(name: string): void {
    if (this.compoundGuards.some((g) => g.name === name && g.blockReads)) {
      rejectSelfReferencingCompound(name);
    }
  }

  guardCompoundMutation(name: string): void {
    if (this.compoundGuards.some((g) => g.name === name)) {
      rejectSelfReferencingCompound(name);
    }
  }

  /** Whether an enclosing command-prefix `'temp'` scope binds `name`. */
  hasTemporaryBinding(name: string): boolean {
    for (let i = this.scopes.length - 1; i >= 1; i--) {
      if (this.scopes[i].kind === 'temp' && this.scopes[i].map.has(name)) return true;
    }
    return false;
  }

  pushFunctionScope(fnName: string, callLine: number, args: string[]): number {
    this.scopes.push({ kind: 'function', map: new Map() });
    const scopeIndex = this.scopes.length - 1;
    this.positional.push([...args]);
    this.calls.push({ name: fnName, line: callLine });
    this.runtime.allocateSlots(args.length + 1);
    return scopeIndex;
  }

  popFunctionScope(scopeIndex: number): void {
    this.calls.pop();
    this.positional.pop();
    this.scopes.length = scopeIndex;
  }

  pushTemporaryScope(): number {
    this.scopes.push({ kind: 'temp', map: new Map() });
    return this.scopes.length - 1;
  }

  popTemporaryScope(scopeIndex: number): void {
    if (!this.scopes[scopeIndex]) return;
    this.scopes.splice(scopeIndex, 1);
  }

  bindTemporaryScalar(scopeIndex: number, name: string, value: string, append: boolean): StoreFailure | undefined {
    this.guardCompoundMutation(name);
    rejectUnsupportedVariableMutation(name, false);
    const existing = this.findOwnCell(name);
    if (existing?.attributes.has('r')) {
      return { ok: false, reason: 'readonly', message: `${name}: readonly variable` };
    }
    const base = append ? (this.readScalar(name) ?? '') : '';
    const combined = base + value;
    this.chargeString(combined);
    const map = this.scopes[scopeIndex].map;
    if (!map.has(name)) this.runtime.allocateSlots(1);
    map.set(name, createCell(name, { kind: 'scalar', value: combined }, ['x'], false, true));
    return undefined;
  }

  // ---------------------------------------------------------------- functions, positional, PRNG

  getFunction(name: string): FunctionDefinition | undefined {
    return this.functions.get(name);
  }

  hasFunction(name: string): boolean {
    return this.functions.has(name);
  }

  setFunction(fn: FunctionDefinition): void {
    if (!this.functions.has(fn.name)) this.runtime.allocateSlots(1);
    this.functions.set(fn.name, fn);
  }

  deleteFunction(name: string): boolean {
    return this.functions.delete(name);
  }

  positionalArgs(): readonly string[] {
    return this.positional.at(-1) as string[];
  }

  setPositionalArgs(args: readonly string[]): void {
    this.runtime.allocateSlots(args.length);
    for (const arg of args) this.chargeString(arg);
    const current = this.positional.at(-1) as string[];
    current.splice(0, current.length, ...args);
  }

  shiftPositionalArgs(count: number): boolean {
    const current = this.positional.at(-1) as string[];
    if (count > current.length) return false;
    current.splice(0, count);
    return true;
  }

  setRematch(elements: readonly string[]): void {
    this.runtime.allocateSlots(elements.length);
    for (const element of elements) this.chargeString(element);
    this.rematch = [...elements];
  }

  seedRandom(seedValue: bigint): void {
    this.prng.reseed(Number(BigInt.asUintN(32, seedValue)));
  }

  // ---------------------------------------------------------------- lookup & single-hop nameref resolution

  isDynamic(name: string): boolean {
    if (this.findOwnCell(name)) return false;
    return name === 'BASH_REMATCH' ? this.rematch !== undefined : DYNAMIC_VARIABLES.has(name);
  }

  /** Resolves a variable name across at most one function-local nameref hop, enforcing capability invariants. */
  resolveTargetName(name: string): string {
    this.guardCompoundRead(name);
    const found = this.findOwnCellWithScope(name);
    if (!found || !found.cell.attributes.has('n')) return name;
    const target = found.cell.value?.kind === 'scalar' ? found.cell.value.value : '';
    this.guardCompoundRead(target);
    const targetFound = this.findOwnCellWithScope(target);
    rejectUnsupportedNamerefDereference(name, target, targetFound ? cellShapeOf(targetFound.cell) : undefined);
    return target;
  }

  ownView(name: string, maxScopeIndex = this.scopes.length - 1): VariableView | undefined {
    this.guardCompoundRead(name);
    const cell = this.findOwnCell(name, maxScopeIndex);
    return cell ? this.cellToView(cell) : undefined;
  }

  priorViewAtIntent(name: string, intent: DestinationIntent): VariableView | undefined {
    if (intent === 'global') return this.ownView(name, 0);
    const own = this.ownView(name);
    return intent === 'local' ? (own?.isCurrentLocal ? own : undefined) : own;
  }

  /** Returns a readonly failure if creating a new local variable in the current function would shadow an outer readonly variable. */
  outerReadonlyFailure(name: string): StoreFailure | undefined {
    const fnIdx = this.currentFunctionScopeIndex();
    if (fnIdx === undefined || this.scopes[fnIdx].map.has(name)) return undefined;
    const outer = this.findOwnCell(name, fnIdx - 1);
    return outer?.attributes.has('r')
      ? { ok: false, reason: 'readonly', message: `${name}: readonly variable` }
      : undefined;
  }

  dynamicView(name: string): VariableView | undefined {
    rejectUnsupportedVariableRead(name);
    if (!this.isDynamic(name)) return undefined;
    if (SCALAR_DYNAMIC_VARIABLES.has(name)) {
      const attributes = new Set<Attribute>(name === 'RANDOM' ? ['i'] : []);
      return {
        name,
        attributes,
        kind: 'scalar',
        scalar: this.readDynamicScalar(name) ?? '',
        isSystem: true,
        userAssigned: false,
        nullReference: false,
        isCurrentLocal: false,
      };
    }
    const elements = this.readDynamicElements(name);
    return {
      name,
      attributes: new Set<Attribute>(['a']),
      ...(elements ? { kind: 'indexed', indexed: elements } : { kind: 'unset' }),
      isSystem: true,
      userAssigned: false,
      nullReference: false,
      isCurrentLocal: false,
    };
  }

  /** Reads scalar value (or element `0` of an array) through the single post-dereference gate. */
  readScalar(name: string): string | undefined {
    const resolved = this.resolveTargetName(name);
    rejectUnsupportedVariableRead(resolved);
    const cell = this.findOwnCell(resolved);
    if (cell) return cellScalarZero(cell.value);
    if (this.isDynamic(resolved)) return this.readDynamicScalar(resolved);
    return undefined;
  }

  isArrayName(resolvedName: string): boolean {
    const cell = this.findOwnCell(resolvedName);
    if (cell) return isArrayCell(cell);
    return this.isDynamic(resolvedName) && !SCALAR_DYNAMIC_VARIABLES.has(resolvedName);
  }

  isAssociativeName(resolvedName: string): boolean {
    const cell = this.findOwnCell(resolvedName);
    return cell?.value?.kind === 'associative' || cell?.attributes.has('A') === true;
  }

  hasIndirectContainer(resolvedName: string): boolean {
    this.guardCompoundRead(resolvedName);
    rejectUnsupportedVariableRead(resolvedName);
    const cell = this.findOwnCell(resolvedName);
    if (cell) return !cell.attributes.has('n');
    return this.isDynamic(resolvedName);
  }

  hasMaterializedTarget(resolvedName: string): boolean {
    this.guardCompoundRead(resolvedName);
    rejectUnsupportedVariableRead(resolvedName);
    const cell = this.findOwnCell(resolvedName);
    if (cell) return cell.value !== undefined;
    if (!this.isDynamic(resolvedName)) return false;
    return resolvedName !== 'FUNCNAME' || this.calls.length > 0;
  }

  translateNegativeIndex(resolvedName: string, index: bigint, allowScalarWrite: boolean): bigint | undefined {
    rejectUnsupportedVariableRead(resolvedName);
    const cell = this.findOwnCell(resolvedName);
    let length = 0n;
    if (cell?.value?.kind === 'indexed') {
      length = maxElementIndex(cell.value.elements) + 1n;
    } else if (!cell && this.isDynamic(resolvedName)) {
      if (SCALAR_DYNAMIC_VARIABLES.has(resolvedName)) length = 1n;
      else {
        const elems = this.readDynamicElements(resolvedName);
        if (elems && elems.size > 0) length = maxElementIndex(elems) + 1n;
      }
    } else if (
      allowScalarWrite &&
      cell !== undefined &&
      !cell.attributes.has('a') &&
      !cell.attributes.has('A') &&
      cell.value?.kind !== 'associative'
    ) {
      length = 1n;
    }
    const resolved = length + index;
    return resolved < 0n ? undefined : resolved;
  }

  readAssociativeElement(resolvedName: string, key: string): string | undefined {
    this.guardCompoundRead(resolvedName);
    rejectUnsupportedVariableRead(resolvedName);
    const cell = this.findOwnCell(resolvedName);
    return cell?.value?.kind === 'associative' ? cell.value.table.get(key) : undefined;
  }

  readIndexedElement(resolvedName: string, index: bigint): string | undefined {
    this.guardCompoundRead(resolvedName);
    rejectUnsupportedVariableRead(resolvedName);
    const cell = this.findOwnCell(resolvedName);
    if (cell?.value) return cellElementAt(cell.value, index);
    if (this.isDynamic(resolvedName)) {
      return SCALAR_DYNAMIC_VARIABLES.has(resolvedName)
        ? index === 0n
          ? this.readDynamicScalar(resolvedName)
          : undefined
        : this.readDynamicElements(resolvedName)?.get(index);
    }
    return undefined;
  }

  readArrayLength(resolvedName: string): number {
    this.guardCompoundRead(resolvedName);
    rejectUnsupportedVariableRead(resolvedName);
    const cell = this.findOwnCell(resolvedName);
    if (cell?.value) return cellElementCount(cell.value);
    if (this.isDynamic(resolvedName)) {
      if (SCALAR_DYNAMIC_VARIABLES.has(resolvedName)) return 1;
      return this.readDynamicElements(resolvedName)?.size ?? 0;
    }
    return 0;
  }

  readArrayValues(resolvedName: string): string[] {
    this.guardCompoundRead(resolvedName);
    rejectUnsupportedVariableRead(resolvedName);
    const cell = this.findOwnCell(resolvedName);
    if (cell?.value) return cellElementValues(cell.value);
    if (this.isDynamic(resolvedName)) {
      if (SCALAR_DYNAMIC_VARIABLES.has(resolvedName)) return [this.readDynamicScalar(resolvedName) as string];
      const elems = this.readDynamicElements(resolvedName);
      return elems ? sortedElements(elems).map(([, v]) => v) : [];
    }
    return [];
  }

  readArrayKeys(resolvedName: string): string[] {
    this.guardCompoundRead(resolvedName);
    rejectUnsupportedVariableRead(resolvedName);
    const cell = this.findOwnCell(resolvedName);
    if (cell?.value) return cellElementKeys(cell.value);
    if (this.isDynamic(resolvedName)) {
      if (SCALAR_DYNAMIC_VARIABLES.has(resolvedName)) return ['0'];
      const elems = this.readDynamicElements(resolvedName);
      return elems ? sortedElements(elems).map(([k]) => String(k)) : [];
    }
    return [];
  }

  namesWithPrefix(prefix: string): string[] {
    const names = this.collectScopedPrefixNames(prefix);
    this.rejectUnsupportedPrefixQuery(prefix);
    return [...names].toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  // ---------------------------------------------------------------- transactional writes, declarations, & unsets

  writeScalarNamed(resolvedName: string, rawText: string, opts: NamedWriteOptions): StoreOutcome {
    this.guardCompoundMutation(resolvedName);
    rejectUnsupportedVariableMutation(resolvedName, false);
    const cell = this.getOrCreateDestination(opts.intent ?? 'visible', resolvedName);
    return this.writeScalarCell(cell, rawText, Boolean(opts.append), opts.evalInt, opts.reportedName);
  }

  writeAssociativeElementNamed(
    resolvedName: string,
    key: string,
    rawText: string,
    opts: NamedWriteOptions
  ): StoreOutcome {
    this.guardCompoundMutation(resolvedName);
    rejectUnsupportedVariableMutation(resolvedName, false);
    const cell = this.getOrCreateDestination(opts.intent ?? 'visible', resolvedName, 'associative');
    return this.writeMapEntry(
      cell,
      key,
      { rawText, append: Boolean(opts.append), evalInt: opts.evalInt, reportedName: opts.reportedName },
      (target) => this.ensureAssociativeTable(target)
    );
  }

  writeIndexedElementNamed(
    resolvedName: string,
    index: bigint,
    rawText: string,
    opts: NamedWriteOptions
  ): StoreOutcome {
    this.guardCompoundMutation(resolvedName);
    rejectUnsupportedVariableMutation(resolvedName, false);
    const cell = this.getOrCreateDestination(opts.intent ?? 'visible', resolvedName);
    return this.writeMapEntry(
      cell,
      index,
      { rawText, append: Boolean(opts.append), evalInt: opts.evalInt, reportedName: opts.reportedName },
      (target) => this.ensureIndexedMap(target)
    );
  }

  writeCompoundNamed(req: CompoundWriteRequest): { outcome: StoreOutcome; materializedArray: boolean } {
    const { resolvedName, intent, isAssoc, preAttrs, postReadonly, elements, hooks } = req;
    this.guardCompoundMutation(resolvedName);
    rejectUnsupportedVariableMutation(resolvedName, false);
    if (intent === 'local') this.rejectLocalShadowingNamerefTarget(resolvedName);
    const prior = this.priorViewAtIntent(resolvedName, intent);
    const wasMaterialized = prior?.kind === 'indexed' || prior?.kind === 'associative';
    const cell = this.getOrCreateDestination(intent, resolvedName, isAssoc ? 'associative' : 'indexed');
    const preErr = applyAttributesToCell(cell, preAttrs, false);
    if (preErr) return { outcome: preErr, materializedArray: false };
    const saved = this.enterCompoundGuard(resolvedName, true);
    let outcome: StoreOutcome;
    try {
      outcome = this.writeCompoundCell(cell, elements, hooks);
    } finally {
      this.leaveCompoundGuards(saved);
    }
    if (!outcome.ok) return { outcome, materializedArray: false };
    if (postReadonly) {
      const roErr = applyAttributesToCell(cell, new Set<Attribute>(['r']), true);
      if (roErr) return { outcome: roErr, materializedArray: false };
    }
    const materialized = !wasMaterialized && (cell.value?.kind === 'indexed' || cell.value?.kind === 'associative');
    return { outcome, materializedArray: materialized };
  }

  /** Streams incremental associative `+=(...)` pairs through the single store compound writer. */
  writeAssociativeCompoundStreamNamed(
    resolvedName: string,
    reportedName: string,
    evalInt: IntEvaluator,
    drivePairs: (commitPair: (key: string, value: string, append: boolean) => boolean) => string | undefined
  ): { outcome: StoreOutcome; syntaxError?: string; materializedArray: boolean } {
    this.guardCompoundMutation(resolvedName);
    rejectUnsupportedVariableMutation(resolvedName, false);
    const cell = this.getOrCreateDestination('visible', resolvedName, 'associative');
    const wasMaterialized = cell.value?.kind === 'associative';
    const writable = writableCellOrFailure(cell, reportedName);
    if (!writable.ok) return { outcome: writable, materializedArray: false };
    const table = this.ensureAssociativeTable(cell);
    cell.userAssigned = true;
    const { streamFailure, syntaxError } = this.runAssociativeStream(cell, table, evalInt, drivePairs);
    if (streamFailure) return { outcome: streamFailure, materializedArray: false };
    return {
      outcome: { ok: true, stored: '' },
      ...(syntaxError !== undefined ? { syntaxError } : {}),
      materializedArray: !wasMaterialized,
    };
  }

  /** Transactionally validates and binds `local -n name=target` inside a function without leaving partial cells. */
  declareNamerefNamed(builtin: string, name: string, value: string | undefined): StoreFailure | undefined {
    this.guardCompoundMutation(name);
    const fnIdx = this.currentFunctionScopeIndex();
    const hasExistingLocal = fnIdx !== undefined && this.scopes[fnIdx].map.has(name);
    rejectUnsupportedNamerefDeclaration(builtin, name, value, fnIdx !== undefined, hasExistingLocal);
    const outerRo = this.outerReadonlyFailure(name);
    if (outerRo) return outerRo;
    const target = value as string;
    const outerFound = isIdentifier(target) ? this.findOwnCellWithScope(target, (fnIdx as number) - 1) : undefined;
    rejectUnsupportedNamerefTarget(name, target, outerFound ? cellShapeOf(outerFound.cell) : undefined);
    if (!isIdentifier(target)) {
      return { ok: false, reason: 'invalidIdentifier', message: `\`${target}': not a valid identifier` };
    }
    this.chargeString(target);
    this.runtime.allocateSlots(1);
    const created = createCell(name, { kind: 'scalar', value: target }, ['n'], false, true);
    this.scopes[fnIdx as number].map.set(name, created);
    return undefined;
  }

  /** Transactionally declares and optionally assigns a scalar or empty array variable at `req.intent`. */
  declareScalarNamed(req: ScalarDeclarationRequest): { failure?: StoreFailure; materializedArray: boolean } {
    const { targetName, intent, effectiveSet, value, append, evalInt } = req;
    this.guardCompoundMutation(targetName);
    rejectUnsupportedVariableMutation(targetName, false);
    if (intent === 'local') this.rejectLocalShadowingNamerefTarget(targetName);
    const prior = this.priorViewAtIntent(targetName, intent);
    const wasMaterialized = prior?.kind === 'indexed' || prior?.kind === 'associative';
    const declaredKind = effectiveSet.has('A') ? 'associative' : effectiveSet.has('a') ? 'indexed' : undefined;
    const cell = this.getOrCreateDestination(intent, targetName, undefined, declaredKind);
    const preAttrs = new Set<Attribute>([...effectiveSet].filter((f): f is Attribute => f !== 'r' && f !== 'n'));
    const preErr = applyAttributesToCell(cell, preAttrs, value === undefined);
    if (preErr) return { failure: preErr, materializedArray: false };
    if (value !== undefined) {
      const outcome = this.writeScalarCell(cell, value, append, evalInt, targetName);
      if (!outcome.ok) return { failure: outcome, materializedArray: false };
    }
    if (effectiveSet.has('r')) {
      const roErr = applyAttributesToCell(cell, new Set<Attribute>(['r']), true);
      if (roErr) return { failure: roErr, materializedArray: false };
    }
    const materialized = !wasMaterialized && (cell.value?.kind === 'indexed' || cell.value?.kind === 'associative');
    return { materializedArray: materialized };
  }

  setNullReferenceNamed(resolvedName: string, isNull: boolean): void {
    const cell = this.findOwnCell(resolvedName);
    if (cell && !cell.attributes.has('n')) cell.nullReference = isNull;
  }

  unsetNamed(name: string, followNameref: boolean): StoreFailure | undefined {
    this.guardCompoundMutation(name);
    const own = this.findOwnCell(name);
    if (own?.attributes.has('n')) rejectUnsupportedNamerefMutation('unset', name);
    const target = followNameref ? this.resolveTargetName(name) : name;
    this.guardCompoundMutation(target);
    rejectUnsupportedVariableMutation(target, false);
    const fnIdx = this.currentFunctionScopeIndex();
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const cell = this.scopes[i].map.get(target);
      if (!cell) continue;
      if (cell.attributes.has('r')) {
        return { ok: false, reason: 'readonly', message: `${target}: cannot unset: readonly variable` };
      }
      if (i > 0 && fnIdx === i) {
        cell.value = undefined;
        cell.userAssigned = false;
        cell.nullReference = false;
        cell.attributes.clear();
      } else {
        this.scopes[i].map.delete(target);
      }
      return undefined;
    }
    return undefined;
  }

  unsetElementNamed(
    resolvedName: string,
    target: { kind: 'associative'; key: string } | { kind: 'indexed'; index: bigint } | { kind: 'wholeArray' },
    reportedName: string
  ): StoreFailure | undefined {
    this.guardCompoundMutation(resolvedName);
    rejectUnsupportedVariableMutation(resolvedName, false);
    const cell = this.findOwnCell(resolvedName);
    if (!cell) return undefined;
    if (cell.attributes.has('r')) {
      return { ok: false, reason: 'readonly', message: `${reportedName}: cannot unset: readonly variable` };
    }
    if (target.kind === 'associative') {
      if (cell.value?.kind === 'associative') cell.value.table.delete(target.key);
      return undefined;
    }
    if (target.kind === 'wholeArray') {
      if (cell.value?.kind === 'indexed') {
        cell.value.elements.clear();
        return undefined;
      }
      if (!cell.attributes.has('a')) {
        return { ok: false, reason: 'notArray', message: `${reportedName}: not an array variable` };
      }
      return undefined;
    }
    if (cell.value?.kind === 'indexed') {
      cell.value.elements.delete(target.index);
      return undefined;
    }
    if (cell.attributes.has('a')) return undefined;
    if (target.index === 0n) return this.unsetNamed(cell.name, false);
    return { ok: false, reason: 'notArray', message: `${reportedName}: not an array variable` };
  }

  // ---------------------------------------------------------------- pure trace inspection

  /** Pure frame-bounded variable views for trace projection; never mutates cells, containers, or PRNG. */
  visibleViews(maxScopeIndex: number): VariableView[] {
    const upper = Math.min(maxScopeIndex, this.scopes.length - 1);
    const seen = new Set<string>();
    const found: { cell: Cell; scopeIdx: number }[] = [];
    for (let i = upper; i >= 0; i--) {
      for (const cell of this.scopes[i].map.values()) {
        if (seen.has(cell.name)) continue;
        seen.add(cell.name);
        if ((!cell.isSystem || cell.userAssigned) && isIdentifier(cell.name) && cell.value !== undefined) {
          found.push({ cell, scopeIdx: i });
        }
      }
    }
    return found.toSorted((a, b) => b.scopeIdx - a.scopeIdx).map(({ cell }) => this.cellToView(cell));
  }

  /** Pure single-hop nameref traversal bounded to `maxScopeIndex` without handles or mutations. */
  resolveViewInFrame(view: VariableView, maxScopeIndex: number): VariableView | undefined {
    if (!view.attributes.has('n')) return view;
    const ref = view.scalar ?? '';
    if (!isIdentifier(ref)) return undefined;
    const target = this.findOwnCell(ref, maxScopeIndex);
    return target && !target.attributes.has('n') ? this.cellToView(target) : undefined;
  }

  // ---------------------------------------------------------------- private helpers

  private currentFunctionScopeIndex(): number | undefined {
    for (let i = this.scopes.length - 1; i >= 1; i--) {
      if (this.scopes[i].kind === 'function') return i;
    }
    return undefined;
  }

  private findOwnCell(name: string, maxScopeIndex = this.scopes.length - 1): Cell | undefined {
    return this.findOwnCellWithScope(name, maxScopeIndex)?.cell;
  }

  private findOwnCellWithScope(
    name: string,
    maxScopeIndex = this.scopes.length - 1
  ): { cell: Cell; scopeIndex: number } | undefined {
    for (let i = Math.min(maxScopeIndex, this.scopes.length - 1); i >= 0; i--) {
      const cell = this.scopes[i].map.get(name);
      if (cell) return { cell, scopeIndex: i };
    }
    return undefined;
  }

  private rejectLocalShadowingNamerefTarget(localName: string): void {
    const fnIdx = this.currentFunctionScopeIndex();
    if (fnIdx === undefined) return;
    for (const cell of this.scopes[fnIdx].map.values()) {
      if (cell.attributes.has('n') && cell.value?.kind === 'scalar' && cell.value.value === localName) {
        rejectUnsupportedNamerefShadowing(localName);
      }
    }
  }

  private cellToView(cell: Cell): VariableView {
    const fnScopeIdx = this.currentFunctionScopeIndex();
    const isCurrentLocal = fnScopeIdx !== undefined && this.scopes[fnScopeIdx].map.get(cell.name) === cell;
    const base = {
      name: cell.name,
      attributes: cell.attributes,
      isSystem: cell.isSystem,
      userAssigned: cell.userAssigned,
      nullReference: cell.nullReference,
      isCurrentLocal,
    };
    if (!cell.value) return { ...base, kind: 'unset' };
    if (cell.value.kind === 'scalar') return { ...base, kind: 'scalar', scalar: cell.value.value };
    if (cell.value.kind === 'indexed') return { ...base, kind: 'indexed', indexed: cell.value.elements };
    return { ...base, kind: 'associative', associative: cell.value.table };
  }

  private readDynamicScalar(name: string): string | undefined {
    if (name === 'RANDOM') return String(this.prng.next());
    if (name === 'LINENO') return String(this.currentLine());
    return this.readDynamicElements(name)?.get(0n);
  }

  private readDynamicElements(name: string): IndexedTable | undefined {
    if (name === 'BASH_REMATCH') {
      return this.rematch ? new IndexedTable(this.rematch.map((v, i) => [BigInt(i), v])) : undefined;
    }
    if (name === 'FUNCNAME') {
      if (this.calls.length === 0) return undefined;
      const items = [...this.calls.toReversed().map((c) => c.name), 'main'];
      return new IndexedTable(items.map((v, i) => [BigInt(i), v]));
    }
    return undefined;
  }

  private collectScopedPrefixNames(prefix: string): Set<string> {
    const names = new Set<string>();
    for (const scope of this.scopes) {
      for (const cell of scope.map.values()) {
        if (!cell.name.startsWith(prefix)) continue;
        this.guardCompoundRead(cell.name);
        if (cell.isSystem && !cell.userAssigned) rejectUnsupportedPrefixListing(prefix);
        if (cell.value !== undefined) names.add(cell.name);
      }
    }
    return names;
  }

  private rejectUnsupportedPrefixQuery(prefix: string): void {
    for (const unsupported of UNSUPPORTED_SPECIAL_VARIABLES) {
      if (unsupported.startsWith(prefix)) rejectUnsupportedSpecialVariable(unsupported);
    }
    for (const envName of ENVIRONMENT_VARIABLES) {
      if (envName.startsWith(prefix)) rejectUnsupportedVariableRead(envName);
    }
    if ('BASH'.startsWith(prefix) || prefix.startsWith('BASH') || 'RANDOM'.startsWith(prefix) || prefix === '') {
      rejectUnsupportedPrefixListing(prefix);
    }
  }

  private getOrCreateDestination(
    intent: DestinationIntent,
    name: string,
    initialContainer?: 'indexed' | 'associative',
    declaredArrayKind?: 'indexed' | 'associative'
  ): Cell {
    if (intent === 'local') {
      const fnIdx = this.currentFunctionScopeIndex();
      if (fnIdx === undefined) throw new Error('local destination requested outside function');
      const localMap = this.scopes[fnIdx].map;
      const existing = localMap.get(name);
      if (existing) return existing;
      this.runtime.allocateSlots(1);
      const created = createCell(
        name,
        createInitialContainer(initialContainer),
        containerAttributes(initialContainer ?? declaredArrayKind)
      );
      localMap.set(name, created);
      return created;
    }
    const existing = intent === 'global' ? this.scopes[0].map.get(name) : this.findOwnCell(name);
    if (existing) return existing;
    this.runtime.allocateSlots(1);
    const created = createCell(
      name,
      createInitialContainer(initialContainer),
      containerAttributes(initialContainer ?? declaredArrayKind)
    );
    this.scopes[0].map.set(name, created);
    return created;
  }

  private writeScalarCell(
    cell: Cell,
    rawText: string,
    append: boolean,
    evalInt: IntEvaluator,
    reportedName?: string
  ): StoreOutcome {
    const target = writableCellOrFailure(cell, reportedName);
    if (!target.ok) return target;
    const { label } = target;
    if (isArrayCell(cell)) {
      return cell.value?.kind === 'associative' || cell.attributes.has('A')
        ? this.writeMapEntry(cell, '0', { rawText, append, evalInt, reportedName: label }, (c) =>
            this.ensureAssociativeTable(c)
          )
        : this.writeMapEntry(cell, 0n, { rawText, append, evalInt, reportedName: label }, (c) =>
            this.ensureIndexedMap(c)
          );
    }
    const base = append && cell.value?.kind === 'scalar' ? cell.value.value : '';
    const prep = this.prepareConvertedString(cell, rawText, base, append, evalInt);
    if (!prep.ok) return prep;
    cell.value = { kind: 'scalar', value: prep.value };
    cell.nullReference = false;
    cell.userAssigned = true;
    return { ok: true, stored: prep.value };
  }

  private writeMapEntry<K>(
    cell: Cell,
    key: K,
    opts: { rawText: string; append: boolean; evalInt: IntEvaluator; reportedName?: string },
    getMap: (target: Cell) => { has(k: K): boolean; get(k: K): string | undefined; set(k: K, v: string): unknown }
  ): StoreOutcome {
    const target = writableCellOrFailure(cell, opts.reportedName);
    if (!target.ok) return target;
    const map = getMap(cell);
    const base = opts.append ? (map.get(key) ?? '') : '';
    const prep = this.prepareConvertedString(cell, opts.rawText, base, opts.append, opts.evalInt);
    if (!prep.ok) return prep;
    if (!map.has(key)) this.runtime.allocateSlots(1);
    map.set(key, prep.value);
    cell.userAssigned = true;
    return { ok: true, stored: prep.value };
  }

  // code-gauge-allow functionCognitiveComplexity -- Writes keyed and plain elements into associative or indexed containers with Bash's partial-commit rules.
  private writeCompoundCell(cell: Cell, elements: CompoundElement[], hooks: CompoundWriteHooks): StoreOutcome {
    const target = writableCellOrFailure(cell, hooks.reportedName);
    if (!target.ok) return target;
    const { label } = target;
    if (cell.value?.kind === 'associative' || cell.attributes.has('A')) {
      return this.writeAssociativeCompound(cell, elements, hooks, label);
    }
    const map = hooks.append ? this.ensureIndexedMap(cell) : new IndexedTable();
    if (!hooks.append) {
      cell.value = { kind: 'indexed', elements: map };
      cell.attributes.add('a');
    }
    cell.userAssigned = true;
    let next = hooks.append ? maxElementIndex(map) + 1n : 0n;
    for (const rawElement of elements) {
      const item = unpackIndexedElement(rawElement);
      const index = item.key === undefined ? next : hooks.evalIndex(cell.name, item.key);
      if (index === undefined) {
        return { ok: false, reason: 'badSubscript', message: `${label}[${item.key ?? ''}]: bad array subscript` };
      }
      const prep = this.prepareConvertedString(
        cell,
        item.value,
        item.append ? (map.get(index) ?? '') : '',
        item.append,
        hooks.evalInt
      );
      if (!prep.ok) return prep;
      if (!map.has(index)) this.runtime.allocateSlots(1);
      map.set(index, prep.value);
      next = index + 1n;
    }
    return { ok: true, stored: '' };
  }

  private writeAssociativeCompound(
    cell: Cell,
    elements: CompoundElement[],
    hooks: CompoundWriteHooks,
    label: string
  ): StoreOutcome {
    const previous = cell.value?.kind === 'associative' ? cell.value.table : undefined;
    const table = hooks.append && previous ? previous : new AssociativeTable(previous?.bucketCount);
    if (hooks.append) cell.value = { kind: 'associative', table };
    const baseTable = hooks.append ? table : previous;
    for (let i = 0; i < elements.length; i++) {
      const entry = readAssociativePair(elements, i, elements[i], label);
      if (entry.consumedNext) i++;
      if (entry.error !== undefined) {
        hooks.onItemError(entry.error);
        continue;
      }
      const failure = this.storeAssociativeCompoundPair(cell, table, baseTable, entry, hooks.evalInt);
      if (failure) {
        cell.value = { kind: 'associative', table };
        cell.attributes.add('A');
        cell.userAssigned = true;
        return failure;
      }
    }
    cell.value = { kind: 'associative', table };
    cell.attributes.add('A');
    cell.userAssigned = true;
    return { ok: true, stored: '' };
  }

  private runAssociativeStream(
    cell: Cell,
    table: AssociativeTable,
    evalInt: IntEvaluator,
    drivePairs: (commitPair: (key: string, value: string, append: boolean) => boolean) => string | undefined
  ): { streamFailure?: StoreFailure; syntaxError?: string } {
    const saved = this.enterCompoundGuard(cell.name, false);
    let streamFailure: StoreFailure | undefined;
    try {
      const syntaxError = drivePairs((key, value, append) => {
        const failure = this.storeAssociativeCompoundPair(cell, table, table, { key, value, append }, evalInt);
        if (failure) {
          streamFailure = failure;
          return false;
        }
        return true;
      });
      return { streamFailure, syntaxError };
    } finally {
      this.leaveCompoundGuards(saved);
    }
  }

  private storeAssociativeCompoundPair(
    cell: Cell,
    table: AssociativeTable,
    baseTable: AssociativeTable | undefined,
    entry: { key: string; value: string; append: boolean },
    evalInt: IntEvaluator
  ): StoreFailure | undefined {
    this.chargeString(entry.key);
    const base = entry.append ? (baseTable?.get(entry.key) ?? '') : '';
    const prep = this.prepareConvertedString(cell, entry.value, base, entry.append, evalInt);
    if (!prep.ok) return prep;
    if (!table.has(entry.key)) this.runtime.allocateSlots(1);
    table.set(entry.key, prep.value);
    return undefined;
  }

  private prepareConvertedString(
    cell: Cell,
    rawValue: string,
    base: string,
    append: boolean,
    evalInt: IntEvaluator
  ): { ok: true; value: string } | StoreFailure {
    const converted = convertForCell(cell, rawValue, base, append, evalInt);
    if (converted === undefined) return { ok: false, reason: 'arithmetic', message: '', alreadyReported: true };
    this.chargeString(converted);
    return { ok: true, value: converted };
  }

  private ensureAssociativeTable(cell: Cell): AssociativeTable {
    if (cell.value?.kind !== 'associative') {
      cell.value = { kind: 'associative', table: new AssociativeTable() };
      cell.attributes.add('A');
    }
    return cell.value.table;
  }

  private ensureIndexedMap(cell: Cell): IndexedTable {
    if (cell.value?.kind === 'indexed') return cell.value.elements;
    const elements = new IndexedTable();
    if (cell.value?.kind === 'scalar') {
      this.runtime.allocateSlots(1);
      elements.set(0n, cell.value.value);
    }
    cell.value = { kind: 'indexed', elements };
    cell.attributes.add('a');
    return elements;
  }

  private chargeString(value: string): void {
    chargeStoreString(value, (cost) => this.runtime.spend(cost));
  }
}

function createCell(
  name: string,
  value: CellValue | undefined,
  attrs: Iterable<Attribute> = [],
  isSystem = false,
  userAssigned = false
): Cell {
  return {
    name,
    value,
    attributes: new Set(attrs),
    isSystem,
    userAssigned,
    nullReference: false,
  };
}

function cloneCellEager(cell: Cell, spend: (cost?: number) => void, allocateSlots: (count: number) => void): Cell {
  let clonedValue: CellValue | undefined;
  if (cell.value?.kind === 'scalar') {
    chargeStoreCopy(1, spend, allocateSlots);
    chargeStoreString(cell.value.value, spend);
    clonedValue = { kind: 'scalar', value: cell.value.value };
  } else if (cell.value?.kind === 'indexed') {
    chargeStoreCopy(cell.value.elements.size + 1, spend, allocateSlots);
    clonedValue = { kind: 'indexed', elements: new IndexedTable(cell.value.elements) };
  } else if (cell.value?.kind === 'associative') {
    chargeStoreCopy(cell.value.table.size + 1, spend, allocateSlots);
    clonedValue = { kind: 'associative', table: cell.value.table.clone() };
  } else {
    chargeStoreCopy(1, spend, allocateSlots);
  }
  return {
    name: cell.name,
    value: clonedValue,
    attributes: new Set(cell.attributes),
    isSystem: cell.isSystem,
    userAssigned: cell.userAssigned,
    nullReference: cell.nullReference,
  };
}

function cellShapeOf(cell: Cell): ExistingCellShape {
  return {
    kind: cell.value?.kind ?? 'unset',
    attributes: cell.attributes,
  };
}

function createInitialContainer(kind: 'indexed' | 'associative' | undefined): CellValue | undefined {
  if (kind === 'indexed') return { kind: 'indexed', elements: new IndexedTable() };
  if (kind === 'associative') return { kind: 'associative', table: new AssociativeTable() };
  return undefined;
}

function containerAttributes(kind: 'indexed' | 'associative' | undefined): Attribute[] {
  return kind === 'associative' ? ['A'] : kind === 'indexed' ? ['a'] : [];
}

function writableCellOrFailure(cell: Cell, reportedName?: string): { ok: true; label: string } | StoreFailure {
  const label = reportedName ?? cell.name;
  if (cell.attributes.has('r')) {
    return { ok: false, reason: 'readonly', message: `${label}: readonly variable` };
  }
  return { ok: true, label };
}

function applyAttributesToCell(
  cell: Cell,
  toAdd: ReadonlySet<Attribute>,
  allowReadonlyAlreadySet: boolean
): StoreFailure | undefined {
  if (cell.attributes.has('r') && !canApplyToReadonlyCell(toAdd, allowReadonlyAlreadySet)) {
    return { ok: false, reason: 'readonly', message: `${cell.name}: readonly variable` };
  }
  for (const attr of toAdd) cell.attributes.add(attr);
  return undefined;
}

function canApplyToReadonlyCell(toAdd: ReadonlySet<Attribute>, allowReadonlyAlreadySet: boolean): boolean {
  if (!allowReadonlyAlreadySet) return false;
  for (const attr of toAdd) {
    if (attr !== 'r' && attr !== 'x') return false;
  }
  return true;
}

function convertForCell(
  cell: Cell,
  rawValue: string,
  base: string,
  append: boolean,
  evalInt: IntEvaluator
): string | undefined {
  if (!cell.attributes.has('i')) return base + rawValue;
  if (append) {
    const lhs = evalInt(base || '0');
    if (lhs === undefined) return undefined;
    const rhs = evalInt(rawValue);
    if (rhs === undefined) return undefined;
    return String(BigInt.asIntN(64, lhs + rhs));
  }
  const evaluated = evalInt(rawValue);
  if (evaluated === undefined) return undefined;
  return String(BigInt.asIntN(64, evaluated));
}

function isArrayCell(cell: Cell): boolean {
  return (
    cell.value?.kind === 'indexed' ||
    cell.value?.kind === 'associative' ||
    cell.attributes.has('a') ||
    cell.attributes.has('A')
  );
}

function cellScalarZero(value: CellValue | undefined): string | undefined {
  if (!value) return undefined;
  if (value.kind === 'scalar') return value.value;
  return value.kind === 'indexed' ? value.elements.get(0n) : value.table.get('0');
}

function cellElementAt(value: CellValue, index: bigint): string | undefined {
  if (value.kind === 'scalar') return index === 0n ? value.value : undefined;
  if (value.kind === 'associative') return value.table.get(String(index));
  return value.elements.get(index);
}

function cellElementCount(value: CellValue): number {
  if (value.kind === 'scalar') return 1;
  return value.kind === 'indexed' ? value.elements.size : value.table.size;
}

function cellElementValues(value: CellValue): string[] {
  if (value.kind === 'scalar') return [value.value];
  if (value.kind === 'indexed') return sortedElements(value.elements).map(([, v]) => v);
  return value.table.entries().map(([, v]) => v);
}

function cellElementKeys(value: CellValue): string[] {
  if (value.kind === 'scalar') return ['0'];
  if (value.kind === 'indexed') return sortedElements(value.elements).map(([k]) => String(k));
  return value.table.entries().map(([k]) => k);
}
