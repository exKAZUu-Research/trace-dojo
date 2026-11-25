import { bitSizeOf } from './layout';
import type { Type } from './types';

const C_INTEGER_BITS = new Set([8, 16, 32, 64, 128]);

/** Whether the C calling convention passes a parameter or returns a value of the type, as Zig 0.17 allows. */
export function cAbiType(type: Type, isReturn: boolean): boolean {
  switch (type.kind) {
    case 'int': {
      return C_INTEGER_BITS.has(type.bits);
    }
    case 'float':
    case 'bool': {
      return true;
    }
    case 'void':
    case 'noreturn': {
      return isReturn;
    }
    case 'pointer': {
      return type.size !== 'slice';
    }
    case 'optional': {
      return type.child.kind === 'pointer' && type.child.size !== 'slice';
    }
    case 'enum': {
      return type.namespace.syntax?.argument !== undefined;
    }
    case 'struct':
    case 'union': {
      // A packed type has a C ABI only through the backing integer that `packed struct(u8)` names, of a C width.
      return (
        type.layout === 'extern' ||
        (type.layout === 'packed' &&
          type.namespace.syntax?.argument !== undefined &&
          C_INTEGER_BITS.has(bitSizeOf(type)))
      );
    }
    default: {
      return false;
    }
  }
}

/** Whether an extern struct or union may hold a field of the type, as Zig 0.17 allows. */
export function externFieldType(type: Type): boolean {
  if (type.kind === 'void') return true;
  if (type.kind === 'array') return externFieldType(type.child);
  return cAbiType(type, false);
}
