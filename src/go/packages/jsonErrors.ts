import { newError } from '../errorValues';
import { addMethod, fn, namedType, opaqueType } from '../native';
import { quote } from '../quote';
import {
  BASIC,
  ERROR_TYPE,
  type NamedType,
  pointerTo,
  type PointerType,
  type Type,
  typeString,
  underlying,
} from '../types';
import { Cell, GoStruct, Iface, Pointer, type Value } from '../values';
import { EOF, ERR_UNEXPECTED_EOF } from './io';
import {
  ERR_CYCLE,
  ERR_NIL_INTERFACE,
  ERR_NON_NIL_REFERENCE,
  ERR_UNKNOWN_NAME,
  MarshalerError,
  SemanticError,
} from './jsonArshal';
import { IoError, pointerLastToken, SyntacticError } from './jsonText';
import {
  EOF_ERROR,
  GoValueError,
  type LibError,
  STRCONV_RANGE,
  STRCONV_SYNTAX,
  UNEXPECTED_EOF,
  unquote,
} from './jsonWire';
import { kindOf, typeName } from './reflection';
import { STRCONV_PACKAGE } from './strconv';
import { errorText, receiverStruct, STRING } from './support';

const INT64 = BASIC.int64;

// reflect -------------------------------------------------------------------------------------------------------------

/** `reflect.Type`, of which error types hold values; the library implements `String`. */
export const REFLECT_TYPE = namedType('reflect', 'Type', {
  kind: 'interface',
  methods: [{ name: 'String', type: fn([], [STRING]) }],
});
const RTYPE = opaqueType(namedType('reflect', 'rtype', { kind: 'struct', fields: [] }));
addMethod(
  RTYPE,
  'String',
  fn([], [STRING]),
  (receiver) => typeString((receiverStruct(receiver).native as { type: Type }).type),
  true
);
addMethod(
  RTYPE,
  'Name',
  fn([], [STRING]),
  (receiver) => typeName((receiverStruct(receiver).native as { type: Type }).type),
  true
);
/** `reflect.Value`, which `UnsupportedValueError` holds. */
export const REFLECT_VALUE = opaqueType(namedType('reflect', 'Value', { kind: 'struct', fields: [] }));
/** `reflect.StructField`, which `UnmarshalFieldError` holds. */
const REFLECT_STRUCT_FIELD = opaqueType(namedType('reflect', 'StructField', { kind: 'struct', fields: [] }));

/** A `reflect.Type` value for a type, or nil. */
export function reflectType(type: Type | undefined): Value {
  if (type === undefined) return undefined;
  return new Iface(pointerTo(RTYPE), new Pointer(new Cell(new GoStruct([], { type })), 'v'));
}

function reflectTypeString(value: Value): string {
  return value === undefined ? '<nil>' : errorTextOf(value, 'String');
}

function errorTextOf(value: Value, method: string): string {
  const iface = value as Iface;
  const struct = (iface.value as Pointer).load() as GoStruct;
  if (method === 'String' && struct.native) return typeString((struct.native as { type: Type }).type);
  return errorText(value);
}

function newPointerError(type: NamedType, fields: Value[]): Value {
  return new Iface(pointerTo(type), new Pointer(new Cell(new GoStruct(fields)), 'v'));
}

function errorType(
  name: string,
  fields: [string, Type][],
  error: (fields: Value[]) => string,
  unwrap?: number
): NamedType {
  const type = namedType('json', name, {
    kind: 'struct',
    fields: fields.map(([fieldName, fieldType]) => ({ name: fieldName, type: fieldType, embedded: false })),
  });
  addMethod(type, 'Error', fn([], [STRING]), (receiver) => error(receiverStruct(receiver).fields), true);
  if (unwrap !== undefined) {
    addMethod(type, 'Unwrap', fn([], [ERROR_TYPE]), (receiver) => receiverStruct(receiver).fields[unwrap], true);
  }
  return type;
}

// v1 error types --------------------------------------------------------------------------------------------------------

export const SYNTAX_ERROR = errorType(
  'SyntaxError',
  [
    ['msg', STRING],
    ['Offset', INT64],
  ],
  (fields) => fields[0] as string
);

export const UNMARSHAL_TYPE_ERROR = errorType(
  'UnmarshalTypeError',
  [
    ['Value', STRING],
    ['Type', REFLECT_TYPE],
    ['Offset', INT64],
    ['Struct', STRING],
    ['Field', STRING],
    ['Err', ERROR_TYPE],
  ],
  ([value, type, , struct, field, err]) => {
    const typeText = reflectTypeString(type);
    let text: string;
    if (struct !== '' || field !== '') {
      let intoWhat = 'Go struct field ';
      const fieldText = field as string;
      const last = fieldText.slice(fieldText.lastIndexOf('.') + 1);
      if (last.length > 0 && /^\d+$/.test(last)) intoWhat = '';
      text = `json: cannot unmarshal ${value as string} into ${intoWhat}${struct as string}.${fieldText} of type ${typeText}`;
    } else {
      text = `json: cannot unmarshal ${value as string} into Go value of type ${typeText}`;
    }
    if (err !== undefined) text += `: ${errorText(err)}`;
    return text;
  },
  5
);

export const INVALID_UNMARSHAL_ERROR = errorType('InvalidUnmarshalError', [['Type', REFLECT_TYPE]], ([type]) => {
  if (type === undefined) return 'json: Unmarshal(nil)';
  const native = ((type as Iface).value as Pointer).load() as GoStruct;
  const goType = (native.native as { type: Type }).type;
  if (kindOf(goType) !== 'pointer') return `json: Unmarshal(non-pointer ${typeString(goType)})`;
  return `json: Unmarshal(nil ${typeString(goType)})`;
});

export const UNSUPPORTED_TYPE_ERROR = errorType(
  'UnsupportedTypeError',
  [['Type', REFLECT_TYPE]],
  ([type]) => `json: unsupported type: ${reflectTypeString(type)}`
);

export const UNSUPPORTED_VALUE_ERROR = errorType(
  'UnsupportedValueError',
  [
    ['Value', REFLECT_VALUE],
    ['Str', STRING],
  ],
  ([, str]) => `json: unsupported value: ${str as string}`
);

export const MARSHALER_ERROR = errorType(
  'MarshalerError',
  [
    ['Type', REFLECT_TYPE],
    ['Err', ERROR_TYPE],
    ['sourceFunc', STRING],
  ],
  ([type, err, sourceFunc]) =>
    `json: error calling ${(sourceFunc as string) || 'MarshalJSON'} for type ${reflectTypeString(type)}: ${errorText(err)}`,
  1
);

export const INVALID_UTF8_ERROR = errorType(
  'InvalidUTF8Error',
  [['S', STRING]],
  ([s]) => `json: invalid UTF-8 in string: ${quote(s as string)}`
);

export const UNMARSHAL_FIELD_ERROR = errorType(
  'UnmarshalFieldError',
  [
    ['Key', STRING],
    ['Type', REFLECT_TYPE],
    ['Field', REFLECT_STRUCT_FIELD],
  ],
  ([key, type]) =>
    `json: cannot unmarshal object key ${quote(key as string)} into unexported field of type ${reflectTypeString(type)}`
);

// Transforming v2 errors into v1 errors ---------------------------------------------------------------------------------

const STRCONV_ERR_SYNTAX = libraryValue('ErrSyntax');
const STRCONV_ERR_RANGE = libraryValue('ErrRange');

function libraryValue(name: string): Value {
  const entity = STRCONV_PACKAGE.members.get(name) as { library: () => Value };
  return entity.library();
}

const REPLACEMENTS: [string, string][] = [
  ['object name', 'object key'],
  ['at start of value', 'looking for beginning of value'],
  ['at start of string', 'looking for beginning of object key string'],
  ['after object value', 'after object key:value pair'],
  ['in number', 'in numeric literal'],
];

/** `strings.NewReplacer(...).Replace` with v1's syntax error wording. */
function replaceWording(text: string): string {
  let out = '';
  for (let i = 0; i < text.length;) {
    const match = REPLACEMENTS.find(([old]) => text.startsWith(old, i));
    if (match) {
      out += match[1];
      i += match[0].length;
    } else {
      out += text[i];
      i++;
    }
  }
  return out;
}

export const UNEXPECTED_END = 'unexpected end of JSON input';

/** `transformSyntacticError`, then the Go value of the error. */
export function syntacticToGo(err: LibError): Value {
  if (err instanceof SyntacticError) {
    if (err.err instanceof IoError) return toGoError(err.err.err);
    let msg = err.err === UNEXPECTED_EOF ? UNEXPECTED_END : err.err.message();
    const cut = msg.indexOf(' (expecting');
    if (cut !== -1 && !msg.includes(' in literal')) msg = msg.slice(0, cut);
    return newPointerError(SYNTAX_ERROR, [replaceWording(msg), BigInt(err.offset)]);
  }
  if (err instanceof IoError) return toGoError(err.err);
  return toGoError(err);
}

/** The Go value of an error the library passes along unchanged. */
export function toGoError(err: LibError): Value {
  if (err instanceof GoValueError) return err.value;
  if (err === EOF_ERROR) return EOF;
  if (err === UNEXPECTED_EOF) return ERR_UNEXPECTED_EOF;
  if (err === STRCONV_SYNTAX) return STRCONV_ERR_SYNTAX;
  if (err === STRCONV_RANGE) return STRCONV_ERR_RANGE;
  if (err instanceof MarshalerError) {
    return newPointerError(MARSHALER_ERROR, [reflectType(err.type), syntacticToGo(err.err), err.sourceFunc]);
  }
  if (err instanceof SyntacticError || err instanceof IoError) return syntacticToGo(err);
  return newError(err.message());
}

/** `transformMarshalError`. */
export function marshalErrorToGo(err: LibError): Value {
  if (err instanceof SemanticError) {
    if (err.err === undefined) return newPointerError(UNSUPPORTED_TYPE_ERROR, [reflectType(err.goType)]);
    let text = err.err.message();
    if (err.err === ERR_CYCLE && err.goType) text += ` via ${typeString(err.goType)}`;
    if (text.startsWith('unsupported value: ')) text = text.slice('unsupported value: '.length);
    return newPointerError(UNSUPPORTED_VALUE_ERROR, [new GoStruct([]), text]);
  }
  return syntacticToGo(err);
}

/** `transformUnmarshalError`, for the value passed to Unmarshal. */
export function unmarshalErrorToGo(root: Value, err: LibError): Value {
  if (!(err instanceof SemanticError)) return syntacticToGo(err);
  if (err.err === ERR_NON_NIL_REFERENCE) return newPointerError(INVALID_UNMARSHAL_ERROR, [reflectType(err.goType)]);
  if (err.err === ERR_UNKNOWN_NAME) return newError(`json: unknown field ${quote(pointerLastToken(err.pointer))}`);
  let inner = err.err === ERR_NIL_INTERFACE ? undefined : err.err;
  let value = KIND_NAMES[err.kind] ?? '';
  if (err.value.length > 0) {
    let jsonValue = err.value;
    const isStrconvError = inner === STRCONV_RANGE || inner === STRCONV_SYNTAX;
    const numeric = err.goType !== undefined && ['int', 'uint', 'float'].includes(kindOf(err.goType));
    if (isStrconvError && numeric) {
      value = 'number';
      if (err.kind === '"') jsonValue = unquote(jsonValue)[0];
      inner = undefined;
    }
    value += ` ${jsonValue}`;
  }
  let rootName = '';
  const rootIface = root as Iface | undefined;
  if (rootIface !== undefined && err.pointer !== '') {
    let type = rootIface.type;
    if (kindOf(type) === 'pointer') type = (underlying(type) as PointerType).element;
    rootName = typeName(type);
  }
  const field = err.pointer.replace(/^\//, '').replaceAll('/', '.');
  return newPointerError(UNMARSHAL_TYPE_ERROR, [
    value,
    reflectType(err.goType),
    BigInt(err.offset),
    rootName,
    field,
    inner === undefined ? undefined : syntacticToGo(inner),
  ]);
}

const KIND_NAMES: Record<string, string> = {
  n: 'null',
  '"': 'string',
  '0': 'number',
  f: 'bool',
  t: 'bool',
  '[': 'array',
  ']': 'array',
  '{': 'object',
  '}': 'object',
};
