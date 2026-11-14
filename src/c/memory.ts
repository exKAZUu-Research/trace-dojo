import type { TurtleState } from '../interpreter/turtleWorld';
import { CRuntimeError } from './errors';
import type { PointerBytes } from './pointerBounds';
import type { CType } from './types';

export type Region = 'text' | 'data' | 'heap' | 'stack';

/** A block of memory: a variable, a string literal, a block from `malloc`, a function, or a turtle. */
export class Allocation {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  /** Each set bit marks an initialized bit; record copies must retain partial bit-field initialization. */
  readonly initialized: Uint8Array;
  readonly pointerBytes: PointerBytes = new Map();
  isAlive = true;
  isReadOnly = false;
  /** The declared type of a variable, which the trace uses to show what a pointer to it points to. */
  type?: CType;
  /** The variable's name, for messages. */
  name?: string;
  turtle?: TurtleState;
  /** The function at this address. */
  target?: unknown;
  /** Whether `malloc` or a related function created the block, which `free` may then release. */
  readonly isHeap: boolean;

  constructor(
    readonly base: number,
    readonly size: number,
    readonly region: Region
  ) {
    this.bytes = new Uint8Array(size);
    this.view = new DataView(this.bytes.buffer);
    this.initialized = new Uint8Array(size);
    this.isHeap = region === 'heap';
  }

  get end(): number {
    return this.base + this.size;
  }
}

const REGION_STARTS: Record<Region, number> = {
  text: 0x1_00_00_00_00,
  data: 0x1_00_00_80_00,
  heap: 0x60_00_00_00_00_00,
  stack: 0x1_6f_df_f0_00,
};

export const MIN_ADDRESS = Math.min(...Object.values(REGION_STARTS));

/** The gap left after every block, so that a pointer just past one block never points into the next. */
const GUARD = 16;
const MAX_STACK_BYTES = 8 * 1024 * 1024;
/** The lowest address the stack region may reach, far below what the operation limit lets a run allocate. */
const STACK_FLOOR = 0x1_40_00_00_00;

/**
 * The address space of one run. Addresses are numbers; each region hands out addresses that it never reuses, so that a
 * pointer to a freed block or a returned function's variable can be told apart from a pointer to a live block.
 */
export class Memory {
  /** The live blocks of each region, in address order. */
  private readonly live: Record<Region, Allocation[]> = { text: [], data: [], heap: [], stack: [] };
  private readonly freed: Allocation[] = [];
  private readonly byBase = new Map<number, Allocation>();
  private next: Record<Region, number> = { ...REGION_STARTS };
  private stackBytes = 0;
  private lastFound?: Allocation;

  allocate(size: number, region: Region, alignment = 16): Allocation {
    let base: number;
    if (region === 'stack') {
      this.stackBytes += size;
      if (this.stackBytes > MAX_STACK_BYTES) throw new CRuntimeError('stackOverflow');
      // The stack grows downward, so that later frames have lower addresses, as on arm64.
      const unit = Math.max(16, alignment);
      this.next.stack = Math.floor((this.next.stack - size - GUARD) / unit) * unit;
      base = this.next.stack;
    } else {
      base = this.alignedBase(region, alignment);
      this.next[region] = base + Math.ceil((Math.max(size, 1) + GUARD) / 16) * 16;
    }
    const allocation = new Allocation(base, size, region);
    this.byBase.set(base, allocation);
    if (region === 'stack') this.live.stack.unshift(allocation);
    else this.live[region].push(allocation);
    return allocation;
  }

  canAllocateHeap(size: number, alignment: number): boolean {
    return Number.isSafeInteger(this.alignedBase('heap', alignment) + Math.max(size, 1) + GUARD);
  }

  private alignedBase(region: Region, alignment: number): number {
    const unit = Math.max(16, alignment);
    return Math.ceil(this.next[region] / unit) * unit;
  }

  /** Ends the lifetime of a block: a returned function's variable, or a block that `free` releases. */
  release(allocation: Allocation): void {
    allocation.isAlive = false;
    this.byBase.delete(allocation.base);
    const list = this.live[allocation.region];
    const index = list.indexOf(allocation);
    if (index !== -1) list.splice(index, 1);
    if (allocation.region === 'stack') this.stackBytes -= allocation.size;
    else this.freed.push(allocation);
    if (this.lastFound === allocation) this.lastFound = undefined;
  }

  /** The live block containing an address, if any. */
  find(address: number): Allocation | undefined {
    const last = this.lastFound;
    if (last && address >= last.base && address < last.end) return last;
    const list = this.live[regionOf(address)];
    let low = 0;
    let high = list.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const candidate = list[middle];
      if (address < candidate.base) high = middle - 1;
      else if (address >= candidate.end) low = middle + 1;
      else {
        this.lastFound = candidate;
        return candidate;
      }
    }
    return undefined;
  }

  /** The live block starting exactly at an address, as `free` requires. */
  findBase(address: number): Allocation | undefined {
    return this.byBase.get(address);
  }

  wasFreed(address: number): boolean {
    return this.freed.some((block) => block.base === address);
  }

  /**
   * The block an access of `size` bytes at `address` falls in, stopping the program at an access that undefined
   * behavior would make: a null pointer, a block that no longer exists, or bytes outside the block.
   */
  locate(address: number, size: number): Allocation {
    const last = this.lastFound;
    if (last && address >= last.base && address + size <= last.end) return last;
    const found = this.find(address);
    if (found && address + size <= found.end) return found;
    throw this.accessError(address, found);
  }

  private accessError(address: number, found: Allocation | undefined): CRuntimeError {
    if (address < 4096) return new CRuntimeError('nullAccess');
    if (found) return new CRuntimeError('outOfBounds');
    const region = regionOf(address);
    // An address in the gap around a live block went past one end of it.
    if (this.live[region].some((block) => address >= block.base - GUARD && address < block.end + GUARD)) {
      return new CRuntimeError('outOfBounds');
    }
    if (region === 'stack' && address >= this.next.stack) {
      return new CRuntimeError('deadStack');
    }
    if (this.freed.some((block) => address >= block.base && address < block.end))
      return new CRuntimeError('useAfterFree');
    return new CRuntimeError('outOfBounds');
  }

  /** Every live block, for the turtles' reachability. */
  *blocks(): Iterable<Allocation> {
    for (const region of ['text', 'data', 'heap', 'stack'] as const) yield* this.live[region];
  }

  isStackAddress(address: number): boolean {
    return regionOf(address) === 'stack';
  }

  isHeapAddress(address: number): boolean {
    return regionOf(address) === 'heap';
  }
}

function regionOf(address: number): Region {
  if (address >= REGION_STARTS.heap) return 'heap';
  if (address >= STACK_FLOOR) return 'stack';
  if (address >= REGION_STARTS.data) return 'data';
  return 'text';
}
