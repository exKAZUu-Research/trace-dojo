import { LIMITS } from '../../interpreter/limits';
import { bytesLikeData, newByteArray, newBytes, requireBytesLike } from '../bytesValues';
import { addressOf, pyRepr } from '../conversions';
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
import { callValue, getAttribute, getAttributeOrUndefined, isTruthy } from '../objects';
import { currentRuntime } from '../runtimeContext';
import {
  builtinClass,
  exceptionClassNamed,
  nativeFunction,
  newException,
  newSet,
  None,
  propertyClass,
  pyError,
  typeError,
  typeName,
  unbox,
  valueError,
} from '../types';
import { UnsupportedFeatureError } from '../unsupported';
import { type Kwargs, type PyClass, PyDescriptor, PyError, PyOpaque, type PyValue } from '../values';
import { type HmacHash, pbkdf2, scrypt } from './hashKdf';
import { builtinClassWithBase } from './moduleClasses';

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

/**
 * The state of a hash object: its algorithm, the message so far (the first `length` bytes of `data`, which grows by
 * doubling, so that many small updates cost what their bytes do), and BLAKE2's parameters.
 */
interface HashState {
  name: string;
  data: Uint8Array;
  length: number;
  blake2?: Blake2Parameters;
}

const hashClass = builtinClass('HASH');
hashClass.typeName = '_hashlib.HASH';
hashClass.module = '_hashlib';
const hashXofClass = builtinClass('HASHXOF', hashClass);
hashXofClass.typeName = '_hashlib.HASHXOF';
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
  const length = state.length + data.length;
  const runtime = currentRuntime();
  runtime.ensureStringFits(length);
  runtime.spend(Math.ceil(data.length / 16));
  if (length > state.data.length) {
    const grown = new Uint8Array(Math.min(Math.max(length, state.data.length * 2), LIMITS.maxStringLength));
    grown.set(state.data.subarray(0, state.length));
    state.data = grown;
  }
  state.data.set(data, state.length);
  state.length = length;
}

function digestOf(state: HashState, length?: number): Uint8Array {
  currentRuntime().scan(state.length * 4);
  const message = state.data.subarray(0, state.length);
  if (state.blake2) return (state.name === 'blake2b' ? blake2b : blake2s)(message, state.blake2);
  return ALGORITHMS[state.name].digest(message, length ?? 0);
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
    return new PyOpaque((self as PyOpaque).cls, state.name, { ...state, data: state.data.slice(0, state.length) });
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
    return newHash(
      constructed,
      { name, data: new Uint8Array(0), length: 0, blake2: parameters },
      args[0] ?? option('string')
    );
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
      return newHash(
        cls,
        { name, data: new Uint8Array(0), length: 0 },
        args[0] ?? kwargs?.get('data') ?? kwargs?.get('string')
      );
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
  return newHash(cls, { name, data: new Uint8Array(0), length: 0 }, data ?? kwargs?.get('string'));
}

// Key derivation and file digests ----------------------------------------------------------------------------------

/** `_hashlib.UnsupportedDigestmodError`, which OpenSSL's lookup of an unknown digest raises. */
const unsupportedDigestmodClass = builtinClassWithBase(
  'UnsupportedDigestmodError',
  exceptionClassNamed('ValueError'),
  '_hashlib'
);
const INT_MAX = 2_147_483_647;

function hmacHash(name: string): HmacHash {
  const algorithm = Object.hasOwn(ALGORITHMS, name) && !name.startsWith('shake') ? ALGORITHMS[name] : undefined;
  if (!algorithm)
    throw new PyError(newException(unsupportedDigestmodClass, ['[digital envelope routines] unsupported']));
  return { ...algorithm, name, digest: (data) => algorithm.digest(data, 0) };
}

/** `pbkdf2_hmac(hash_name, password, salt, iterations, dklen=None)`. */
function pbkdf2Hmac(args: PyValue[], kwargs: Kwargs): PyValue {
  const [nameValue, password, salt, iterationsValue, dklenValue] = PBKDF2_KEYWORDS.map((name, index) =>
    argument(args, kwargs, index, name)
  );
  for (const [index, value] of [nameValue, password, salt, iterationsValue].entries()) {
    if (value === undefined) {
      throw typeError(`pbkdf2_hmac() missing required argument '${PBKDF2_KEYWORDS[index]}' (pos ${index + 1})`);
    }
  }
  const name = unbox(nameValue as PyValue);
  if (typeof name !== 'string') {
    throw typeError(`pbkdf2_hmac() argument 'hash_name' must be str, not ${typeName(nameValue as PyValue)}`);
  }
  const passwordData = requireBytesLike(password as PyValue);
  const saltData = requireBytesLike(salt as PyValue);
  const iterations = toIndex(iterationsValue as PyValue);
  const hash = hmacHash(name.toLowerCase());
  if (iterations < 1n) throw valueError('iteration value must be greater than 0.');
  if (iterations > BigInt(INT_MAX)) throw pyError('OverflowError', 'iteration value is too great.');
  const dklen = dklenValue === undefined || dklenValue === None ? BigInt(hash.digestSize) : toIndex(dklenValue);
  if (dklen < 1n) throw valueError('key length must be greater than 0.');
  if (dklen > BigInt(INT_MAX)) throw pyError('OverflowError', 'key length is too great.');
  currentRuntime().ensureRoom(Math.ceil(Number(dklen) / 8));
  return newBytes(pbkdf2(hash, passwordData, saltData, Number(iterations), Number(dklen)));
}

const PBKDF2_KEYWORDS = ['hash_name', 'password', 'salt', 'iterations', 'dklen'];
const SCRYPT_MAX_MEMORY = 32 * 1024 * 1024;

/** `scrypt(password, *, salt, n, r, p, maxmem=0, dklen=64)`. */
function scryptFunction(args: PyValue[], kwargs: Kwargs): PyValue {
  if (args.length > 1) throw typeError(`scrypt() takes exactly 1 positional argument (${args.length} given)`);
  const values = ['password', 'salt', 'n', 'r', 'p'].map((name, index) => {
    const value = argument(args, kwargs, index, name);
    if (value === undefined) throw typeError(`scrypt() missing required argument '${name}' (pos ${index + 1})`);
    return value;
  });
  const [password, salt] = values.slice(0, 2).map((value) => requireBytesLike(value));
  const [nValue, rValue, pValue] = values.slice(2);
  if (typeof unbox(nValue) !== 'bigint') throw typeError('n is required and must be an unsigned int');
  const [n, r, p] = [nValue, rValue, pValue].map((value) => Number(toIndex(value)));
  if (n < 2 || (n & (n - 1)) !== 0) throw valueError('n must be a power of 2.');
  const maxmem = Number(toIndex(kwargs?.get('maxmem') ?? 0n));
  if (maxmem < 0 || maxmem > INT_MAX) throw valueError(`maxmem must be positive and smaller than ${INT_MAX}`);
  const dklen = Number(toIndex(kwargs?.get('dklen') ?? 64n));
  if (dklen < 1 || dklen > INT_MAX) throw valueError(`dklen must be greater than 0 and smaller than ${INT_MAX}`);
  // OpenSSL's checks of the other parameters, with its default limit of 32 MiB of memory.
  const memory = 128 * r * p + 128 * r * (n + 2);
  if (
    r < 1 ||
    p < 1 ||
    p > (2 ** 30 - 1) / r ||
    (16 * r <= 63 && n >= 2 ** (16 * r)) ||
    memory > (maxmem || SCRYPT_MAX_MEMORY)
  ) {
    throw valueError('Invalid parameter combination for n, r, p, maxmem.');
  }
  if (memory > SCRYPT_MAX_MEMORY) {
    throw new UnsupportedFeatureError('maxmem で 32 MiB より多くのメモリを使わせる hashlib.scrypt()');
  }
  currentRuntime().ensureRoom(Math.ceil(dklen / 8));
  currentRuntime().spend(Math.ceil(memory / 1024));
  return newBytes(scrypt(hmacHash('sha256'), password, salt, { n, r, p, length: dklen }));
}

/** `file_digest(fileobj, digest, /, *, _bufsize=2**18)`, which reads a binary stream such as io.BytesIO. */
function fileDigest(args: PyValue[], kwargs: Kwargs): PyValue {
  const [file, digest] = args;
  const runtime = currentRuntime();
  const hash = typeof unbox(digest) === 'string' ? newByName([digest], undefined) : callValue(digest, []);
  const update = getAttribute(hash, 'update');
  const getbuffer = getAttributeOrUndefined(file, 'getbuffer');
  if (getbuffer !== undefined) {
    callValue(update, [callValue(getbuffer, [])]);
    return hash;
  }
  const readinto = getAttributeOrUndefined(file, 'readinto');
  const readable = getAttributeOrUndefined(file, 'readable');
  if (readinto === undefined || readable === undefined || !isTruthy(callValue(readable, []))) {
    throw valueError(`'${pyRepr(file)}' is not a file-like object in binary reading mode.`);
  }
  const size = Number(toIndex(kwargs?.get('_bufsize') ?? 262_144n));
  runtime.ensureRoom(Math.ceil(size / 8));
  const buffer = newByteArray(new Uint8Array(size));
  for (;;) {
    const count = callValue(readinto, [buffer]);
    if (count === None)
      throw new PyError(newException(exceptionClassNamed('BlockingIOError'), ['I/O operation would block.']));
    const length = Number(toIndex(count));
    if (length === 0) return hash;
    callValue(update, [newBytes(buffer.data.slice(0, length))]);
  }
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
      [
        'pbkdf2_hmac',
        builtin('pbkdf2_hmac', 'takes', 0, 5, pbkdf2Hmac, { keywords: PBKDF2_KEYWORDS, short: 'pbkdf2_hmac' }),
      ],
      [
        'scrypt',
        builtin('scrypt', 'expected', 0, Number.POSITIVE_INFINITY, scryptFunction, {
          keywords: ['password', 'salt', 'n', 'r', 'p', 'maxmem', 'dklen'],
        }),
      ],
      ['file_digest', builtin('file_digest', 'takes', 2, 2, fileDigest, { keywords: ['_bufsize'] })],
      ...GUARANTEED.filter((name) => !name.startsWith('blake2')).map((name): [string, PyValue] => [
        name,
        constructor(name),
      ]),
    ])
);
