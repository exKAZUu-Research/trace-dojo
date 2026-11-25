import type { Type } from './types';

const C_INTEGER_BITS = new Set([8, 16, 32, 64, 128]);

/** Whether the C calling convention passes a parameter or returns a value of the type, as Zig 0.17 allows. */
export function cAbiType(type: Type, isReturn: boolean): boolean {
  switch (type.kind) {
    case 'int': {
      return cInteger(type.bits, type.signed);
    }
    case 'float': {
      return type.bits !== 80;
    }
    case 'bool': {
      return true;
    }
    case 'void': {
      return isReturn;
    }
    case 'array': {
      return type.isVector === true;
    }
    case 'pointer': {
      return cPointer(type);
    }
    case 'optional': {
      return type.child.kind === 'pointer' && cPointer(type.child);
    }
    case 'enum': {
      const tag = type.tagType;
      return type.namespace.syntax?.argument !== undefined && tag !== undefined && cInteger(tag.bits, tag.signed);
    }
    case 'struct':
    case 'union': {
      // A packed type has a C ABI only through the backing integer that `packed struct(u8)` names, of a C width.
      const backing = type.backingInteger;
      return (
        type.layout === 'extern' ||
        (type.layout === 'packed' && backing !== undefined && cInteger(backing.bits, backing.signed))
      );
    }
    default: {
      return false;
    }
  }
}

/** Whether C has an integer of the width, which an int, an enum's tag, or a packed type's backing integer needs. */
function cInteger(bits: number, signed: boolean): boolean {
  return C_INTEGER_BITS.has(bits) || (bits === 0 && !signed);
}

/** Whether an extern struct or union may hold a field of the type, as Zig 0.17 allows. */
export function externFieldType(type: Type): boolean {
  if (type.kind === 'void') return true;
  if (type.kind === 'array') return !type.isVector && externFieldType(type.child);
  return cAbiType(type, false);
}

/** A pointer that C can hold: not a slice, and to a function only of the C calling convention. */
function cPointer(type: Extract<Type, { kind: 'pointer' }>): boolean {
  return type.size !== 'slice' && (type.child.kind !== 'fn' || type.child.callingConvention === 'c');
}
