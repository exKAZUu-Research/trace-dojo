// oxlint-disable unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import type { Entity } from '../entities';
import { newError } from '../errorValues';
import { encodeRune } from '../literals';
import { addMethod, definePackage, fn, namedType, nativeFunction, opaqueType, typeEntity } from '../native';
import { nilPointerPanic } from '../runtimeErrors';
import { ANY, BASIC, ERROR_TYPE, pointerTo, sliceOf, type Type } from '../types';
import { Cell, GoStruct, Iface, Pointer, Slice, type Value } from '../values';
import { BUFFER, BYTES_PACKAGE } from './bytes';
import { IO_READER, IO_WRITER } from './io';
import { marshalEncode, unmarshalDecode } from './jsonArshal';
import { MARSHALER, NUMBER, RAW_MESSAGE, UNMARSHALER, type UnmarshalOptions } from './jsonArshalCore';
import {
  INVALID_UNMARSHAL_ERROR,
  INVALID_UTF8_ERROR,
  MARSHALER_ERROR,
  marshalErrorToGo,
  reflectType,
  syntacticToGo,
  SYNTAX_ERROR,
  toGoError,
  UNEXPECTED_END,
  UNMARSHAL_FIELD_ERROR,
  UNMARSHAL_TYPE_ERROR,
  unmarshalErrorToGo,
  UNSUPPORTED_TYPE_ERROR,
  UNSUPPORTED_VALUE_ERROR,
} from './jsonErrors';
import { DecoderState, type EncoderOptions, EncoderState, IoError, SyntacticError } from './jsonText';
import { EOF_ERROR, type LibError, TextError, UNEXPECTED_EOF, unquote } from './jsonWire';
import { parseFloat, parseInt } from './strconv';
import { appendBytes, BOOL, byteSlice, bytesOf, callMethod, FLOAT64, receiverStruct, STRING } from './support';

const BYTES = sliceOf(BASIC.uint8);
const INT64 = BASIC.int64;
const BUFFER_POINTER = pointerTo(BUFFER);

// Number, RawMessage, Delim, and Token ----------------------------------------------------------------------------------

addMethod(NUMBER, 'String', fn([], [STRING]), (receiver) => receiver);
addMethod(NUMBER, 'Float64', fn([], [FLOAT64, ERROR_TYPE]), (receiver) => parseFloat(receiver as string, 64));
addMethod(NUMBER, 'Int64', fn([], [INT64, ERROR_TYPE]), (receiver) => parseInt(receiver as string, 10, 64, 'ParseInt'));

addMethod(RAW_MESSAGE, 'MarshalJSON', fn([], [BYTES, ERROR_TYPE]), (receiver) => [
  receiver ?? byteSlice('null'),
  undefined,
]);
addMethod(
  RAW_MESSAGE,
  'UnmarshalJSON',
  fn([BYTES], [ERROR_TYPE]),
  (receiver, [data]) => {
    if (!(receiver instanceof Pointer)) return newError('jsontext.Value: UnmarshalJSON on nil pointer');
    const current = receiver.load() as Slice | undefined;
    const emptied = current && new Slice(current.array, current.offset, 0, current.capacity);
    receiver.store(appendBytes(emptied, bytesOf(data)) ?? byteSlice(''));
    return;
  },
  true
);
addMethod(RAW_MESSAGE, 'String', fn([], [STRING]), (receiver) => (receiver === undefined ? 'null' : bytesOf(receiver)));
addMethod(RAW_MESSAGE, 'Clone', fn([], [RAW_MESSAGE]), (receiver) =>
  receiver === undefined ? undefined : byteSlice(bytesOf(receiver))
);
RAW_MESSAGE.unsupported = new Set(['IsValid', 'Format', 'Compact', 'Indent', 'Canonicalize', 'Kind']);

const DELIM = namedType('json', 'Delim', BASIC.int32);
addMethod(DELIM, 'String', fn([], [STRING]), (receiver) => encodeRune(Number(receiver as bigint)));
const TOKEN = namedType('json', 'Token', ANY);

// Marshal and Unmarshal -----------------------------------------------------------------------------------------------

const MARSHAL_OPTIONS: EncoderOptions = { escapeHTML: true, escapeJS: true, multiline: false, indent: '', prefix: '' };

/** `json.Marshal` with the encoder options: the encoding or the v1 error. */
function marshal(value: Value, options = MARSHAL_OPTIONS): [string, Value] {
  const enc = new EncoderState(options);
  const err = marshalEncode(enc, value);
  if (err) return ['', marshalErrorToGo(err)];
  return [enc.buf, undefined];
}

function unmarshal(data: string, value: Value, uo: UnmarshalOptions): Value {
  const err = unmarshalDecode(new DecoderState(data), value, uo, true);
  return err === undefined ? undefined : unmarshalErrorToGo(value, err);
}

/** `jsontext.AppendFormat` with v1's options for Compact and Indent. */
function appendFormat(src: string, options: EncoderOptions): [string, LibError | undefined] {
  const enc = new EncoderState(options);
  const err = enc.writeValue(src);
  return err ? [src, err] : [enc.buf, undefined];
}

const COMPACT_OPTIONS: EncoderOptions = {
  escapeHTML: false,
  escapeJS: false,
  multiline: false,
  indent: '',
  prefix: '',
};

/** `appendIndent`: the indented form of `src`, or the v1 error. */
function indent(src: string, prefixArg: string, indentArg: string): [string, Value] {
  const fix = trimmedLength(prefixArg) + trimmedLength(indentArg) > 0;
  const prefix = fix ? ' '.repeat(prefixArg.length) : prefixArg;
  const indentText = fix ? ' '.repeat(indentArg.length) : indentArg;
  let [out, err] = appendFormat(src, { ...COMPACT_OPTIONS, multiline: true, prefix, indent: indentText });
  if (err) return ['', syntacticToGo(err)];
  const trailing = /[ \n\r\t]*$/.exec(src)?.[0] ?? '';
  out += trailing;
  if (fix) out = restoreIndentation(out, prefixArg, indentArg);
  return [out, undefined];
}

/** The length of `strings.Trim(text, " \t")`. */
function trimmedLength(text: string): number {
  return text.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '').length;
}

/** Overwrites the spaces after each newline with the prefix and repeated indent, as v1's appendIndent does. */
function restoreIndentation(text: string, prefix: string, indentText: string): string {
  return text.replaceAll(/\n( *)/g, (_, spaces: string) => {
    let fill = prefix.slice(0, spaces.length);
    while (fill.length < spaces.length && indentText.length > 0) {
      fill += indentText.slice(0, spaces.length - fill.length);
    }
    return `\n${fill}${spaces.slice(fill.length)}`;
  });
}

function htmlEscape(src: string): string {
  const hex = '0123456789abcdef';
  let out = '';
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src.charCodeAt(i);
    if (c === 0x3c || c === 0x3e || c === 0x26) {
      out += `${src.slice(start, i)}\\u00${hex[c >> 4]}${hex[c & 15]}`;
      start = i + 1;
    }
    if (c === 0xe2 && i + 2 < src.length && src.charCodeAt(i + 1) === 0x80 && (src.charCodeAt(i + 2) & ~1) === 0xa8) {
      out += `${src.slice(start, i)}\\u202${hex[src.charCodeAt(i + 2) & 15]}`;
      start = i + 3;
    }
  }
  return out + src.slice(start);
}

/** `checkValid`. */
function checkValid(data: string): LibError | undefined {
  const dec = new DecoderState(data);
  const [, err] = dec.readValue({ nonVerbatim: false });
  if (err) {
    if (err === EOF_ERROR) return new SyntacticError(dec.inputOffset() + dec.unreadBuffer().length, '', UNEXPECTED_EOF);
    return err;
  }
  return dec.checkEOF();
}

function writeToBuffer(dst: Value, bytes: string): void {
  if (!(dst instanceof Pointer)) nilPointerPanic();
  callMethod(new Iface(BUFFER_POINTER, dst), 'Write', [byteSlice(bytes)]);
}

// Encoder and Decoder -------------------------------------------------------------------------------------------------

interface EncoderNative {
  writer: Value;
  escapeHTML: boolean;
  prefix: string;
  indent: string;
  err: Value;
  [key: string]: unknown;
}

const ENCODER = opaqueType(namedType('json', 'Encoder', { kind: 'struct', fields: [] }));
const ENCODER_POINTER = pointerTo(ENCODER);

function encoderOf(receiver: Value): EncoderNative {
  return receiverStruct(receiver).native as EncoderNative;
}

addMethod(
  ENCODER,
  'Encode',
  fn([ANY], [ERROR_TYPE]),
  (receiver, [value]) => {
    const enc = encoderOf(receiver);
    if (enc.err !== undefined) return enc.err;
    let [bytes, err] = marshal(value, { ...MARSHAL_OPTIONS, escapeHTML: enc.escapeHTML });
    if (err !== undefined) return err;
    if (enc.prefix.length + enc.indent.length > 0) {
      [bytes, err] = indent(bytes, enc.prefix, enc.indent);
      if (err !== undefined) return err;
    }
    const [, writeErr] = callMethod(enc.writer, 'Write', [byteSlice(`${bytes}\n`)]) as [bigint, Value];
    if (writeErr !== undefined) enc.err = writeErr;
    return writeErr;
  },
  true
);
addMethod(
  ENCODER,
  'SetIndent',
  fn([STRING, STRING], []),
  (receiver, [prefix, indentText]) => {
    const enc = encoderOf(receiver);
    enc.prefix = prefix as string;
    enc.indent = indentText as string;
    return [];
  },
  true
);
addMethod(
  ENCODER,
  'SetEscapeHTML',
  fn([BOOL], []),
  (receiver, [on]) => {
    encoderOf(receiver).escapeHTML = on as boolean;
    return [];
  },
  true
);

interface DecoderNative {
  state: DecoderState;
  options: UnmarshalOptions;
  err: LibError | undefined;
  hadPeeked: boolean;
  hadEOF: boolean;
  [key: string]: unknown;
}

const DECODER = opaqueType(namedType('json', 'Decoder', { kind: 'struct', fields: [] }));
const DECODER_POINTER = pointerTo(DECODER);

function decoderOf(receiver: Value): DecoderNative {
  return receiverStruct(receiver).native as DecoderNative;
}

/** The Go value of a decoder's sticky error. */
function stickyError(err: LibError): Value {
  return err instanceof TextError && err.text === UNEXPECTED_END ? toGoError(UNEXPECTED_EOF) : syntacticToGo(err);
}

addMethod(
  DECODER,
  'Decode',
  fn([ANY], [ERROR_TYPE]),
  (receiver, [value]) => {
    const dec = decoderOf(receiver);
    if (dec.err) return stickyError(dec.err);
    const [raw, err] = dec.state.readValue({ nonVerbatim: false });
    if (err) {
      dec.err = err instanceof SyntacticError && err.err === UNEXPECTED_EOF ? new TextError(UNEXPECTED_END) : err;
      return stickyError(dec.err);
    }
    dec.hadPeeked = false;
    dec.hadEOF = false;
    return unmarshal(raw, value, dec.options);
  },
  true
);
addMethod(
  DECODER,
  'UseNumber',
  fn([], []),
  (receiver) => {
    decoderOf(receiver).options.useNumber = true;
    return [];
  },
  true
);
addMethod(
  DECODER,
  'DisallowUnknownFields',
  fn([], []),
  (receiver) => {
    decoderOf(receiver).options.rejectUnknownMembers = true;
    return [];
  },
  true
);
addMethod(
  DECODER,
  'Buffered',
  fn([], [IO_READER]),
  (receiver) => {
    const newReader = BYTES_PACKAGE.members.get('NewReader') as unknown as {
      direct: (args: Value[]) => Value;
      type: { results: Type[] };
    };
    const reader = newReader.direct([byteSlice(decoderOf(receiver).state.unreadBuffer())]);
    return new Iface(newReader.type.results[0], reader);
  },
  true
);
addMethod(
  DECODER,
  'InputOffset',
  fn([], [INT64]),
  (receiver) => {
    const dec = decoderOf(receiver);
    let offset = dec.state.inputOffset();
    if (dec.hadPeeked || dec.hadEOF) {
      const unread = dec.state.unreadBuffer();
      const trailing = unread.replace(/^[ \n\r\t]+/, '');
      if (trailing.length > 0) {
        offset += unread.length - trailing.length;
        if (dec.hadEOF && (trailing[0] === ',' || trailing[0] === ':')) offset++;
      }
    }
    return BigInt(offset);
  },
  true
);
addMethod(
  DECODER,
  'More',
  fn([], [BOOL]),
  (receiver) => {
    const dec = decoderOf(receiver);
    dec.hadPeeked = true;
    const kind = dec.state.peekKind();
    if (kind === '') {
      if (dec.err === undefined) {
        const [, err] = dec.state.readToken();
        dec.err = err ?? new TextError('json: successful read after failed peek');
        if (dec.err instanceof IoError) dec.err = dec.err.err;
      }
      return dec.err !== EOF_ERROR;
    }
    return kind !== ']' && kind !== '}';
  },
  true
);
addMethod(
  DECODER,
  'Token',
  fn([], [TOKEN, ERROR_TYPE]),
  (receiver) => {
    const dec = decoderOf(receiver);
    if (dec.err) return [undefined, stickyError(dec.err)];
    const [token, err] = dec.state.readToken();
    if (err) {
      if (err instanceof SyntacticError && err.err === UNEXPECTED_EOF) {
        if (dec.state.unreadBuffer().replaceAll(/[ \r\n\t,:]/g, '').length === 0) {
          dec.hadEOF = true;
          return [undefined, toGoError(EOF_ERROR)];
        }
        return [undefined, toGoError(UNEXPECTED_EOF)];
      }
      return [undefined, syntacticToGo(err)];
    }
    dec.hadPeeked = false;
    dec.hadEOF = false;
    return tokenValue(dec, token.kind, token.raw ?? '');
  },
  true
);

/** The `Token` result for a token: its Go value and any error. */
function tokenValue(dec: DecoderNative, kind: string, raw: string): [Value, Value] {
  switch (kind) {
    case 'n': {
      return [undefined, undefined];
    }
    case 'f':
    case 't': {
      return [new Iface(BOOL, kind === 't'), undefined];
    }
    case '"': {
      return [new Iface(STRING, unquote(raw)[0]), undefined];
    }
    case '0': {
      if (dec.options.useNumber) return [new Iface(NUMBER, raw), undefined];
      const [value, err] = parseFloat(raw, 64);
      if (err !== undefined) {
        const offset = BigInt(dec.state.inputOffset());
        const fields = [`number ${raw}`, reflectType(FLOAT64), offset, '', '', undefined];
        return [
          undefined,
          new Iface(pointerTo(UNMARSHAL_TYPE_ERROR), new Pointer(new Cell(new GoStruct(fields)), 'v')),
        ];
      }
      return [new Iface(FLOAT64, value), undefined];
    }
    default: {
      return [new Iface(DELIM, BigInt(kind.charCodeAt(0))), undefined];
    }
  }
}

function newEncoder(writer: Value): Pointer {
  const native: EncoderNative = { writer, escapeHTML: true, prefix: '', indent: '', err: undefined };
  return new Pointer(new Cell(new GoStruct([], native)), 'v');
}

function newDecoder(reader: Value): Pointer {
  const native: DecoderNative = {
    state: new DecoderState('', reader),
    options: { useNumber: false, rejectUnknownMembers: false },
    err: undefined,
    hadPeeked: false,
    hadEOF: false,
  };
  return new Pointer(new Cell(new GoStruct([], native)), 'v');
}

// Package ---------------------------------------------------------------------------------------------------------------

const members: Record<string, Entity> = {
  Marshal: nativeFunction('Marshal', fn([ANY], [BYTES, ERROR_TYPE]), ([value]) => {
    const [bytes, err] = marshal(value);
    return err === undefined ? [byteSlice(bytes), undefined] : [undefined, err];
  }),
  MarshalIndent: nativeFunction(
    'MarshalIndent',
    fn([ANY, STRING, STRING], [BYTES, ERROR_TYPE]),
    ([value, prefix, indentText]) => {
      let [bytes, err] = marshal(value);
      if (err !== undefined) return [undefined, err];
      [bytes, err] = indent(bytes, prefix as string, indentText as string);
      return err === undefined ? [byteSlice(bytes), undefined] : [undefined, err];
    }
  ),
  Unmarshal: nativeFunction('Unmarshal', fn([BYTES, ANY], [ERROR_TYPE]), ([data, value]) =>
    unmarshal(bytesOf(data), value, { useNumber: false, rejectUnknownMembers: false })
  ),
  Valid: nativeFunction('Valid', fn([BYTES], [BOOL]), ([data]) => checkValid(bytesOf(data)) === undefined),
  Compact: nativeFunction('Compact', fn([BUFFER_POINTER, BYTES], [ERROR_TYPE]), ([dst, src]) => {
    const [out, err] = appendFormat(bytesOf(src), COMPACT_OPTIONS);
    if (err) return syntacticToGo(err);
    writeToBuffer(dst, out);
    return;
  }),
  Indent: nativeFunction(
    'Indent',
    fn([BUFFER_POINTER, BYTES, STRING, STRING], [ERROR_TYPE]),
    ([dst, src, prefix, indentText]) => {
      const [out, err] = indent(bytesOf(src), prefix as string, indentText as string);
      writeToBuffer(dst, out);
      return err;
    }
  ),
  HTMLEscape: nativeFunction('HTMLEscape', fn([BUFFER_POINTER, BYTES], []), ([dst, src]) => {
    writeToBuffer(dst, htmlEscape(bytesOf(src)));
    return [];
  }),
  NewEncoder: nativeFunction('NewEncoder', fn([IO_WRITER], [ENCODER_POINTER]), ([writer]) => newEncoder(writer)),
  NewDecoder: nativeFunction('NewDecoder', fn([IO_READER], [DECODER_POINTER]), ([reader]) => newDecoder(reader)),
  Encoder: typeEntity(ENCODER),
  Decoder: typeEntity(DECODER),
  Marshaler: typeEntity(MARSHALER),
  Unmarshaler: typeEntity(UNMARSHALER),
  Number: typeEntity(NUMBER),
  RawMessage: { kind: 'type', name: 'RawMessage', type: RAW_MESSAGE },
  Delim: typeEntity(DELIM),
  Token: typeEntity(TOKEN),
  SyntaxError: typeEntity(SYNTAX_ERROR),
  UnmarshalTypeError: typeEntity(UNMARSHAL_TYPE_ERROR),
  InvalidUnmarshalError: typeEntity(INVALID_UNMARSHAL_ERROR),
  UnsupportedTypeError: typeEntity(UNSUPPORTED_TYPE_ERROR),
  UnsupportedValueError: typeEntity(UNSUPPORTED_VALUE_ERROR),
  MarshalerError: typeEntity(MARSHALER_ERROR),
  InvalidUTF8Error: typeEntity(INVALID_UTF8_ERROR),
  UnmarshalFieldError: typeEntity(UNMARSHAL_FIELD_ERROR),
};

export const JSON_PACKAGE = definePackage('encoding/json', members, [
  'Options',
  'DefaultOptionsV1',
  'CallMethodsWithLegacySemantics',
  'FormatByteArrayAsArray',
  'FormatBytesWithLegacySemantics',
  'FormatDurationAsNano',
  'MatchCaseSensitiveDelimiter',
  'MergeWithLegacySemantics',
  'OmitEmptyWithLegacySemantics',
  'ParseBytesWithLooseRFC4648',
  'ParseTimeWithLooseRFC3339',
  'ReportErrorsWithLegacySemantics',
  'StringifyWithLegacySemantics',
  'UnmarshalArrayFromAnyLength',
]);
