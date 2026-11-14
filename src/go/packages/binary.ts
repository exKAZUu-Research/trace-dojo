import type { Entity } from '../entities';
import { addMethod, currentRuntime, definePackage, fn, namedType } from '../native';
import { indexPanic } from '../runtimeErrors';
import { appendValues } from '../sliceOps';
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
  const source = slice as Slice | undefined;
  const length = source?.length ?? 0;
  if (length < count) indexPanic(count - 1, length);
  return Array.from({ length: count }, (_, index) => (source as Slice).get(index) as bigint);
}

function writeBytes(slice: Value, bytes: bigint[]): void {
  const target = slice as Slice | undefined;
  if ((target?.length ?? 0) < bytes.length) {
    indexPanic(bytes.length - 1, target?.length ?? 0);
  }
  for (const [index, byte] of bytes.entries()) (target as Slice).set(index, byte);
}

function byteOrder(name: string, littleEndian: boolean): Value {
  const type = namedType('binary', name[0].toLowerCase() + name.slice(1), { kind: 'struct', fields: [] });
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
    const encoded = (value: Value): bigint[] => {
      const bytes = Array.from(
        { length: count },
        (_, index) => ((value as bigint) >> BigInt(8 * (count - 1 - index))) & 255n
      );
      return littleEndian ? bytes.toReversed() : bytes;
    };
    addMethod(type, `PutUint${bits}`, fn([BYTES, type2], []), (_receiver, [b, value]) => {
      writeBytes(b, encoded(value));
    });
    addMethod(type, `AppendUint${bits}`, fn([BYTES, type2], [BYTES]), (_receiver, [b, value]) =>
      appendValues(
        b as Slice | undefined,
        encoded(value),
        BASIC.uint8,
        () => 0n,
        (slots) => currentRuntime().allocate(slots)
      )
    );
  }
  addMethod(type, 'GoString', fn([], [STRING]), () => `binary.${name}`);
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
const APPEND_BYTE_ORDER = namedType('binary', 'AppendByteOrder', {
  kind: 'interface',
  methods: [
    { name: 'AppendUint16', type: fn([BYTES, UINT16], [BYTES]) },
    { name: 'AppendUint32', type: fn([BYTES, UINT32], [BYTES]) },
    { name: 'AppendUint64', type: fn([BYTES, UINT64], [BYTES]) },
    { name: 'String', type: fn([], [STRING]) },
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
    AppendByteOrder: { kind: 'type', name: 'AppendByteOrder', type: APPEND_BYTE_ORDER },
  },
  [
    'Read',
    'Write',
    'Size',
    'PutVarint',
    'PutUvarint',
    'Varint',
    'Uvarint',
    'NativeEndian',
    'MaxVarintLen64',
    'Append',
    'Encode',
    'Decode',
  ]
);
