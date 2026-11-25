// code-gauge-allow-file fileNcss -- Encapsulates VariableStore scopes, cells, copy-on-write containers, PRNG, and dynamic read descriptors in one single-writer module.
import { ExecutionLimitError, LIMITS } from '../interpreter/limits';
import {
  ASSOCIATIVE_BUCKETS,
  AssociativeTable,
  type CompoundElement,
  isIdentifier,
  isValidFunctionName,
  maxElementIndex,
  pushCompoundElementRoots,
  readAssociativePair,
  type ReadonlyAssociativeTable,
  sortedElements,
  unpackIndexedElement,
} from './associativeTable';
import {
  type Attribute,
  ATTRIBUTE_ORDER,
  DYNAMIC_VARIABLES,
  ENVIRONMENT_VARIABLES,
  rejectSpecialVariableMutation,
  rejectUnsupportedHostEnv,
  rejectUnsupportedNamerefTarget,
  rejectUnsupportedPrefixListing,
  rejectUnsupportedSpecialVariable,
  SCALAR_DYNAMIC_VARIABLES,
  UNSUPPORTED_SPECIAL_VARIABLES,
} from './capabilities';
import type { StoreFailure, StoreOutcome } from './failurePolicy';
import { BASH_VERSION, type FunctionDefinition, type Runtime } from './runtime';

export {
  ASSOCIATIVE_BUCKETS,
  AssociativeTable,
  type CompoundElement,
  isIdentifier,
  isValidFunctionName,
  maxElementIndex,
  pushCompoundElementRoots,
  readAssociativePair,
  type ReadonlyAssociativeTable,
  sortedElements,
  unpackIndexedElement,
};
export { type Attribute, ATTRIBUTE_ORDER, DYNAMIC_VARIABLES, ENVIRONMENT_VARIABLES, SCALAR_DYNAMIC_VARIABLES };

type CellValue =
  | { kind: 'scalar'; value: string }
  | { kind: 'indexed'; elements: Map<bigint, string> }
  | { kind: 'associative'; table: AssociativeTable };

interface Cell {
  readonly id: number;
  readonly name: string;
  value: CellValue | undefined;
  attributes: Set<Attribute>;
  isSystem: boolean;
  userAssigned: boolean;
  shared: boolean;
  nullReference: boolean;
  unreadHostEnv: boolean;
}

interface ScopeEntry {
  readonly kind: 'global' | 'function' | 'temp';
  readonly map: Map<string, Cell>;
}

export interface CallFrameEntry {
  readonly name: string;
  readonly line: number;
}

/** Opaque handle to a `VariableStore`-owned variable cell. */
export interface CellHandle {
  readonly __cellBrand: 'CellHandle';
  readonly id: number;
  readonly name: string;
}

/** Immutable read-only snapshot of a variable cell or synthesized dynamic descriptor. */
export interface VariableView {
  readonly handle?: CellHandle;
  readonly name: string;
  readonly attributes: ReadonlySet<Attribute>;
  readonly kind: 'unset' | 'scalar' | 'indexed' | 'associative';
  readonly scalar?: string;
  readonly indexed?: ReadonlyMap<bigint, string>;
  readonly associative?: ReadonlyAssociativeTable;
  readonly isSystem: boolean;
  readonly userAssigned: boolean;
  readonly nullReference: boolean;
  readonly isCurrentLocal: boolean;
}

export type DestinationIntent = 'local' | 'global' | 'visible';

export interface DestinationSelection {
  readonly scope: DestinationIntent;
  readonly name: string;
  readonly cell: CellHandle;
  readonly created: boolean;
}

export type NamerefResolution =
  | { readonly kind: 'resolved'; readonly name: string; readonly cell?: CellHandle; readonly fromNameref: boolean }
  | { readonly kind: 'cycle'; readonly cyclicName: string };

export type IntEvaluator = (expression: string) => bigint | undefined;

export interface CompoundWriteHooks {
  readonly append: boolean;
  readonly reportedName?: string;
  readonly evalIndex: (cellHandle: CellHandle, rawKey: string) => bigint | undefined;
  readonly evalInt: IntEvaluator;
  readonly onItemError: (message: string) => void;
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

let nextCellId = 1;

/**
 * Single owner and single writer of Bash scopes, variable cells, copy-on-write containers, functions,
 * positional parameters, call stack metadata, host-unset tombstones, regex captures, and PRNG streams.
 */
export class VariableStore {
  private readonly scopes: ScopeEntry[];
  private readonly cellsById = new Map<number, Cell>();
  private readonly functions: Map<string, FunctionDefinition>;
  private readonly positional: string[][];
  private readonly calls: CallFrameEntry[];
  private readonly unsetHostEnv: Set<string>;
  private rematch: string[];
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
      unsetHostEnv: Set<string>;
      rematch: string[];
      prng: RandomStream;
      lastStatus: number;
      lastArgument: string | undefined;
      subshellLevel: number;
    }
  ) {
    if (forked) {
      this.scopes = forked.scopes;
      for (const scope of this.scopes) {
        for (const cell of scope.map.values()) this.cellsById.set(cell.id, cell);
      }
      this.functions = forked.functions;
      this.positional = forked.positional;
      this.calls = forked.calls;
      this.unsetHostEnv = forked.unsetHostEnv;
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
    this.unsetHostEnv = new Set();
    this.rematch = [];
    this.prng = new RandomStream();
    this.subshellLevel = 0;
    this.initSystemVariables();
  }

  setLineReader(reader: () => number): void {
    this.currentLine = reader;
  }

  private initSystemVariables(): void {
    const defineSystem = (name: string, value: CellValue, attrs: Attribute[] = []): void => {
      const cell = this.allocateCell(name, value, attrs, true, false);
      this.scopes[0].map.set(name, cell);
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
        elements: new Map(['5', '3', '0', '1', 'release', 'aarch64-apple-darwin20.0.0'].map((v, i) => [BigInt(i), v])),
      },
      ['a', 'r']
    );
  }

  private allocateCell(
    name: string,
    value: CellValue | undefined,
    attrs: Iterable<Attribute> = [],
    isSystem = false,
    userAssigned = false
  ): Cell {
    const cell: Cell = {
      id: nextCellId++,
      name,
      value,
      attributes: new Set(attrs),
      isSystem,
      userAssigned,
      shared: false,
      nullReference: false,
      unreadHostEnv: false,
    };
    this.cellsById.set(cell.id, cell);
    return cell;
  }

  private toHandle(cell: Cell): CellHandle {
    return { __cellBrand: 'CellHandle', id: cell.id, name: cell.name };
  }

  private getCell(handle: CellHandle): Cell {
    const cell = this.cellsById.get(handle.id);
    if (!cell) throw new Error(`Stale cell handle for ${handle.name}`);
    return cell;
  }

  // ---------------------------------------------------------------- fork & scopes

  /** Creates an isolated child `VariableStore` for a command substitution with copy-on-write containers. */
  fork(childLineReader: () => number): VariableStore {
    const clonedScopes: ScopeEntry[] = this.scopes.map((entry) => {
      const map = new Map<string, Cell>();
      for (const [name, cell] of entry.map) {
        this.runtime.spend();
        const isContainer = cell.value !== undefined && cell.value.kind !== 'scalar';
        if (isContainer) cell.shared = true;
        map.set(name, {
          id: nextCellId++,
          name: cell.name,
          value: cell.value?.kind === 'scalar' ? { kind: 'scalar', value: cell.value.value } : cell.value,
          attributes: new Set(cell.attributes),
          isSystem: cell.isSystem,
          userAssigned: cell.userAssigned,
          shared: isContainer,
          nullReference: cell.nullReference,
          unreadHostEnv: cell.unreadHostEnv,
        });
      }
      return { kind: entry.kind, map };
    });
    const nextLevel = this.subshellLevel + 1;
    return new VariableStore(this.runtime, childLineReader, {
      scopes: clonedScopes,
      functions: new Map(this.functions),
      positional: this.positional.map((args) => [...args]),
      calls: this.calls.map((c) => ({ ...c })),
      unsetHostEnv: new Set(this.unsetHostEnv),
      rematch: [...this.rematch],
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

  private currentFunctionScopeIndex(): number | undefined {
    for (let i = this.scopes.length - 1; i >= 1; i--) {
      if (this.scopes[i].kind === 'function') return i;
    }
    return undefined;
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
    return scopeIndex;
  }

  popFunctionScope(scopeIndex: number): void {
    this.calls.pop();
    this.positional.pop();
    for (let i = this.scopes.length - 1; i >= scopeIndex; i--) {
      for (const cell of this.scopes[i].map.values()) this.cellsById.delete(cell.id);
    }
    this.scopes.length = scopeIndex;
  }

  pushTemporaryScope(): number {
    this.scopes.push({ kind: 'temp', map: new Map() });
    return this.scopes.length - 1;
  }

  popTemporaryScope(scopeIndex: number): void {
    const entry = this.scopes[scopeIndex];
    if (!entry) return;
    for (const cell of entry.map.values()) this.cellsById.delete(cell.id);
    this.scopes.splice(scopeIndex, 1);
  }

  bindTemporaryScalar(scopeIndex: number, name: string, value: string, append: boolean): void {
    if (append && this.isUnreadHostEnv(name)) rejectUnsupportedHostEnv(name);
    const base = append ? (this.readScalar(name) ?? '') : '';
    const combined = base + value;
    this.checkStringLength(combined);
    const map = this.scopes[scopeIndex].map;
    const prev = map.get(name);
    if (prev) this.cellsById.delete(prev.id);
    const cell = this.allocateCell(name, { kind: 'scalar', value: combined }, ['x'], false, true);
    map.set(name, cell);
  }

  // ---------------------------------------------------------------- functions, positional, PRNG

  getFunction(name: string): FunctionDefinition | undefined {
    return this.functions.get(name);
  }

  hasFunction(name: string): boolean {
    return this.functions.has(name);
  }

  setFunction(fn: FunctionDefinition): void {
    this.functions.set(fn.name, fn);
  }

  deleteFunction(name: string): boolean {
    return this.functions.delete(name);
  }

  positionalArgs(): readonly string[] {
    return this.positional.at(-1) as string[];
  }

  setPositionalArgs(args: readonly string[]): void {
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
    this.rematch = [...elements];
  }

  seedRandom(seedValue: bigint): void {
    this.prng.reseed(Number(BigInt.asUintN(32, seedValue)));
  }

  // ---------------------------------------------------------------- lookup & single access gate

  isUnreadHostEnv(name: string, maxScopeIndex = this.scopes.length - 1): boolean {
    if (!ENVIRONMENT_VARIABLES.has(name) || this.unsetHostEnv.has(name)) return false;
    const cell = this.findOwnCell(name, maxScopeIndex);
    return !cell || cell.unreadHostEnv;
  }

  isDynamic(name: string): boolean {
    return (DYNAMIC_VARIABLES.has(name) || name === 'BASH_REMATCH') && !this.findOwnCell(name);
  }

  private checkPostDereferenceAccess(name: string): void {
    rejectUnsupportedSpecialVariable(name);
    if (this.isUnreadHostEnv(name)) rejectUnsupportedHostEnv(name);
  }

  private findOwnCell(name: string, maxScopeIndex = this.scopes.length - 1): Cell | undefined {
    for (let i = Math.min(maxScopeIndex, this.scopes.length - 1); i >= 0; i--) {
      const cell = this.scopes[i].map.get(name);
      if (cell) return cell;
    }
    return undefined;
  }

  /** Resolves whole-variable nameref chains in one place with cycle detection and optional scope bound. */
  resolveChain(name: string, maxScopeIndex = this.scopes.length - 1): NamerefResolution {
    const seen = new Set<Cell>();
    let current = name;
    let fromNameref = false;
    for (;;) {
      const cell = this.findOwnCell(current, maxScopeIndex);
      if (!cell?.attributes.has('n') || cell.value?.kind !== 'scalar' || cell.value.value === '') {
        return { kind: 'resolved', name: current, ...(cell ? { cell: this.toHandle(cell) } : {}), fromNameref };
      }
      if (seen.has(cell)) return { kind: 'cycle', cyclicName: cell.name };
      seen.add(cell);
      const target = cell.value.value;
      rejectUnsupportedNamerefTarget(target, (n) => this.isUnreadHostEnv(n));
      current = target;
      fromNameref = true;
    }
  }

  ownView(name: string, maxScopeIndex = this.scopes.length - 1): VariableView | undefined {
    const cell = this.findOwnCell(name, maxScopeIndex);
    return cell ? this.cellToView(cell) : undefined;
  }

  viewOfHandle(handle: CellHandle): VariableView {
    return this.cellToView(this.getCell(handle));
  }

  private cellToView(cell: Cell): VariableView {
    const fnScopeIdx = this.currentFunctionScopeIndex();
    const isCurrentLocal = fnScopeIdx !== undefined && this.scopes[fnScopeIdx].map.get(cell.name) === cell;
    const base = {
      handle: this.toHandle(cell),
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

  // ---------------------------------------------------------------- dynamic descriptors & reads

  private readDynamicScalar(name: string): string | undefined {
    if (name === 'RANDOM') return String(this.prng.next());
    if (name === 'LINENO') return String(this.currentLine());
    return this.readDynamicElements(name)?.get(0n);
  }

  private readDynamicElements(name: string): Map<bigint, string> | undefined {
    if (name === 'BASH_REMATCH') {
      return new Map(this.rematch.map((v, i) => [BigInt(i), v]));
    }
    if (name === 'FUNCNAME') {
      if (this.calls.length === 0) return undefined;
      const items = [...this.calls.toReversed().map((c) => c.name), 'main'];
      return new Map(items.map((v, i) => [BigInt(i), v]));
    }
    return undefined;
  }

  dynamicView(name: string): VariableView | undefined {
    rejectUnsupportedSpecialVariable(name);
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
    if (!elements) return undefined;
    return {
      name,
      attributes: new Set<Attribute>(['a']),
      kind: 'indexed',
      indexed: elements,
      isSystem: true,
      userAssigned: false,
      nullReference: false,
      isCurrentLocal: false,
    };
  }

  /** Reads scalar value (or element `0` of an array) through the single post-dereference gate. */
  readScalar(name: string, onCycle?: (cyclicName: string) => void): string | undefined {
    const res = this.resolveChain(name);
    if (res.kind === 'cycle') {
      onCycle?.(res.cyclicName);
      return undefined;
    }
    rejectUnsupportedSpecialVariable(res.name);
    if (res.cell) {
      const cell = this.getCell(res.cell);
      if (cell.unreadHostEnv) rejectUnsupportedHostEnv(cell.name);
      return cellScalarZero(cell.value);
    }
    if (this.isDynamic(res.name)) return this.readDynamicScalar(res.name);
    this.checkPostDereferenceAccess(res.name);
    return undefined;
  }

  isArrayName(resolvedName: string): boolean {
    const cell = this.findOwnCell(resolvedName);
    if (cell) {
      return (
        cell.value?.kind === 'indexed' ||
        cell.value?.kind === 'associative' ||
        cell.attributes.has('a') ||
        cell.attributes.has('A')
      );
    }
    return this.isDynamic(resolvedName) && !SCALAR_DYNAMIC_VARIABLES.has(resolvedName);
  }

  isAssociativeName(resolvedName: string): boolean {
    const cell = this.findOwnCell(resolvedName);
    return cell?.value?.kind === 'associative' || cell?.attributes.has('A') === true;
  }

  hasMaterializedTarget(resolvedName: string): boolean {
    rejectUnsupportedSpecialVariable(resolvedName);
    const cell = this.findOwnCell(resolvedName);
    if (cell && !cell.unreadHostEnv) return cell.value !== undefined;
    this.checkPostDereferenceAccess(resolvedName);
    if (!this.isDynamic(resolvedName)) return false;
    return resolvedName !== 'FUNCNAME' || this.calls.length > 0;
  }

  translateNegativeIndex(resolvedName: string, index: bigint, allowScalarWrite: boolean): bigint | undefined {
    rejectUnsupportedSpecialVariable(resolvedName);
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

  readAssociativeElement(handle: CellHandle, key: string): string | undefined {
    const cell = this.getCell(handle);
    if (cell.unreadHostEnv) rejectUnsupportedHostEnv(cell.name);
    return cell.value?.kind === 'associative' ? cell.value.table.get(key) : undefined;
  }

  readIndexedElement(resolvedName: string, index: bigint): string | undefined {
    rejectUnsupportedSpecialVariable(resolvedName);
    const cell = this.findOwnCell(resolvedName);
    if (cell?.value) return cellElementAt(cell.value, index);
    if (this.isDynamic(resolvedName)) {
      return SCALAR_DYNAMIC_VARIABLES.has(resolvedName)
        ? index === 0n
          ? this.readDynamicScalar(resolvedName)
          : undefined
        : this.readDynamicElements(resolvedName)?.get(index);
    }
    this.checkPostDereferenceAccess(resolvedName);
    return undefined;
  }

  readArrayLength(resolvedName: string): number {
    rejectUnsupportedSpecialVariable(resolvedName);
    const cell = this.findOwnCell(resolvedName);
    if (cell?.value) return cellElementCount(cell.value);
    if (this.isDynamic(resolvedName)) {
      if (SCALAR_DYNAMIC_VARIABLES.has(resolvedName)) return 1;
      return this.readDynamicElements(resolvedName)?.size ?? 0;
    }
    this.checkPostDereferenceAccess(resolvedName);
    return 0;
  }

  readArrayValues(resolvedName: string): string[] {
    rejectUnsupportedSpecialVariable(resolvedName);
    const cell = this.findOwnCell(resolvedName);
    if (cell?.value) return cellElementValues(cell.value);
    if (this.isDynamic(resolvedName)) {
      if (SCALAR_DYNAMIC_VARIABLES.has(resolvedName)) return [this.readDynamicScalar(resolvedName) as string];
      const elems = this.readDynamicElements(resolvedName);
      return elems ? sortedElements(elems).map(([, v]) => v) : [];
    }
    this.checkPostDereferenceAccess(resolvedName);
    return [];
  }

  readArrayKeys(resolvedName: string): string[] {
    rejectUnsupportedSpecialVariable(resolvedName);
    const cell = this.findOwnCell(resolvedName);
    if (cell?.value) return cellElementKeys(cell.value);
    if (this.isDynamic(resolvedName)) {
      if (SCALAR_DYNAMIC_VARIABLES.has(resolvedName)) return ['0'];
      const elems = this.readDynamicElements(resolvedName);
      return elems ? sortedElements(elems).map(([k]) => String(k)) : [];
    }
    this.checkPostDereferenceAccess(resolvedName);
    return [];
  }

  namesWithPrefix(prefix: string): string[] {
    const names = this.collectScopedPrefixNames(prefix);
    this.rejectUnsupportedPrefixQuery(prefix);
    return [...names].toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  private collectScopedPrefixNames(prefix: string): Set<string> {
    const names = new Set<string>();
    for (const scope of this.scopes) {
      for (const cell of scope.map.values()) {
        if (!cell.name.startsWith(prefix)) continue;
        if (cell.isSystem && !cell.userAssigned) rejectUnsupportedPrefixListing(prefix);
        if (cell.value !== undefined && !cell.unreadHostEnv) names.add(cell.name);
      }
    }
    return names;
  }

  private rejectUnsupportedPrefixQuery(prefix: string): void {
    for (const unsupported of UNSUPPORTED_SPECIAL_VARIABLES) {
      if (unsupported.startsWith(prefix)) rejectUnsupportedSpecialVariable(unsupported);
    }
    for (const envName of ENVIRONMENT_VARIABLES) {
      if (envName.startsWith(prefix) && this.isUnreadHostEnv(envName)) rejectUnsupportedHostEnv(envName);
    }
    if ('BASH'.startsWith(prefix) || prefix.startsWith('BASH') || 'RANDOM'.startsWith(prefix) || prefix === '') {
      rejectUnsupportedPrefixListing(prefix);
    }
  }

  // ---------------------------------------------------------------- canonical destination selector & mutations

  /** Selects or creates the destination cell for a declaration, assignment, or compound store. */
  selectDestination(
    intent: DestinationIntent,
    name: string,
    initialContainer?: 'indexed' | 'associative',
    checkAppendHostEnv = false,
    declaredArrayKind?: 'indexed' | 'associative'
  ): DestinationSelection {
    if (intent === 'local') return this.selectLocalDestination(name, initialContainer, declaredArrayKind);
    return this.selectScopedDestination(intent, name, initialContainer, checkAppendHostEnv, declaredArrayKind);
  }

  private selectLocalDestination(
    name: string,
    initialContainer?: 'indexed' | 'associative',
    declaredArrayKind?: 'indexed' | 'associative'
  ): DestinationSelection {
    const fnIdx = this.currentFunctionScopeIndex();
    if (fnIdx === undefined) throw new Error('local destination requested outside function');
    const localMap = this.scopes[fnIdx].map;
    const existing = localMap.get(name);
    if (existing) return { scope: 'local', name, cell: this.toHandle(existing), created: false };
    const created = this.allocateCell(
      name,
      this.createInitialContainer(initialContainer),
      containerAttributes(initialContainer ?? declaredArrayKind)
    );
    localMap.set(name, created);
    return { scope: 'local', name, cell: this.toHandle(created), created: true };
  }

  private selectScopedDestination(
    intent: 'global' | 'visible',
    name: string,
    initialContainer: 'indexed' | 'associative' | undefined,
    checkAppendHostEnv: boolean,
    declaredArrayKind?: 'indexed' | 'associative'
  ): DestinationSelection {
    const maxScope = intent === 'global' ? 0 : this.scopes.length - 1;
    if (checkAppendHostEnv && this.isUnreadHostEnv(name, maxScope)) rejectUnsupportedHostEnv(name);
    const existing = intent === 'global' ? this.scopes[0].map.get(name) : this.findOwnCell(name);
    if (existing) return { scope: intent, name, cell: this.toHandle(existing), created: false };
    const unreadHostEnv = initialContainer === undefined && this.isUnreadHostEnv(name, maxScope);
    const created = this.allocateCell(
      name,
      this.createInitialContainer(initialContainer),
      containerAttributes(initialContainer ?? declaredArrayKind)
    );
    created.unreadHostEnv = unreadHostEnv;
    this.scopes[0].map.set(name, created);
    return { scope: intent, name, cell: this.toHandle(created), created: true };
  }

  private createInitialContainer(kind: 'indexed' | 'associative' | undefined): CellValue | undefined {
    if (kind === 'indexed') return { kind: 'indexed', elements: new Map() };
    if (kind === 'associative') return { kind: 'associative', table: new AssociativeTable() };
    return undefined;
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

  /** Applies declaration attributes (`a`, `A`, `i`, `r`, `x`) to `handle` after capability validation. */
  applyAttributes(
    handle: CellHandle,
    toAdd: ReadonlySet<Attribute>,
    allowReadonlyAlreadySet = true
  ): StoreFailure | undefined {
    const cell = this.getCell(handle);
    if (cell.attributes.has('r') && !canApplyToReadonlyCell(toAdd, allowReadonlyAlreadySet)) {
      return { ok: false, reason: 'readonly', message: `${cell.name}: readonly variable` };
    }
    this.detachShared(cell);
    for (const attr of toAdd) cell.attributes.add(attr);
    return undefined;
  }

  /** Binds a whole-variable nameref target onto `handle`, returning any store failure or cycle warning. */
  bindNameref(
    handle: CellHandle,
    target: string | undefined,
    inFunction: boolean
  ): { ok: true; cycleWarning?: string } | StoreFailure {
    const cell = this.getCell(handle);
    if (cell.attributes.has('r')) {
      return { ok: false, reason: 'readonly', message: `${cell.name}: readonly variable` };
    }
    if (isArrayCell(cell)) {
      return { ok: false, reason: 'incompatibleArray', message: `${cell.name}: reference variable cannot be an array` };
    }
    if (target !== undefined) {
      rejectUnsupportedNamerefTarget(target, (n) => this.isUnreadHostEnv(n));
      if (target !== '' && !isIdentifier(target)) {
        return { ok: false, reason: 'invalidIdentifier', message: `\`${target}': not a valid identifier` };
      }
      if (!inFunction && target === cell.name) {
        return {
          ok: false,
          reason: 'cannotAssign',
          message: `${cell.name}: nameref variable self reference not allowed`,
        };
      }
      cell.value = { kind: 'scalar', value: target };
      cell.shared = false;
      cell.nullReference = false;
      cell.unreadHostEnv = false;
      cell.userAssigned = true;
    }
    cell.attributes.add('n');
    const cycle = this.hasCycleFrom(cell);
    return {
      ok: true,
      ...(cycle ? { cycleWarning: `warning: ${cell.name}: circular name reference` } : {}),
    };
  }

  private hasCycleFrom(start: Cell): boolean {
    const seen = new Set<Cell>();
    for (let cur: Cell | undefined = start; cur?.attributes.has('n') && cur.value?.kind === 'scalar';) {
      if (seen.has(cur)) return true;
      seen.add(cur);
      const target: string = cur.value.value;
      cur = target === '' ? undefined : this.findOwnCell(target);
    }
    return false;
  }

  setNullReference(handle: CellHandle, isNull: boolean): void {
    const cell = this.getCell(handle);
    cell.nullReference = isNull;
  }

  writeScalar(
    handle: CellHandle,
    rawText: string,
    append: boolean,
    evalInt: IntEvaluator,
    reportedName?: string
  ): StoreOutcome {
    const target = this.writableCellOrFailure(handle, reportedName);
    if (!target.ok) return target;
    const { cell, label } = target;
    if (isArrayCell(cell)) {
      return cell.value?.kind === 'associative' || cell.attributes.has('A')
        ? this.writeAssociativeElement(handle, '0', rawText, append, evalInt, label)
        : this.writeIndexedElement(handle, 0n, rawText, append, evalInt, label);
    }
    if (append && cell.unreadHostEnv) rejectUnsupportedHostEnv(cell.name);
    const base = append && cell.value?.kind === 'scalar' ? cell.value.value : '';
    const prep = this.prepareConvertedString(cell, rawText, base, append, evalInt);
    if (!prep.ok) return prep;
    cell.value = { kind: 'scalar', value: prep.value };
    cell.shared = false;
    cell.nullReference = false;
    cell.unreadHostEnv = false;
    cell.userAssigned = true;
    return { ok: true, stored: prep.value };
  }

  writeAssociativeElement(
    handle: CellHandle,
    key: string,
    rawText: string,
    append: boolean,
    evalInt: IntEvaluator,
    reportedName?: string
  ): StoreOutcome {
    return this.writeMapEntry(handle, key, { rawText, append, evalInt, reportedName }, (cell) =>
      this.ensureAssociativeTable(cell)
    );
  }

  writeIndexedElement(
    handle: CellHandle,
    index: bigint,
    rawText: string,
    append: boolean,
    evalInt: IntEvaluator,
    reportedName?: string
  ): StoreOutcome {
    return this.writeMapEntry(handle, index, { rawText, append, evalInt, reportedName }, (cell) => {
      this.detachShared(cell);
      return this.ensureIndexedMap(cell);
    });
  }

  private writeMapEntry<K>(
    handle: CellHandle,
    key: K,
    opts: { rawText: string; append: boolean; evalInt: IntEvaluator; reportedName?: string },
    getMap: (cell: Cell) => { has(k: K): boolean; get(k: K): string | undefined; set(k: K, v: string): unknown }
  ): StoreOutcome {
    const target = this.writableCellOrFailure(handle, opts.reportedName);
    if (!target.ok) return target;
    if (opts.append && target.cell.unreadHostEnv) rejectUnsupportedHostEnv(target.cell.name);
    const map = getMap(target.cell);
    const base = opts.append ? (map.get(key) ?? '') : '';
    const prep = this.prepareConvertedString(target.cell, opts.rawText, base, opts.append, opts.evalInt);
    if (!prep.ok) return prep;
    if (!map.has(key)) this.runtime.allocateSlots(1);
    map.set(key, prep.value);
    target.cell.unreadHostEnv = false;
    target.cell.userAssigned = true;
    return { ok: true, stored: prep.value };
  }

  // code-gauge-allow functionCognitiveComplexity -- Writes keyed and plain elements into associative or indexed containers with Bash's partial-commit rules.
  writeCompound(handle: CellHandle, elements: CompoundElement[], hooks: CompoundWriteHooks): StoreOutcome {
    const target = this.writableCellOrFailure(handle, hooks.reportedName);
    if (!target.ok) return target;
    const { cell, label } = target;
    if (hooks.append && cell.unreadHostEnv) rejectUnsupportedHostEnv(cell.name);
    this.detachShared(cell);
    if (cell.value?.kind === 'associative' || cell.attributes.has('A')) {
      return this.writeAssociativeCompound(cell, elements, hooks, label);
    }
    const map = hooks.append ? this.ensureIndexedMap(cell) : new Map<bigint, string>();
    if (!hooks.append) {
      cell.value = { kind: 'indexed', elements: map };
      cell.attributes.add('a');
    }
    cell.unreadHostEnv = false;
    cell.userAssigned = true;
    let next = hooks.append ? maxElementIndex(map) + 1n : 0n;
    for (const rawElement of elements) {
      const item = unpackIndexedElement(rawElement);
      const index = item.key === undefined ? next : hooks.evalIndex(handle, item.key);
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
        cell.unreadHostEnv = false;
        cell.userAssigned = true;
        return failure;
      }
    }
    cell.value = { kind: 'associative', table };
    cell.attributes.add('A');
    cell.unreadHostEnv = false;
    cell.userAssigned = true;
    return { ok: true, stored: '' };
  }

  private storeAssociativeCompoundPair(
    cell: Cell,
    table: AssociativeTable,
    baseTable: AssociativeTable | undefined,
    entry: { key: string; value: string; append: boolean },
    evalInt: IntEvaluator
  ): StoreFailure | undefined {
    const base = entry.append ? (baseTable?.get(entry.key) ?? '') : '';
    const prep = this.prepareConvertedString(cell, entry.value, base, entry.append, evalInt);
    if (!prep.ok) return prep;
    if (!table.has(entry.key)) this.runtime.allocateSlots(1);
    table.set(entry.key, prep.value);
    return undefined;
  }

  /** Streams incremental associative `+=(...)` pairs through the single store compound writer. */
  writeAssociativeCompoundStream(
    handle: CellHandle,
    reportedName: string,
    evalInt: IntEvaluator,
    drivePairs: (commitPair: (key: string, value: string, append: boolean) => boolean) => string | undefined
  ): { outcome: StoreOutcome; syntaxError?: string } {
    const target = this.writableCellOrFailure(handle, reportedName);
    if (!target.ok) return { outcome: target };
    const { cell } = target;
    if (cell.unreadHostEnv) rejectUnsupportedHostEnv(cell.name);
    this.detachShared(cell);
    const table = this.ensureAssociativeTable(cell);
    cell.unreadHostEnv = false;
    cell.userAssigned = true;
    let streamFailure: StoreFailure | undefined;
    const syntaxError = drivePairs((key, value, append) => {
      const failure = this.storeAssociativeCompoundPair(cell, table, table, { key, value, append }, evalInt);
      if (failure) {
        streamFailure = failure;
        return false;
      }
      return true;
    });
    if (streamFailure) return { outcome: streamFailure };
    return { outcome: { ok: true, stored: '' }, ...(syntaxError !== undefined ? { syntaxError } : {}) };
  }

  unsetNamed(target: string): StoreFailure | undefined {
    rejectSpecialVariableMutation(target, false);
    const fnIdx = this.currentFunctionScopeIndex();
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const cell = this.scopes[i].map.get(target);
      if (!cell) continue;
      if (cell.attributes.has('r')) {
        return { ok: false, reason: 'readonly', message: `${target}: cannot unset: readonly variable` };
      }
      if (i > 0 && fnIdx === i) {
        cell.value = undefined;
        cell.shared = false;
        cell.userAssigned = false;
        cell.nullReference = false;
        cell.attributes.clear();
      } else {
        this.scopes[i].map.delete(target);
        this.cellsById.delete(cell.id);
      }
      if (i === 0 && ENVIRONMENT_VARIABLES.has(target)) this.unsetHostEnv.add(target);
      return undefined;
    }
    if (ENVIRONMENT_VARIABLES.has(target)) this.unsetHostEnv.add(target);
    return undefined;
  }

  unsetElement(
    handle: CellHandle,
    target: { kind: 'associative'; key: string } | { kind: 'indexed'; index: bigint } | { kind: 'wholeArray' },
    reportedName: string
  ): StoreFailure | undefined {
    const cell = this.getCell(handle);
    if (cell.attributes.has('r')) {
      return { ok: false, reason: 'readonly', message: `${reportedName}: cannot unset: readonly variable` };
    }
    if (target.kind === 'associative') {
      if (cell.value?.kind === 'associative') {
        this.detachShared(cell);
        cell.value.table.delete(target.key);
      }
      return undefined;
    }
    if (target.kind === 'wholeArray') {
      if (cell.value?.kind === 'indexed') {
        this.detachShared(cell);
        cell.value.elements.clear();
        return undefined;
      }
      if (!cell.attributes.has('a')) {
        return { ok: false, reason: 'notArray', message: `${reportedName}: not an array variable` };
      }
      return undefined;
    }
    if (cell.value?.kind === 'indexed') {
      this.detachShared(cell);
      cell.value.elements.delete(target.index);
      return undefined;
    }
    if (cell.attributes.has('a')) return undefined;
    if (target.index === 0n) return this.unsetNamed(cell.name);
    return { ok: false, reason: 'notArray', message: `${reportedName}: not an array variable` };
  }

  // ---------------------------------------------------------------- pure trace & GC inspection

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

  /** Pure whole-variable nameref traversal bounded to `maxScopeIndex` with cycle detection. */
  resolveViewInFrame(view: VariableView, maxScopeIndex: number): VariableView | undefined {
    if (!view.handle || !view.attributes.has('n')) return view;
    const visited = new Set<number>();
    let cur: Cell | undefined = this.getCell(view.handle);
    for (let depth = 0; depth < 16 && cur; depth++) {
      if (!cur.attributes.has('n') || cur.value?.kind !== 'scalar') return this.cellToView(cur);
      if (visited.has(cur.id)) return undefined;
      visited.add(cur.id);
      const ref: string = cur.value.value;
      if (ref === '') return this.cellToView(cur);
      if (!isIdentifier(ref)) return undefined;
      cur = this.findOwnCell(ref, maxScopeIndex);
    }
    return undefined;
  }

  /** Yields all stored scalar/array strings, associative keys, and positional parameters for turtle GC. */
  *storedReachableStrings(): Iterable<string> {
    for (const scope of this.scopes) {
      for (const cell of scope.map.values()) {
        if (cell.value) yield* cellStrings(cell.value);
      }
    }
    for (const args of this.positional) yield* args;
    yield* this.rematch;
    if (this.lastArgument !== undefined) yield this.lastArgument;
  }

  // ---------------------------------------------------------------- private cell helpers

  private writableCellOrFailure(
    handle: CellHandle,
    reportedName?: string
  ): { ok: true; cell: Cell; label: string } | StoreFailure {
    const cell = this.getCell(handle);
    const label = reportedName ?? cell.name;
    if (cell.attributes.has('r')) {
      return { ok: false, reason: 'readonly', message: `${label}: readonly variable` };
    }
    return { ok: true, cell, label };
  }

  private prepareConvertedString(
    cell: Cell,
    rawValue: string,
    base: string,
    append: boolean,
    evalInt: IntEvaluator
  ): { ok: true; value: string } | StoreFailure {
    const converted = this.convertForCell(cell, rawValue, base, append, evalInt);
    if (converted === undefined) return { ok: false, reason: 'arithmetic', message: '', alreadyReported: true };
    this.checkStringLength(converted);
    return { ok: true, value: converted };
  }

  private ensureAssociativeTable(cell: Cell): AssociativeTable {
    this.detachShared(cell);
    if (cell.value?.kind !== 'associative') {
      cell.value = { kind: 'associative', table: new AssociativeTable() };
      cell.attributes.add('A');
    }
    return cell.value.table;
  }

  private detachShared(cell: Cell): void {
    if (!cell.shared) return;
    if (cell.value?.kind === 'indexed') {
      cell.value = { kind: 'indexed', elements: new Map(cell.value.elements) };
    } else if (cell.value?.kind === 'associative') {
      cell.value = { kind: 'associative', table: cell.value.table.clone() };
    } else if (cell.value?.kind === 'scalar') {
      cell.value = { kind: 'scalar', value: cell.value.value };
    }
    cell.shared = false;
  }

  private ensureIndexedMap(cell: Cell): Map<bigint, string> {
    if (cell.value?.kind === 'indexed') return cell.value.elements;
    const elements = new Map<bigint, string>();
    if (cell.value?.kind === 'scalar') {
      this.runtime.allocateSlots(1);
      elements.set(0n, cell.value.value);
    }
    cell.value = { kind: 'indexed', elements };
    cell.attributes.add('a');
    return elements;
  }

  private convertForCell(
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

  private checkStringLength(value: string): void {
    this.runtime.spend(Math.ceil(value.length / 256));
    if (value.length > LIMITS.maxStringLength) throw new ExecutionLimitError('storage');
  }
}

function containerAttributes(kind: 'indexed' | 'associative' | undefined): Attribute[] {
  return kind === 'associative' ? ['A'] : kind === 'indexed' ? ['a'] : [];
}

function* cellStrings(value: CellValue): Iterable<string> {
  if (value.kind === 'scalar') {
    yield value.value;
    return;
  }
  if (value.kind === 'indexed') {
    yield* value.elements.values();
    return;
  }
  yield* value.table.rawStrings();
}

function isArrayCell(cell: Cell): boolean {
  return (
    cell.value?.kind === 'indexed' ||
    cell.value?.kind === 'associative' ||
    cell.attributes.has('a') ||
    cell.attributes.has('A')
  );
}

function canApplyToReadonlyCell(toAdd: ReadonlySet<Attribute>, allowReadonlyAlreadySet: boolean): boolean {
  if (!allowReadonlyAlreadySet) return false;
  for (const attr of toAdd) {
    if (attr !== 'r' && attr !== 'x') return false;
  }
  return true;
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
