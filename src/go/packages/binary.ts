import type { Entity } from '../entities';
import { addMethod, definePackage, fn, namedType } from '../native';
import { GoPanic } from '../runtime';
import { BASIC, type Type } from '../types';
import { GoStruct, Iface, type Slice, type Value } from '../values';
import { BYTES, STRING } from './support';

const libraryVariable = (name: string, type: Type, value: Value): Entity => ({
  kind: 'var',
  name,
  type,
  span: { row: 0, column: 0 },
  used: true,
  boxed: false,
  owner: undefined,
  slot: -1,
  library: () => value,
});

// encoding/binary -----------------------------------------------------------------------------------------------------

const UINT16 = BASIC.uint16;
const UINT32 = BASIC.uint32;
const UINT64 = BASIC.uint64;

function readBytes(slice: Value, count: number): bigint[] {
  const values = (slice as Slice | undefined)?.values() ?? [];
  if (values.length < count) {
    throw new GoPanic(
      new Iface(STRING, `runtime error: index out of range [${count - 1}] with length ${values.length}`)
    );
  }
  return values.slice(0, count) as bigint[];
}

function writeBytes(slice: Value, bytes: bigint[]): void {
  const target = slice as Slice | undefined;
  if ((target?.length ?? 0) < bytes.length) {
    throw new GoPanic(
      new Iface(STRING, `runtime error: index out of range [${bytes.length - 1}] with length ${target?.length ?? 0}`)
    );
  }
  for (const [index, byte] of bytes.entries()) (target as Slice).set(index, byte);
}

function byteOrder(name: string, littleEndian: boolean): Value {
  const type = namedType('binary', name, { kind: 'struct', fields: [] });
  for (const [bits, type2] of [
    [16, UINT16],
    [32, UINT32],
    [64, UINT64],
  ] as const) {
    const count = bits / 8;
    addMethod(type, `Uint${bits}`, fn([BYTES], [type2]), (_receiver, [b]) => {
      const bytes = readBytes(b, count);
      const ordered = littleEndian ? bytes.toReversed() : bytes;
      return ordered.reduce((total, byte) => (total << 8n) | byte, 0n);
    });
    addMethod(type, `PutUint${bits}`, fn([BYTES, type2], []), (_receiver, [b, value]) => {
      const bytes = Array.from(
        { length: count },
        (_, index) => ((value as bigint) >> BigInt(8 * (count - 1 - index))) & 255n
      );
      writeBytes(b, littleEndian ? bytes.toReversed() : bytes);
      return;
    });
  }
  addMethod(type, 'String', fn([], [STRING]), () => name);
  return new Iface(type, new GoStruct([]));
}

const BYTE_ORDER = namedType('binary', 'ByteOrder', {
  kind: 'interface',
  methods: [
    { name: 'PutUint16', type: fn([BYTES, UINT16], []) },
    { name: 'PutUint32', type: fn([BYTES, UINT32], []) },
    { name: 'PutUint64', type: fn([BYTES, UINT64], []) },
    { name: 'String', type: fn([], [STRING]) },
    { name: 'Uint16', type: fn([BYTES], [UINT16]) },
    { name: 'Uint32', type: fn([BYTES], [UINT32]) },
    { name: 'Uint64', type: fn([BYTES], [UINT64]) },
  ],
});
const bigEndian = byteOrder('BigEndian', false);
const littleEndian = byteOrder('LittleEndian', true);

export const BINARY_PACKAGE = definePackage(
  'encoding/binary',
  {
    BigEndian: libraryVariable('BigEndian', (bigEndian as Iface).type, (bigEndian as Iface).value),
    LittleEndian: libraryVariable('LittleEndian', (littleEndian as Iface).type, (littleEndian as Iface).value),
    ByteOrder: { kind: 'type', name: 'ByteOrder', type: BYTE_ORDER },
  },
  [
    'Read',
    'Write',
    'Size',
    'PutVarint',
    'PutUvarint',
    'Varint',
    'Uvarint',
    'AppendByteOrder',
    'NativeEndian',
    'MaxVarintLen64',
    'Append',
    'Encode',
    'Decode',
  ]
);
