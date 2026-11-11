import { PyBytes } from './bytesValues';
import { classOf, Ellipsis, None, NotImplemented, objectClass, tupleClass, typeName } from './types';
import { UnsupportedFeatureError } from './unsupported';
import { PyComplex, PyObject, PyRange, PyTuple, type PyValue } from './values';

/** The bytes of the header the garbage collector adds before the objects it tracks, which `__sizeof__` leaves out. */
const GC_HEADER = 16;

/** `sys.getsizeof` of the objects whose size in CPython does not depend on how they grew. */
export function sizeOf(value: PyValue): number {
  const size = fixedSize(value);
  if (size === undefined)
    throw new UnsupportedFeatureError(`sys.getsizeof() での ${typeName(value)} オブジェクトの大きさ`);
  return size;
}

/** `__sizeof__()`: the size `sys.getsizeof` reports without the garbage collector's header. */
export function sizeWithoutHeader(value: PyValue): bigint {
  const size = sizeOf(value);
  return BigInt(value instanceof PyTuple ? size - GC_HEADER : size);
}

// code-gauge-allow functionCognitiveComplexity 16 -- One case per kind of object of a fixed layout.
function fixedSize(value: PyValue): number | undefined {
  if (typeof value === 'bigint' || typeof value === 'boolean') return intSize(BigInt(value));
  if (typeof value === 'number') return 24;
  if (typeof value === 'string') return isAscii(value) ? 41 + value.length : undefined;
  if (value === None || value === Ellipsis || value === NotImplemented) return 16;
  if (value instanceof PyComplex) return 32;
  if (value instanceof PyBytes && !value.isMutable && value.cls.isBuiltin) return 33 + value.length;
  if (value instanceof PyTuple && value.cls === tupleClass) return 48 + 8 * value.items.length;
  if (value instanceof PyRange) return 48;
  return value instanceof PyObject && classOf(value) === objectClass ? 16 : undefined;
}

/** The size of an int, whose 30-bit digits take 4 bytes each, with at least one digit. */
function intSize(value: bigint): number {
  const magnitude = value < 0n ? -value : value;
  return 24 + 4 * Math.max(1, Math.ceil(magnitude.toString(2).length / 30));
}

/** Whether a string is ASCII, whose size depends only on its length, unlike others, which may cache their UTF-8. */
function isAscii(text: string): boolean {
  for (let index = 0; index < text.length; index++) if ((text.codePointAt(index) ?? 0) > 0x7f) return false;
  return true;
}
