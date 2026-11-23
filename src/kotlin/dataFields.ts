import { stringOf } from './format';
import { arrayContentString, dataArrayKind } from './natives/arrays';
import type { Frame } from './runtime';
import { type KType, resolved } from './types';
import type { PrimitiveKind, Value } from './values';

/** How a data class renders an array property, which the JVM's generated members treat by the array's storage. */
export interface DataArrayField {
  storage?: PrimitiveKind | 'Boolean';
  wrapper?: string;
}

export function dataArrayField(type: KType | undefined): DataArrayField | undefined {
  const actual = type && resolved(type);
  if (actual?.kind !== 'class' || !actual.cls.isLibrary) return undefined;
  const name = actual.cls.name;
  if (name === 'Array') return {};
  const kind = dataArrayKind(name);
  switch (kind) {
    case 'UByte': {
      return { storage: 'Byte', wrapper: name };
    }
    case 'UShort': {
      return { storage: 'Short', wrapper: name };
    }
    case 'UInt': {
      return { storage: 'Int', wrapper: name };
    }
    case 'ULong': {
      return { storage: 'Long', wrapper: name };
    }
    case undefined: {
      return undefined;
    }
    default: {
      return { storage: kind };
    }
  }
}

export function dataFieldString(frame: Frame, value: Value, array: DataArrayField | undefined): string {
  return array && !array.wrapper ? arrayContentString(frame, value, array.storage) : stringOf(frame, value);
}
