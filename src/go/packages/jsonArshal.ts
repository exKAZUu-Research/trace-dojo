// oxlint-disable unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import { quote } from '../quote';
import { type NamedType, pointerTo, type SliceType, type Type, typeIdentityKey, underlying } from '../types';
import { type Iface, type Pointer, type Slice, type Value } from '../values';
import {
  makeInterfaceArshaler,
  makeListArshaler,
  makeMapArshaler,
  makePointerArshaler,
  makeStructArshaler,
} from './jsonArshalComposite';
import {
  ALL_METHOD_TYPES,
  type Arshaler,
  elementOf,
  ERR_NON_NIL_REFERENCE,
  ERR_NON_STRING_VALUE,
  goError,
  MARSHALER,
  MarshalerError,
  type MarshalOptions,
  newMarshalErrorBefore,
  newRef,
  newUnmarshalErrorAfter,
  newUnmarshalErrorAfterWithSkipping,
  newUnmarshalErrorAfterWithValue,
  NUMBER,
  Ref,
  SemanticError,
  TEXT_APPENDER,
  TEXT_MARSHALER,
  TEXT_UNMARSHALER,
  UNMARSHALER,
  type UnmarshalOptions,
  ValueError,
} from './jsonArshalCore';
import { base64Decode, base64Encode } from './jsonBase64';
import { type DecoderState, type EncoderState, kindOf as jsonKindOf, SyntacticError } from './jsonText';
import type { LibError } from './jsonWire';
import {
  consumeNumber,
  EOF_ERROR,
  formatJSONFloat,
  parseUintWire,
  STRCONV_RANGE,
  STRCONV_SYNTAX,
  TextError,
  UNEXPECTED_EOF,
  unquote,
  unquoteMayCopy,
} from './jsonWire';
import { bitsOf, callPointerMethod, implementsVia } from './reflection';
import { parseFloat } from './strconv';
import { byteSlice, bytesOf, errorText } from './support';
import { typeKind } from './templateReflect';

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
  switch (typeKind(type)) {
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
      return lazy(() => makeMapArshaler(type, lookupArshaler));
    }
    case 'struct': {
      return lazy(() => makeStructArshaler(type, lookupArshaler));
    }
    case 'slice':
    case 'array': {
      const element = (underlying(type) as SliceType).element;
      const list = lazy(() => makeListArshaler(type, lookupArshaler));
      if (typeKind(element) === 'uint' && bitsOf(element) === 8 && underlying(element).kind === 'basic') {
        return makeBytesArshaler(type, list);
      }
      return list;
    }
    case 'pointer': {
      return lazy(() => makePointerArshaler(type, lookupArshaler));
    }
    case 'interface': {
      return makeInterfaceArshaler(type, lookupArshaler);
    }
    default: {
      return makeInvalidArshaler(type);
    }
  }
}

// code-gauge-allow functionCognitiveComplexity 20 -- Transcribes the typed Go arshalers so tagged and ordinary values share diagnostics.
function makeBoolArshaler(type: Type): Arshaler {
  return {
    nonDefault: false,
    marshal: (enc, ref) => enc.writeToken(ref.get() ? 't' : 'f'),
    unmarshal: (dec, ref, uo) => {
      const [token, err] = dec.readToken();
      if (err) return err;
      if (token.kind === 'n') return;
      if (!uo.stringify && (token.kind === 't' || token.kind === 'f')) {
        ref.set(token.kind === 't');
        return;
      }
      if (uo.stringify && token.kind === '"') {
        const text = unquoteMayCopy(token.raw as string, false);
        if (text === 'null') return;
        if (text !== 'true' && text !== 'false') return newUnmarshalErrorAfterWithValue(dec, type, STRCONV_SYNTAX);
        ref.set(text === 'true');
        return;
      }
      return newUnmarshalErrorAfterWithSkipping(dec, type, undefined);
    },
  };
}

// code-gauge-allow functionCognitiveComplexity 17 -- Transcribes the typed Go arshalers so tagged and ordinary values share diagnostics.
function makeStringArshaler(type: Type): Arshaler {
  return {
    nonDefault: false,
    marshal: (enc, ref) => enc.writeToken('"', ref.get() as string),
    unmarshal: (dec, ref, uo) => {
      const flags = { nonVerbatim: false };
      const [val, err] = dec.readValue(flags);
      if (err) return err;
      if (val[0] === 'n') return;
      if (val[0] === '"') {
        let text = unquoteMayCopy(val, !flags.nonVerbatim);
        if (uo.stringify) {
          if (text === 'null') return;
          const [decoded, error] = unquote(text);
          if (error) return newUnmarshalErrorAfter(dec, type, new SyntacticError(0, '', error));
          text = decoded;
        }
        ref.set(text);
        return;
      }
      return newUnmarshalErrorAfter(dec, type, undefined);
    },
  };
}

// code-gauge-allow functionCognitiveComplexity 23 -- Transcribes the typed Go arshalers so tagged and ordinary values share diagnostics.
function makeIntArshaler(type: Type): Arshaler {
  const bits = bitsOf(type);
  const signed = typeKind(type) === 'int';
  return {
    nonDefault: false,
    marshal: (enc, ref) => {
      const text = String(ref.get() as bigint);
      return enc.tokens.last.needObjectName ? enc.appendRaw('"', text) : enc.appendRaw('0', text);
    },
    unmarshal: (dec, ref, uo) => {
      const stringify = dec.tokens.last.needObjectName || uo.stringify;
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
    unmarshal: (dec, ref, uo) => unmarshalFloat(dec, ref, type, bits, uo.stringify),
  };
}

function unmarshalFloat(
  dec: DecoderState,
  ref: Ref,
  type: Type,
  bits: 32 | 64,
  stringTag = false
): LibError | undefined {
  const stringify = dec.tokens.last.needObjectName || stringTag;
  const flags = { nonVerbatim: false };
  const [raw, err] = dec.readValue(flags);
  if (err) return err;
  const kind = jsonKindOf(raw[0]);
  if (kind === 'n') return undefined;
  const quoted = kind === '"';
  if (quoted !== stringify || (!quoted && kind !== '0')) return newUnmarshalErrorAfter(dec, type, undefined);
  const val = quoted ? unquoteMayCopy(raw, !flags.nonVerbatim) : raw;
  const [value, parseErr] = parseFloatText(val, bits);
  if (parseErr) return quoted && val === 'null' ? undefined : newUnmarshalErrorAfterWithValue(dec, type, parseErr);
  ref.set(value);
  return undefined;
}

/** `strconv.ParseFloat`, with its unwrapped error. */
function parseFloatText(text: string, bits: 32 | 64): [number, LibError | undefined] {
  const [value, err] = parseFloat(text, bits);
  if (err === undefined) return [value, undefined];
  return [value, errorText(err).endsWith('value out of range') ? STRCONV_RANGE : STRCONV_SYNTAX];
}

// code-gauge-allow functionCognitiveComplexity 17 -- A transcription of Go's makeBytesArshaler, step by step.
function makeBytesArshaler(type: Type, list: Arshaler): Arshaler {
  const isArray = typeKind(type) === 'array';
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

// code-gauge-allow functionNcss 33 -- A transcription of Go's makeNumberArshaler, step by step.
// code-gauge-allow functionCognitiveComplexity 20 -- A transcription of Go's makeNumberArshaler, step by step.
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

// Methods ---

/** `makeMethodArshaler`: the program's MarshalJSON, MarshalText, UnmarshalJSON, and UnmarshalText methods. */
// code-gauge-allow functionCognitiveComplexity 16 -- A transcription of Go's makeMethodArshaler, step by step.
function makeMethodArshaler(fncs: Arshaler, type: Type): Arshaler {
  const kind = typeKind(type);
  if (kind === 'pointer' || kind === 'interface' || type === NUMBER) return fncs;
  const result = { ...fncs };
  const pointerType = pointerTo(type);
  addMarshalMethod(result, type, TEXT_MARSHALER, (enc, pointer) => marshalText(enc, type, pointer, 'MarshalText', []));
  addMarshalMethod(result, type, TEXT_APPENDER, (enc, pointer) =>
    marshalText(enc, type, pointer, 'AppendText', [undefined])
  );
  addMarshalMethod(result, type, MARSHALER, (enc, pointer) => {
    const [val, err] = callPointerMethod(type, pointer, 'MarshalJSON', []) as [Value, Value];
    if (err !== undefined) return new MarshalerError(pointerType, goError(err), 'MarshalJSON');
    const writeErr = enc.writeValue(bytesOf(val));
    return writeErr && new MarshalerError(pointerType, writeErr, 'MarshalJSON');
  });
  if (implementsVia(type, TEXT_UNMARSHALER)) {
    result.nonDefault = true;
    result.unmarshal = (dec, ref) => unmarshalText(dec, ref, type);
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

/**
 * Makes `result` marshal with a method of the interface when the type has it, falling back to the previous function
 * as v1 does: for a pointer method of a value that is not addressable, and for object names other than text.
 */
function addMarshalMethod(
  result: Arshaler,
  type: Type,
  iface: NamedType,
  call: (enc: EncoderState, pointer: Pointer) => LibError | undefined
): void {
  const via = implementsVia(type, iface);
  if (!via) return;
  result.nonDefault = true;
  const previous = result.marshal;
  const fallbackAtName = iface === MARSHALER || typeKind(type) === 'string';
  result.marshal = (enc, ref, mo) => {
    if ((via === 'pointer' && ref.forcedAddr) || (enc.tokens.last.needObjectName && fallbackAtName)) {
      return previous(enc, ref, mo);
    }
    return call(enc, ref.pointer);
  };
}

function marshalText(
  enc: EncoderState,
  type: Type,
  pointer: Pointer,
  method: string,
  args: Value[]
): LibError | undefined {
  const [text, err] = callPointerMethod(type, pointer, method, args) as [Value, Value];
  if (err !== undefined) return new MarshalerError(pointerTo(type), goError(err), method);
  return enc.appendRaw('"', bytesOf(text));
}

function unmarshalText(dec: DecoderState, ref: Ref, type: Type): LibError | undefined {
  const flags = { nonVerbatim: false };
  const [val, err] = dec.readValue(flags);
  if (err) return err;
  if (val[0] === 'n') return undefined;
  if (val[0] !== '"') return newUnmarshalErrorAfter(dec, type, ERR_NON_STRING_VALUE);
  const text = unquoteMayCopy(val, !flags.nonVerbatim);
  const callErr = callPointerMethod(type, ref.pointer, 'UnmarshalText', [byteSlice(text)]) as Value;
  return callErr === undefined ? undefined : goError(callErr);
}

// Entry points ----------------------------------------------------------------------------------------------------------

/** `marshalEncode`: writes the JSON encoding of an `any` argument. */
export function marshalEncode(enc: EncoderState, value: Value): LibError | undefined {
  const iface = value as Iface | undefined;
  if (iface === undefined || (typeKind(iface.type) === 'pointer' && iface.value === undefined)) {
    return enc.writeToken('n');
  }
  const mo: MarshalOptions = { seen: new Set() };
  if (typeKind(iface.type) === 'pointer') {
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
  if (iface === undefined || typeKind(iface.type) !== 'pointer' || iface.value === undefined) {
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
