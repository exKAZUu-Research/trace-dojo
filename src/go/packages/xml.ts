// oxlint-disable unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import type { Entity } from '../entities';
import { mapKeyOf } from '../equality';
import { newError } from '../errorValues';
import { encodeRune } from '../literals';
import { addMethod, currentRuntime, definePackage, fn, nativeFunction, typeEntity } from '../native';
import { quote } from '../quote';
import { ANY, BASIC, ERROR_TYPE, pointerTo, sliceOf } from '../types';
import { Cell, GoMap, GoStruct, Iface, Pointer, Slice, type Value } from '../values';
import { IO_READER, IO_WRITER, libraryVariable } from './io';
import { byteSlice, bytesOf, callMethod, INT, receiverStruct, STRING } from './support';
import { type ByteSource, sourceOf, StringSource, XmlDecoder } from './xmlDecoder';
import { escapePieces, goWriter, Printer } from './xmlMarshal';
import { HTML_ENTITIES } from './xmlTables';
import {
  ATTR,
  CHAR_DATA,
  COMMENT,
  DECODER,
  DIRECTIVE,
  ENCODER,
  END_ELEMENT,
  MARSHALER,
  MARSHALER_ATTR,
  NAME,
  PROC_INST,
  START_ELEMENT,
  SYNTAX_ERROR,
  TAG_PATH_ERROR,
  TOKEN,
  TOKEN_READER,
  tokenFromGo,
  tokenToGo,
  UNMARSHAL_ERROR,
  UNMARSHALER,
  UNMARSHALER_ATTR,
  UNSUPPORTED_TYPE_ERROR,
  type XToken,
} from './xmlTypes';
import { XmlUnmarshaler } from './xmlUnmarshal';

const BYTES = sliceOf(BASIC.uint8);
const ENCODER_POINTER = pointerTo(ENCODER);
const DECODER_POINTER = pointerTo(DECODER);

// Token methods -------------------------------------------------------------------------------------------------------

function copyBytes(value: Value): Value {
  return value === undefined ? undefined : byteSlice(bytesOf(value));
}

addMethod(START_ELEMENT, 'Copy', fn([], [START_ELEMENT]), (receiver) => {
  const [name, attr] = (receiver as GoStruct).fields;
  const attrs = ((attr as Slice | undefined)?.values() ?? []).map((a) => {
    const [attrName, value] = (a as GoStruct).fields;
    return new GoStruct([new GoStruct([...(attrName as GoStruct).fields]), value]);
  });
  return new GoStruct([new GoStruct([...(name as GoStruct).fields]), new Slice(attrs, 0, attrs.length, attrs.length)]);
});
addMethod(START_ELEMENT, 'End', fn([], [END_ELEMENT]), (receiver) => {
  const [name] = (receiver as GoStruct).fields;
  return new GoStruct([new GoStruct([...(name as GoStruct).fields])]);
});
for (const type of [CHAR_DATA, COMMENT, DIRECTIVE]) addMethod(type, 'Copy', fn([], [type]), copyBytes);
addMethod(PROC_INST, 'Copy', fn([], [PROC_INST]), (receiver) => {
  const [target, inst] = (receiver as GoStruct).fields;
  return new GoStruct([target, copyBytes(inst)]);
});

function copyToken(token: Value): Value {
  const decoded = tokenFromGo(token);
  if (decoded === undefined) return token;
  return tokenToGo(decoded);
}

addMethod(
  TAG_PATH_ERROR,
  'Error',
  fn([], [STRING]),
  (receiver) => {
    const [struct, field1, tag1, field2, tag2] = receiverStruct(receiver).fields as [
      Value,
      string,
      string,
      string,
      string,
    ];
    const typeText = struct === undefined ? '%!s(<nil>)' : (callMethod(struct, 'String') as string);
    return `${typeText} field ${quote(field1)} with tag ${quote(tag1)} conflicts with field ${quote(field2)} with tag ${quote(tag2)}`;
  },
  true
);

// Encoder -------------------------------------------------------------------------------------------------------------

function printerOf(receiver: Value): Printer {
  return (receiverStruct(receiver).native as { printer: Printer }).printer;
}

function newEncoder(writer: Value): Pointer {
  const printer = new Printer(goWriter(writer));
  const pointer = new Pointer(new Cell(new GoStruct([], { printer })), 'v');
  printer.encoder = pointer;
  return pointer;
}

function encode(printer: Printer, value: Value, start: XToken | undefined): Value {
  const iface = value as Iface | undefined;
  const val = iface === undefined ? undefined : { type: iface.type, value: iface.value, readOnly: false };
  const err = printer.marshalValue(val, undefined, start);
  if (err !== undefined) return err;
  return printer.w.flush();
}

addMethod(
  ENCODER,
  'Encode',
  fn([ANY], [ERROR_TYPE]),
  (receiver, [value]) => encode(printerOf(receiver), value, undefined),
  true
);
addMethod(
  ENCODER,
  'EncodeElement',
  fn([ANY, START_ELEMENT], [ERROR_TYPE]),
  (receiver, [value, start]) => encode(printerOf(receiver), value, tokenFromGo(new Iface(START_ELEMENT, start))),
  true
);
addMethod(
  ENCODER,
  'EncodeToken',
  fn([TOKEN], [ERROR_TYPE]),
  (receiver, [token]) => printerOf(receiver).encodeToken(tokenFromGo(token)),
  true
);
addMethod(ENCODER, 'Flush', fn([], [ERROR_TYPE]), (receiver) => printerOf(receiver).w.flush(), true);
addMethod(ENCODER, 'Close', fn([], [ERROR_TYPE]), (receiver) => printerOf(receiver).close(), true);
addMethod(
  ENCODER,
  'Indent',
  fn([STRING, STRING], []),
  (receiver, [prefix, indent]) => {
    const printer = printerOf(receiver);
    printer.prefix = prefix as string;
    printer.indent = indent as string;
    return [];
  },
  true
);

/** Marshal and MarshalIndent: encodes into memory and closes the encoder. */
function marshal(value: Value, prefix: string, indent: string): Value[] {
  let out = '';
  const printer = new Printer((bytes) => {
    currentRuntime().checkStringLength(out.length + bytes.length);
    out += bytes;
    return [bytes.length, undefined];
  });
  printer.encoder = new Pointer(new Cell(new GoStruct([], { printer })), 'v');
  printer.prefix = prefix;
  printer.indent = indent;
  const err = encode(printer, value, undefined) ?? printer.close();
  if (err !== undefined) return [undefined, err];
  return [byteSlice(out), undefined];
}

// Decoder -------------------------------------------------------------------------------------------------------------

interface DecoderNative {
  decoder: XmlDecoder;
  unmarshaler: XmlUnmarshaler;
  [key: string]: unknown;
}

function newDecoder(source: ByteSource | undefined, tokenReader?: Value): Pointer {
  const struct = new GoStruct([true, undefined, undefined, undefined, '']);
  const pointer = new Pointer(new Cell(struct), 'v');
  const decoder = new XmlDecoder(struct, source, tokenReader);
  struct.native = { decoder, unmarshaler: new XmlUnmarshaler(decoder, pointer) } satisfies DecoderNative;
  return pointer;
}

function decoderOf(receiver: Value): DecoderNative {
  return receiverStruct(receiver).native as DecoderNative;
}

function startFrom(value: Value): Extract<XToken, { kind: 'start' }> | undefined {
  if (!(value instanceof Pointer)) return undefined;
  return tokenFromGo(new Iface(START_ELEMENT, value.load())) as Extract<XToken, { kind: 'start' }>;
}

addMethod(
  DECODER,
  'Decode',
  fn([ANY], [ERROR_TYPE]),
  (receiver, [value]) => decoderOf(receiver).unmarshaler.decodeElement(value, undefined),
  true
);
addMethod(
  DECODER,
  'DecodeElement',
  fn([ANY, pointerTo(START_ELEMENT)], [ERROR_TYPE]),
  (receiver, [value, start]) => decoderOf(receiver).unmarshaler.decodeElement(value, startFrom(start)),
  true
);
addMethod(
  DECODER,
  'Token',
  fn([], [TOKEN, ERROR_TYPE]),
  (receiver) => {
    const [token, err] = decoderOf(receiver).decoder.token();
    return [token === undefined ? undefined : tokenToGo(token), err];
  },
  true
);
addMethod(
  DECODER,
  'RawToken',
  fn([], [TOKEN, ERROR_TYPE]),
  (receiver) => {
    const { decoder } = decoderOf(receiver);
    if (decoder.inUnmarshalXML) return [undefined, RAW_TOKEN_ERROR];
    const [token, err] = decoder.rawToken();
    return [token === undefined ? undefined : tokenToGo(token), err];
  },
  true
);
addMethod(DECODER, 'Skip', fn([], [ERROR_TYPE]), (receiver) => decoderOf(receiver).unmarshaler.skip(), true);
addMethod(
  DECODER,
  'InputOffset',
  fn([], [BASIC.int64]),
  (receiver) => BigInt(decoderOf(receiver).decoder.offset),
  true
);
addMethod(
  DECODER,
  'InputPos',
  fn([], [INT, INT]),
  (receiver) => decoderOf(receiver).decoder.inputPos().map(BigInt),
  true
);

const RAW_TOKEN_ERROR = newError('xml: cannot use RawToken from UnmarshalXML method');

// Package ---------------------------------------------------------------------------------------------------------------

const HEADER = '<?xml version="1.0" encoding="UTF-8"?>\n';

function htmlEntityMap(): GoMap {
  const keyOf = mapKeyOf(BASIC.string);
  const map = new GoMap(keyOf);
  for (const [name, code] of HTML_ENTITIES) map.entries.set(keyOf(name), { key: name, value: encodeRune(code) });
  return map;
}

const HTML_AUTO_CLOSE = [
  'basefont',
  'br',
  'area',
  'link',
  'img',
  'param',
  'hr',
  'input',
  'col',
  'frame',
  'isindex',
  'base',
  'meta',
];

/** `EscapeText`, writing each piece with its own Write call as Go does. */
function escapeTextTo(writer: Value, s: string): Value {
  for (const piece of escapePieces(s, true)) {
    const [, err] = callMethod(writer, 'Write', [byteSlice(piece)]) as [bigint, Value];
    if (err !== undefined) return err;
  }
  return undefined;
}

const members: Record<string, Entity> = {
  Header: {
    kind: 'const',
    name: 'Header',
    type: BASIC.untypedString,
    value: { kind: 'string', value: HEADER },
    span: { row: 0, column: 0 },
    used: true,
  },
  HTMLEntity: libraryVariable('HTMLEntity', { kind: 'map', key: STRING, value: STRING }, htmlEntityMap()),
  HTMLAutoClose: libraryVariable(
    'HTMLAutoClose',
    sliceOf(STRING),
    new Slice(HTML_AUTO_CLOSE, 0, HTML_AUTO_CLOSE.length, HTML_AUTO_CLOSE.length)
  ),
  Marshal: nativeFunction('Marshal', fn([ANY], [BYTES, ERROR_TYPE]), ([value]) => marshal(value, '', '')),
  MarshalIndent: nativeFunction(
    'MarshalIndent',
    fn([ANY, STRING, STRING], [BYTES, ERROR_TYPE]),
    ([value, prefix, indent]) => marshal(value, prefix as string, indent as string)
  ),
  Unmarshal: nativeFunction('Unmarshal', fn([BYTES, ANY], [ERROR_TYPE]), ([data, value]) => {
    const pointer = newDecoder(new StringSource(bytesOf(data)));
    return decoderOf(pointer).unmarshaler.decodeElement(value, undefined);
  }),
  NewEncoder: nativeFunction('NewEncoder', fn([IO_WRITER], [ENCODER_POINTER]), ([writer]) => newEncoder(writer)),
  NewDecoder: nativeFunction('NewDecoder', fn([IO_READER], [DECODER_POINTER]), ([reader]) => {
    return newDecoder(sourceOf(reader));
  }),
  NewTokenDecoder: nativeFunction('NewTokenDecoder', fn([TOKEN_READER], [DECODER_POINTER]), ([reader]) => {
    const iface = reader as Iface;
    if (iface !== undefined && iface.type.kind === 'pointer' && iface.type.element === DECODER) return iface.value;
    return newDecoder(undefined, reader);
  }),
  EscapeText: nativeFunction('EscapeText', fn([IO_WRITER, BYTES], [ERROR_TYPE]), ([writer, s]) =>
    escapeTextTo(writer, bytesOf(s))
  ),
  Escape: nativeFunction('Escape', fn([IO_WRITER, BYTES], []), ([writer, s]) => {
    escapeTextTo(writer, bytesOf(s));
    return [];
  }),
  CopyToken: nativeFunction('CopyToken', fn([TOKEN], [TOKEN]), ([token]) => copyToken(token)),
  Name: typeEntity(NAME),
  Attr: typeEntity(ATTR),
  StartElement: typeEntity(START_ELEMENT),
  EndElement: typeEntity(END_ELEMENT),
  CharData: typeEntity(CHAR_DATA),
  Comment: typeEntity(COMMENT),
  ProcInst: typeEntity(PROC_INST),
  Directive: typeEntity(DIRECTIVE),
  Token: typeEntity(TOKEN),
  TokenReader: typeEntity(TOKEN_READER),
  Marshaler: typeEntity(MARSHALER),
  Unmarshaler: typeEntity(UNMARSHALER),
  MarshalerAttr: typeEntity(MARSHALER_ATTR),
  UnmarshalerAttr: typeEntity(UNMARSHALER_ATTR),
  Encoder: typeEntity(ENCODER),
  Decoder: typeEntity(DECODER),
  SyntaxError: typeEntity(SYNTAX_ERROR),
  UnmarshalError: typeEntity(UNMARSHAL_ERROR),
  UnsupportedTypeError: typeEntity(UNSUPPORTED_TYPE_ERROR),
  TagPathError: typeEntity(TAG_PATH_ERROR),
};

export const XML_PACKAGE = definePackage('encoding/xml', members);
