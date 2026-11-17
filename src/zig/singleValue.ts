import type { Type } from './types';
import { registerStorageLocation, type Value, ZArray, ZStruct, ZUnion } from './values';

interface Fact {
  value: Value;
}

export function singleValueOf(type: Type, spend: () => void): Fact | undefined {
  return valueOf(type, spend, new Set());
}

// code-gauge-allow functionCognitiveComplexity 28 -- Keeps guarded metadata-only singleton construction together.
// code-gauge-allow functionNcss 37 -- Dispatches the supported zero-bit value representations.
function valueOf(type: Type, spend: () => void, seen: Set<Type>): Fact | undefined {
  if (seen.has(type)) return undefined;
  spend();
  seen.add(type);
  try {
    switch (type.kind) {
      case 'void': {
        return { value: undefined };
      }
      case 'int': {
        return type.bits === 0 ? { value: 0n } : undefined;
      }
      case 'array': {
        if (type.length === 0n)
          return {
            value: new ZArray(type.sentinel === undefined ? [] : [type.sentinel], 0, 0, type.sentinel !== undefined),
          };
        const child = valueOf(type.child, spend, seen);
        return child ? { value: constantArray(type, child.value) } : undefined;
      }
      case 'struct': {
        if (type.native || type.namespace.internal || !type.fields) return undefined;
        const values: Value[] = [];
        for (const field of type.fields) {
          spend();
          const child = field.comptimeValue ?? valueOf(field.type, spend, seen);
          if (!child) return undefined;
          values.push(child.value);
        }
        return { value: new ZStruct(values) };
      }
      case 'enum': {
        return type.tagType?.bits === 0 && type.fields?.length === 1 ? { value: type.fields[0].value } : undefined;
      }
      case 'union': {
        if (type.fields?.length !== 1 || (type.tagType && !valueOf(type.tagType, spend, seen))) return undefined;
        const child = valueOf(type.fields[0].type, spend, seen);
        return child ? { value: new ZUnion(0, child.value) } : undefined;
      }
      default: {
        return undefined;
      }
    }
  } finally {
    seen.delete(type);
  }
}

function constantArray(type: Extract<Type, { kind: 'array' }>, value: Value): ZArray {
  const backing: Value[] = [];
  const slots = new Proxy<Value[]>(backing, {
    get: (target, key, receiver) =>
      typeof key === 'string' && /^\d+$/.test(key) ? value : Reflect.get(target, key, receiver),
    set: () => true,
  });
  registerStorageLocation(slots, () => ({ storage: backing, index: 0 }), true);
  return new ZArray(slots, 0, type.length, type.sentinel !== undefined);
}
