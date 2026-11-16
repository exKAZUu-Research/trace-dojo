import { panic } from './arith';
import type { Type } from './types';
import { aliasStorage, type Slots, type Value, ZArray, ZStruct, ZUnion } from './values';

let evaluationDepth = 0;

export function duringComptime<T>(evaluate: () => T): T {
  evaluationDepth++;
  try {
    return evaluate();
  } finally {
    evaluationDepth--;
  }
}

export function rejectRuntimeEffect(): void {
  if (evaluationDepth > 0) panic('unable to resolve comptime value');
}

export function markRuntimeStorage(storage: Slots, type: Type): void {
  protectSlots(storage, [type]);
}

function protectValue(value: Value, type: Type): void {
  if (value instanceof ZArray && type.kind === 'array') {
    protectSlots(
      value,
      Array.from({ length: value.slots.length }, () => type.child)
    );
  } else if (value instanceof ZStruct && type.kind === 'struct') {
    protectSlots(value, type.fields?.map((field) => field.type) ?? []);
  } else if (value instanceof ZUnion && type.kind === 'union') {
    protectSlots(value, [type.fields?.[value.tag]?.type]);
    let tag = value.tag;
    Object.defineProperty(value, 'tag', {
      get: () => {
        rejectRuntimeEffect();
        return tag;
      },
      set: (next: number) => {
        rejectRuntimeEffect();
        tag = next;
      },
    });
  }
}

function protectSlots(storage: Slots, types: readonly (Type | undefined)[]): void {
  const original = storage.slots;
  for (const [index, type] of types.entries()) if (type) protectValue(original[index], type);
  const proxy = new Proxy(original, {
    get: (target, key, receiver) => {
      if (typeof key === 'string' && /^\d+$/.test(key)) {
        const type = types[Number(key)];
        if (type?.kind !== 'array' && type?.kind !== 'struct' && type?.kind !== 'union' && type?.kind !== 'void')
          rejectRuntimeEffect();
      }
      return Reflect.get(target, key, receiver);
    },
    set: (target, key, value, receiver) => {
      rejectRuntimeEffect();
      return Reflect.set(target, key, value, receiver);
    },
  });
  aliasStorage(proxy, original);
  storage.slots = proxy;
}
