// oxlint-disable unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import { mapKeyOf } from '../equality';
import { currentRuntime, fn, namedType } from '../native';
import { quote } from '../quote';
import { grownCapacity } from '../sliceOps';
import {
  ANY,
  BASIC,
  ERROR_TYPE,
  type MapType,
  type NamedType,
  pointerTo,
  sliceOf,
  type SliceType,
  type Type,
  typeIdentityKey,
  typeString,
  underlying,
} from '../types';
import { copyValue, type GoArray, GoMap, type GoStruct, Iface, Pointer, Slice, type Value } from '../values';
import { base64Decode, base64Encode } from './jsonBase64';
import {
  type DecoderState,
  type EncoderState,
  ERR_NON_STRING_NAME,
  IoError,
  type Kind,
  kindOf as jsonKindOf,
  SyntacticError,
} from './jsonText';
import {
  consumeNumber,
  EOF_ERROR,
  formatJSONFloat,
  GoValueError,
  LibError,
  parseUintWire,
  STRCONV_RANGE,
  STRCONV_SYNTAX,
  TextError,
  UNEXPECTED_EOF,
  unquoteMayCopy,
} from './jsonWire';
import {
  bitsOf,
  callPointerMethod,
  callValueMethod,
  exported,
  fieldName,
  implementsVia,
  kindOf,
  newVariable,
  structOf,
  zeroValue,
} from './reflection';
import { parseFloat } from './strconv';
import { equalFold } from './strings';
import { byteSlice, bytesOf, errorText } from './support';

const BYTES = sliceOf(BASIC.uint8);

/** `json.Marshaler`. */
export const MARSHALER = namedType('json', 'Marshaler', {
  kind: 'interface',
  methods: [{ name: 'MarshalJSON', type: fn([], [BYTES, ERROR_TYPE]) }],
});
/** `json.Unmarshaler`. */
export const UNMARSHALER = namedType('json', 'Unmarshaler', {
  kind: 'interface',
  methods: [{ name: 'UnmarshalJSON', type: fn([BYTES], [ERROR_TYPE]) }],
});
export const TEXT_MARSHALER = namedType('encoding', 'TextMarshaler', {
  kind: 'interface',
  methods: [{ name: 'MarshalText', type: fn([], [BYTES, ERROR_TYPE]) }],
});
export const TEXT_UNMARSHALER = namedType('encoding', 'TextUnmarshaler', {
  kind: 'interface',
  methods: [{ name: 'UnmarshalText', type: fn([BYTES], [ERROR_TYPE]) }],
});
const TEXT_APPENDER = namedType('encoding', 'TextAppender', {
  kind: 'interface',
  methods: [{ name: 'AppendText', type: fn([BYTES], [BYTES, ERROR_TYPE]) }],
});
const ALL_METHOD_TYPES = [MARSHALER, TEXT_APPENDER, TEXT_MARSHALER, UNMARSHALER, TEXT_UNMARSHALER];

/** `json.Number`. */
export const NUMBER = namedType('json', 'Number', BASIC.string);
/** `json.RawMessage`, an alias of `jsontext.Value`. */
export const RAW_MESSAGE = namedType('encoding/json/jsontext', 'Value', BYTES);

const FLOAT64 = BASIC.float64;
const MAP_STRING_ANY: MapType = { kind: 'map', key: BASIC.string, value: ANY };
const SLICE_ANY: SliceType = sliceOf(ANY);

// Errors ------------------------------------------------------------------------------------------------------------

export const ERR_CYCLE = new TextError('encountered a cycle');
export const ERR_NON_NIL_REFERENCE = new TextError('value must be passed as a non-nil pointer reference');
export const ERR_NIL_INTERFACE = new TextError('cannot derive concrete type for nil interface with finite type set');
export const ERR_UNKNOWN_NAME = new TextError('unknown object member name');
const ERR_NIL_FIELD = new TextError('cannot set embedded pointer to unexported struct type');
const ERR_NON_STRING_VALUE = new TextError('JSON value must be string type');

/** `json.SemanticError` of v2, which v1 turns into its own error types. */
export class SemanticError extends LibError {
  constructor(
    readonly action: string,
    public offset: number,
    public pointer: string,
    readonly kind: Kind,
    public value: string,
    readonly goType: Type | undefined,
    public err: LibError | undefined
  ) {
    super();
  }

  message(): string {
    let text = `json: cannot ${this.action || 'handle'}`;
    if (this.goType) text += ` Go ${typeString(this.goType)}`;
    if (this.err) text += `: ${this.err.message()}`;
    return text;
  }

  override unwrap(): LibError | undefined {
    return this.err;
  }
}

/** `internal.ValueError`: an error about a Go value, which v1 reports with the value. */
class ValueError extends LibError {
  constructor(readonly err: LibError) {
    super();
  }

  message(): string {
    return this.err.message();
  }
}

/** `json.MarshalerError`. */
export class MarshalerError extends LibError {
  constructor(
    readonly type: Type,
    public err: LibError,
    readonly sourceFunc: string
  ) {
    super();
  }

  message(): string {
    return `json: error calling ${this.sourceFunc} for type ${typeString(this.type)}: ${this.err.message()}`;
  }

  override unwrap(): LibError {
    return this.err;
  }
}

function toUnexpectedEOF(err: LibError | undefined): LibError | undefined {
  return err === EOF_ERROR ? UNEXPECTED_EOF : err;
}

function newMarshalErrorBefore(enc: EncoderState, type: Type | undefined, err: LibError | undefined): SemanticError {
  return new SemanticError(
    'marshal',
    enc.buf.length + enc.countNextDelimWhitespace(),
    enc.stackPointer(+1),
    '',
    '',
    type,
    toUnexpectedEOF(err)
  );
}

function newUnmarshalErrorBefore(dec: DecoderState, type: Type, err: LibError | undefined): SemanticError {
  const kind = dec.peekKind();
  return new SemanticError(
    'unmarshal',
    dec.inputOffset() + dec.countNextDelimWhitespace(),
    dec.stackPointer(+1),
    kind,
    '',
    type,
    toUnexpectedEOF(err)
  );
}

function newUnmarshalErrorBeforeWithSkipping(dec: DecoderState, type: Type, err: LibError | undefined): LibError {
  const error = newUnmarshalErrorBefore(dec, type, err);
  return dec.skipValue() ?? error;
}

function newUnmarshalErrorAfter(dec: DecoderState, type: Type, err: LibError | undefined): SemanticError {
  const tokOrVal = dec.previousTokenOrValue();
  const kind = jsonKindOf(tokOrVal.trimStart()[0]);
  let offset = dec.inputOffset() - tokOrVal.length;
  offset += kind === '[' || kind === '{' ? 1 : tokOrVal.length;
  return new SemanticError('unmarshal', offset, dec.stackPointer(-1), kind, '', type, toUnexpectedEOF(err));
}

function newUnmarshalErrorAfterWithValue(dec: DecoderState, type: Type, err: LibError | undefined): SemanticError {
  const error = newUnmarshalErrorAfter(dec, type, err);
  if (error.kind === '"' || error.kind === '0') error.value = dec.previousTokenOrValue();
  return error;
}

function newUnmarshalErrorAfterWithSkipping(dec: DecoderState, type: Type, err: LibError | undefined): LibError {
  const error = newUnmarshalErrorAfter(dec, type, err);
  return dec.skipValueRemainder() ?? error;
}

/** Whether an unmarshal error stops decoding, which with v1's semantics only syntax and I/O errors do. */
function isFatal(err: LibError): boolean {
  return err instanceof SyntacticError || err instanceof IoError || err === EOF_ERROR;
}

// Values ------------------------------------------------------------------------------------------------------------

/** `addressableValue`: a variable and whether its address was taken only for marshaling. */
export class Ref {
  constructor(
    readonly pointer: Pointer,
    readonly forcedAddr: boolean
  ) {}

  get(): Value {
    return this.pointer.load();
  }

  set(value: Value): void {
    this.pointer.store(value);
  }
}

function newRef(type: Type, value: Value = zeroValue(type)): Ref {
  return new Ref(newVariable(type, copyValue(value)), true);
}

export interface MarshalOptions {
  /** The pointers being marshaled below depth 1000, for detecting cycles. */
  seen: Set<string>;
}

export interface UnmarshalOptions {
  useNumber: boolean;
  rejectUnknownMembers: boolean;
}

type Marshal = (enc: EncoderState, ref: Ref, mo: MarshalOptions) => LibError | undefined;
type Unmarshal = (dec: DecoderState, ref: Ref, uo: UnmarshalOptions) => LibError | undefined;

interface Arshaler {
  marshal: Marshal;
  unmarshal: Unmarshal;
  nonDefault: boolean;
}

const START_DETECTING_CYCLES_AFTER = 1000;

const arshalerCache = new Map<string, Arshaler>();

/** The marshal and unmarshal functions of a type, made once for each type. */
export function lookupArshaler(type: Type): Arshaler {
  const key = typeIdentityKey(type);
  let arshaler = arshalerCache.get(key);
  if (!arshaler) {
    arshaler = makeMethodArshaler(makeDefaultArshaler(type), type);
    arshalerCache.set(key, arshaler);
  }
  return arshaler;
}

/** An arshaler whose functions are made on first use, so that recursive types refer to themselves. */
function lazy(make: () => Arshaler): Arshaler {
  let made: Arshaler | undefined;
  const get = (): Arshaler => (made ??= make());
  return {
    marshal: (enc, ref, mo) => get().marshal(enc, ref, mo),
    unmarshal: (dec, ref, uo) => get().unmarshal(dec, ref, uo),
    nonDefault: false,
  };
}

function makeDefaultArshaler(type: Type): Arshaler {
  if (type.kind === 'named' && type === NUMBER) return makeNumberArshaler(type);
  switch (kindOf(type)) {
    case 'bool': {
      return makeBoolArshaler(type);
    }
    case 'string': {
      return makeStringArshaler(type);
    }
    case 'int':
    case 'uint': {
      return makeIntArshaler(type);
    }
    case 'float': {
      return makeFloatArshaler(type);
    }
    case 'map': {
      return lazy(() => makeMapArshaler(type));
    }
    case 'struct': {
      return lazy(() => makeStructArshaler(type));
    }
    case 'slice':
    case 'array': {
      const element = (underlying(type) as SliceType).element;
      const list = lazy(() => makeListArshaler(type));
      if (kindOf(element) === 'uint' && bitsOf(element) === 8 && underlying(element).kind === 'basic') {
        return makeBytesArshaler(type, list);
      }
      return list;
    }
    case 'pointer': {
      return lazy(() => makePointerArshaler(type));
    }
    case 'interface': {
      return makeInterfaceArshaler(type);
    }
    default: {
      return makeInvalidArshaler(type);
    }
  }
}

function makeBoolArshaler(type: Type): Arshaler {
  return {
    nonDefault: false,
    marshal: (enc, ref) => enc.writeToken(ref.get() ? 't' : 'f'),
    unmarshal: (dec, ref) => {
      const [token, err] = dec.readToken();
      if (err) return err;
      if (token.kind === 'n') return;
      if (token.kind === 't' || token.kind === 'f') {
        ref.set(token.kind === 't');
        return;
      }
      return newUnmarshalErrorAfterWithSkipping(dec, type, undefined);
    },
  };
}

function makeStringArshaler(type: Type): Arshaler {
  return {
    nonDefault: false,
    marshal: (enc, ref) => enc.writeToken('"', ref.get() as string),
    unmarshal: (dec, ref) => {
      const flags = { nonVerbatim: false };
      const [val, err] = dec.readValue(flags);
      if (err) return err;
      if (val[0] === 'n') return;
      if (val[0] === '"') {
        ref.set(unquoteMayCopy(val, !flags.nonVerbatim));
        return;
      }
      return newUnmarshalErrorAfter(dec, type, undefined);
    },
  };
}

function makeIntArshaler(type: Type): Arshaler {
  const bits = bitsOf(type);
  const signed = kindOf(type) === 'int';
  return {
    nonDefault: false,
    marshal: (enc, ref) => {
      const text = String(ref.get() as bigint);
      return enc.tokens.last.needObjectName ? enc.appendRaw('"', text) : enc.appendRaw('0', text);
    },
    unmarshal: (dec, ref) => {
      const stringify = dec.tokens.last.needObjectName;
      const flags = { nonVerbatim: false };
      const [raw, err] = dec.readValue(flags);
      if (err) return err;
      const kind = jsonKindOf(raw[0]);
      if (kind === 'n') return;
      if (kind === '"' && stringify) {
        const val = unquoteMayCopy(raw, !flags.nonVerbatim);
        const [value, parseErr] = parseLegacyInteger(val, bits, signed);
        if (parseErr) {
          if (val === 'null') return;
          return newUnmarshalErrorAfterWithValue(dec, type, parseErr);
        }
        ref.set(value);
        return;
      }
      if (kind === '0' && !stringify) {
        const [value, parseErr] = parseWireInteger(raw, bits, signed);
        if (parseErr) return newUnmarshalErrorAfterWithValue(dec, type, parseErr);
        ref.set(value);
        return;
      }
      return newUnmarshalErrorAfter(dec, type, undefined);
    },
  };
}

/** A JSON number as an integer of the type, as v2's integer unmarshaling parses it. */
function parseWireInteger(raw: string, bits: number, signed: boolean): [bigint, LibError | undefined] {
  const negative = signed && raw[0] === '-';
  const [n, ok] = parseUintWire(negative ? raw.slice(1) : raw);
  const max = signed ? 1n << BigInt(bits - 1) : (1n << BigInt(bits)) - 1n;
  let overflow = signed ? (negative && n > max) || (!negative && n > max - 1n) : n > max;
  if (!ok) {
    if (n !== (1n << 64n) - 1n) return [0n, STRCONV_SYNTAX];
    overflow = true;
  }
  if (overflow) return [0n, STRCONV_RANGE];
  return [negative ? -n : n, undefined];
}

/** `strconv.ParseInt` or `ParseUint` in base 10, reporting the unwrapped error as v1's legacy stringified numbers do. */
function parseLegacyInteger(text: string, bits: number, signed: boolean): [bigint, LibError | undefined] {
  let s = text;
  let negative = false;
  if (signed && (s[0] === '+' || s[0] === '-')) {
    negative = s[0] === '-';
    s = s.slice(1);
  }
  if (s === '' || !/^\d+$/.test(s)) return [0n, STRCONV_SYNTAX];
  const value = BigInt(s);
  if (signed) {
    const max = 1n << BigInt(bits - 1);
    if ((negative && value > max) || (!negative && value >= max)) return [0n, STRCONV_RANGE];
    return [negative ? -value : value, undefined];
  }
  if (value >= 1n << BigInt(bits)) return [0n, STRCONV_RANGE];
  return [value, undefined];
}

function makeFloatArshaler(type: Type): Arshaler {
  const bits = bitsOf(type) as 32 | 64;
  return {
    nonDefault: false,
    marshal: (enc, ref) => {
      const value = ref.get() as number;
      if (!Number.isFinite(value)) {
        const text = Number.isNaN(value) ? 'NaN' : value > 0 ? '+Inf' : '-Inf';
        return newMarshalErrorBefore(enc, type, new ValueError(new TextError(`unsupported value: ${text}`)));
      }
      const text = formatJSONFloat(value, bits);
      return enc.tokens.last.needObjectName ? enc.appendRaw('"', text) : enc.appendRaw('0', text);
    },
    unmarshal: (dec, ref) => {
      const stringify = dec.tokens.last.needObjectName;
      const flags = { nonVerbatim: false };
      const [raw, err] = dec.readValue(flags);
      if (err) return err;
      const kind = jsonKindOf(raw[0]);
      if (kind === 'n') return;
      let val = raw;
      if (kind === '"') {
        if (!stringify) return newUnmarshalErrorAfter(dec, type, undefined);
        val = unquoteMayCopy(raw, !flags.nonVerbatim);
        const [value, parseErr] = parseFloatText(val, bits);
        if (parseErr) {
          if (val === 'null') return;
          return newUnmarshalErrorAfterWithValue(dec, type, parseErr);
        }
        ref.set(value);
        return;
      }
      if (kind === '0' && !stringify) {
        const [value, parseErr] = parseFloatText(val, bits);
        if (parseErr) return newUnmarshalErrorAfterWithValue(dec, type, parseErr);
        ref.set(value);
        return;
      }
      return newUnmarshalErrorAfter(dec, type, undefined);
    },
  };
}

/** `strconv.ParseFloat`, with its unwrapped error. */
function parseFloatText(text: string, bits: 32 | 64): [number, LibError | undefined] {
  const [value, err] = parseFloat(text, bits);
  if (err === undefined) return [value, undefined];
  return [value, errorText(err).endsWith('value out of range') ? STRCONV_RANGE : STRCONV_SYNTAX];
}

function makeBytesArshaler(type: Type, list: Arshaler): Arshaler {
  const isArray = kindOf(type) === 'array';
  const element = (underlying(type) as SliceType).element;
  const hasMarshaler = ALL_METHOD_TYPES.slice(0, 3).some((iface) => implementsVia(element, iface));
  return {
    nonDefault: false,
    marshal: (enc, ref, mo) => {
      if (isArray || hasMarshaler) return list.marshal(enc, ref, mo);
      const slice = ref.get() as Slice | undefined;
      if (slice === undefined) return enc.writeToken('n');
      return enc.appendRaw('"', base64Encode(bytesOf(slice)));
    },
    unmarshal: (dec, ref, uo) => {
      if (isArray || dec.peekKind() === '[') return list.unmarshal(dec, ref, uo);
      const flags = { nonVerbatim: false };
      const [raw, err] = dec.readValue(flags);
      if (err) return err;
      const kind = jsonKindOf(raw[0]);
      if (kind === 'n') {
        ref.set(undefined);
        return;
      }
      if (kind === '"') {
        const [bytes, decodeErr] = base64Decode(unquoteMayCopy(raw, !flags.nonVerbatim));
        if (decodeErr) return newUnmarshalErrorAfter(dec, type, decodeErr);
        ref.set(byteSlice(bytes));
        return;
      }
      return newUnmarshalErrorAfter(dec, type, undefined);
    },
  };
}

function makeNumberArshaler(type: NamedType): Arshaler {
  const string = makeStringArshaler(type);
  return {
    nonDefault: true,
    marshal: (enc, ref, mo) => {
      if (enc.tokens.last.needObjectName) return string.marshal(enc, ref, mo);
      const n = (ref.get() as string) || '0';
      const [count, err] = consumeNumber(n);
      if (count !== n.length || err) {
        const error = new TextError(`cannot parse ${quote(n)} as JSON number: invalid syntax`, STRCONV_SYNTAX);
        return new MarshalerError(pointerTo(type), error, 'MarshalJSONTo');
      }
      return enc.appendRaw('0', n);
    },
    unmarshal: (dec, ref, uo) => {
      if (dec.tokens.last.needObjectName) return string.unmarshal(dec, ref, uo);
      const depth = dec.tokens.depth;
      const length = dec.tokens.last.length;
      const flags = { nonVerbatim: false };
      const [raw, err] = dec.readValue(flags);
      if (err) return err;
      const kind = jsonKindOf(raw[0]);
      if (kind === 'n') return;
      if (kind === '"') {
        const val = unquoteMayCopy(raw, !flags.nonVerbatim);
        const [n, numErr] = consumeNumber(val);
        if (n !== val.length || numErr || val === '') {
          return skipUntil(dec, depth, length, new SemanticError('', 0, '', '"', raw, type, STRCONV_SYNTAX));
        }
        ref.set(val);
        return;
      }
      if (kind === '0') {
        ref.set(raw);
        return;
      }
      return skipUntil(dec, depth, length, new SemanticError('', 0, '', kind, '', type, undefined));
    },
  };
}

function skipUntil(dec: DecoderState, depth: number, length: number, err: LibError): LibError {
  while (dec.tokens.depth > depth || (dec.tokens.depth === depth && dec.tokens.last.length < length + 1)) {
    const [, readErr] = dec.readToken();
    if (readErr) return readErr;
  }
  return err;
}

// Maps ----------------------------------------------------------------------------------------------------------------

function makeMapArshaler(type: Type): Arshaler {
  const mapType = underlying(type) as MapType;
  const keyFncs = lookupArshaler(mapType.key);
  const valFncs = lookupArshaler(mapType.value);
  const keyOf = mapKeyOf(mapType.key);
  const stringKeys = kindOf(mapType.key) === 'string';
  return {
    nonDefault: false,
    marshal: (enc, ref, mo) => {
      const map = ref.get() as GoMap | undefined;
      const cycleErr = enterPointer(enc, mo, type, map, 0);
      if (cycleErr) return cycleErr;
      try {
        return marshalMap(enc, map, mo);
      } finally {
        leavePointer(mo, type, map, 0);
      }
    },
    unmarshal: (dec, ref, uo) => {
      const [token, err] = dec.readToken();
      if (err) return err;
      if (token.kind === 'n') {
        ref.set(undefined);
        return;
      }
      if (token.kind !== '{') return newUnmarshalErrorAfterWithSkipping(dec, type, undefined);
      let map = ref.get() as GoMap | undefined;
      if (map === undefined) {
        map = new GoMap(keyOf);
        ref.set(map);
      }
      let errUnmarshal: LibError | undefined;
      while (dec.peekKind() !== '}') {
        const keyRef = newRef(mapType.key);
        const keyErr = keyFncs.unmarshal(dec, keyRef, uo);
        if (keyErr) {
          if (isFatal(keyErr)) return keyErr;
          const skipErr = dec.skipValue();
          if (skipErr) return skipErr;
          errUnmarshal ??= keyErr;
          continue;
        }
        const key = keyRef.get();
        const valueRef = newRef(mapType.value);
        const valErr = valFncs.unmarshal(dec, valueRef, uo);
        currentRuntime().allocate(2);
        map.entries.set(keyOf(key), { key, value: valueRef.get() });
        if (valErr) {
          if (isFatal(valErr)) return valErr;
          errUnmarshal ??= valErr;
        }
      }
      const [, endErr] = dec.readToken();
      return endErr ?? errUnmarshal;
    },
  };

  function marshalMap(enc: EncoderState, map: GoMap | undefined, mo: MarshalOptions): LibError | undefined {
    const entries = map ? [...map.entries.values()] : [];
    if (entries.length === 0 && map === undefined) return enc.writeToken('n');
    let err = enc.writeToken('{');
    if (err) return err;
    if (entries.length <= 1 || (stringKeys && !keyFncs.nonDefault)) {
      if (entries.length > 1) entries.sort((a, b) => compareBytes(a.key as string, b.key as string));
      for (const entry of entries) {
        err = marshalKey(enc, entry.key, mo) ?? valFncs.marshal(enc, newRef(mapType.value, entry.value), mo);
        if (err) return err;
      }
    } else {
      const members: { name: string; value: Value }[] = [];
      for (const entry of entries) {
        const start = enc.buf.length;
        err = marshalKey(enc, entry.key, mo);
        if (err) return err;
        members.push({ name: enc.unwriteObjectMemberName(start), value: entry.value });
      }
      members.sort((a, b) => compareBytes(a.name, b.name));
      for (const member of members) {
        err = enc.writeToken('"', member.name) ?? valFncs.marshal(enc, newRef(mapType.value, member.value), mo);
        if (err) return err;
      }
    }
    return enc.writeToken('}');
  }

  function marshalKey(enc: EncoderState, key: Value, mo: MarshalOptions): LibError | undefined {
    const err = keyFncs.marshal(enc, newRef(mapType.key, key), mo);
    if (err instanceof SyntacticError && err.err === ERR_NON_STRING_NAME) {
      return newMarshalErrorBefore(enc, mapType.key, err);
    }
    return err;
  }
}

export function compareBytes(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** `visitPointer` below the depth where cycles are detected; the key identifies the pointer, type, and length. */
function enterPointer(
  enc: EncoderState,
  mo: MarshalOptions,
  type: Type,
  target: object | undefined,
  length: number
): LibError | undefined {
  if (enc.tokens.depth <= START_DETECTING_CYCLES_AFTER || target === undefined) return undefined;
  const key = `${identityOf(target)}|${typeIdentityKey(type)}|${length}`;
  if (mo.seen.has(key)) return newMarshalErrorBefore(enc, type, ERR_CYCLE);
  mo.seen.add(key);
  return undefined;
}

function leavePointer(mo: MarshalOptions, type: Type, target: object | undefined, length: number): void {
  if (target === undefined) return;
  mo.seen.delete(`${identityOf(target)}|${typeIdentityKey(type)}|${length}`);
}

const identities = new WeakMap<object, number>();
let nextIdentity = 0;

function identityOf(target: object): string {
  if (target instanceof Pointer) return `${identityOf(target.base as object)}.${target.key}`;
  if (target instanceof Slice) return `${identityOf(target.array)}.${target.offset}`;
  let id = identities.get(target);
  if (id === undefined) {
    id = nextIdentity++;
    identities.set(target, id);
  }
  return String(id);
}

// Structs -------------------------------------------------------------------------------------------------------------

interface StructField {
  id: number;
  /** The indexes of the embedded fields to go through and then of the field itself. */
  index: number[];
  type: Type;
  name: string;
  quotedName: string;
}

interface StructFields {
  flattened: StructField[];
  byActualName: Map<string, StructField>;
}

/** `makeStructFields` for structs without tags: exported fields, and the fields of embedded structs. */
// code-gauge-allow functionCognitiveComplexity 30 -- A transcription of Go's makeStructFields for untagged fields.
function makeStructFields(root: Type): StructFields {
  const queue: { type: Type; index: number[]; visitChildren: boolean }[] = [
    { type: root, index: [], visitChildren: true },
  ];
  const seen = new Set<string>([typeIdentityKey(root)]);
  let allFields: StructField[] = [];
  for (let queueIndex = 0; queueIndex < queue.length; queueIndex++) {
    const entry = queue[queueIndex];
    const struct = structOf(entry.type);
    if (!struct) continue;
    for (const [i, field] of struct.fields.entries()) {
      const isExported = exported(field.name);
      if (!isExported && !field.embedded) continue;
      const index = [...entry.index, i];
      if (field.embedded) {
        const embedded = field.type.kind === 'pointer' ? field.type.element : field.type;
        if (kindOf(embedded) === 'struct') {
          const key = typeIdentityKey(embedded);
          if (entry.visitChildren) queue.push({ type: embedded, index, visitChildren: !seen.has(key) });
          seen.add(key);
          continue;
        }
        if (!isExported) continue;
      }
      const name = fieldName(field.name);
      allFields.push({ id: allFields.length, index, type: field.type, name, quotedName: `"${name}"` });
    }
  }
  allFields.sort((x, y) => compareBytes(x.name, y.name) || x.index.length - y.index.length);
  const flattened: StructField[] = [];
  while (allFields.length > 0) {
    let n = 1;
    while (n < allFields.length && allFields[n - 1].name === allFields[n].name) n++;
    if (n === 1 || allFields[0].index.length !== allFields[1].index.length) flattened.push(allFields[0]);
    allFields = allFields.slice(n);
  }
  flattened.sort((x, y) => x.id - y.id);
  for (const [i, field] of flattened.entries()) field.id = i;
  flattened.sort((x, y) => compareIndexes(x.index, y.index));
  return { flattened, byActualName: new Map(flattened.map((field) => [field.name, field])) };
}

function compareIndexes(x: number[], y: number[]): number {
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}

function elementOf(type: Type): Type {
  return (underlying(type) as { element: Type }).element;
}

function makeStructArshaler(type: Type): Arshaler {
  const fields = makeStructFields(type);
  return {
    nonDefault: false,
    marshal: (enc, ref, mo) => {
      let err = enc.writeToken('{');
      if (err) return err;
      for (const field of fields.flattened) {
        const value = walkField(ref, type, field, false);
        if (!value) continue;
        enc.buf += (enc.tokens.last.length > 0 ? ',' : '') + field.quotedName;
        enc.names[enc.names.length - 1] = field.name;
        enc.tokens.last.length++;
        err = lookupArshaler(field.type).marshal(enc, value, mo);
        if (err) return err;
      }
      return enc.writeToken('}');
    },
    unmarshal: (dec, ref, uo) => {
      const [token, err] = dec.readToken();
      if (err) return err;
      if (token.kind === 'n') return;
      if (token.kind !== '{') return newUnmarshalErrorAfterWithSkipping(dec, type, undefined);
      let errUnmarshal: LibError | undefined;
      while (dec.peekKind() !== '}') {
        const flags = { nonVerbatim: false };
        const [raw, nameErr] = dec.readValue(flags);
        if (nameErr) return nameErr;
        const name = unquoteMayCopy(raw, !flags.nonVerbatim);
        const field =
          fields.byActualName.get(name) ??
          fields.flattened.filter((candidate) => equalFold(name, candidate.name)).toSorted((a, b) => a.id - b.id)[0];
        if (!field) {
          if (uo.rejectUnknownMembers) errUnmarshal ??= newUnmarshalErrorAfter(dec, type, ERR_UNKNOWN_NAME);
          const skipErr = dec.skipValue();
          if (skipErr) return skipErr;
          continue;
        }
        const value = walkField(ref, type, field, true);
        let fieldErr: LibError | undefined;
        if (value) {
          fieldErr = lookupArshaler(field.type).unmarshal(dec, value, uo);
        } else {
          errUnmarshal ??= newUnmarshalErrorBefore(dec, type, ERR_NIL_FIELD);
          fieldErr = dec.skipValue();
        }
        if (fieldErr) {
          if (isFatal(fieldErr)) return fieldErr;
          errUnmarshal ??= fieldErr;
        }
      }
      const [, endErr] = dec.readToken();
      return endErr ?? errUnmarshal;
    },
  };
}

/** `fieldByIndex`: the field's variable, allocating nil embedded pointers when unmarshaling. */
function walkField(ref: Ref, type: Type, field: StructField, mayAlloc: boolean): Ref | undefined {
  let current = ref;
  let currentType = type;
  for (const [step, i] of field.index.entries()) {
    if (step > 0 && kindOf(currentType) === 'pointer') {
      let target = current.get() as Pointer | undefined;
      if (target === undefined) {
        if (!mayAlloc || readOnlyAt(type, field, step)) return undefined;
        target = newVariable(elementOf(currentType));
        current.set(target);
      }
      current = new Ref(target, false);
      currentType = elementOf(currentType);
    }
    const struct = current.get() as GoStruct;
    const structType = structOf(currentType);
    if (!structType) return undefined;
    current = new Ref(new Pointer(struct.fields, i), current.forcedAddr);
    currentType = structType.fields[i].type;
  }
  return current;
}

/** Whether the embedded field at the step of the path is reached through an unexported field. */
function readOnlyAt(type: Type, field: StructField, step: number): boolean {
  let currentType = type;
  for (const i of field.index.slice(0, step)) {
    if (kindOf(currentType) === 'pointer') currentType = elementOf(currentType);
    const struct = structOf(currentType);
    if (!struct) return true;
    if (!exported(struct.fields[i].name)) return true;
    currentType = struct.fields[i].type;
  }
  return false;
}

// Slices, arrays, and pointers ------------------------------------------------------------------------------------------

function makeListArshaler(type: Type): Arshaler {
  const isArray = kindOf(type) === 'array';
  const element = elementOf(type);
  const valFncs = lookupArshaler(element);
  return {
    nonDefault: false,
    marshal: (enc, ref, mo) => {
      const list = ref.get() as Slice | GoArray | undefined;
      if (list === undefined) return enc.writeToken('n');
      const length = list instanceof Slice ? list.length : list.elements.length;
      const cycleErr = isArray ? undefined : enterPointer(enc, mo, type, list as Slice, length);
      if (cycleErr) return cycleErr;
      try {
        let err = enc.writeToken('[');
        if (err) return err;
        for (let i = 0; i < length; i++) {
          const pointer =
            list instanceof Slice ? new Pointer(list.array, list.offset + i) : new Pointer(list.elements, i);
          err = valFncs.marshal(enc, new Ref(pointer, isArray && ref.forcedAddr), mo);
          if (err) return err;
        }
        return enc.writeToken(']');
      } finally {
        if (!isArray) leavePointer(mo, type, list as Slice, length);
      }
    },
    unmarshal: (dec, ref, uo) => (isArray ? unmarshalArray(dec, ref, uo) : unmarshalSlice(dec, ref, uo)),
  };

  function unmarshalSlice(dec: DecoderState, ref: Ref, uo: UnmarshalOptions): LibError | undefined {
    const [token, err] = dec.readToken();
    if (err) return err;
    if (token.kind === 'n') {
      ref.set(undefined);
      return undefined;
    }
    if (token.kind !== '[') return newUnmarshalErrorAfterWithSkipping(dec, type, undefined);
    const slice = ref.get() as Slice | undefined;
    let array = slice?.array ?? [];
    let offset = slice?.offset ?? 0;
    let capacity = slice?.capacity ?? 0;
    let i = 0;
    let errUnmarshal: LibError | undefined;
    while (dec.peekKind() !== ']') {
      if (i === capacity) {
        const grown = grownCapacity(capacity, capacity + 1, element);
        currentRuntime().allocate(grown);
        const next = array.slice(offset, offset + capacity);
        while (next.length < grown) next.push(zeroValue(element));
        [array, offset, capacity] = [next, 0, grown];
      }
      const elementRef = new Ref(new Pointer(array, offset + i), false);
      i++;
      const elementErr = valFncs.unmarshal(dec, elementRef, uo);
      if (elementErr) {
        if (isFatal(elementErr)) {
          ref.set(new Slice(array, offset, i, capacity));
          return elementErr;
        }
        errUnmarshal ??= elementErr;
      }
    }
    ref.set(i === 0 ? new Slice([], 0, 0, 0) : new Slice(array, offset, i, capacity));
    const [, endErr] = dec.readToken();
    return endErr ?? errUnmarshal;
  }

  function unmarshalArray(dec: DecoderState, ref: Ref, uo: UnmarshalOptions): LibError | undefined {
    const [token, err] = dec.readToken();
    if (err) return err;
    if (token.kind === 'n') return undefined;
    if (token.kind !== '[') return newUnmarshalErrorAfterWithSkipping(dec, type, undefined);
    const elements = (ref.get() as GoArray).elements;
    let i = 0;
    let errUnmarshal: LibError | undefined;
    while (dec.peekKind() !== ']') {
      if (i >= elements.length) {
        const skipErr = dec.skipValue();
        if (skipErr) return skipErr;
        continue;
      }
      const elementErr = valFncs.unmarshal(dec, new Ref(new Pointer(elements, i), ref.forcedAddr), uo);
      if (elementErr) {
        if (isFatal(elementErr)) return elementErr;
        errUnmarshal ??= elementErr;
      }
      i++;
    }
    for (; i < elements.length; i++) elements[i] = zeroValue(element);
    const [, endErr] = dec.readToken();
    return endErr ?? errUnmarshal;
  }
}

function makePointerArshaler(type: Type): Arshaler {
  const element = elementOf(type);
  const valFncs = lookupArshaler(element);
  return {
    nonDefault: false,
    marshal: (enc, ref, mo) => {
      const pointer = ref.get() as Pointer | undefined;
      const cycleErr = enterPointer(enc, mo, type, pointer, 0);
      if (cycleErr) return cycleErr;
      try {
        if (pointer === undefined) return enc.writeToken('n');
        return valFncs.marshal(enc, new Ref(pointer, false), mo);
      } finally {
        leavePointer(mo, type, pointer, 0);
      }
    },
    unmarshal: (dec, ref, uo) => {
      if (dec.peekKind() === 'n') {
        const [, err] = dec.readToken();
        if (err) return err;
        ref.set(undefined);
        return;
      }
      let pointer = ref.get() as Pointer | undefined;
      if (pointer === undefined) {
        pointer = newVariable(element);
        ref.set(pointer);
      }
      return valFncs.unmarshal(dec, new Ref(pointer, false), uo);
    },
  };
}

function makeInterfaceArshaler(type: Type): Arshaler {
  const isAny =
    underlying(type).kind === 'interface' && (underlying(type) as { methods: unknown[] }).methods.length === 0;
  const legacyMarshaler = ALL_METHOD_TYPES.slice(0, 3).find((iface) => implementsVia(type, iface) === 'value');
  return {
    nonDefault: false,
    marshal: (enc, ref, mo) => {
      const iface = ref.get() as Iface | undefined;
      if (iface === undefined) return enc.writeToken('n');
      if (legacyMarshaler && kindOf(iface.type) === 'pointer' && iface.value === undefined) {
        return marshalNilPointerWithMethod(enc, iface, legacyMarshaler);
      }
      return lookupArshaler(iface.type).marshal(enc, newRef(iface.type, iface.value), mo);
    },
    unmarshal: (dec, ref, uo) => {
      const current = ref.get() as Iface | undefined;
      if (current !== undefined) {
        if (kindOf(current.type) === 'pointer' && current.value !== undefined) {
          if (dec.peekKind() === 'n' && kindOf(elementOf(current.type)) === 'pointer') {
            const [, err] = dec.readToken();
            if (err) return err;
            (current.value as Pointer).store(undefined);
            return;
          }
        } else {
          ref.set(undefined);
        }
      }
      if (dec.peekKind() === 'n') {
        const [, err] = dec.readToken();
        if (err) return err;
        ref.set(undefined);
        return;
      }
      const existing = ref.get() as Iface | undefined;
      let valueType: Type;
      if (existing === undefined) {
        const kind = dec.peekKind();
        if (!isAny) return newUnmarshalErrorBeforeWithSkipping(dec, type, ERR_NIL_INTERFACE);
        switch (kind) {
          case 'f':
          case 't': {
            valueType = BASIC.bool;
            break;
          }
          case '"': {
            valueType = BASIC.string;
            break;
          }
          case '0': {
            valueType = uo.useNumber ? NUMBER : FLOAT64;
            break;
          }
          case '{': {
            valueType = MAP_STRING_ANY;
            break;
          }
          case '[': {
            valueType = SLICE_ANY;
            break;
          }
          default: {
            return dec.readValue({ nonVerbatim: false })[1];
          }
        }
      } else {
        valueType = existing.type;
      }
      const valueRef = newRef(valueType, existing?.value ?? zeroValue(valueType));
      const err = lookupArshaler(valueType).unmarshal(dec, valueRef, uo);
      ref.set(new Iface(valueType, valueRef.get()));
      return err;
    },
  };
}

/** Marshals a nil pointer in an interface type with a marshal method, calling the method as v1 did. */
function marshalNilPointerWithMethod(enc: EncoderState, iface: Iface, marshaler: NamedType): LibError | undefined {
  if (marshaler === MARSHALER) {
    const [val, err] = callValueMethod(iface.type, undefined, 'MarshalJSON', []) as [Value, Value];
    if (err !== undefined) return new MarshalerError(iface.type, goError(err), 'MarshalJSON');
    const writeErr = enc.writeValue(bytesOf(val));
    return writeErr && new MarshalerError(iface.type, writeErr, 'MarshalJSON');
  }
  const method = marshaler === TEXT_MARSHALER ? 'MarshalText' : 'AppendText';
  const args = marshaler === TEXT_MARSHALER ? [] : [undefined];
  const [text, err] = callValueMethod(iface.type, undefined, method, args) as [Value, Value];
  if (err !== undefined) return new MarshalerError(iface.type, goError(err), method);
  return enc.appendRaw('"', bytesOf(text));
}

function makeInvalidArshaler(type: Type): Arshaler {
  return {
    nonDefault: false,
    marshal: (enc) => newMarshalErrorBefore(enc, type, undefined),
    unmarshal: (dec) => {
      const [val, err] = dec.readValue({ nonVerbatim: false });
      if (err) return err;
      if (val[0] === 'n') return;
      return newUnmarshalErrorAfter(dec, type, undefined);
    },
  };
}

// Methods -------------------------------------------------------------------------------------------------------------

export function goError(value: Value): GoValueError {
  return new GoValueError(value, errorText(value));
}

/** `makeMethodArshaler`: the program's MarshalJSON, MarshalText, UnmarshalJSON, and UnmarshalText methods. */
// code-gauge-allow functionCognitiveComplexity 30 -- One case per method that Go's makeMethodArshaler handles.
function makeMethodArshaler(fncs: Arshaler, type: Type): Arshaler {
  const kind = kindOf(type);
  if (kind === 'pointer' || kind === 'interface' || type === NUMBER) return fncs;
  const result = { ...fncs };
  const pointerType = pointerTo(type);
  const addMarshal = (iface: NamedType, call: (enc: EncoderState, pointer: Pointer) => LibError | undefined): void => {
    const via = implementsVia(type, iface);
    if (!via) return;
    result.nonDefault = true;
    const previous = result.marshal;
    const isString = kind === 'string';
    result.marshal = (enc, ref, mo) => {
      const atName = enc.tokens.last.needObjectName;
      const textLike = iface !== MARSHALER;
      if ((via === 'pointer' && ref.forcedAddr) || (atName && (!textLike || isString))) {
        return previous(enc, ref, mo);
      }
      return call(enc, ref.pointer);
    };
  };
  addMarshal(TEXT_MARSHALER, (enc, pointer) => {
    const [text, err] = callPointerMethod(type, pointer, 'MarshalText', []) as [Value, Value];
    if (err !== undefined) return new MarshalerError(pointerType, goError(err), 'MarshalText');
    return enc.appendRaw('"', bytesOf(text));
  });
  addMarshal(TEXT_APPENDER, (enc, pointer) => {
    const [text, err] = callPointerMethod(type, pointer, 'AppendText', [undefined]) as [Value, Value];
    if (err !== undefined) return new MarshalerError(pointerType, goError(err), 'AppendText');
    return enc.appendRaw('"', bytesOf(text));
  });
  addMarshal(MARSHALER, (enc, pointer) => {
    const [val, err] = callPointerMethod(type, pointer, 'MarshalJSON', []) as [Value, Value];
    if (err !== undefined) return new MarshalerError(pointerType, goError(err), 'MarshalJSON');
    const writeErr = enc.writeValue(bytesOf(val));
    return writeErr && new MarshalerError(pointerType, writeErr, 'MarshalJSON');
  });
  if (implementsVia(type, TEXT_UNMARSHALER)) {
    result.nonDefault = true;
    result.unmarshal = (dec, ref) => {
      const flags = { nonVerbatim: false };
      const [val, err] = dec.readValue(flags);
      if (err) return err;
      if (val[0] === 'n') return;
      if (val[0] !== '"') return newUnmarshalErrorAfter(dec, type, ERR_NON_STRING_VALUE);
      const text = unquoteMayCopy(val, !flags.nonVerbatim);
      const callErr = callPointerMethod(type, ref.pointer, 'UnmarshalText', [byteSlice(text)]) as Value;
      return callErr === undefined ? undefined : goError(callErr);
    };
  }
  if (implementsVia(type, UNMARSHALER)) {
    result.nonDefault = true;
    const previous = result.unmarshal;
    result.unmarshal = (dec, ref, uo) => {
      if (dec.tokens.last.needObjectName) return previous(dec, ref, uo);
      const [val, err] = dec.readValue({ nonVerbatim: false });
      if (err) return err;
      const callErr = callPointerMethod(type, ref.pointer, 'UnmarshalJSON', [byteSlice(val)]) as Value;
      return callErr === undefined ? undefined : goError(callErr);
    };
  }
  return result;
}

// Entry points ----------------------------------------------------------------------------------------------------------

/** `marshalEncode`: writes the JSON encoding of an `any` argument. */
export function marshalEncode(enc: EncoderState, value: Value): LibError | undefined {
  const iface = value as Iface | undefined;
  if (iface === undefined || (kindOf(iface.type) === 'pointer' && iface.value === undefined)) {
    return enc.writeToken('n');
  }
  const mo: MarshalOptions = { seen: new Set() };
  if (kindOf(iface.type) === 'pointer') {
    return lookupArshaler(elementOf(iface.type)).marshal(enc, new Ref(iface.value as Pointer, false), mo);
  }
  return lookupArshaler(iface.type).marshal(enc, newRef(iface.type, iface.value), mo);
}

/** `unmarshalDecode`: decodes the next value into what an `any` argument points to. */
export function unmarshalDecode(
  dec: DecoderState,
  value: Value,
  uo: UnmarshalOptions,
  last: boolean
): LibError | undefined {
  const iface = value as Iface | undefined;
  if (iface === undefined || kindOf(iface.type) !== 'pointer' || iface.value === undefined) {
    return new SemanticError('unmarshal', 0, '', '', '', iface?.type, ERR_NON_NIL_REFERENCE);
  }
  const unexpectedEnd = (): LibError =>
    new SyntacticError(dec.inputOffset() + dec.unreadBuffer().length, '', UNEXPECTED_EOF);
  const checkErr = dec.checkNextValue(last);
  if (checkErr) return checkErr === EOF_ERROR && last ? unexpectedEnd() : checkErr;
  const err = lookupArshaler(elementOf(iface.type)).unmarshal(dec, new Ref(iface.value as Pointer, false), uo);
  if (err) return err === EOF_ERROR && last ? unexpectedEnd() : err;
  return last ? dec.checkEOF() : undefined;
}
