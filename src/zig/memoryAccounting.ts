import { assert } from 'es-toolkit';

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
  assert(accounting, 'No memory accounting is active');
  accounting.spend(cost);
}

export function reserveMemory(slots: number): void {
  assert(accounting, 'No memory accounting is active');
  accounting.reserve(slots);
}

export function memorySpace(): BufferMemorySpace {
  assert(accounting, 'No memory accounting is active');
  return accounting.space;
}
