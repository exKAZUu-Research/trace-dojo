import type { Span } from './ast';
import { sizeOf } from './layout';
import type { SemaApi } from './semaBase';
import type { Type } from './types';
import { registerStorageLocation, type Value, ZArray, ZStruct, ZUnion } from './values';

interface Fact {
  value: Value;
}

export function singleValueOf(sema: SemaApi, type: Type, span: Span): Fact | undefined {
  sema.resolveStorage(type, span);
  if (sizeOf(type) !== 0) return undefined;
  return zeroValueOf(sema, type, span);
}

// code-gauge-allow functionCognitiveComplexity 28 -- Dispatches the canonical construction for each zero-bit runtime type.
// code-gauge-allow functionNcss 38 -- Keeps the zero-bit type cases together.
function zeroValueOf(sema: SemaApi, type: Type, span: Span): Fact | undefined {
  sema.spendCompilation();
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
      const child = singleValueOf(sema, type.child, span);
      if (!child) return undefined;
      const backing: Value[] = [];
      const slots = new Proxy<Value[]>(backing, {
        get: (target, key, receiver) =>
          typeof key === 'string' && /^\d+$/.test(key) ? child.value : Reflect.get(target, key, receiver),
        set: () => true,
      });
      registerStorageLocation(slots, () => ({ storage: backing, index: 0 }), true);
      return { value: new ZArray(slots, 0, type.length, type.sentinel !== undefined) };
    }
    case 'struct': {
      if (type.native || type.namespace.internal) return undefined;
      const values: Value[] = [];
      for (const field of sema.structFields(type, span)) {
        const child = field.comptimeValue ?? singleValueOf(sema, field.type, span);
        if (!child) return undefined;
        values.push(child.value);
      }
      return { value: new ZStruct(values) };
    }
    case 'enum': {
      const fields = sema.enumFields(type);
      return fields.length === 1 ? { value: fields[0].value } : undefined;
    }
    case 'union': {
      const fields = sema.unionFields(type);
      if (fields.length !== 1) return undefined;
      const child = singleValueOf(sema, fields[0].type, span);
      return child ? { value: new ZUnion(0, child.value) } : undefined;
    }
    default: {
      return undefined;
    }
  }
}
