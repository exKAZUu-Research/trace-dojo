import { ExecutionLimitError, LIMITS } from '../interpreter/limits';
import { sizeOf } from './layout';
import { singleValueOf } from './singleValue';
import type { Type } from './types';

export class CompilationStorage {
  private allocated = 0;

  reserve(type: Type): void {
    this.allocated += valueSlots(type);
    if (this.allocated > LIMITS.maxSlots) throw new ExecutionLimitError('storage');
  }
}

// code-gauge-allow functionNcss 37 -- Counts the storage of each value representation recursively.
// code-gauge-allow functionCognitiveComplexity 19 -- Computes nested storage requirements by type without allocating values.
export function valueSlots(type: Type): number {
  let count = 0;
  switch (type.kind) {
    case 'int':
    case 'float': {
      count = Math.max(0, Math.ceil(type.bits / 64) - 1);
      break;
    }
    case 'array': {
      if (singleValueOf(type.child, () => {})) break;
      count = Number(type.length + (type.sentinel === undefined ? 0n : 1n));
      if (type.length > 0 && count <= LIMITS.maxSlots) count += Number(type.length) * valueSlots(type.child);
      break;
    }
    case 'struct': {
      if (type.namespace.internal) break;
      count = type.native?.storageSlots ?? 0;
      for (const field of type.fields ?? []) {
        count += 1 + valueSlots(field.type);
        if (count > LIMITS.maxSlots) break;
      }
      break;
    }
    case 'union': {
      count = 1;
      for (const field of type.fields ?? []) count = Math.max(count, 1 + valueSlots(field.type));
      break;
    }
    case 'optional': {
      count = valueSlots(type.child);
      break;
    }
    case 'error_union': {
      count = valueSlots(type.payload);
      break;
    }
  }
  if (!Number.isSafeInteger(count) || count > LIMITS.maxSlots) throw new ExecutionLimitError('storage');
  return count;
}

export function transferCost(type: Type): number {
  return sizeOf(type) === 0 ? 0 : 1 + valueSlots(type);
}

export function allocationSlots(count: number, child: Type): number {
  if (count === 0) return 0;
  try {
    return count * (1 + valueSlots(child));
  } catch (error) {
    if (error instanceof ExecutionLimitError) return Infinity;
    throw error;
  }
}

export function checkOutputSize(length: number): void {
  if (!Number.isSafeInteger(length) || length > LIMITS.maxOutputLength * 4) throw new ExecutionLimitError('output');
}
