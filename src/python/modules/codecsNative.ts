import { bytesLikeData, newBytes } from '../bytesValues';
import { charmapNatives } from '../charmapCodecs';
import {
  callCodec,
  codecModule,
  customErrorHandler,
  decodeBytes,
  encodeString,
  ErrorHandling,
  hasTextCodec,
  lookupCodec,
  registerErrorHandler,
  setEncodingsCodecLookup,
  setRegisteredCodecLookup,
} from '../codecs';
import { builtin } from '../define';
import { importModule, registerModule } from '../modules';
import { argument } from '../nativeArgs';
import { toIndex } from '../numbers';
import { callValue, getAttribute, isTruthy } from '../objects';
import type { Runtime } from '../runtime';
import { currentRuntime } from '../runtimeContext';
import { exceptionClassNamed, isInstanceOf, newException, newTuple, None, typeError, typeName } from '../types';
import { characterName } from '../unicodeDatabase';
import { escapePoint } from '../unicodeErrors';
import { utf7Natives } from '../utf7';
import { PyError, PyInstance, PyTuple, type PyValue } from '../values';
import { escapeDecodeFunction } from './escapeDecode';

/** The codec modules whose `encodings` module this grader has, which `codecs.lookup` imports. */
export const ENCODINGS_MODULES = new Set<string>([
  'ascii',
  'latin_1',
  'utf_8',
  'utf_8_sig',
  'utf_16',
  'utf_16_le',
  'utf_16_be',
  'utf_32',
  'utf_32_le',
  'utf_32_be',
  'shift_jis',
  'cp932',
  'euc_jp',
  'rot_13',
  'hex_codec',
  'base64_codec',
  'zlib_codec',
]);

/** Adds the `encodings` module of a codec, which `codecs.lookup` imports. */
export function addEncodingsModule(module: string): void {
  ENCODINGS_MODULES.add(module);
}

/** The codecs whose stateless functions `_codecs` exports, such as `utf_8_encode` and `utf_8_decode`. */
const UNICODE_CODECS = [
  'ascii',
  'latin_1',
  'utf_8',
  'utf_16',
  'utf_16_le',
  'utf_16_be',
  'utf_32',
  'utf_32_le',
  'utf_32_be',
  'raw_unicode_escape',
  'unicode_escape',
];

/** What `codecs.register` and `codecs.lookup` keep for each run. */
interface Registry {
  searches: PyValue[];
  cache: Map<string, PyValue>;
}

const registries = new WeakMap<Runtime, Registry>();

registerModule('_codecs', () => {
  const entries = new Map<string, PyValue>([
    ['register', builtin('register', 'one', 1, 1, ([search]) => registerSearch(search))],
    ['unregister', builtin('unregister', 'one', 1, 1, ([search]) => unregisterSearch(search))],
    ['lookup', builtin('lookup', 'one', 1, 1, ([encoding]) => lookup(encoding))],
    ['encode', codecFunction('encode')],
    ['decode', codecFunction('decode')],
    ['lookup_error', builtin('lookup_error', 'one', 1, 1, ([name]) => lookupErrorHandler(name))],
    ['register_error', builtin('register_error', 'expected', 2, 2, ([name, handler]) => registerError(name, handler))],
    [
      '_encode_with',
      builtin('_encode_with', 'expected', 3, 3, ([module, input, errors]) => encodeWith(module, input, errors)),
    ],
    [
      '_incremental_decoder',
      builtin('_incremental_decoder', 'one', 1, 1, ([module]) => incrementalDecoder(module as string)),
    ],
    [
      '_incremental_encoder',
      builtin('_incremental_encoder', 'one', 1, 1, ([module]) => incrementalEncoder(module as string)),
    ],
    [
      '_decode_with',
      builtin('_decode_with', 'expected', 4, 4, ([module, input, errors, final]) =>
        decodeWith(module as string, input, errors, isTruthy(final), `${module as string}_decode`)
      ),
    ],
  ]);
  for (const [name, handler] of ERROR_HANDLERS) {
    // CPython's `_codecs` exports the handlers of the error names that the C codecs know as functions.
    if (!name.startsWith('surrogate')) entries.set(`${name}_errors`, handler);
  }
  for (const module of UNICODE_CODECS) {
    entries.set(`${module}_encode`, unicodeEncoder(module));
    entries.set(`${module}_decode`, unicodeDecoder(module));
  }
  entries.set('escape_decode', escapeDecodeFunction);
  for (const [name, value] of [...charmapNatives(), ...utf7Natives()]) entries.set(name, value);
  entries.set('utf_16_ex_decode', exDecoder(2));
  entries.set('utf_32_ex_decode', exDecoder(4));
  return entries;
});

// The codec registry -------------------------------------------------------------------------------------------------

// `str.encode` and `bytes.decode` run the codecs written in Python through their `encodings` modules.
setEncodingsCodecLookup((module) => (ENCODINGS_MODULES.has(module) ? searchEncodings(module) : undefined));

// `str.encode` and `bytes.decode` find the encodings registered search functions give, as in CPython.
setRegisteredCodecLookup((encoding) => {
  const state = registries.get(currentRuntime());
  return state && state.searches.length > 0 ? lookup(encoding) : undefined;
});

function registry(): Registry {
  const runtime = currentRuntime();
  let state = registries.get(runtime);
  if (!state) {
    state = { searches: [], cache: new Map() };
    registries.set(runtime, state);
  }
  return state;
}

function registerSearch(search: PyValue): PyValue {
  if (!isCallable(search)) throw typeError('argument must be callable');
  registry().searches.push(search);
  return None;
}

function unregisterSearch(search: PyValue): PyValue {
  const state = registry();
  const index = state.searches.indexOf(search);
  if (index !== -1) {
    state.searches.splice(index, 1);
    state.cache.clear();
  }
  return None;
}

/** `codecs.lookup`: the CodecInfo of an encoding, from this grader's `encodings` modules or a registered search. */
function lookup(encoding: PyValue): PyValue {
  if (typeof encoding !== 'string') throw typeError(`lookup() argument must be str, not ${typeName(encoding)}`);
  const state = registry();
  const key = cacheKey(encoding);
  const cached = state.cache.get(key);
  if (cached !== undefined) return cached;
  const info = searchEncodings(encoding) ?? searchRegistered(state, key);
  if (info === undefined) throw lookupError(`unknown encoding: ${encoding}`);
  state.cache.set(key, info);
  return info;
}

/** The name CPython's codec registry caches an encoding by: lowercase, with other characters than ASCII letters, digits and dots collapsed into underscores. */
function cacheKey(encoding: string): string {
  let result = '';
  let punctuation = false;
  for (const char of encoding) {
    if (/[A-Za-z0-9.]/.test(char)) {
      if (punctuation && result !== '') result += '_';
      result += char.toLowerCase();
      punctuation = false;
    } else {
      punctuation = true;
    }
  }
  return result;
}

function searchEncodings(encoding: string): PyValue | undefined {
  const module = codecModule(encoding);
  if (module === undefined) return undefined;
  if (!ENCODINGS_MODULES.has(module)) {
    throw currentRuntime().unsupported(`文字コード ${module}`);
  }
  const getregentry = importModule(currentRuntime(), `encodings.${module}`).dict.get('getregentry');
  return callValue(getregentry as PyValue, []);
}

function searchRegistered(state: Registry, key: string): PyValue | undefined {
  for (const search of state.searches) {
    const result = callValue(search, [key]);
    if (result === None) continue;
    const codecInfo = getAttribute(importModule(currentRuntime(), 'codecs'), 'CodecInfo');
    if (!isInstanceOf(result, codecInfo as never) && !(result instanceof PyTuple && result.items.length === 4)) {
      throw typeError('codec search functions must return 4-tuples');
    }
    return result;
  }
  return undefined;
}

/** `codecs.encode(obj, encoding, errors)` and `codecs.decode`, which call the codec's function on any object. */
function codecFunction(direction: 'encode' | 'decode'): PyValue {
  return builtin(
    direction,
    'takes',
    1,
    3,
    (args, kwargs) => {
      const object = argument(args, kwargs, 0, 'obj') as PyValue;
      const encoding = stringArgument(direction, 'encoding', argument(args, kwargs, 1, 'encoding') ?? 'utf8');
      const errors = stringArgument(direction, 'errors', argument(args, kwargs, 2, 'errors') ?? 'strict');
      const result = callCodec(codecInfoFunction(lookup(encoding), direction), [object, errors], direction, encoding);
      if (!(result instanceof PyTuple) || result.items.length !== 2) {
        throw typeError(`${direction}r must return a tuple (object, integer)`);
      }
      return result.items[0];
    },
    { keywords: ['obj', 'encoding', 'errors'] }
  );
}

function stringArgument(direction: string, name: string, value: PyValue): string {
  if (typeof value !== 'string')
    throw typeError(`${direction}() argument '${name}' must be str, not ${typeName(value)}`);
  return value;
}

/** The encode or decode function of a CodecInfo, or of the 4-tuple an old search function may give instead. */
function codecInfoFunction(info: PyValue, direction: 'encode' | 'decode'): PyValue {
  if (info instanceof PyTuple && !(info instanceof PyInstance)) return info.items[direction === 'encode' ? 0 : 1];
  return getAttribute(info, direction);
}

// The stateless codec functions ---------------------------------------------------------------------------------------

function unicodeEncoder(module: string): PyValue {
  const name = `${module}_encode`;
  return builtin(name, 'expected', 1, 2, ([input, errors]) => {
    if (typeof input !== 'string') throw typeError(`${name}() argument 1 must be str, not ${typeName(input)}`);
    return encodeWith(module, input, errors ?? None, name);
  });
}

function encodeWith(module: PyValue, input: PyValue, errors: PyValue, name = `${module as string}_encode`): PyValue {
  if (typeof input !== 'string') throw typeError(`${name}() argument 1 must be str, not ${typeName(input)}`);
  const encoded = encodeString(input, module as string, errorsName(name, errors));
  // oxlint-disable-next-line typescript/no-misused-spread -- Python counts a string's length in code points.
  return newTuple([newBytes(encoded), BigInt([...input].length)]);
}

function unicodeDecoder(module: string): PyValue {
  const name = `${module}_decode`;
  return builtin(name, 'expected', 1, 3, ([input, errors, final]) =>
    decodeWith(module, input, errors ?? None, final !== undefined && isTruthy(final), name)
  );
}

/** Decodes all of `input`, or, unless `final`, all but an incomplete sequence at its end, with how much it used. */
function decodeWith(module: string, input: PyValue, errors: PyValue, final: boolean, name: string): PyValue {
  const data = requireBytes(input);
  const handler = errorsName(name, errors);
  const used = final ? data.length : data.length - incompleteTail(data, module);
  const text = used === 0 ? '' : decodeBytes(data.subarray(0, used), module, handler);
  return newTuple([text, BigInt(used)]);
}

/**
 * The incremental decoder or encoder of a codec that keeps a state, such as iso2022_jp, which io's TextIOWrapper uses
 * in place of its own, or None for any other codec.
 */
export function statefulCodecFunction(encoding: string, direction: 'encode' | 'decode'): PyValue {
  const module = codecModule(encoding);
  if (module === undefined || !hasTextCodec(module)) return None;
  const codec = lookupCodec(module, direction);
  if (direction === 'decode') return codec.incrementalDecoder ? incrementalDecoder(module) : None;
  return codec.incrementalEncoder ? incrementalEncoder(module) : None;
}

/**
 * The decoder of an IncrementalDecoder or StreamReader of a multibyte codec, which keeps the codec's state from one
 * call to the next: `decode(data, errors, final)` gives the text and how many bytes it used.
 */
function incrementalDecoder(module: string): PyValue {
  const codec = lookupCodec(module, 'decode');
  const decode = codec.incrementalDecoder?.();
  return builtin('decode', 'expected', 3, 3, ([input, errors, final]) => {
    if (!decode) return decodeWith(module, input, errors, isTruthy(final), `${module}_decode`);
    const data = requireBytes(input);
    const handling = new ErrorHandling(
      errorsName('decode', errors),
      codec.name,
      new Uint8Array(data),
      codec.inlineHandlers?.decode
    );
    const { text, consumed } = decode(data, handling, isTruthy(final));
    return newTuple([text, BigInt(consumed)]);
  });
}

/** The encoder of an IncrementalEncoder or StreamWriter of a multibyte codec, which keeps the codec's state. */
function incrementalEncoder(module: string): PyValue {
  const codec = lookupCodec(module, 'encode');
  const encode = codec.incrementalEncoder?.();
  return builtin('encode', 'expected', 3, 3, ([input, errors, final]) => {
    if (typeof input !== 'string') throw typeError(`encode() argument 1 must be str, not ${typeName(input)}`);
    if (!encode) return newBytes(encodeString(input, module, errorsName('encode', errors)));
    // oxlint-disable-next-line typescript/no-misused-spread -- Python encodes strings by code point.
    const points = [...input].map((char) => char.codePointAt(0) as number);
    const handling = new ErrorHandling(
      errorsName('encode', errors),
      codec.name,
      input,
      codec.inlineHandlers?.encode,
      points
    );
    return newBytes(encode(points, handling, isTruthy(final)));
  });
}

/** `utf_16_ex_decode(data, errors, byteorder, final)`: decodes in the order a BOM gives, which it reports. */
function exDecoder(size: 2 | 4): PyValue {
  const name = `utf_${size * 8}_ex_decode`;
  return builtin(name, 'expected', 1, 4, ([input, errors, byteorderValue, final]) => {
    const data = requireBytes(input);
    const requested = byteorderValue === undefined ? 0 : Number(toIndex(byteorderValue));
    const isFinal = final !== undefined && isTruthy(final);
    if (requested === 0 && data.length < size && !isFinal) return newTuple(['', 0n, 0n]);
    const [order, start] = requested === 0 ? byteOrderMark(data, size) : [requested, 0];
    const module = `utf_${size * 8}_${order === 1 ? 'be' : 'le'}`;
    const decoded = decodeWith(module, newBytes(data.subarray(start)), errors ?? None, isFinal, name) as PyTuple;
    return newTuple([decoded.items[0], (decoded.items[1] as bigint) + BigInt(start), BigInt(order)]);
  });
}

/** The byte order a BOM at the start of `data` gives, -1 for little and 1 for big endian, and its length. */
function byteOrderMark(data: Uint8Array, size: 2 | 4): [number, number] {
  const bom = [...data.subarray(0, size)].join(',');
  if (bom === (size === 2 ? '255,254' : '255,254,0,0')) return [-1, size];
  if (bom === (size === 2 ? '254,255' : '0,0,254,255')) return [1, size];
  return [0, 0];
}

function requireBytes(input: PyValue): Uint8Array {
  const data = bytesLikeData(input);
  if (data === undefined) throw typeError(`a bytes-like object is required, not '${typeName(input)}'`);
  return data;
}

function errorsName(name: string, errors: PyValue): string {
  if (errors === None) return 'strict';
  if (typeof errors !== 'string') throw typeError(`${name}() argument 2 must be str or None, not ${typeName(errors)}`);
  return errors;
}

/** How many bytes at the end of `data` start a character that the next data may complete. */
function incompleteTail(data: Uint8Array, module: string): number {
  if (module === 'utf_8') return utf8Tail(data);
  if (module.startsWith('utf_16')) {
    const odd = data.length % 2;
    const end = data.length - odd;
    if (end < 2) return odd;
    const bigEndian = module === 'utf_16_be' || (module === 'utf_16' && data[0] === 0xfe && data[1] === 0xff);
    const unit = bigEndian ? (data[end - 2] << 8) | data[end - 1] : data[end - 2] | (data[end - 1] << 8);
    return odd + (unit >= 0xd8_00 && unit <= 0xdb_ff ? 2 : 0);
  }
  if (module.startsWith('utf_32')) return data.length % 4;
  if (module === 'shift_jis' || module === 'cp932') return multibyteTail(data, shiftJisLength);
  if (module === 'euc_jp') return multibyteTail(data, eucJpLength);
  return lookupCodec(module, 'decode').incompleteTail?.(data) ?? 0;
}

/** The bytes of a UTF-8 sequence that the end of `data` leaves incomplete, when they are valid so far. */
function utf8Tail(data: Uint8Array): number {
  for (let back = 1; back <= Math.min(3, data.length); back++) {
    const lead = data[data.length - back];
    if ((lead & 0xc0) === 0x80) continue;
    if (utf8SequenceLength(lead) <= back) return 0;
    const second = data[data.length - back + 1];
    if (second !== undefined && !validSecondByte(lead, second)) return 0;
    return back;
  }
  return 0;
}

function utf8SequenceLength(lead: number): number {
  if (lead >= 0xc2 && lead <= 0xdf) return 2;
  if (lead >= 0xe0 && lead <= 0xef) return 3;
  return lead >= 0xf0 && lead <= 0xf4 ? 4 : 1;
}

function validSecondByte(lead: number, byte: number): boolean {
  if (lead === 0xe0) return byte >= 0xa0 && byte <= 0xbf;
  if (lead === 0xed) return byte >= 0x80 && byte <= 0x9f;
  if (lead === 0xf0) return byte >= 0x90 && byte <= 0xbf;
  if (lead === 0xf4) return byte >= 0x80 && byte <= 0x8f;
  return byte >= 0x80 && byte <= 0xbf;
}

function multibyteTail(data: Uint8Array, sequenceLength: (lead: number) => number): number {
  let index = 0;
  while (index < data.length) {
    const length = sequenceLength(data[index]);
    if (index + length > data.length) return data.length - index;
    index += length;
  }
  return 0;
}

const shiftJisLength = (lead: number): number =>
  (lead >= 0x81 && lead <= 0x9f) || (lead >= 0xe0 && lead <= 0xfc) ? 2 : 1;
const eucJpLength = (lead: number): number =>
  lead === 0x8f ? 3 : lead === 0x8e || (lead >= 0xa1 && lead <= 0xfe) ? 2 : 1;

// Error handlers ------------------------------------------------------------------------------------------------------

type UnicodeErrorKind = 'encode' | 'decode' | 'translate';

const ERROR_HANDLERS = new Map<string, PyValue>(
  (
    [
      ['strict', strictErrors],
      ['ignore', () => ['', undefined]],
      ['replace', replaceErrors],
      ['xmlcharrefreplace', xmlcharrefreplaceErrors],
      ['backslashreplace', backslashreplaceErrors],
      ['namereplace', namereplaceErrors],
      ['surrogateescape', surrogateescapeErrors],
      ['surrogatepass', surrogatepassErrors],
    ] as [string, (error: PyValue, kind: UnicodeErrorKind) => [PyValue, unknown]][]
  ).map(([name, run]) => [
    name,
    builtin(`${name}_errors`, 'one', 1, 1, ([error]) => {
      const kind = unicodeErrorKind(error);
      if (kind === undefined && name !== 'strict') {
        throw typeError(`don't know how to handle ${typeName(error)} in error callback`);
      }
      const [replacement] = run(error, kind as UnicodeErrorKind);
      return newTuple([replacement, BigInt(errorEnd(error))]);
    }),
  ])
);

function unicodeErrorKind(error: PyValue): UnicodeErrorKind | undefined {
  if (!(error instanceof PyInstance)) return undefined;
  if (error.cls.isSubclassOf(exceptionClassNamed('UnicodeEncodeError'))) return 'encode';
  if (error.cls.isSubclassOf(exceptionClassNamed('UnicodeDecodeError'))) return 'decode';
  if (error.cls.isSubclassOf(exceptionClassNamed('UnicodeTranslateError'))) return 'translate';
  return undefined;
}

function strictErrors(error: PyValue): never {
  if (error instanceof PyInstance && error.exception) throw new PyError(error);
  throw typeError('codec must pass exception instance');
}

function replaceErrors(error: PyValue, kind: UnicodeErrorKind): [PyValue, unknown] {
  const count = errorEnd(error) - errorStart(error);
  if (kind === 'encode') return ['?'.repeat(count), undefined];
  return [kind === 'decode' ? '�' : '�'.repeat(count), undefined];
}

function xmlcharrefreplaceErrors(error: PyValue, kind: UnicodeErrorKind): [PyValue, unknown] {
  if (kind !== 'encode') throw handlerTypeError(error);
  return [
    errorPoints(error)
      .map((point) => `&#${point};`)
      .join(''),
    undefined,
  ];
}

function backslashreplaceErrors(error: PyValue, kind: UnicodeErrorKind): [PyValue, unknown] {
  if (kind === 'decode') {
    const data = bytesLikeData(getAttribute(error, 'object')) ?? new Uint8Array();
    let text = '';
    for (const byte of data.subarray(errorStart(error), errorEnd(error)))
      text += `\\x${byte.toString(16).padStart(2, '0')}`;
    return [text, undefined];
  }
  return [
    errorPoints(error)
      .map((point) => escapePoint(point))
      .join(''),
    undefined,
  ];
}

function namereplaceErrors(error: PyValue, kind: UnicodeErrorKind): [PyValue, unknown] {
  if (kind !== 'encode') throw handlerTypeError(error);
  const names = errorPoints(error).map((point) => {
    const name = characterName(point, true);
    return name === undefined ? escapePoint(point) : `\\N{${name}}`;
  });
  return [names.join(''), undefined];
}

function surrogateescapeErrors(error: PyValue, kind: UnicodeErrorKind): [PyValue, unknown] {
  if (kind === 'decode') {
    const data = bytesLikeData(getAttribute(error, 'object')) ?? new Uint8Array();
    const bytes = [...data.subarray(errorStart(error), errorEnd(error))];
    if (bytes.some((byte) => byte < 0x80)) throw new PyError(error as PyInstance);
    return [String.fromCodePoint(...bytes.map((byte) => 0xdc_00 + byte)), undefined];
  }
  if (kind === 'encode') {
    const points = errorPoints(error);
    if (points.some((point) => point < 0xdc_80 || point > 0xdc_ff)) throw new PyError(error as PyInstance);
    return [newBytes(Uint8Array.from(points, (point) => point - 0xdc_00)), undefined];
  }
  throw handlerTypeError(error);
}

function surrogatepassErrors(): never {
  throw currentRuntime().unsupported('codecs.surrogatepass_errors の直接の呼び出し');
}

function handlerTypeError(error: PyValue): PyError {
  return typeError(`don't know how to handle ${typeName(error)} in error callback`);
}

function errorStart(error: PyValue): number {
  return Number(toIndex(getAttribute(error, 'start')));
}

function errorEnd(error: PyValue): number {
  return Number(toIndex(getAttribute(error, 'end')));
}

function errorPoints(error: PyValue): number[] {
  const text = getAttribute(error, 'object');
  const points = Array.from(typeof text === 'string' ? text : '', (char) => char.codePointAt(0) as number);
  return points.slice(errorStart(error), errorEnd(error));
}

function lookupErrorHandler(name: PyValue): PyValue {
  if (typeof name !== 'string') throw typeError(`lookup_error() argument must be str, not ${typeName(name)}`);
  const handler = customErrorHandler(currentRuntime(), name) ?? ERROR_HANDLERS.get(name);
  if (handler === undefined) throw lookupError(`unknown error handler name '${name}'`);
  return handler;
}

function registerError(name: PyValue, handler: PyValue): PyValue {
  if (typeof name !== 'string') throw typeError(`register_error() argument 1 must be str, not ${typeName(name)}`);
  if (!isCallable(handler)) throw typeError('handler must be callable');
  registerErrorHandler(currentRuntime(), name, handler);
  return None;
}

function isCallable(value: PyValue): boolean {
  return callValue(currentRuntime().builtins.get('callable') as PyValue, [value]) === true;
}

function lookupError(message: string): PyError {
  return new PyError(newException(exceptionClassNamed('LookupError'), [message]));
}
