// code-gauge-allow-file fileNcss 480 -- Preserves JSON field dominance, tags and typed value handling in the composite encoder.
// oxlint-disable unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import { mapKeyOf } from '../equality';
import { currentRuntime, fn, namedType } from '../native';
import { grownCapacity } from '../sliceOps';
import { lookupStructTag } from '../structTags';
import {
  ANY,
  BASIC,
  isExported,
  type MapType,
  type NamedType,
  sliceOf,
  type Type,
  typeIdentityKey,
  underlying,
} from '../types';
import { Complex, type GoArray, GoMap, type GoStruct, Iface, Pointer, Slice, type Value } from '../values';
import {
  ALL_MARSHALER_TYPES,
  type Arshaler,
  compareBytes,
  elementOf,
  ERR_NIL_INTERFACE,
  ERR_UNKNOWN_NAME,
  goError,
  isFatal,
  MARSHALER,
  MarshalerError,
  type MarshalOptions,
  newMarshalErrorBefore,
  newRef,
  newUnmarshalErrorAfter,
  newUnmarshalErrorAfterWithSkipping,
  newUnmarshalErrorBefore,
  newUnmarshalErrorBeforeWithSkipping,
  NUMBER,
  Ref,
  TEXT_MARSHALER,
  type UnmarshalOptions,
  visiting,
} from './jsonArshalCore';
import { parseJsonFieldTag } from './jsonFieldTags';
import { type DecoderState, EncoderState, ERR_NON_STRING_NAME, SyntacticError } from './jsonText';
import { type LibError, TextError, unquoteMayCopy } from './jsonWire';
import {
  callPointerMethod,
  callValueMethod,
  fieldName,
  implementsVia,
  newVariable,
  structOf,
  zeroValue,
} from './reflection';
import { equalFold } from './strings';
import { bytesOf } from './support';
import { typeKind } from './templateReflect';

/** Finds the arshaler of a type, which the composite arshalers use for their elements. */
export type Lookup = (type: Type) => Arshaler;

const ERR_NIL_FIELD = new TextError('cannot set embedded pointer to unexported struct type');
const MAP_STRING_ANY: MapType = { kind: 'map', key: BASIC.string, value: ANY };
const SLICE_ANY = sliceOf(ANY);

/** Reads `{` or `[`, or null; reports other values as type errors. Returns 'null', 'open', or the error. */
function readOpening(dec: DecoderState, type: Type, open: '{' | '['): 'null' | 'open' | LibError {
  const [token, err] = dec.readToken();
  if (err) return err;
  if (token.kind === 'n') return 'null';
  if (token.kind !== open) return newUnmarshalErrorAfterWithSkipping(dec, type, undefined);
  return 'open';
}

/** Keeps the first non-fatal error of a composite value's members; returns a fatal one to stop at. */
class MemberErrors {
  first: LibError | undefined;

  /** Records the error, returning it when it ends unmarshaling. */
  fatal(err: LibError | undefined): LibError | undefined {
    if (err === undefined) return undefined;
    if (isFatal(err)) return err;
    this.first ??= err;
    return undefined;
  }

  /** Reads the closing delimiter, then reports the first error. */
  close(dec: DecoderState): LibError | undefined {
    const [, err] = dec.readToken();
    return err ?? this.first;
  }
}

// Maps ----------------------------------------------------------------------------------------------------------------

// code-gauge-allow functionNcss 38 -- A transcription of Go's makeMapArshaler, step by step.
// code-gauge-allow functionCognitiveComplexity 26 -- A transcription of Go's makeMapArshaler, step by step.
export function makeMapArshaler(type: Type, lookup: Lookup): Arshaler {
  const mapType = underlying(type) as MapType;
  const keyFncs = lookup(mapType.key);
  const valFncs = lookup(mapType.value);
  const sortByKey = typeKind(mapType.key) === 'string' && !keyFncs.nonDefault;
  return {
    nonDefault: false,
    marshal: (enc, ref, mo) => {
      const map = ref.get() as GoMap | undefined;
      return visiting(enc, mo, type, map, 0, () => marshalMap(enc, map, mo));
    },
    unmarshal: (dec, ref, uo) => unmarshalMap(dec, ref, uo, type, keyFncs, valFncs),
  };

  function marshalMap(enc: EncoderState, map: GoMap | undefined, mo: MarshalOptions): LibError | undefined {
    if (map === undefined) return enc.writeToken('n');
    const entries = [...map.entries.values()];
    let err = enc.writeToken('{');
    if (err) return err;
    const members = entries.length <= 1 || sortByKey ? sortedStringMembers(entries) : namedMembers(enc, entries, mo);
    if (members instanceof LibErrorBox) return members.err;
    for (const member of members) {
      err = member.name === undefined ? marshalKey(enc, member.key, mo) : enc.writeToken('"', member.name);
      err ??= valFncs.marshal(enc, newRef(mapType.value, member.value), mo);
      if (err) return err;
    }
    return enc.writeToken('}');
  }

  /** The entries with the names their keys marshal to, in name order, as Go sorts other keys. */
  function namedMembers(
    enc: EncoderState,
    entries: { key: Value; value: Value }[],
    mo: MarshalOptions
  ): Member[] | LibErrorBox {
    const members: Member[] = [];
    for (const entry of entries) {
      const start = enc.buf.length;
      const err = marshalKey(enc, entry.key, mo);
      if (err) return new LibErrorBox(err);
      members.push({ key: entry.key, value: entry.value, name: enc.unwriteObjectMemberName(start) });
    }
    return members.toSorted((a, b) => compareBytes(a.name as string, b.name as string));
  }

  function marshalKey(enc: EncoderState, key: Value, mo: MarshalOptions): LibError | undefined {
    const err = keyFncs.marshal(enc, newRef(mapType.key, key), mo);
    if (err instanceof SyntacticError && err.err === ERR_NON_STRING_NAME) {
      return newMarshalErrorBefore(enc, mapType.key, err);
    }
    return err;
  }
}

/** The entries in key order, when keys are strings marshaled as they are or there are not several. */
function sortedStringMembers(entries: { key: Value; value: Value }[]): Member[] {
  const members = entries.map(({ key, value }) => ({ key, value, name: undefined }));
  return members.length > 1 ? members.toSorted((a, b) => compareBytes(a.key as string, b.key as string)) : members;
}

interface Member {
  key: Value;
  value: Value;
  /** The name the key marshaled to, or undefined to marshal the key when writing. */
  name: string | undefined;
}

class LibErrorBox {
  constructor(readonly err: LibError) {}
}

function unmarshalMap(
  dec: DecoderState,
  ref: Ref,
  uo: UnmarshalOptions,
  type: Type,
  keyFncs: Arshaler,
  valFncs: Arshaler
): LibError | undefined {
  const opening = readOpening(dec, type, '{');
  if (opening === 'null') ref.set(undefined);
  if (opening !== 'open') return opening === 'null' ? undefined : opening;
  const mapType = underlying(type) as MapType;
  const keyOf = mapKeyOf(mapType.key);
  let map = ref.get() as GoMap | undefined;
  if (map === undefined) {
    map = new GoMap(keyOf);
    ref.set(map);
  }
  const errors = new MemberErrors();
  while (dec.peekKind() !== '}') {
    const keyRef = newRef(mapType.key);
    const keyErr = keyFncs.unmarshal(dec, keyRef, uo);
    if (keyErr) {
      const fatal = errors.fatal(keyErr) ?? dec.skipValue();
      if (fatal) return fatal;
      continue;
    }
    const key = keyRef.get();
    const valueRef = newRef(mapType.value);
    const valErr = valFncs.unmarshal(dec, valueRef, uo);
    currentRuntime().allocate(2);
    map.entries.set(keyOf(key), { key, value: valueRef.get() });
    const fatal = errors.fatal(valErr);
    if (fatal) return fatal;
  }
  return errors.close(dec);
}

// Structs -------------------------------------------------------------------------------------------------------------

interface StructField {
  id: number;
  /** The indexes of the embedded fields to go through and then of the field itself. */
  index: number[];
  type: Type;
  name: string;
  omitEmpty: boolean;
  omitZero: boolean;
  stringify: boolean;
  tagged: boolean;
}

interface StructFields {
  flattened: StructField[];
  byActualName: Map<string, StructField>;
}

interface QueueEntry {
  type: Type;
  index: number[];
  visitChildren: boolean;
}

/** Exported fields and promoted fields, selected by depth and explicit JSON names. */
function makeStructFields(root: Type): StructFields {
  const queue: QueueEntry[] = [{ type: root, index: [], visitChildren: true }];
  const seen = new Set<string>([typeIdentityKey(root)]);
  const allFields: StructField[] = [];
  for (let queueIndex = 0; queueIndex < queue.length; queueIndex++) {
    collectFields(queue[queueIndex], queue, seen, allFields);
  }
  const flattened = dominantFields(allFields);
  flattened.sort((x, y) => x.id - y.id);
  for (const [i, field] of flattened.entries()) field.id = i;
  flattened.sort((x, y) => compareIndexes(x.index, y.index));
  return { flattened, byActualName: new Map(flattened.map((field) => [field.name, field])) };
}

/** Adds the fields of one struct, queueing its embedded structs to visit later, as breadth-first order requires. */
// code-gauge-allow functionCognitiveComplexity 20 -- Preserves JSON field dominance, tags and typed value handling in the composite encoder.
function collectFields(entry: QueueEntry, queue: QueueEntry[], seen: Set<string>, allFields: StructField[]): void {
  const struct = structOf(entry.type);
  if (!struct) return;
  for (const [i, field] of struct.fields.entries()) {
    const tag = lookupStructTag(field.tag, 'json');
    if (tag === '-') continue;
    const { name: tagName, options } = parseJsonFieldTag(tag);
    const tagged = tagName !== undefined;
    const fieldExported = isExported(field.name);
    if (!fieldExported && !field.embedded) continue;
    const index = [...entry.index, i];
    const embedded = field.type.kind === 'pointer' ? field.type.element : field.type;
    if (!tagged && field.embedded && typeKind(embedded) === 'struct') {
      const key = typeIdentityKey(embedded);
      if (entry.visitChildren) queue.push({ type: embedded, index, visitChildren: !seen.has(key) });
      seen.add(key);
    } else if (fieldExported) {
      const name = fieldName(tagged ? tagName : field.name);
      allFields.push({
        id: allFields.length,
        index,
        type: field.type,
        name,
        omitEmpty: options.includes('omitempty'),
        omitZero: options.includes('omitzero'),
        stringify: options.includes('string') && stringTagType(field.type),
        tagged,
      });
    }
  }
}

/** The field of each name that dominates the others: the only shallowest one. */
function dominantFields(allFields: StructField[]): StructField[] {
  const sorted = allFields.toSorted((x, y) => compareBytes(x.name, y.name) || x.index.length - y.index.length);
  const flattened: StructField[] = [];
  for (let start = 0; start < sorted.length;) {
    let end = start + 1;
    while (end < sorted.length && sorted[end].name === sorted[start].name) end++;
    if (end - start === 1 || sorted[start].index.length !== sorted[start + 1].index.length) {
      flattened.push(sorted[start]);
    } else {
      const shallow = sorted
        .slice(start, end)
        .filter((field) => field.index.length === sorted[start].index.length && field.tagged);
      if (shallow.length === 1) flattened.push(shallow[0]);
    }
    start = end;
  }
  return flattened;
}

function compareIndexes(x: number[], y: number[]): number {
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}

export function makeStructArshaler(type: Type, lookup: Lookup): Arshaler {
  const fields = makeStructFields(type);
  return {
    nonDefault: false,
    marshal: (enc, ref, mo) => {
      let err = enc.writeToken('{');
      if (err) return err;
      for (const field of fields.flattened) {
        const value = walkField(ref, type, field, false);
        if (
          !value ||
          (field.omitEmpty && emptyJsonValue(value.get(), field.type)) ||
          (field.omitZero && zeroJsonValue(value, field.type))
        )
          continue;
        err = enc.writeToken('"', field.name);
        err ??= marshalField(enc, value, field, mo, lookup);
        if (err) return err;
      }
      return enc.writeToken('}');
    },
    unmarshal: (dec, ref, uo) => unmarshalStruct(dec, ref, uo, type, fields, lookup),
  };
}

// code-gauge-allow functionCognitiveComplexity 16 -- A transcription of Go's unmarshalStruct, step by step.
function unmarshalStruct(
  dec: DecoderState,
  ref: Ref,
  uo: UnmarshalOptions,
  type: Type,
  fields: StructFields,
  lookup: Lookup
): LibError | undefined {
  const opening = readOpening(dec, type, '{');
  if (opening !== 'open') return opening === 'null' ? undefined : opening;
  const errors = new MemberErrors();
  while (dec.peekKind() !== '}') {
    const flags = { nonVerbatim: false };
    const [raw, nameErr] = dec.readValue(flags);
    if (nameErr) return nameErr;
    const field = findField(fields, unquoteMayCopy(raw, !flags.nonVerbatim));
    const value = field && walkField(ref, type, field, true);
    let fieldErr: LibError | undefined;
    if (!field) {
      if (uo.rejectUnknownMembers) errors.first ??= newUnmarshalErrorAfter(dec, type, ERR_UNKNOWN_NAME);
      fieldErr = dec.skipValue();
    } else if (value) {
      fieldErr = unmarshalField(dec, value, field, uo, lookup);
    } else {
      errors.first ??= newUnmarshalErrorBefore(dec, type, ERR_NIL_FIELD);
      fieldErr = dec.skipValue();
    }
    const fatal = errors.fatal(fieldErr);
    if (fatal) return fatal;
  }
  return errors.close(dec);
}

/** The field an object member's name refers to: the exact name, or else the first case-insensitive match. */
function findField(fields: StructFields, name: string): StructField | undefined {
  return (
    fields.byActualName.get(name) ??
    fields.flattened.filter((candidate) => equalFold(name, candidate.name)).toSorted((a, b) => a.id - b.id)[0]
  );
}

/** `fieldByIndex`: the field's variable, allocating nil embedded pointers when unmarshaling. */
function walkField(ref: Ref, type: Type, field: StructField, mayAlloc: boolean): Ref | undefined {
  let current = ref;
  let currentType = type;
  for (const [step, i] of field.index.entries()) {
    if (step > 0 && typeKind(currentType) === 'pointer') {
      let target = current.get() as Pointer | undefined;
      if (target === undefined) {
        if (!mayAlloc || readOnlyAt(type, field, step)) return undefined;
        target = newVariable(elementOf(currentType));
        current.set(target);
      }
      current = new Ref(target, false);
      currentType = elementOf(currentType);
    }
    const structType = structOf(currentType);
    if (!structType) return undefined;
    current = new Ref(new Pointer((current.get() as GoStruct).fields, i), current.forcedAddr);
    currentType = structType.fields[i].type;
  }
  return current;
}

/** Whether the embedded field at the step of the path is reached through an unexported field. */
function readOnlyAt(type: Type, field: StructField, step: number): boolean {
  let currentType = type;
  for (const i of field.index.slice(0, step)) {
    if (typeKind(currentType) === 'pointer') currentType = elementOf(currentType);
    const struct = structOf(currentType);
    if (!struct || !isExported(struct.fields[i].name)) return true;
    currentType = struct.fields[i].type;
  }
  return false;
}

// Slices, arrays, and pointers ------------------------------------------------------------------------------------------

export function makeListArshaler(type: Type, lookup: Lookup): Arshaler {
  const isArray = typeKind(type) === 'array';
  const element = elementOf(type);
  const valFncs = lookup(element);
  return {
    nonDefault: false,
    marshal: (enc, ref, mo) => {
      const list = ref.get() as Slice | GoArray | undefined;
      if (list === undefined) return enc.writeToken('n');
      if (list instanceof Slice) {
        return visiting(enc, mo, type, list, list.length, () =>
          marshalElements(enc, list.array, list.offset, list.length, false, mo)
        );
      }
      return marshalElements(enc, list.elements, 0, list.elements.length, ref.forcedAddr, mo);
    },
    unmarshal: (dec, ref, uo) =>
      isArray ? unmarshalArray(dec, ref, uo, type, valFncs) : unmarshalSlice(dec, ref, uo, type, valFncs),
  };

  function marshalElements(
    enc: EncoderState,
    array: Value[],
    offset: number,
    length: number,
    forcedAddr: boolean,
    mo: MarshalOptions
  ): LibError | undefined {
    let err = enc.writeToken('[');
    if (err) return err;
    for (let i = 0; i < length; i++) {
      err = valFncs.marshal(enc, new Ref(new Pointer(array, offset + i), forcedAddr), mo);
      if (err) return err;
    }
    return enc.writeToken(']');
  }
}

function unmarshalSlice(
  dec: DecoderState,
  ref: Ref,
  uo: UnmarshalOptions,
  type: Type,
  valFncs: Arshaler
): LibError | undefined {
  const opening = readOpening(dec, type, '[');
  if (opening === 'null') ref.set(undefined);
  if (opening !== 'open') return opening === 'null' ? undefined : opening;
  const element = elementOf(type);
  const slice = ref.get() as Slice | undefined;
  let [array, offset, capacity] = [slice?.array ?? [], slice?.offset ?? 0, slice?.capacity ?? 0];
  let i = 0;
  const errors = new MemberErrors();
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
    const fatal = errors.fatal(valFncs.unmarshal(dec, elementRef, uo));
    if (fatal) {
      ref.set(new Slice(array, offset, i, capacity));
      return fatal;
    }
  }
  ref.set(i === 0 ? new Slice([], 0, 0, 0) : new Slice(array, offset, i, capacity));
  return errors.close(dec);
}

function unmarshalArray(
  dec: DecoderState,
  ref: Ref,
  uo: UnmarshalOptions,
  type: Type,
  valFncs: Arshaler
): LibError | undefined {
  const opening = readOpening(dec, type, '[');
  if (opening !== 'open') return opening === 'null' ? undefined : opening;
  const elements = (ref.get() as GoArray).elements;
  let i = 0;
  const errors = new MemberErrors();
  for (; dec.peekKind() !== ']'; i++) {
    const err =
      i < elements.length
        ? errors.fatal(valFncs.unmarshal(dec, new Ref(new Pointer(elements, i), ref.forcedAddr), uo))
        : dec.skipValue();
    if (err) return err;
  }
  for (; i < elements.length; i++) elements[i] = zeroValue(elementOf(type));
  return errors.close(dec);
}

export function makePointerArshaler(type: Type, lookup: Lookup): Arshaler {
  const element = elementOf(type);
  const valFncs = lookup(element);
  return {
    nonDefault: false,
    marshal: (enc, ref, mo) => {
      const pointer = ref.get() as Pointer | undefined;
      return visiting(enc, mo, type, pointer, 0, () =>
        pointer === undefined ? enc.writeToken('n') : valFncs.marshal(enc, new Ref(pointer, false), mo)
      );
    },
    unmarshal: (dec, ref, uo) => {
      if (dec.peekKind() === 'n') {
        const [, err] = dec.readToken();
        if (!err) ref.set(undefined);
        return err;
      }
      let pointer = ref.get() as Pointer | undefined;
      if (pointer === undefined) {
        pointer = newVariable(element);
        ref.set(pointer);
      }
      const error = valFncs.unmarshal(dec, new Ref(pointer, false), uo);
      if (!error && uo.stringify && dec.previousTokenOrValue() === '"null"') ref.set(undefined);
      return error;
    },
  };
}

// Interfaces ----------------------------------------------------------------------------------------------------------

export function makeInterfaceArshaler(type: Type, lookup: Lookup): Arshaler {
  const isAny = (underlying(type) as { methods: unknown[] }).methods.length === 0;
  const legacyMarshaler = ALL_MARSHALER_TYPES.find((iface) => implementsVia(type, iface) === 'value');
  return {
    nonDefault: false,
    marshal: (enc, ref, mo) => {
      const iface = ref.get() as Iface | undefined;
      if (iface === undefined) return enc.writeToken('n');
      if (legacyMarshaler && typeKind(iface.type) === 'pointer' && iface.value === undefined) {
        return marshalNilPointerWithMethod(enc, iface, legacyMarshaler);
      }
      return lookup(iface.type).marshal(enc, newRef(iface.type, iface.value), mo);
    },
    unmarshal: (dec, ref, uo) => {
      const nullErr = unmarshalNullInterface(dec, ref);
      if (nullErr !== 'not null') return nullErr;
      const existing = ref.get() as Iface | undefined;
      if (existing === undefined && !isAny) return newUnmarshalErrorBeforeWithSkipping(dec, type, ERR_NIL_INTERFACE);
      const valueType = existing?.type ?? anyValueType(dec, uo);
      if (valueType === undefined) return dec.readValue({ nonVerbatim: false })[1];
      const valueRef = newRef(valueType, existing?.value ?? zeroValue(valueType));
      const err = lookup(valueType).unmarshal(dec, valueRef, uo);
      ref.set(new Iface(valueType, valueRef.get()));
      return err;
    },
  };
}

/**
 * Handles v1's merging into an interface's value and JSON null: keeps only a non-nil pointer to merge into, and stores
 * nil for null. Returns 'not null' when a value remains to unmarshal.
 */
function unmarshalNullInterface(dec: DecoderState, ref: Ref): LibError | undefined | 'not null' {
  const current = ref.get() as Iface | undefined;
  const mergeable = current !== undefined && typeKind(current.type) === 'pointer' && current.value !== undefined;
  if (current !== undefined && !mergeable) ref.set(undefined);
  if (dec.peekKind() !== 'n') return 'not null';
  const [, err] = dec.readToken();
  if (err) return err;
  if (mergeable && typeKind(elementOf(current.type)) === 'pointer') (current.value as Pointer).store(undefined);
  else ref.set(undefined);
  return undefined;
}

/** The type that unmarshaling into an empty interface makes for the next value. */
function anyValueType(dec: DecoderState, uo: UnmarshalOptions): Type | undefined {
  switch (dec.peekKind()) {
    case 'f':
    case 't': {
      return BASIC.bool;
    }
    case '"': {
      return BASIC.string;
    }
    case '0': {
      return uo.useNumber ? NUMBER : BASIC.float64;
    }
    case '{': {
      return MAP_STRING_ANY;
    }
    case '[': {
      return SLICE_ANY;
    }
    default: {
      return undefined;
    }
  }
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

function emptyJsonValue(value: Value, type: Type): boolean {
  const under = underlying(type);
  if (under.kind === 'basic') return value === false || value === 0n || value === 0 || value === '';
  if (under.kind === 'array') return under.length === 0;
  if (under.kind === 'slice') return ((value as Slice | undefined)?.length ?? 0) === 0;
  if (under.kind === 'map') return ((value as GoMap | undefined)?.entries.size ?? 0) === 0;
  return value === undefined;
}

const IS_ZERO = namedType('json', 'isZeroer', {
  kind: 'interface',
  methods: [{ name: 'IsZero', type: fn([], [BASIC.bool]) }],
});

function stringTagType(type: Type): boolean {
  const declared = underlying(type);
  const scalar = declared.kind === 'pointer' ? declared.element : type;
  const under = underlying(scalar);
  return under.kind === 'basic' && !['complex64', 'complex128', 'unsafe.Pointer'].includes(under.name);
}

function marshalField(
  enc: EncoderState,
  value: Ref,
  field: StructField,
  mo: MarshalOptions,
  lookup: Lookup
): LibError | undefined {
  const arshaler = lookup(field.type);
  if (!field.stringify || arshaler.nonDefault || value.get() === undefined) return arshaler.marshal(enc, value, mo);
  const inner = new EncoderState(enc.options);
  const err = arshaler.marshal(inner, value, mo);
  return err ?? enc.writeToken('"', inner.buf);
}

function unmarshalField(
  dec: DecoderState,
  value: Ref,
  field: StructField,
  uo: UnmarshalOptions,
  lookup: Lookup
): LibError | undefined {
  return lookup(field.type).unmarshal(dec, value, { ...uo, stringify: field.stringify });
}

function zeroJsonValue(ref: Ref, type: Type): boolean {
  const value = ref.get();
  if (value === undefined) return true;
  const method = implementsVia(type, IS_ZERO);
  if (method === 'value') return callValueMethod(type, value, 'IsZero', []) as boolean;
  if (method === 'pointer') {
    return callPointerMethod(type, ref.pointer, 'IsZero', []) as boolean;
  }
  return structuralZero(value, type);
}

function structuralZero(value: Value, type: Type): boolean {
  if (value === undefined) return true;
  const under = underlying(type);
  if (under.kind === 'struct')
    return under.fields.every((field, index) => structuralZero((value as GoStruct).fields[index], field.type));
  if (under.kind === 'array')
    return (value as GoArray).elements.every((element) => structuralZero(element, under.element));
  if (under.kind !== 'basic') return false;
  if (value instanceof Complex) return value.re === 0 && value.im === 0;
  return value === false || value === 0n || value === 0 || value === '';
}
