import { ExecutionLimitError, LIMITS } from '../interpreter/limits';
import type { Type } from './types';

export class CompilationStorage {
  private allocated = 0;

  reserve(type: Type): void {
    this.allocated += valueSlots(type);
    if (this.allocated > LIMITS.maxSlots) throw new ExecutionLimitError('storage');
  }
}

export function valueSlots(type: Type): number {
  let count = 0;
  switch (type.kind) {
    case 'array': {
      count = type.length + (type.sentinel === undefined ? 0 : 1);
      if (type.length > 0 && count <= LIMITS.maxSlots) count += type.length * valueSlots(type.child);
      break;
    }
    case 'struct': {
      for (const field of type.fields ?? []) {
        count += 1 + valueSlots(field.type);
        if (count > LIMITS.maxSlots) break;
      }
      break;
    }
    case 'union': {
      count = 1 + Math.max(0, ...(type.fields ?? []).map((field) => valueSlots(field.type)));
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
