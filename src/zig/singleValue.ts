import type { Type } from './types';
import { type Value, ZArray, zeroArray, ZStruct, ZUnion } from './values';

interface Fact {
  value: Value;
}

const singleValues = new WeakMap<Type, Fact>();

export function singleValueOf(type: Type, spend: () => void): Fact | undefined {
  const cached = singleValues.get(type);
  if (cached) return cached;
  const fact = valueOf(type, spend, new Set());
  if (fact) singleValues.set(type, fact);
  return fact;
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
        if (type.length === 0n && type.sentinel === undefined) return { value: new ZArray([]) };
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
  return zeroArray(type.length, type.sentinel !== undefined, value);
}
