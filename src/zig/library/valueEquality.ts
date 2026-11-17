import type { Span } from '../ast';
import { packedValuesEqual } from '../bufferMemory';
import type { SemaApi } from '../semaBase';
import type { Type } from '../types';
import {
  ErrorValue,
  NULL,
  optionalPayload,
  scalarValuesEqual,
  Slice,
  Some,
  storageLocation,
  type Value,
  ZArray,
  zeroArrayElement,
  ZStruct,
  ZUnion,
} from '../values';

const validatedTypes = new WeakSet<Type>();

// code-gauge-allow functionNcss 31 -- Keeps the recursive type-domain checks together before comparison.
export function validateEquality(sema: SemaApi, type: Type, span: Span, seen = new Set<Type>()): void {
  if (validatedTypes.has(type) || seen.has(type)) return;
  sema.spendCompilation();
  seen.add(type);
  switch (type.kind) {
    case 'union': {
      if (type.layout === 'packed') break;
      if (!type.tagType) sema.error(span, 'タグのない共用体は、std.meta.eql で比べられません。');
      for (const field of sema.unionFields(type)) validateEquality(sema, field.type, span, seen);
      break;
    }
    case 'struct': {
      if (type.layout === 'packed') break;
      for (const field of sema.structFields(type, span)) validateEquality(sema, field.type, span, seen);
      break;
    }
    case 'array': {
      if (type.length !== 0n) validateEquality(sema, type.child, span, seen);
      break;
    }
    case 'optional': {
      validateEquality(sema, type.child, span, seen);
      break;
    }
    case 'error_union': {
      validateEquality(sema, type.payload, span, seen);
      break;
    }
  }
  validatedTypes.add(type);
}

// code-gauge-allow functionCognitiveComplexity 27 -- Dispatches each value representation through the same typed comparison budget.
export function valuesEqual(type: Type | undefined, a: Value, b: Value, spend: () => void): boolean {
  spend();
  if ((type?.kind === 'struct' || type?.kind === 'union') && type.layout === 'packed')
    return packedValuesEqual(type, a, b);
  if (type?.kind === 'optional') {
    if (a === NULL || b === NULL) return a === b;
    return valuesEqual(type.child, optionalPayload(a), optionalPayload(b), spend);
  }
  if (type?.kind === 'error_union') {
    if (a instanceof ErrorValue || b instanceof ErrorValue) return a === b;
    return valuesEqual(type.payload, a, b, spend);
  }
  if (a instanceof ZArray && b instanceof ZArray)
    return arraysEqual(type?.kind === 'array' ? type.child : undefined, a, b, spend);
  if (a instanceof ZStruct && b instanceof ZStruct) return structsEqual(type, a, b, spend);
  if (a instanceof ZUnion && b instanceof ZUnion)
    return (
      a.tag === b.tag &&
      valuesEqual(type?.kind === 'union' ? type.fields?.[a.tag]?.type : undefined, a.slots[0], b.slots[0], spend)
    );
  if (a instanceof Some && b instanceof Some) return valuesEqual(undefined, a.value, b.value, spend);
  if (a instanceof Slice && b instanceof Slice) {
    const left = storageLocation(a.target.slots, a.start);
    const right = storageLocation(b.target.slots, b.start);
    return left.storage === right.storage && left.index === right.index && a.lengthValue === b.lengthValue;
  }
  return scalarValuesEqual(a, b);
}

function arraysEqual(child: Type | undefined, a: ZArray, b: ZArray, spend: () => void): boolean {
  if (a.lengthValue !== b.lengthValue) return false;
  if (a.lengthValue === 0n) return true;
  const left = zeroArrayElement(a);
  const right = zeroArrayElement(b);
  if (left || right) return valuesEqual(child, left ? left.value : a.get(0), right ? right.value : b.get(0), spend);
  for (let index = 0; BigInt(index) < a.lengthValue; index++)
    if (!valuesEqual(child, a.get(index), b.get(index), spend)) return false;
  return true;
}

function structsEqual(type: Type | undefined, a: ZStruct, b: ZStruct, spend: () => void): boolean {
  if (a.slots.length !== b.slots.length) return false;
  const fields = type?.kind === 'struct' ? type.fields : undefined;
  for (let index = 0; index < a.slots.length; index++) {
    const field = fields?.[index];
    const constant = field?.comptimeValue;
    if (
      !valuesEqual(
        field?.type,
        constant ? constant.value : a.slots[index],
        constant ? constant.value : b.slots[index],
        spend
      )
    )
      return false;
  }
  return true;
}
