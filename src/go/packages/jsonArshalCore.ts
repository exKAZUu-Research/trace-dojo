// oxlint-disable unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import { fn, namedType } from '../native';
import { BASIC, ERROR_TYPE, sliceOf, type Type, typeIdentityKey, typeString, underlying } from '../types';
import { copyValue, Pointer, Slice, type Value } from '../values';
import {
  type DecoderState,
  type EncoderState,
  IoError,
  type Kind,
  kindOf as jsonKindOf,
  SyntacticError,
} from './jsonText';
import { EOF_ERROR, GoValueError, LibError, TextError, UNEXPECTED_EOF } from './jsonWire';
import { newVariable, zeroValue } from './reflection';
import { errorText } from './support';

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
export const TEXT_APPENDER = namedType('encoding', 'TextAppender', {
  kind: 'interface',
  methods: [{ name: 'AppendText', type: fn([BYTES], [BYTES, ERROR_TYPE]) }],
});
export const ALL_METHOD_TYPES = [MARSHALER, TEXT_APPENDER, TEXT_MARSHALER, UNMARSHALER, TEXT_UNMARSHALER];

/** `json.Number`. */
export const NUMBER = namedType('json', 'Number', BASIC.string);
/** `json.RawMessage`, an alias of `jsontext.Value`. */
export const RAW_MESSAGE = namedType('encoding/json/jsontext', 'Value', BYTES);

// Errors ------------------------------------------------------------------------------------------------------------

export const ERR_CYCLE = new TextError('encountered a cycle');
export const ERR_NON_NIL_REFERENCE = new TextError('value must be passed as a non-nil pointer reference');
export const ERR_NIL_INTERFACE = new TextError('cannot derive concrete type for nil interface with finite type set');
export const ERR_UNKNOWN_NAME = new TextError('unknown object member name');
export const ERR_NON_STRING_VALUE = new TextError('JSON value must be string type');

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
export class ValueError extends LibError {
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

export function newMarshalErrorBefore(
  enc: EncoderState,
  type: Type | undefined,
  err: LibError | undefined
): SemanticError {
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

export function newUnmarshalErrorBefore(dec: DecoderState, type: Type, err: LibError | undefined): SemanticError {
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

export function newUnmarshalErrorBeforeWithSkipping(
  dec: DecoderState,
  type: Type,
  err: LibError | undefined
): LibError {
  const error = newUnmarshalErrorBefore(dec, type, err);
  return dec.skipValue() ?? error;
}

export function newUnmarshalErrorAfter(dec: DecoderState, type: Type, err: LibError | undefined): SemanticError {
  const tokOrVal = dec.previousTokenOrValue();
  const kind = jsonKindOf(tokOrVal.trimStart()[0]);
  let offset = dec.inputOffset() - tokOrVal.length;
  offset += kind === '[' || kind === '{' ? 1 : tokOrVal.length;
  return new SemanticError('unmarshal', offset, dec.stackPointer(-1), kind, '', type, toUnexpectedEOF(err));
}

export function newUnmarshalErrorAfterWithValue(
  dec: DecoderState,
  type: Type,
  err: LibError | undefined
): SemanticError {
  const error = newUnmarshalErrorAfter(dec, type, err);
  if (error.kind === '"' || error.kind === '0') error.value = dec.previousTokenOrValue();
  return error;
}

export function newUnmarshalErrorAfterWithSkipping(dec: DecoderState, type: Type, err: LibError | undefined): LibError {
  const error = newUnmarshalErrorAfter(dec, type, err);
  return dec.skipValueRemainder() ?? error;
}

/** Whether an unmarshal error stops decoding, which with v1's semantics only syntax and I/O errors do. */
export function isFatal(err: LibError): boolean {
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

export interface MarshalOptions {
  /** The pointers being marshaled below depth 1000, for detecting cycles. */
  seen: Set<string>;
}

export interface UnmarshalOptions {
  useNumber: boolean;
  rejectUnknownMembers: boolean;
}

export type Marshal = (enc: EncoderState, ref: Ref, mo: MarshalOptions) => LibError | undefined;
export type Unmarshal = (dec: DecoderState, ref: Ref, uo: UnmarshalOptions) => LibError | undefined;

export interface Arshaler {
  marshal: Marshal;
  unmarshal: Unmarshal;
  nonDefault: boolean;
}

const START_DETECTING_CYCLES_AFTER = 1000;

/** The arshalers of the marshal methods that v1 calls on an interface's nil pointer, in Go's order. */
export const ALL_MARSHALER_TYPES = ALL_METHOD_TYPES.slice(0, 3);

export function newRef(type: Type, value: Value = zeroValue(type)): Ref {
  return new Ref(newVariable(type, copyValue(value)), true);
}

export function compareBytes(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export function elementOf(type: Type): Type {
  return (underlying(type) as { element: Type }).element;
}

export function goError(value: Value): GoValueError {
  return new GoValueError(value, errorText(value));
}

/**
 * Marshals with `visitPointer`'s cycle detection, which Go starts below a depth of 1000: the key identifies the pointer,
 * map, or slice, its type, and its length.
 */
export function visiting(
  enc: EncoderState,
  mo: MarshalOptions,
  type: Type,
  target: object | undefined,
  length: number,
  marshal: () => LibError | undefined
): LibError | undefined {
  if (enc.tokens.depth <= START_DETECTING_CYCLES_AFTER || target === undefined) return marshal();
  const key = `${identityOf(target)}|${typeIdentityKey(type)}|${length}`;
  if (mo.seen.has(key)) return newMarshalErrorBefore(enc, type, ERR_CYCLE);
  mo.seen.add(key);
  try {
    return marshal();
  } finally {
    mo.seen.delete(key);
  }
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
