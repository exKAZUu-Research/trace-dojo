// oxlint-disable unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import type { Entity } from '../entities';
import {
  addMethod,
  currentRuntime,
  definePackage,
  fn,
  namedType,
  nativeFunction,
  opaqueType,
  typeEntity,
} from '../native';
import type { Runtime } from '../runtime';
import { nilPointerPanic } from '../runtimeErrors';
import { BASIC, type InterfaceMethod, type NamedType, pointerTo, type Type } from '../types';
import { Cell, GoArray, GoStruct, Iface, Pointer, type Value } from '../values';
import { crc32Table, crc32Update, type Digest, type DigestName, newDigest } from './hashAlgorithms';
import { libraryVariable } from './io';
import { appendBytes, BYTES, bytesOf, ERROR_TYPE, INT, receiverStruct, spendFor } from './support';

const UINT32 = BASIC.uint32;
const UINT64 = BASIC.uint64;

const HASH_METHODS: InterfaceMethod[] = [
  { name: 'BlockSize', type: fn([], [INT]) },
  { name: 'Reset', type: fn([], []) },
  { name: 'Size', type: fn([], [INT]) },
  { name: 'Sum', type: fn([BYTES], [BYTES]) },
  { name: 'Write', type: fn([BYTES], [INT, ERROR_TYPE]) },
];

function hashInterface(name: string, extra: InterfaceMethod[]): NamedType {
  const methods = [...HASH_METHODS, ...extra].toSorted((a, b) => (a.name < b.name ? -1 : 1));
  return namedType('hash', name, { kind: 'interface', methods });
}

const HASH = hashInterface('Hash', []);
const HASH32 = hashInterface('Hash32', [{ name: 'Sum32', type: fn([], [UINT32]) }]);
const HASH64 = hashInterface('Hash64', [{ name: 'Sum64', type: fn([], [UINT64]) }]);
const CLONER = hashInterface('Cloner', []);
(CLONER.underlying as { methods: InterfaceMethod[] }).methods.unshift({
  name: 'Clone',
  type: fn([], [CLONER, ERROR_TYPE]),
});

const XOF = namedType('hash', 'XOF', {
  kind: 'interface',
  methods: [
    { name: 'BlockSize', type: fn([], [INT]) },
    { name: 'Read', type: fn([BYTES], [INT, ERROR_TYPE]) },
    { name: 'Reset', type: fn([], []) },
    { name: 'Write', type: fn([BYTES], [INT, ERROR_TYPE]) },
  ],
});

export const HASH_PACKAGE = definePackage('hash', {
  Hash: typeEntity(HASH),
  Hash32: typeEntity(HASH32),
  Hash64: typeEntity(HASH64),
  Cloner: typeEntity(CLONER),
  XOF: typeEntity(XOF),
});

function toBytes(value: Value): Uint8Array {
  const text = bytesOf(value);
  spendFor(text.length);
  return Uint8Array.from(text, (char) => char.charCodeAt(0));
}

function byteArray(bytes: Uint8Array): GoArray {
  return new GoArray(Array.from(bytes, BigInt));
}

function intConstant(name: string, value: number): Entity {
  return {
    kind: 'const',
    name,
    type: BASIC.untypedInt,
    value: { kind: 'int', value: BigInt(value) },
    span: { row: 0, column: 0 },
    used: true,
  };
}

/** Adds `Size`, `BlockSize`, `Sum` and `Write` to a digest type from the functions that reach its state. */
function addHashMethods(
  type: NamedType,
  sizes: (receiver: Value) => { size: number; blockSize: number },
  write: (receiver: Value, bytes: Uint8Array) => void,
  sum: (receiver: Value) => Uint8Array
): void {
  addMethod(type, 'Size', fn([], [INT]), (receiver) => BigInt(sizes(receiver).size), true);
  addMethod(type, 'BlockSize', fn([], [INT]), (receiver) => BigInt(sizes(receiver).blockSize), true);
  addMethod(
    type,
    'Write',
    fn([BYTES], [INT, ERROR_TYPE]),
    (receiver, [bytes]) => {
      const data = toBytes(bytes);
      write(receiver, data);
      return [BigInt(data.length), undefined];
    },
    true
  );
  addMethod(
    type,
    'Sum',
    fn([BYTES], [BYTES]),
    (receiver, [prefix]) => appendBytes(prefix, String.fromCharCode(...sum(receiver))),
    true
  );
}

// Cryptographic digests ---------------------------------------------------------------------------------------------

function digestOf(receiver: Value): Digest {
  return receiverStruct(receiver).native?.digest as Digest;
}

function digestStruct(digest: Digest): GoStruct {
  const state = { digest, clone: () => ({ ...state, digest: digest.clone() }) };
  return new GoStruct([], state);
}

/** A digest type such as `*sha256.Digest`, whose state lives in `native`. */
function digestType(pkg: string, name: string): NamedType {
  const type = opaqueType(namedType(pkg, name, { kind: 'struct', fields: [] }));
  addHashMethods(
    type,
    (receiver) => digestOf(receiver),
    (receiver, bytes) => digestOf(receiver).write(bytes),
    (receiver) => digestOf(receiver).sum()
  );
  addMethod(
    type,
    'Reset',
    fn([], []),
    (receiver) => {
      digestOf(receiver).reset();
      return;
    },
    true
  );
  addMethod(
    type,
    'Clone',
    fn([], [CLONER, ERROR_TYPE]),
    (receiver) => [
      new Iface(pointerTo(type), new Pointer(new Cell(digestStruct(digestOf(receiver).clone())), 'v')),
      undefined,
    ],
    true
  );
  return type;
}

function newHash(type: NamedType, name: DigestName): Iface {
  currentRuntime().allocate(1);
  return new Iface(pointerTo(type), new Pointer(new Cell(digestStruct(newDigest(name))), 'v'));
}

function sumFunction(name: string, digestName: DigestName): Entity {
  const size = newDigest(digestName).size;
  const result: Type = { kind: 'array', element: BASIC.uint8, length: size };
  return nativeFunction(name, fn([BYTES], [result]), ([data]) => {
    const digest = newDigest(digestName);
    digest.write(toBytes(data));
    return byteArray(digest.sum());
  });
}

function newFunction(name: string, type: NamedType, digestName: DigestName): Entity {
  return nativeFunction(name, fn([], [HASH]), () => newHash(type, digestName));
}

const SHA256_DIGEST = digestType('crypto/sha256', 'Digest');
export const SHA256_PACKAGE = definePackage('crypto/sha256', {
  Size: intConstant('Size', 32),
  Size224: intConstant('Size224', 28),
  BlockSize: intConstant('BlockSize', 64),
  New: newFunction('New', SHA256_DIGEST, 'sha256'),
  New224: newFunction('New224', SHA256_DIGEST, 'sha224'),
  Sum256: sumFunction('Sum256', 'sha256'),
  Sum224: sumFunction('Sum224', 'sha224'),
});

const SHA512_DIGEST = digestType('crypto/sha512', 'Digest');
export const SHA512_PACKAGE = definePackage('crypto/sha512', {
  Size: intConstant('Size', 64),
  Size224: intConstant('Size224', 28),
  Size256: intConstant('Size256', 32),
  Size384: intConstant('Size384', 48),
  BlockSize: intConstant('BlockSize', 128),
  New: newFunction('New', SHA512_DIGEST, 'sha512'),
  New384: newFunction('New384', SHA512_DIGEST, 'sha384'),
  New512_224: newFunction('New512_224', SHA512_DIGEST, 'sha512_224'),
  New512_256: newFunction('New512_256', SHA512_DIGEST, 'sha512_256'),
  Sum512: sumFunction('Sum512', 'sha512'),
  Sum384: sumFunction('Sum384', 'sha384'),
  Sum512_224: sumFunction('Sum512_224', 'sha512_224'),
  Sum512_256: sumFunction('Sum512_256', 'sha512_256'),
});

const SHA1_DIGEST = digestType('crypto/sha1', 'digest');
export const SHA1_PACKAGE = definePackage('crypto/sha1', {
  Size: intConstant('Size', 20),
  BlockSize: intConstant('BlockSize', 64),
  New: newFunction('New', SHA1_DIGEST, 'sha1'),
  Sum: sumFunction('Sum', 'sha1'),
});

const MD5_DIGEST = digestType('crypto/md5', 'digest');
export const MD5_PACKAGE = definePackage('crypto/md5', {
  Size: intConstant('Size', 16),
  BlockSize: intConstant('BlockSize', 64),
  New: newFunction('New', MD5_DIGEST, 'md5'),
  Sum: sumFunction('Sum', 'md5'),
});

// FNV ---------------------------------------------------------------------------------------------------------------

interface FnvVariant {
  name: string;
  bits: 32 | 64 | 128;
  /** FNV-1a mixes each byte in before multiplying, FNV-1 after. */
  xorFirst: boolean;
}

const FNV_PRIMES = { 32: 16_777_619n, 64: 1_099_511_628_211n, 128: (1n << 88n) + 315n };
const FNV_OFFSETS = {
  32: 2_166_136_261n,
  64: 14_695_981_039_346_656_037n,
  128: 0x6c_62_27_2e_07_bb_01_42_62_b8_21_75_62_95_c5_8dn,
};

/** A 128-bit sum is `[2]uint64`, high word first; the others are the integer itself. */
function fnvLoad(receiver: Value, bits: number): bigint {
  if (!(receiver instanceof Pointer)) nilPointerPanic();
  const value = receiver.load();
  if (bits !== 128) return value as bigint;
  const [high, low] = (value as GoArray).elements as bigint[];
  return (high << 64n) | low;
}

function fnvStore(receiver: Value, bits: number, sum: bigint): void {
  const pointer = receiver as Pointer;
  if (bits === 128) pointer.store(new GoArray([sum >> 64n, BigInt.asUintN(64, sum)]));
  else pointer.store(sum);
}

function fnvValue(bits: number, sum: bigint): Value {
  return bits === 128 ? new GoArray([sum >> 64n, BigInt.asUintN(64, sum)]) : sum;
}

function fnvType({ name, bits, xorFirst }: FnvVariant): NamedType {
  const underlyingType: Type = bits === 128 ? { kind: 'array', element: UINT64, length: 2 } : BASIC[`uint${bits}`];
  const type = namedType('hash/fnv', name, underlyingType);
  const prime = FNV_PRIMES[bits];
  addHashMethods(
    type,
    () => ({ size: bits / 8, blockSize: 1 }),
    (receiver, bytes) => {
      let sum = fnvLoad(receiver, bits);
      for (const byte of bytes) {
        if (xorFirst) sum ^= BigInt(byte);
        sum = BigInt.asUintN(bits, sum * prime);
        if (!xorFirst) sum ^= BigInt(byte);
      }
      fnvStore(receiver, bits, sum);
    },
    (receiver) => {
      const sum = fnvLoad(receiver, bits);
      return Uint8Array.from({ length: bits / 8 }, (_, index) => Number((sum >> BigInt(bits - 8 - index * 8)) & 0xffn));
    }
  );
  addMethod(
    type,
    'Reset',
    fn([], []),
    (receiver) => {
      fnvLoad(receiver, bits);
      fnvStore(receiver, bits, FNV_OFFSETS[bits]);
      return;
    },
    true
  );
  if (bits !== 128) {
    addMethod(type, `Sum${bits}`, fn([], [BASIC[`uint${bits}`]]), (receiver) => fnvLoad(receiver, bits), true);
  }
  addMethod(
    type,
    'Clone',
    fn([], [CLONER, ERROR_TYPE]),
    (receiver) => [
      new Iface(pointerTo(type), new Pointer(new Cell(fnvValue(bits, fnvLoad(receiver, bits))), 'v')),
      undefined,
    ],
    true
  );
  return type;
}

function fnvConstructor(variant: FnvVariant): Entity {
  const type = fnvType(variant);
  const result = variant.bits === 32 ? HASH32 : variant.bits === 64 ? HASH64 : HASH;
  const constructorName = `New${variant.bits}${variant.xorFirst ? 'a' : ''}`;
  return nativeFunction(constructorName, fn([], [result]), () => {
    currentRuntime().allocate(1);
    return new Iface(pointerTo(type), new Pointer(new Cell(fnvValue(variant.bits, FNV_OFFSETS[variant.bits])), 'v'));
  });
}

const FNV_VARIANTS: FnvVariant[] = [32, 64, 128].flatMap((bits) =>
  [false, true].map((xorFirst) => ({ name: `sum${bits}${xorFirst ? 'a' : ''}`, bits: bits as 32 | 64 | 128, xorFirst }))
);

export const FNV_PACKAGE = definePackage(
  'hash/fnv',
  Object.fromEntries(
    FNV_VARIANTS.map((variant) => [`New${variant.bits}${variant.xorFirst ? 'a' : ''}`, fnvConstructor(variant)])
  )
);

// CRC-32 ------------------------------------------------------------------------------------------------------------

const IEEE = 0xed_b8_83_20;
const CASTAGNOLI = 0x82_f6_3b_78;
const KOOPMAN = 0xeb_31_d8_2e;
const CRC_TABLE = namedType('hash/crc32', 'Table', { kind: 'array', element: UINT32, length: 256 });
const CRC_TABLE_POINTER = pointerTo(CRC_TABLE);
const CRC_DIGEST = namedType('hash/crc32', 'digest', {
  kind: 'struct',
  fields: [
    { name: 'crc', type: UINT32, embedded: false },
    { name: 'tab', type: CRC_TABLE_POINTER, embedded: false },
  ],
});

const IEEE_TABLE = crc32Table(IEEE);
const CASTAGNOLI_TABLE = crc32Table(CASTAGNOLI);

/** The tables a run shares as Go's package variables `IEEETable` and the cached Castagnoli table. */
interface CrcTables {
  ieee: Pointer;
  castagnoli?: Pointer;
}

const crcTables = new WeakMap<Runtime, CrcTables>();

function tablePointer(table: readonly number[]): Pointer {
  currentRuntime().allocate(256);
  return new Pointer(new Cell(new GoArray(table.map(BigInt))), 'v');
}

function tablesOfRun(): CrcTables {
  const runtime = currentRuntime();
  let tables = crcTables.get(runtime);
  if (!tables) {
    tables = { ieee: tablePointer(IEEE_TABLE) };
    crcTables.set(runtime, tables);
  }
  return tables;
}

function makeTable(poly: number): Pointer {
  const tables = tablesOfRun();
  if (poly === IEEE) return tables.ieee;
  if (poly === CASTAGNOLI) return (tables.castagnoli ??= tablePointer(CASTAGNOLI_TABLE));
  return tablePointer(crc32Table(poly));
}

/** `crc32.update`: the IEEE and Castagnoli tables use Go's own precomputed tables, others their entries. */
function crcUpdate(crc: number, table: Value, bytes: Uint8Array): number {
  if (!(table instanceof Pointer)) nilPointerPanic();
  const tables = tablesOfRun();
  if (table.equals(tables.ieee)) return crc32Update(crc, IEEE_TABLE, bytes);
  if (tables.castagnoli && table.equals(tables.castagnoli)) return crc32Update(crc, CASTAGNOLI_TABLE, bytes);
  const entries = ((table.load() as GoArray).elements as bigint[]).map(Number);
  return crc32Update(crc, entries, bytes);
}

addHashMethods(
  CRC_DIGEST,
  () => ({ size: 4, blockSize: 1 }),
  (receiver, bytes) => {
    const fields = receiverStruct(receiver).fields;
    fields[0] = BigInt(crcUpdate(Number(fields[0] as bigint), fields[1], bytes));
  },
  (receiver) => {
    const crc = Number(receiverStruct(receiver).fields[0] as bigint);
    return Uint8Array.of(crc >>> 24, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff);
  }
);
addMethod(
  CRC_DIGEST,
  'Reset',
  fn([], []),
  (receiver) => {
    receiverStruct(receiver).fields[0] = 0n;
    return;
  },
  true
);
addMethod(CRC_DIGEST, 'Sum32', fn([], [UINT32]), (receiver) => receiverStruct(receiver).fields[0], true);
addMethod(
  CRC_DIGEST,
  'Clone',
  fn([], [CLONER, ERROR_TYPE]),
  (receiver) => {
    const [crc, table] = receiverStruct(receiver).fields;
    return [new Iface(pointerTo(CRC_DIGEST), new Pointer(new Cell(new GoStruct([crc, table])), 'v')), undefined];
  },
  true
);

function newCrcDigest(table: Value): Iface {
  currentRuntime().allocate(1);
  return new Iface(pointerTo(CRC_DIGEST), new Pointer(new Cell(new GoStruct([0n, table])), 'v'));
}

export const CRC32_PACKAGE = definePackage('hash/crc32', {
  Table: typeEntity(CRC_TABLE),
  Size: intConstant('Size', 4),
  IEEE: intConstant('IEEE', IEEE),
  Castagnoli: intConstant('Castagnoli', CASTAGNOLI),
  Koopman: intConstant('Koopman', KOOPMAN),
  IEEETable: libraryVariable('IEEETable', CRC_TABLE_POINTER, () => tablesOfRun().ieee),
  MakeTable: nativeFunction('MakeTable', fn([UINT32], [CRC_TABLE_POINTER]), ([poly]) => makeTable(Number(poly))),
  New: nativeFunction('New', fn([CRC_TABLE_POINTER], [HASH32]), ([table]) => newCrcDigest(table)),
  NewIEEE: nativeFunction('NewIEEE', fn([], [HASH32]), () => newCrcDigest(tablesOfRun().ieee)),
  Update: nativeFunction('Update', fn([UINT32, CRC_TABLE_POINTER, BYTES], [UINT32]), ([crc, table, data]) =>
    BigInt(crcUpdate(Number(crc), table, toBytes(data)))
  ),
  Checksum: nativeFunction('Checksum', fn([BYTES, CRC_TABLE_POINTER], [UINT32]), ([data, table]) =>
    BigInt(crcUpdate(0, table, toBytes(data)))
  ),
  ChecksumIEEE: nativeFunction('ChecksumIEEE', fn([BYTES], [UINT32]), ([data]) =>
    BigInt(crc32Update(0, IEEE_TABLE, toBytes(data)))
  ),
});
