import { LIMITS } from '../interpreter/limits';
import { bindBufferMemory } from './bufferMemory';
import { spendMemory } from './memoryAccounting';
import { type Frame, StackOverflow } from './runtime';
import type { Type } from './types';
import { NativeHandle, NULL, type Pointer, type Slice, type Slots, storageLocation, ZArray, ZStruct } from './values';

export interface AllocatorState extends Record<string, unknown> {
  name: string;
  owner?: Pointer;
}

export interface ByteRegion {
  buffer: Slice;
  offset: number;
  length: number;
}

export interface ByteReservation {
  region?: ByteRegion;
  complete: (memory: object) => void;
}

interface Allocation {
  state: AllocatorState | undefined;
  start: number;
  end: number;
  region?: ByteRegion;
  arenaNode?: NativeHandle;
  live: boolean;
}

interface ArenaNode extends Record<string, unknown> {
  size: number;
  end: number;
  next?: NativeHandle;
  region?: ByteRegion;
  memory: object;
}

const allocations = new WeakMap<object, Map<number, Allocation>>();
const NODE_SIZE = 24;

// code-gauge-allow functionCognitiveComplexity 23 -- Keeps zero-size frees, in-place remaps and allocator-specific reservations at one allocation boundary.
export function reserveAllocatorBytes(
  frame: Frame,
  state: AllocatorState | undefined,
  length: number,
  alignment: number,
  previous?: object,
  depth = 0
): ByteReservation | undefined {
  checkDepth(frame, depth);
  const owner = state?.owner?.load();
  const prior = previous ? allocationOf(previous) : undefined;
  if (length === 0) {
    if (previous) freeAllocatedMemory(state, previous);
    return { complete: () => {} };
  }
  if (owner instanceof ZStruct && state?.name === 'fixed') {
    if (prior?.live && previous && resizeAllocatorBytes(state, previous, length)) return reservation(prior);
    const buffer = owner.slots[1] as Slice;
    const used = Number(owner.slots[0] as bigint);
    const start =
      prior?.live && prior.end === used
        ? prior.start
        : alignTo(bufferAddress(buffer) + used, alignment) - bufferAddress(buffer);
    if (start + length > buffer.length) return undefined;
    owner.slots[0] = BigInt(start + length);
    return reservation({ state, start, end: start + length, region: { buffer, offset: start, length }, live: true });
  }
  if (owner instanceof ZStruct && state?.name === 'arena')
    return reserveArena(frame, state, owner, length, alignment, prior, depth);
  if (owner instanceof ZStruct && state?.name === 'debug' && !prior?.live)
    owner.slots[0] = (owner.slots[0] as bigint) + 1n;
  return reservation({ state, start: 0, end: length, live: true });
}

export function bindAllocatorBytes(
  frame: Frame,
  reservation: ByteReservation,
  memory: object,
  type: Type,
  count: number,
  initialized: number
): void {
  if (reservation.region) {
    bindBufferMemory(
      memory,
      type,
      count,
      reservation.region.buffer,
      reservation.region.offset,
      frame.runtime,
      initialized
    );
  }
  reservation.complete(memory);
}

// code-gauge-allow functionCognitiveComplexity 16 -- Frees each allocator kind using its own last-allocation semantics.
export function freeAllocatorMemory(state: AllocatorState | undefined, memory: object, depth = 0): void {
  if (depth >= LIMITS.maxCallDepth) throw new StackOverflow();
  const record = allocationOf(memory);
  if (!record?.live) return;
  const owner = state?.owner?.load();
  if (owner instanceof ZStruct && state?.name === 'fixed') {
    if (record.end === Number(owner.slots[0] as bigint)) owner.slots[0] = BigInt(record.start);
  } else if (owner instanceof ZStruct && state?.name === 'debug') {
    owner.slots[0] = (owner.slots[0] as bigint) - 1n;
  } else if (owner instanceof ZStruct && state?.name === 'arena') {
    const first = arenaHeader(owner).slots[0];
    if (first instanceof NativeHandle && first === record.arenaNode) {
      const node = first.state as ArenaNode;
      if (record.end === node.end) node.end = record.start;
    }
  }
  record.live = false;
}

export function freeAllocatedMemory(state: AllocatorState | undefined, memory: object): void {
  poisonAllocatorBytes(memory);
  freeAllocatorMemory(state, memory);
}

export function poisonAllocatorBytes(memory: object, offset = 0, length?: number): void {
  const record = allocationOf(memory);
  const region = record?.region;
  if (!record?.live || !region) return;
  const count = length ?? region.length - offset;
  spendMemory(count);
  for (let index = 0; index < count; index++) region.buffer.set(region.offset + offset + index, 0xaan);
}

export function deinitArena(frame: Frame, arena: ZStruct): void {
  const child = childOf(arena);
  const header = arenaHeader(arena);
  for (const first of header.slots) {
    let current = first;
    while (current instanceof NativeHandle) {
      frame.runtime.spend();
      const node = current.state as ArenaNode;
      freeAllocatorMemory(child, node.memory);
      current = node.next;
    }
  }
  header.slots.fill(NULL);
}

export function arenaCapacity(frame: Frame, arena: ZStruct): number {
  let capacity = 0;
  for (const first of arenaHeader(arena).slots) {
    let current = first;
    while (current instanceof NativeHandle) {
      frame.runtime.spend();
      const node = current.state as ArenaNode;
      capacity += node.size - NODE_SIZE;
      current = node.next;
    }
  }
  return capacity;
}

// code-gauge-allow functionNcss 46 -- Preserves arena node ownership through resize and replacement failures.
// code-gauge-allow functionCognitiveComplexity 21 -- Preserves arena node ownership through resize and replacement failures.
export function resetArena(frame: Frame, arena: ZStruct, limit?: number): boolean {
  if (limit === 0) {
    deinitArena(frame, arena);
    return true;
  }
  const child = childOf(arena);
  const header = arenaHeader(arena);
  let remaining = limit ?? Number.POSITIVE_INFINITY;
  let successful = true;
  for (let group = 0; group < header.slots.length; group++) {
    let first = header.slots[group];
    if (!(first instanceof NativeHandle)) continue;
    let total = 0;
    let last = first;
    for (;;) {
      frame.runtime.spend();
      const node = last.state as ArenaNode;
      total += node.size - NODE_SIZE;
      if (!node.next) break;
      freeAllocatorMemory(child, node.memory);
      last = node.next;
    }
    const capacity = Math.min(total, remaining);
    remaining -= capacity;
    const size = Math.floor((NODE_SIZE + capacity) / 2) * 2;
    const node = last.state as ArenaNode;
    node.end = 0;
    node.next = undefined;
    header.slots[group] = last;
    if (size === NODE_SIZE) {
      freeAllocatorMemory(child, node.memory);
      header.slots[group] = NULL;
    } else if (size !== node.size) {
      if (resizeAllocatorBytes(child, node.memory, size)) node.size = size;
      else {
        const reserved = reserveAllocatorBytes(frame, child, size, 8);
        if (!reserved) successful = false;
        else {
          freeAllocatorMemory(child, node.memory);
          const memory = {};
          reserved.complete(memory);
          header.slots[group] = new NativeHandle('arenaNode', {
            size,
            end: 0,
            memory,
            region: reserved.region,
          } satisfies ArenaNode);
        }
      }
    }
  }
  return successful;
}

// code-gauge-allow functionNcss 37 -- Follows the reference arena allocation, child resize, and chunk growth sequence.
// code-gauge-allow functionCognitiveComplexity 16 -- Follows the reference arena allocation, child resize, and chunk growth sequence.
// code-gauge-allow functionParameterCount 7 -- Keeps allocation size, alignment, prior storage, and recursion budget explicit.
function reserveArena(
  frame: Frame,
  state: AllocatorState,
  owner: ZStruct,
  length: number,
  alignment: number,
  previous: Allocation | undefined,
  depth: number
): ByteReservation | undefined {
  const header = arenaHeader(owner);
  const child = childOf(owner);
  let first = header.slots[0] instanceof NativeHandle ? header.slots[0] : undefined;
  let node = first?.state as ArenaNode | undefined;
  if (node && previous?.live && previous.arenaNode === first) {
    if (previous.end === node.end && previous.start + length <= node.size - NODE_SIZE) {
      node.end = previous.start + length;
      return arenaReservation(state, first!, previous.start, length);
    }
    if (length <= previous.end - previous.start) return arenaReservation(state, first!, previous.start, length);
  }
  if (node) {
    const base = nodeAddress(node) + NODE_SIZE;
    const start = alignTo(base + node.end, alignment) - base;
    node.end = start + length;
    if (node.end <= node.size - NODE_SIZE) return arenaReservation(state, first!, start, length);
    const resizedStart = alignTo(base + node.end, alignment) - base;
    const size = alignTo(NODE_SIZE + resizedStart + length, 2);
    if (resizeAllocatorBytes(child, node.memory, size)) {
      node.size = size;
      node.end = resizedStart + length;
      return arenaReservation(state, first!, resizedStart, length);
    }
  }
  const previousCapacity = node ? node.size - NODE_SIZE : 0;
  const required = previousCapacity + NODE_SIZE + alignment + length + 16;
  const size = alignTo(required + Math.floor(required / 2), 2);
  const reserved = reserveAllocatorBytes(frame, child, size, 8, undefined, depth + 1);
  if (!reserved) return undefined;
  const memory = {};
  reserved.complete(memory);
  const base = reserved.region ? bufferAddress(reserved.region.buffer) + reserved.region.offset + NODE_SIZE : NODE_SIZE;
  const start = alignTo(base, alignment) - base;
  const next = first;
  first = new NativeHandle('arenaNode', {
    size,
    end: start + length,
    next,
    region: reserved.region,
    memory,
  } satisfies ArenaNode);
  header.slots[0] = first;
  return arenaReservation(state, first, start, length);
}

function arenaReservation(state: AllocatorState, handle: NativeHandle, start: number, length: number): ByteReservation {
  const node = handle.state as ArenaNode;
  const region = node.region && { buffer: node.region.buffer, offset: node.region.offset + NODE_SIZE + start, length };
  return reservation({ state, start, end: start + length, region, arenaNode: handle, live: true });
}

// code-gauge-allow functionCognitiveComplexity 27 -- Applies the distinct in-place resize rules of each allocator.
// code-gauge-allow functionNcss 33 -- Keeps allocation record updates after the allocator-specific resize decisions.
function resizeAllocatorBytes(state: AllocatorState | undefined, memory: object, size: number): boolean {
  const record = allocationOf(memory);
  if (!record?.live) return false;
  const owner = state?.owner?.load();
  if (owner instanceof ZStruct && state?.name === 'fixed') {
    const buffer = owner.slots[1] as Slice;
    if (record.end !== Number(owner.slots[0] as bigint)) {
      if (size > record.end - record.start) return false;
    } else {
      if (record.start + size > buffer.length) return false;
      owner.slots[0] = BigInt(record.start + size);
    }
  } else if (owner instanceof ZStruct && state?.name === 'arena') {
    const first = arenaHeader(owner).slots[0];
    if (!(first instanceof NativeHandle) || first !== record.arenaNode) return size <= record.end - record.start;
    const node = first.state as ArenaNode;
    if (record.end !== node.end) return size <= record.end - record.start;
    if (record.start + size > node.size - NODE_SIZE) return false;
    node.end = record.start + size;
  } else {
    const capacity = state?.name === 'page' ? alignTo(record.end - record.start, 16_384) : record.end - record.start;
    if (size > capacity) return false;
  }
  record.end = record.start + size;
  if (record.region) record.region.length = size;
  return true;
}

function reservation(record: Allocation): ByteReservation {
  return {
    region: record.region,
    complete: (memory) => {
      const location = memoryLocation(memory);
      let entries = allocations.get(location.storage);
      if (!entries) {
        entries = new Map();
        allocations.set(location.storage, entries);
      }
      entries.set(location.index, record);
    },
  };
}

function allocationOf(memory: object): Allocation | undefined {
  const location = memoryLocation(memory);
  return allocations.get(location.storage)?.get(location.index);
}

function memoryLocation(memory: object): { storage: object; index: number } {
  if (memory instanceof ZArray) return storageLocation(memory.slots, memory.offset);
  if ('slots' in memory && Array.isArray((memory as Slots).slots)) return storageLocation((memory as Slots).slots, 0);
  return { storage: memory, index: 0 };
}

function bufferAddress(buffer: Slice): number {
  return storageLocation(buffer.target.slots, buffer.start).index;
}

function nodeAddress(node: ArenaNode): number {
  return node.region ? bufferAddress(node.region.buffer) + node.region.offset : 0;
}

function arenaHeader(arena: ZStruct): ZStruct {
  return arena.slots[1] as ZStruct;
}

function childOf(arena: ZStruct): AllocatorState {
  return (arena.slots[0] as NativeHandle).state as AllocatorState;
}

function alignTo(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function checkDepth(frame: Frame, depth: number): void {
  frame.runtime.spend();
  if (depth >= LIMITS.maxCallDepth) throw new StackOverflow();
}
