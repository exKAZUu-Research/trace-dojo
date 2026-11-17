import assert from 'node:assert/strict';

import type { BufferMemorySpace } from './bufferMemory';

interface MemoryAccounting {
  space: BufferMemorySpace;
  spend: (cost?: number) => void;
  reserve: (slots: number) => void;
}

let accounting: MemoryAccounting | undefined;

export function withMemoryAccounting<T>(next: MemoryAccounting, evaluate: () => T): T {
  const previous = accounting;
  accounting = next;
  try {
    return evaluate();
  } finally {
    accounting = previous;
  }
}

export function spendMemory(cost = 1): void {
  assert.ok(accounting);
  accounting.spend(cost);
}

export function reserveMemory(slots: number): void {
  assert.ok(accounting);
  accounting.reserve(slots);
}

export function memorySpace(): BufferMemorySpace {
  assert.ok(accounting);
  return accounting.space;
}
