import {
  invalidateMethodCaches,
  NIL,
  RArray,
  RBasic,
  RClass,
  RHash,
  RObject,
  RProc,
  RRange,
  RString,
  RSymbol,
  type Value,
} from './objects';
import { rt } from './runtime';

export function str(s: string): RString {
  rt().checkStringLength(s.length);
  const value = new RString(rt().c.String, s);
  if (
    /[\uDC80-\uDCFF]/.test(s) &&
    [...s].some((char) => {
      const point = char.codePointAt(0) as number;
      return point >= 0xdc_80 && point <= 0xdc_ff;
    })
  )
    value.rawBytes = encodeInvalidText(s);
  return value;
}

export function stringBytes(value: RString): Uint8Array {
  if (value.rawBytes) return value.rawBytes;
  return value.binary
    ? Uint8Array.from([...value.s].map((char) => char.codePointAt(0) as number))
    : new TextEncoder().encode(value.s);
}

export function stringFromBytes(bytes: Uint8Array, binary = false): RString {
  if (binary) {
    let text = '';
    for (const byte of bytes) text += String.fromCodePoint(byte);
    const value = str(text);
    value.binary = true;
    value.rawBytes = Uint8Array.from(bytes);
    return value;
  }
  let invalid = false;
  try {
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    invalid = true;
  }
  const text = invalid ? decodeInvalidBytes(bytes) : new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
  rt().checkStringLength(text.length);
  const value = new RString(rt().c.String, text);
  if (invalid) {
    value.rawBytes = Uint8Array.from(bytes);
  }
  return value;
}

function decodeInvalidBytes(bytes: Uint8Array): string {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let text = '';
  for (let index = 0; index < bytes.length;) {
    const first = bytes[index];
    const width = first < 0x80 ? 1 : first >= 0xc2 && first < 0xe0 ? 2 : first < 0xf0 ? 3 : first < 0xf5 ? 4 : 0;
    if (width > 0 && index + width <= bytes.length) {
      try {
        text += decoder.decode(bytes.subarray(index, index + width));
        index += width;
        continue;
      } catch {
        // An invalid byte remains one byte in the String's internal text.
      }
    }
    text += String.fromCodePoint(0xdc_00 + first);
    index++;
  }
  return text;
}

function encodeInvalidText(text: string): Uint8Array {
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  let valid = '';
  const flush = (): void => {
    if (valid) for (const byte of encoder.encode(valid)) bytes.push(byte);
    valid = '';
  };
  for (const char of text) {
    const point = char.codePointAt(0) as number;
    if (point >= 0xdc_80 && point <= 0xdc_ff) {
      flush();
      bytes.push(point - 0xdc_00);
    } else {
      valid += char;
      if (valid.length >= 4096) flush();
    }
  }
  flush();
  return Uint8Array.from(bytes);
}

export function stringCharacters(value: RString): RString[] {
  if (!value.rawBytes && !value.binary) return [...value.s].map((char) => str(char));
  const bytes = stringBytes(value);
  const characters: RString[] = [];
  for (let index = 0; index < bytes.length;) {
    rt().spend();
    const first = bytes[index];
    const width = value.binary ? 1 : first < 0x80 ? 1 : first < 0xe0 ? 2 : first < 0xf0 ? 3 : 4;
    const segment = bytes.slice(index, Math.min(bytes.length, index + width));
    let valid = value.binary || first < 0x80;
    if (!valid && segment.length === width) {
      try {
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(segment);
        valid = true;
      } catch {
        valid = false;
      }
    }
    if (valid) {
      characters.push(stringFromBytes(segment, value.binary));
      index += segment.length;
    } else {
      characters.push(stringFromBytes(bytes.slice(index, index + 1)));
      index++;
    }
  }
  return characters;
}

export function joinStringCharacters(characters: RString[], binary = false): RString {
  const chunks = characters.map(stringBytes);
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  rt().checkStringLength(length);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return stringFromBytes(bytes, binary);
}

export function arr(items: Value[]): RArray {
  rt().spend(Math.floor(items.length / 64));
  return new RArray(rt().c.Array, items);
}

export function newHash(): RHash {
  return new RHash(rt().c.Hash);
}

export function sym(name: string): RSymbol {
  return RSymbol.of(name);
}

export function range(begin: Value, end: Value, exclusive: boolean): RRange {
  return new RRange(rt().c.Range, begin, end, exclusive);
}

export function truthy(value: Value): boolean {
  return value !== false && value !== NIL;
}

export function isNil(value: Value): boolean {
  return value === NIL;
}

/** The class whose methods a value responds to: its singleton class if it has one, else its class. */
export function classOf(value: Value): RClass {
  const { c } = rt();
  switch (typeof value) {
    case 'bigint': {
      return c.Integer;
    }
    case 'number': {
      return c.Float;
    }
    case 'boolean': {
      return value ? c.TrueClass : c.FalseClass;
    }
  }
  if (value === NIL) return c.NilClass;
  if (value instanceof RSymbol) return c.Symbol;
  if (value instanceof RClass) return singletonClassOf(value);
  return (value as RBasic).singleton ?? (value as RBasic).cls;
}

/** The class a value is an instance of, skipping singleton classes, as `obj.class` returns. */
export function realClassOf(value: Value): RClass {
  if (value instanceof RClass) return value.isModule ? rt().c.Module : rt().c.Class;
  let cls = classOf(value);
  while (cls.isSingleton && cls.superclass) cls = cls.superclass;
  return cls;
}

/** The singleton class of an object, created on first use; a class's chains to its superclass's. */
export function singletonClassOf(value: Value): RClass {
  const { c } = rt();
  if (!(value instanceof RBasic)) {
    throw new TypeError('A singleton class of an immediate value');
  }
  if (value.singleton) return value.singleton;
  let superclass: RClass;
  if (value instanceof RClass) {
    if (value.isModule) superclass = c.Module;
    else superclass = value.superclass ? singletonClassOf(value.superclass) : c.Class;
  } else {
    superclass = value.cls;
  }
  const singleton = new RClass(c.Class, undefined, superclass, false, true);
  singleton.attached = value;
  value.singleton = singleton;
  invalidateMethodCaches();
  return singleton;
}

export function isA(value: Value, cls: RClass): boolean {
  return classOf(value).isSubclassOf(cls);
}

export function isString(value: Value): value is RString {
  return value instanceof RString;
}

export function isArray(value: Value): value is RArray {
  return value instanceof RArray;
}

export function isHash(value: Value): value is RHash {
  return value instanceof RHash;
}

export function isProc(value: Value): value is RProc {
  return value instanceof RProc;
}

export function isException(value: Value): value is RObject {
  return value instanceof RObject && value.exception !== undefined;
}

export function isInteger(value: Value): value is bigint {
  return typeof value === 'bigint';
}

export function isFloat(value: Value): value is number {
  return typeof value === 'number';
}

export function isNumeric(value: Value): value is bigint | number {
  return typeof value === 'bigint' || typeof value === 'number';
}

/** A copy of what an iteration visits, for loops whose bodies may change the collection. */
export function snapshot<T>(items: Iterable<T>): T[] {
  return [...items];
}
