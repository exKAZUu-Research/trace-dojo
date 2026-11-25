import { panic } from './arith';
import { reserveMemory, spendMemory } from './memoryAccounting';
import { propertyIndex } from './sparseBytes';
import type { Type } from './types';
import { aliasStorage, type Slots, type Value, ZArray, zeroArrayElement, ZStruct, ZUnion } from './values';

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
  spendMemory();
  protectValue(storage.slots[0], type);
  protectSlots(storage, (index) => (index === 0 ? type : undefined));
}

function protectValue(value: Value, type: Type): void {
  if (value instanceof ZArray && type.kind === 'array') {
    protectArray(value, type.child);
  } else if (value instanceof ZStruct && type.kind === 'struct') {
    const fields = type.fields ?? [];
    spendMemory(fields.length);
    for (const [index, field] of fields.entries()) {
      if (isAggregate(field.type)) protectValue(value.slots[index], field.type);
    }
    protectSlots(value, (index) => fields[index]?.type);
  } else if (value instanceof ZUnion && type.kind === 'union') {
    protectUnion(value, type);
  }
}

function protectArray(array: ZArray, child: Type): void {
  const length = array.slots.length;
  if (isAggregate(child) && length > 0) {
    const singleton = zeroArrayElement(array);
    if (singleton) protectValue(singleton.value, child);
    else {
      spendMemory(length);
      for (let index = 0; index < length; index++) protectValue(array.slots[index], child);
    }
  }
  protectSlots(array, (index) => (index < length ? child : undefined));
}

function protectUnion(union: ZUnion, type: Extract<Type, { kind: 'union' }>): void {
  const payload = type.fields?.[union.tag]?.type;
  if (payload && isAggregate(payload)) protectValue(union.slots[0], payload);
  protectSlots(union, (index) => (index === 0 ? payload : undefined));
  let tag = union.tag;
  Object.defineProperty(union, 'tag', {
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

function protectSlots(storage: Slots, typeAt: (index: number) => Type | undefined): void {
  reserveMemory(1);
  spendMemory();
  const original = storage.slots;
  const proxy = new Proxy(original, {
    get: (target, key, receiver) => {
      const index = propertyIndex(key);
      const type = index === undefined ? undefined : typeAt(index);
      if (index !== undefined && (!type || (type.kind !== 'void' && !isAggregate(type)))) rejectRuntimeEffect();
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

function isAggregate(type: Type): boolean {
  return type.kind === 'array' || type.kind === 'struct' || type.kind === 'union';
}
