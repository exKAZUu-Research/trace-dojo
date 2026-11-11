import { bytesLikeData, newBytes, PyBytes } from './bytesValues';
import { CODEC_ALIASES, NON_TEXT_CODECS } from './data/codecNames';
import { toIndex } from './numbers';
import { callValue, getAttribute, getAttributeOrUndefined } from './objects';
import type { Runtime } from './runtime';
import { currentRuntime } from './runtimeContext';
import { exceptionClassNamed, newException, typeError, typeName, unbox } from './types';
import { characterName } from './unicodeDatabase';
import { escapePoint, unicodeException } from './unicodeErrors';
import { PyError, PyTuple, type PyValue } from './values';

/** How a codec converts between code points and bytes, with the name its errors give. */
export interface TextCodec {
  /** The codec's name in UnicodeError messages. */
  name: string;
  encode: (points: readonly number[], errors: ErrorHandling) => Uint8Array;
  decode: (data: Uint8Array, errors: ErrorHandling) => string;
  /**
   * The error handlers CPython's codec applies inline, without creating the exception object that a later error
   * reuses for its arguments.
   */
  inlineHandlers?: { encode: ReadonlySet<string>; decode: ReadonlySet<string> };
  /** How many bytes at the end of data start a sequence that more data may complete, for incremental decoding. */
  incompleteTail?: (data: Uint8Array) => number;
}

/** Creates the codec a module name stands for, loading its tables only when a program uses it. */
const codecFactories = new Map<string, () => TextCodec>();
const codecs = new Map<string, TextCodec>();

export function registerCodec(module: string, create: () => TextCodec): void {
  codecFactories.set(module, create);
}

/** `text.encode(encoding, errors)`. */
export function encodeString(text: string, encoding: string, errors: string): Uint8Array {
  const codec = lookupCodec(encoding, 'encode');
  // oxlint-disable-next-line typescript/no-misused-spread -- Python encodes strings by code point.
  const points = Array.from(text, (char) => char.codePointAt(0) as number);
  currentRuntime().scan(points.length);
  const handling = new ErrorHandling(errors, codec.name, text, codec.inlineHandlers?.encode, points);
  const result = codec.encode(points, handling);
  currentRuntime().buildString(result.length);
  return result;
}

/** `data.decode(encoding, errors)`. */
export function decodeBytes(data: Uint8Array, encoding: string, errors: string): string {
  const codec = lookupCodec(encoding, 'decode');
  currentRuntime().scan(data.length);
  const result = codec.decode(data, new ErrorHandling(errors, codec.name, data, codec.inlineHandlers?.decode));
  currentRuntime().buildString(result.length);
  return result;
}

/** `str(value, encoding, errors)`, which decodes a bytes-like object. */
export function decodeObject(
  object: PyValue,
  encodingValue: PyValue | undefined,
  errorsValue: PyValue | undefined
): string {
  const [value, encoding, errors] = [object, encodingValue, errorsValue].map((each) =>
    each === undefined ? undefined : unbox(each)
  ) as [PyValue, PyValue | undefined, PyValue | undefined];
  for (const [name, argument] of [
    ['encoding', encoding],
    ['errors', errors],
  ] as const) {
    if (argument !== undefined && typeof argument !== 'string') {
      throw typeError(`str() argument '${name}' must be str, not ${typeName(argument)}`);
    }
  }
  if (typeof value === 'string') throw typeError('decoding str is not supported');
  const data = bytesLikeData(value);
  if (data === undefined) throw typeError(`decoding to str: need a bytes-like object, ${typeName(value)} found`);
  return decodeBytes(data, (encoding as string | undefined) ?? 'utf8', (errors as string | undefined) ?? 'strict');
}

export function lookupCodec(encoding: string, direction: 'encode' | 'decode'): TextCodec {
  const module = codecModule(encoding);
  if (module === undefined) {
    const info = registeredCodecLookup?.(encoding);
    if (info === undefined) throw lookupError(`unknown encoding: ${encoding}`);
    return registeredTextCodec(info, encoding, direction);
  }
  if (NON_TEXT_CODECS.has(module)) {
    throw lookupError(`'${encoding}' is not a text encoding; use codecs.${direction}() to handle arbitrary codecs`);
  }
  let codec = codecs.get(module);
  if (!codec) {
    const create = codecFactories.get(module);
    if (!create) throw currentRuntime().unsupported(`文字コード ${module}`);
    codec = create();
    codecs.set(module, codec);
  }
  return codec;
}

/** Whether this grader implements the text codec of a codec module, such as `utf_8`. */
export function hasTextCodec(module: string): boolean {
  return codecFactories.has(module);
}

/** Finds the CodecInfo of an encoding through the search functions a program registered with `codecs.register`. */
let registeredCodecLookup: ((encoding: string) => PyValue | undefined) | undefined;

export function setRegisteredCodecLookup(lookup: (encoding: string) => PyValue | undefined): void {
  registeredCodecLookup = lookup;
}

/** A text codec that calls the functions of a CodecInfo from a registered search function. */
function registeredTextCodec(info: PyValue, encoding: string, direction: 'encode' | 'decode'): TextCodec {
  const field = (name: 'encode' | 'decode'): PyValue =>
    info instanceof PyTuple ? info.items[name === 'encode' ? 0 : 1] : getAttribute(info, name);
  if (!(info instanceof PyTuple) && getAttributeOrUndefined(info, '_is_text_encoding') === false) {
    throw lookupError(`'${encoding}' is not a text encoding; use codecs.${direction}() to handle arbitrary codecs`);
  }
  const call = (name: 'encode' | 'decode', input: PyValue, errors: ErrorHandling): PyValue => {
    const result = callValue(field(name), [input, errors.name]);
    if (!(result instanceof PyTuple) || result.items.length !== 2) {
      throw typeError(`${name}r must return a tuple (object, integer)`);
    }
    return result.items[0];
  };
  return {
    name: encoding,
    encode: (points, errors) => {
      const result = call('encode', String.fromCodePoint(...points), errors);
      if (!(result instanceof PyBytes)) {
        throw typeError(
          `'${encoding}' encoder returned '${typeName(result)}' instead of 'bytes'; use codecs.encode() to encode to arbitrary types`
        );
      }
      return result.data;
    },
    decode: (data, errors) => {
      const result = call('decode', newBytes(new Uint8Array(data)), errors);
      if (typeof result !== 'string') {
        throw typeError(
          `'${encoding}' decoder returned '${typeName(result)}' instead of 'str'; use codecs.decode() to decode to arbitrary types`
        );
      }
      return result;
    },
  };
}

/** The error handlers each run registered with `codecs.register_error`, by name. */
const customErrorHandlers = new WeakMap<Runtime, Map<string, PyValue>>();

export function registerErrorHandler(runtime: Runtime, name: string, handler: PyValue): void {
  let handlers = customErrorHandlers.get(runtime);
  if (!handlers) {
    handlers = new Map();
    customErrorHandlers.set(runtime, handlers);
  }
  handlers.set(name, handler);
}

export function customErrorHandler(runtime: Runtime, name: string): PyValue | undefined {
  return customErrorHandlers.get(runtime)?.get(name);
}

let aliasTable: Map<string, string> | undefined;

/** The codec module an encoding name stands for, or undefined for an unknown one. */
export function codecModuleOf(encoding: string): string | undefined {
  return codecModule(encoding);
}

/** The codec module an encoding name stands for, found as CPython's encodings.search_function finds it. */
export function codecModule(encoding: string): string | undefined {
  if (!aliasTable) {
    aliasTable = new Map();
    for (const [module, aliases] of Object.entries(CODEC_ALIASES)) {
      aliasTable.set(module, module);
      for (const alias of aliases.split(' ')) if (alias !== '') aliasTable.set(alias, module);
    }
  }
  const normalized = normalizeEncoding(encoding.toLowerCase());
  return aliasTable.get(normalized) ?? aliasTable.get(normalized.replaceAll('.', '_'));
}

/** Collapses each run of characters other than ASCII letters, digits, and dots into one underscore. */
function normalizeEncoding(encoding: string): string {
  let result = '';
  let punctuation = false;
  for (const char of encoding) {
    if (/[\p{L}\p{N}.]/u.test(char)) {
      if (punctuation && result !== '') result += '_';
      if (char < '\u0080') result += char;
      punctuation = false;
    } else {
      punctuation = true;
    }
  }
  return result;
}

function lookupError(message: string): PyError {
  return new PyError(newException(exceptionClassNamed('LookupError'), [message]));
}

// Error handlers ----------------------------------------------------------------------------------------------------

/** What an encoder's error handler gives in place of unencodable characters. */
export type EncodeReplacement = { text: string } | { bytes: readonly number[] };

/**
 * Applies an error handler, by its name, to the characters or bytes a codec cannot convert. As in CPython, the first
 * error passed to a handler that is not inline creates the exception, and later errors only update its attributes, so
 * its `args` keep the first error's position.
 */
export class ErrorHandling {
  private firstError: [number, number, string] | undefined;

  constructor(
    readonly name: string,
    private readonly encoding: string,
    private readonly object: string | Uint8Array,
    private readonly inlineHandlers: ReadonlySet<string> = new Set(),
    private readonly points: readonly number[] = []
  ) {}

  /** The same handling for errors that name another codec, as a UTF-16 decoder names the byte order it read. */
  renamed(encoding: string): ErrorHandling {
    return new ErrorHandling(this.name, encoding, this.object, this.inlineHandlers, this.points);
  }

  private record(start: number, end: number, reason: string): void {
    if (!this.inlineHandlers.has(this.name)) this.firstError ??= [start, end, reason];
  }

  /**
   * The replacement for the unencodable characters from `start` up to `end`. `passSurrogate` gives a surrogate's
   * bytes in a UTF codec, for the surrogatepass handler.
   */
  encodeError(
    start: number,
    end: number,
    reason: string,
    passSurrogate?: (point: number) => readonly number[]
  ): EncodeReplacement {
    const points = this.points.slice(start, end);
    this.record(start, end, reason);
    switch (this.name) {
      case 'strict': {
        throw this.encodeException(start, end, reason);
      }
      case 'ignore': {
        return { text: '' };
      }
      case 'replace': {
        return { text: '?'.repeat(end - start) };
      }
      case 'backslashreplace': {
        return { text: points.map((point) => escapePoint(point)).join('') };
      }
      case 'xmlcharrefreplace': {
        return { text: points.map((point) => `&#${point};`).join('') };
      }
      case 'namereplace': {
        return {
          text: points
            .map((point) => {
              const name = characterName(point, true);
              return name === undefined ? escapePoint(point) : `\\N{${name}}`;
            })
            .join(''),
        };
      }
      case 'surrogateescape': {
        // CPython escapes the leading escapable characters before it reports the rest.
        const escapable = points.findIndex((point) => point < 0xdc_80 || point > 0xdc_ff);
        if (escapable !== -1) throw this.encodeException(start + escapable, end, reason);
        return { bytes: points.map((point) => point - 0xdc_00) };
      }
      case 'surrogatepass': {
        if (!passSurrogate || !points.every((point) => point >= 0xd8_00 && point <= 0xdf_ff)) {
          throw this.encodeException(start, end, reason);
        }
        return { bytes: points.flatMap((point) => passSurrogate(point)) };
      }
      default: {
        return this.customEncodeError(start, end, reason);
      }
    }
  }

  /** The replacement a handler from `codecs.register_error` gives, which must resume where the error ends. */
  private customEncodeError(start: number, end: number, reason: string): EncodeReplacement {
    const [replacement, position] = this.callCustomHandler(
      this.encodeException(start, end, reason),
      'encoding error handler must return (str/bytes, int) tuple',
      (value) => typeof value === 'string' || value instanceof PyBytes
    );
    if (position !== end) {
      throw currentRuntime().unsupported('エラーの終わり以外から再開する独自のエラーハンドラ（codecs.register_error）');
    }
    return typeof replacement === 'string' ? { text: replacement } : { bytes: [...(replacement as PyBytes).data] };
  }

  private callCustomHandler(
    error: PyError,
    message: string,
    isReplacement: (value: PyValue) => boolean
  ): [PyValue, number] {
    const handler = customErrorHandler(currentRuntime(), this.name);
    if (handler === undefined) throw unknownHandler(this.name);
    const result = callValue(handler, [error.exception]);
    if (!(result instanceof PyTuple) || result.items.length !== 2 || !isReplacement(result.items[0])) {
      throw typeError(message);
    }
    const length = typeof this.object === 'string' ? this.points.length : this.object.length;
    const requested = toIndex(result.items[1]);
    const position = Number(requested) + (requested < 0n ? length : 0);
    if (position < 0 || position > length) {
      throw new PyError(
        newException(exceptionClassNamed('IndexError'), [`position ${requested} from error handler out of bounds`])
      );
    }
    return [result.items[0], position];
  }

  /**
   * The text in place of the undecodable bytes from `start` up to `end`, and where decoding resumes. `passSurrogate`
   * decodes an encoded surrogate at `start` in a UTF codec, for the surrogatepass handler.
   */
  // code-gauge-allow functionNcss 32 -- One case per builtin error handler.
  decodeError(
    start: number,
    end: number,
    reason: string,
    passSurrogate?: () => { point: number; length: number } | undefined
  ): { text: string; resume: number } {
    const data = this.object as Uint8Array;
    this.record(start, end, reason);
    switch (this.name) {
      case 'strict': {
        throw this.decodeException(start, end, reason);
      }
      case 'ignore': {
        return { text: '', resume: end };
      }
      case 'replace': {
        return { text: '�', resume: end };
      }
      case 'backslashreplace': {
        let text = '';
        for (const byte of data.subarray(start, end)) text += `\\x${byte.toString(16).padStart(2, '0')}`;
        return { text, resume: end };
      }
      case 'surrogateescape': {
        // CPython escapes the leading bytes above ASCII and resumes after them.
        const bytes = [...data.subarray(start, end)];
        const escaped = bytes.findIndex((byte) => byte < 0x80);
        if (escaped === 0) throw this.decodeException(start, end, reason);
        const count = escaped === -1 ? bytes.length : escaped;
        return {
          text: String.fromCodePoint(...bytes.slice(0, count).map((byte) => 0xdc_00 + byte)),
          resume: start + count,
        };
      }
      case 'surrogatepass': {
        const surrogate = passSurrogate?.();
        if (!surrogate) throw this.decodeException(start, end, reason);
        return { text: String.fromCodePoint(surrogate.point), resume: start + surrogate.length };
      }
      case 'xmlcharrefreplace':
      case 'namereplace': {
        throw typeError("don't know how to handle UnicodeDecodeError in error callback");
      }
      default: {
        return this.customDecodeError(start, end, reason);
      }
    }
  }

  /** The text and the position to resume at that a handler from `codecs.register_error` gives. */
  private customDecodeError(start: number, end: number, reason: string): { text: string; resume: number } {
    const [text, resume] = this.callCustomHandler(
      this.decodeException(start, end, reason),
      'decoding error handler must return (str, int) tuple',
      (value) => typeof value === 'string'
    );
    return { text: text as string, resume };
  }

  /** The UnicodeEncodeError for the characters from `start` up to `end`. */
  encodeException(start: number, end: number, reason: string): PyError {
    return this.exception('UnicodeEncodeError', this.object as string, start, end, reason);
  }

  private decodeException(start: number, end: number, reason: string): PyError {
    return this.exception(
      'UnicodeDecodeError',
      newBytes(new Uint8Array(this.object as Uint8Array)),
      start,
      end,
      reason
    );
  }

  private exception(
    name: 'UnicodeEncodeError' | 'UnicodeDecodeError',
    object: PyValue,
    start: number,
    end: number,
    reason: string
  ): PyError {
    this.firstError ??= [start, end, reason];
    const [firstStart, firstEnd, firstReason] = this.firstError;
    const args = [this.encoding, object, BigInt(firstStart), BigInt(firstEnd), firstReason];
    return new PyError(unicodeException(name, args, [this.encoding, object, BigInt(start), BigInt(end), reason]));
  }
}

function unknownHandler(name: string): PyError {
  return lookupError(`unknown error handler name '${name}'`);
}
