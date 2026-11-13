import { newError } from '../errorValues';
import { addMethod, fn, namedType, opaqueType } from '../native';
import { ANY, BASIC, ERROR_TYPE, funcType, type NamedType, pointerTo, sliceOf, type Type } from '../types';
import { Cell, GoStruct, Iface, Pointer, Slice, type Value } from '../values';
import { IO_READER } from './io';
import { REFLECT_TYPE, reflectType } from './jsonErrors';
import { byteSlice, bytesOf, callMethod, receiverStruct, sliceValues, STRING } from './support';

const BYTES = sliceOf(BASIC.uint8);

// Tokens ----------------------------------------------------------------------------------------------------------------

export interface XName {
  space: string;
  local: string;
}

export interface XAttr {
  name: XName;
  value: string;
}

/** A token of the XML stream, as the decoder and encoder handle it internally. */
export type XToken =
  | { kind: 'start'; name: XName; attr: XAttr[] }
  | { kind: 'end'; name: XName }
  | { kind: 'chardata' | 'comment' | 'directive'; data: string }
  | { kind: 'procinst'; target: string; inst: string };

export const NAME = namedType('xml', 'Name', {
  kind: 'struct',
  fields: [
    { name: 'Space', type: STRING, embedded: false },
    { name: 'Local', type: STRING, embedded: false },
  ],
});
export const ATTR = namedType('xml', 'Attr', {
  kind: 'struct',
  fields: [
    { name: 'Name', type: NAME, embedded: false },
    { name: 'Value', type: STRING, embedded: false },
  ],
});
export const START_ELEMENT = namedType('xml', 'StartElement', {
  kind: 'struct',
  fields: [
    { name: 'Name', type: NAME, embedded: false },
    { name: 'Attr', type: sliceOf(ATTR), embedded: false },
  ],
});
export const END_ELEMENT = namedType('xml', 'EndElement', {
  kind: 'struct',
  fields: [{ name: 'Name', type: NAME, embedded: false }],
});
export const CHAR_DATA = namedType('xml', 'CharData', BYTES);
export const COMMENT = namedType('xml', 'Comment', BYTES);
export const DIRECTIVE = namedType('xml', 'Directive', BYTES);
export const PROC_INST = namedType('xml', 'ProcInst', {
  kind: 'struct',
  fields: [
    { name: 'Target', type: STRING, embedded: false },
    { name: 'Inst', type: BYTES, embedded: false },
  ],
});
export const TOKEN = namedType('xml', 'Token', ANY);
export const TOKEN_READER = namedType('xml', 'TokenReader', {
  kind: 'interface',
  methods: [{ name: 'Token', type: fn([], [TOKEN, ERROR_TYPE]) }],
});

export function nameToGo(name: XName): GoStruct {
  return new GoStruct([name.space, name.local]);
}

export function nameFromGo(value: Value): XName {
  const [space, local] = (value as GoStruct).fields as [string, string];
  return { space, local };
}

export function attrsToGo(attrs: XAttr[]): Slice {
  const values = attrs.map((attr) => new GoStruct([nameToGo(attr.name), attr.value]));
  return new Slice(values, 0, values.length, values.length);
}

export function attrsFromGo(value: Value): XAttr[] {
  return sliceValues(value).map((attr) => {
    const [name, text] = (attr as GoStruct).fields;
    return { name: nameFromGo(name), value: text as string };
  });
}

/** The Go value of a token, as `Token` returns it. */
export function tokenToGo(token: XToken): Value {
  switch (token.kind) {
    case 'start': {
      return new Iface(START_ELEMENT, new GoStruct([nameToGo(token.name), attrsToGo(token.attr)]));
    }
    case 'end': {
      return new Iface(END_ELEMENT, new GoStruct([nameToGo(token.name)]));
    }
    case 'chardata': {
      return new Iface(CHAR_DATA, byteSlice(token.data));
    }
    case 'comment': {
      return new Iface(COMMENT, byteSlice(token.data));
    }
    case 'directive': {
      return new Iface(DIRECTIVE, byteSlice(token.data));
    }
    case 'procinst': {
      return new Iface(PROC_INST, new GoStruct([token.target, byteSlice(token.inst)]));
    }
  }
}

/** The token a Go token value holds, or undefined for a value of another type. */
export function tokenFromGo(value: Value): XToken | undefined {
  if (!(value instanceof Iface)) return undefined;
  const { type } = value;
  if (type === START_ELEMENT) {
    const [name, attr] = (value.value as GoStruct).fields;
    return { kind: 'start', name: nameFromGo(name), attr: attrsFromGo(attr) };
  }
  if (type === END_ELEMENT) return { kind: 'end', name: nameFromGo((value.value as GoStruct).fields[0]) };
  if (type === CHAR_DATA) return { kind: 'chardata', data: bytesOf(value.value) };
  if (type === COMMENT) return { kind: 'comment', data: bytesOf(value.value) };
  if (type === DIRECTIVE) return { kind: 'directive', data: bytesOf(value.value) };
  if (type === PROC_INST) {
    const [target, inst] = (value.value as GoStruct).fields;
    return { kind: 'procinst', target: target as string, inst: bytesOf(inst) };
  }
  return undefined;
}

// Encoder, Decoder, and the method interfaces ---------------------------------------------------------------------------

export const ENCODER = opaqueType(namedType('xml', 'Encoder', { kind: 'struct', fields: [] }));
/** `xml.Decoder`, whose exported fields programs set and whose state the library keeps in `native`. */
export const DECODER = opaqueType(
  namedType('xml', 'Decoder', {
    kind: 'struct',
    fields: [
      { name: 'Strict', type: BASIC.bool, embedded: false },
      { name: 'AutoClose', type: sliceOf(STRING), embedded: false },
      { name: 'Entity', type: { kind: 'map', key: STRING, value: STRING }, embedded: false },
      {
        name: 'CharsetReader',
        type: funcType([STRING, IO_READER], [IO_READER, ERROR_TYPE]),
        embedded: false,
      },
      { name: 'DefaultSpace', type: STRING, embedded: false },
    ],
  })
);

export const MARSHALER = namedType('xml', 'Marshaler', {
  kind: 'interface',
  methods: [{ name: 'MarshalXML', type: fn([pointerTo(ENCODER), START_ELEMENT], [ERROR_TYPE]) }],
});
export const UNMARSHALER = namedType('xml', 'Unmarshaler', {
  kind: 'interface',
  methods: [{ name: 'UnmarshalXML', type: fn([pointerTo(DECODER), START_ELEMENT], [ERROR_TYPE]) }],
});
export const MARSHALER_ATTR = namedType('xml', 'MarshalerAttr', {
  kind: 'interface',
  methods: [{ name: 'MarshalXMLAttr', type: fn([NAME], [ATTR, ERROR_TYPE]) }],
});
export const UNMARSHALER_ATTR = namedType('xml', 'UnmarshalerAttr', {
  kind: 'interface',
  methods: [{ name: 'UnmarshalXMLAttr', type: fn([ATTR], [ERROR_TYPE]) }],
});

// Errors ----------------------------------------------------------------------------------------------------------------

export const SYNTAX_ERROR = namedType('xml', 'SyntaxError', {
  kind: 'struct',
  fields: [
    { name: 'Msg', type: STRING, embedded: false },
    { name: 'Line', type: BASIC.int, embedded: false },
  ],
});
addMethod(
  SYNTAX_ERROR,
  'Error',
  fn([], [STRING]),
  (receiver) => {
    const [msg, line] = receiverStruct(receiver).fields as [string, bigint];
    return `XML syntax error on line ${line}: ${msg}`;
  },
  true
);

export const UNMARSHAL_ERROR = namedType('xml', 'UnmarshalError', STRING);
addMethod(UNMARSHAL_ERROR, 'Error', fn([], [STRING]), (receiver) => receiver);

export const UNSUPPORTED_TYPE_ERROR = namedType('xml', 'UnsupportedTypeError', {
  kind: 'struct',
  fields: [{ name: 'Type', type: REFLECT_TYPE, embedded: false }],
});
addMethod(
  UNSUPPORTED_TYPE_ERROR,
  'Error',
  fn([], [STRING]),
  (receiver) => `xml: unsupported type: ${callMethod(receiverStruct(receiver).fields[0], 'String') as string}`,
  true
);

export const TAG_PATH_ERROR = namedType('xml', 'TagPathError', {
  kind: 'struct',
  fields: [
    { name: 'Struct', type: REFLECT_TYPE, embedded: false },
    { name: 'Field1', type: STRING, embedded: false },
    { name: 'Tag1', type: STRING, embedded: false },
    { name: 'Field2', type: STRING, embedded: false },
    { name: 'Tag2', type: STRING, embedded: false },
  ],
});

function pointerError(type: NamedType, fields: Value[]): Value {
  return new Iface(pointerTo(type), new Pointer(new Cell(new GoStruct(fields)), 'v'));
}

export function syntaxError(msg: string, line: number): Value {
  return pointerError(SYNTAX_ERROR, [msg, BigInt(line)]);
}

export function unsupportedTypeError(type: Type): Value {
  return pointerError(UNSUPPORTED_TYPE_ERROR, [reflectType(type)]);
}

export function tagPathError(type: Type, field1: string, field2: string): Value {
  return pointerError(TAG_PATH_ERROR, [reflectType(type), field1, '', field2, '']);
}

export function plainError(text: string): Value {
  return newError(text);
}
