import { bytesLikeData, newBytes } from '../bytesValues';
import { addressOf } from '../conversions';
import { builtin, method } from '../define';
import {
  blake2b,
  type Blake2Parameters,
  blake2s,
  keccak,
  md5,
  ripemd160,
  sha1,
  sha256,
  sha512,
  sm3,
} from '../hashAlgorithms';
import { registerModule } from '../modules';
import { argument, checkArgs } from '../nativeArgs';
import { toIndex } from '../numbers';
import { isTruthy } from '../objects';
import { currentRuntime } from '../runtimeContext';
import {
  builtinClass,
  nativeFunction,
  newSet,
  None,
  propertyClass,
  pyError,
  typeError,
  typeName,
  unbox,
  valueError,
} from '../types';
import { type Kwargs, type PyClass, PyDescriptor, PyOpaque, type PyValue } from '../values';

interface Algorithm {
  digestSize: number;
  blockSize: number;
  digest: (data: Uint8Array, length: number) => Uint8Array;
}

const ALGORITHMS: Record<string, Algorithm> = {
  md5: { digestSize: 16, blockSize: 64, digest: md5 },
  sha1: { digestSize: 20, blockSize: 64, digest: sha1 },
  sha224: { digestSize: 28, blockSize: 64, digest: (data) => sha256(data, true) },
  sha256: { digestSize: 32, blockSize: 64, digest: (data) => sha256(data) },
  sha384: { digestSize: 48, blockSize: 128, digest: (data) => sha512(data, 384) },
  sha512: { digestSize: 64, blockSize: 128, digest: (data) => sha512(data) },
  sha512_224: { digestSize: 28, blockSize: 128, digest: (data) => sha512(data, 224) },
  sha512_256: { digestSize: 32, blockSize: 128, digest: (data) => sha512(data, 256) },
  sha3_224: { digestSize: 28, blockSize: 144, digest: (data) => keccak(data, 144, 0x06, 28) },
  sha3_256: { digestSize: 32, blockSize: 136, digest: (data) => keccak(data, 136, 0x06, 32) },
  sha3_384: { digestSize: 48, blockSize: 104, digest: (data) => keccak(data, 104, 0x06, 48) },
  sha3_512: { digestSize: 64, blockSize: 72, digest: (data) => keccak(data, 72, 0x06, 64) },
  shake_128: { digestSize: 0, blockSize: 168, digest: (data, length) => keccak(data, 168, 0x1f, length) },
  shake_256: { digestSize: 0, blockSize: 136, digest: (data, length) => keccak(data, 136, 0x1f, length) },
  ripemd160: { digestSize: 20, blockSize: 64, digest: ripemd160 },
  sm3: { digestSize: 32, blockSize: 64, digest: sm3 },
  'md5-sha1': {
    digestSize: 36,
    blockSize: 64,
    digest: (data) => Uint8Array.from([...md5(data), ...sha1(data)]),
  },
};
const GUARANTEED = [
  'blake2b',
  'blake2s',
  'md5',
  'sha1',
  'sha224',
  'sha256',
  'sha384',
  'sha3_224',
  'sha3_256',
  'sha3_384',
  'sha3_512',
  'sha512',
  'shake_128',
  'shake_256',
];

/** The state of a hash object: its algorithm, the message so far, and BLAKE2's parameters. */
interface HashState {
  name: string;
  data: Uint8Array;
  blake2?: Blake2Parameters;
}

const hashClass = builtinClass('HASH');
hashClass.module = '_hashlib';
const hashXofClass = builtinClass('HASHXOF', hashClass);
hashXofClass.module = '_hashlib';

const stateOf = (self: PyValue): HashState => (self as PyOpaque).data as HashState;

/** The bytes a hash object takes in, which must not be a str. */
function messageData(value: PyValue): Uint8Array {
  if (typeof unbox(value) === 'string') throw typeError('Strings must be encoded before hashing');
  const data = bytesLikeData(value);
  if (data === undefined) throw typeError('object supporting the buffer API required');
  return data;
}

function newHash(cls: PyClass, state: HashState, initial: PyValue | undefined): PyOpaque {
  const hash = new PyOpaque(cls, state.name, state);
  if (initial !== undefined && initial !== None) append(state, messageData(initial));
  return hash;
}

function append(state: HashState, data: Uint8Array): void {
  currentRuntime().buildString(state.data.length + data.length);
  const joined = new Uint8Array(state.data.length + data.length);
  joined.set(state.data);
  joined.set(data, state.data.length);
  state.data = joined;
}

function digestOf(state: HashState, length?: number): Uint8Array {
  currentRuntime().scan(state.data.length * 4);
  if (state.blake2) return (state.name === 'blake2b' ? blake2b : blake2s)(state.data, state.blake2);
  return ALGORITHMS[state.name].digest(state.data, length ?? 0);
}

const hex = (data: Uint8Array): string => [...data].map((byte) => byte.toString(16).padStart(2, '0')).join('');

// Hash objects ------------------------------------------------------------------------------------------------------

function defineHashMethods(cls: PyClass, info: (state: HashState) => { digestSize: number; blockSize: number }): void {
  method(cls, 'update', 'one', 1, 1, (self, [data]) => {
    append(stateOf(self), messageData(data));
    return None;
  });
  method(cls, 'copy', 'none', 0, 0, (self) => {
    const state = stateOf(self);
    return new PyOpaque((self as PyOpaque).cls, state.name, { ...state });
  });
  for (const [name, read] of [
    ['name', (state: HashState): PyValue => state.name],
    ['digest_size', (state: HashState): PyValue => BigInt(info(state).digestSize)],
    ['block_size', (state: HashState): PyValue => BigInt(info(state).blockSize)],
  ] as const) {
    cls.dict.set(
      name,
      new PyDescriptor(
        propertyClass,
        nativeFunction(name, ([self]) => read(stateOf(self)))
      )
    );
  }
}

defineHashMethods(hashClass, (state) => ALGORITHMS[state.name]);
method(hashClass, 'digest', 'none', 0, 0, (self) => newBytes(digestOf(stateOf(self))));
method(hashClass, 'hexdigest', 'none', 0, 0, (self) => hex(digestOf(stateOf(self))));
method(
  hashClass,
  '__repr__',
  'none',
  0,
  0,
  (self) => `<${stateOf(self).name} _hashlib.HASH object @ ${addressOf(self as PyOpaque)}>`
);

function xofLength(name: string, args: PyValue[], kwargs: Kwargs): number {
  const length = argument(args, kwargs, 0, 'length');
  if (length === undefined) throw typeError(`${name}() missing required argument 'length' (pos 1)`);
  const count = toIndex(length);
  if (count < 0n) throw pyError('MemoryError');
  currentRuntime().buildString(Number(count) * 2);
  return Number(count);
}

for (const [name, toValue] of [
  ['digest', (data: Uint8Array): PyValue => newBytes(data)],
  ['hexdigest', (data: Uint8Array): PyValue => hex(data)],
] as const) {
  method(
    hashXofClass,
    name,
    'takes',
    0,
    1,
    (self, args, kwargs) => toValue(digestOf(stateOf(self), xofLength(name, args, kwargs))),
    { keywords: ['length'] }
  );
}

// BLAKE2 ------------------------------------------------------------------------------------------------------------

const BLAKE2_KEYWORDS = [
  'data',
  'digest_size',
  'key',
  'salt',
  'person',
  'fanout',
  'depth',
  'leaf_size',
  'node_offset',
  'node_depth',
  'inner_size',
  'last_node',
  'usedforsecurity',
  'string',
];

// code-gauge-allow functionCognitiveComplexity 23 -- Checks each of BLAKE2's parameters as _blake2 does.
function blake2Class(name: 'blake2b' | 'blake2s', wide: boolean): PyClass {
  const cls = builtinClass(name);
  cls.module = '_blake2';
  const sizes = { salt: wide ? 16 : 8, person: wide ? 16 : 8, key: wide ? 64 : 32, digest: wide ? 64 : 32 };
  cls.construct = (constructed, args, kwargs) => {
    checkArgs({ qualified: name, min: 0, max: 1, style: 'takes', keywords: BLAKE2_KEYWORDS }, args, kwargs);
    const option = (key: string): PyValue | undefined => kwargs?.get(key);
    const bytesOption = (key: string, limit: number): Uint8Array => {
      const value = option(key);
      const data = value === undefined ? new Uint8Array(0) : messageData(value);
      if (data.length > limit) throw valueError(`maximum ${key === 'key' ? 'key' : key} length is ${limit} bytes`);
      return data;
    };
    const number = (key: string, fallback: number): number => Number(toIndex(option(key) ?? BigInt(fallback)));
    const digestSize = number('digest_size', sizes.digest);
    if (digestSize < 1 || digestSize > sizes.digest) {
      throw valueError(
        `digest_size for ${name === 'blake2b' ? 'Blake2b' : 'Blake2s'} must be between 1 and ${sizes.digest} bytes, here it is ${digestSize}`
      );
    }
    const parameters: Blake2Parameters = {
      digestSize,
      key: bytesOption('key', sizes.key),
      salt: bytesOption('salt', sizes.salt),
      person: bytesOption('person', sizes.person),
      fanout: number('fanout', 1),
      depth: number('depth', 1),
      leafSize: number('leaf_size', 0),
      nodeOffset: toIndex(option('node_offset') ?? 0n),
      nodeDepth: number('node_depth', 0),
      innerSize: number('inner_size', 0),
      lastNode: isTruthy(option('last_node') ?? false),
    };
    return newHash(constructed, { name, data: new Uint8Array(0), blake2: parameters }, args[0] ?? option('string'));
  };
  defineHashMethods(cls, (state) => ({ digestSize: state.blake2?.digestSize ?? 0, blockSize: wide ? 128 : 64 }));
  method(cls, 'digest', 'none', 0, 0, (self) => newBytes(digestOf(stateOf(self))));
  method(cls, 'hexdigest', 'none', 0, 0, (self) => hex(digestOf(stateOf(self))));
  method(cls, '__repr__', 'none', 0, 0, (self) => `<_blake2.${name} object at ${addressOf(self as PyOpaque)}>`);
  for (const [key, value] of [
    ['SALT_SIZE', sizes.salt],
    ['PERSON_SIZE', sizes.person],
    ['MAX_KEY_SIZE', sizes.key],
    ['MAX_DIGEST_SIZE', sizes.digest],
  ] as const) {
    cls.dict.set(key, BigInt(value));
  }
  return cls;
}

const blake2bClass = blake2Class('blake2b', true);
const blake2sClass = blake2Class('blake2s', false);

// The module --------------------------------------------------------------------------------------------------------

function constructor(name: string): PyValue {
  return builtin(
    `openssl_${name}`,
    'takes',
    0,
    1,
    (args, kwargs) => {
      const cls = name.startsWith('shake') ? hashXofClass : hashClass;
      return newHash(cls, { name, data: new Uint8Array(0) }, args[0] ?? kwargs?.get('data') ?? kwargs?.get('string'));
    },
    { keywords: ['data', 'usedforsecurity', 'string'] }
  );
}

function newByName(args: PyValue[], kwargs: Kwargs): PyValue {
  const nameArgument = argument(args, kwargs, 0, 'name');
  const nameValue = nameArgument === undefined ? undefined : unbox(nameArgument);
  if (nameValue === undefined) throw typeError("new() missing required argument 'name' (pos 1)");
  if (typeof nameValue !== 'string') throw typeError(`new() argument 'name' must be str, not ${typeName(nameValue)}`);
  const name = nameValue.toLowerCase();
  const data = argument(args, kwargs, 1, 'data');
  if (name === 'blake2b' || name === 'blake2s') {
    const rest = new Map(kwargs);
    rest.delete('name');
    rest.delete('data');
    return currentRuntime().instantiate(
      name === 'blake2b' ? blake2bClass : blake2sClass,
      data === undefined ? [] : [data],
      rest
    );
  }
  if (!Object.hasOwn(ALGORITHMS, name)) throw valueError(`unsupported hash type ${nameValue}`);
  const cls = name.startsWith('shake') ? hashXofClass : hashClass;
  return newHash(cls, { name, data: new Uint8Array(0) }, data ?? kwargs?.get('string'));
}

registerModule(
  'hashlib',
  () =>
    new Map<string, PyValue>([
      ['new', builtin('new', 'takes', 0, 2, newByName, { keywords: ['name', ...BLAKE2_KEYWORDS] })],
      ['algorithms_guaranteed', newSet(GUARANTEED)],
      ['algorithms_available', newSet([...Object.keys(ALGORITHMS), 'blake2b', 'blake2s'])],
      ['blake2b', blake2bClass],
      ['blake2s', blake2sClass],
      ...GUARANTEED.filter((name) => !name.startsWith('blake2')).map((name): [string, PyValue] => [
        name,
        constructor(name),
      ]),
    ]),
  {
    file_digest: 'hashlib.file_digest（ファイルの読み書き）',
    pbkdf2_hmac: 'hashlib.pbkdf2_hmac',
    scrypt: 'hashlib.scrypt',
  }
);
