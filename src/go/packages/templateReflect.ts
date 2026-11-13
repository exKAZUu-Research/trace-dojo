// oxlint-disable unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255, which charCodeAt reads as raw bytes.
import { assignFailure } from '../assignability';
import { decodeRune } from '../literals';
import { dynamicMethod } from '../methods';
import { namedType } from '../native';
import { plainPanic } from '../runtimeErrors';
import {
  BASIC,
  ERROR_TYPE,
  type FuncType,
  integerBits,
  type InterfaceType,
  isInterface,
  lookupFieldOrMethod,
  missingMethod,
  pointerTo,
  type StructType,
  type Type,
  typeString,
  underlying,
} from '../types';
import { copyValue, GoArray, GoFunc, GoMap, GoStruct, Iface, Pointer, Slice, type Value } from '../values';
import { zeroValue } from './reflection';
import { stringPanic } from './support';
import { isUpper } from './unicodeSupport';

/**
 * A valid `reflect.Value`: a value with its static type, and the location it was read from when it is addressable.
 * `undefined` stands for the invalid (zero) `reflect.Value`.
 */
export interface RV {
  readonly type: Type;
  readonly value: Value;
  readonly addr?: Pointer;
}

export type RValue = RV | undefined;

export type Kind =
  | 'bool'
  | 'int'
  | 'uint'
  | 'float'
  | 'complex'
  | 'string'
  | 'array'
  | 'slice'
  | 'map'
  | 'struct'
  | 'pointer'
  | 'interface'
  | 'func'
  | 'invalid';

/** `reflect.Value`, as the parameter and result type of the builtin functions that take values as they are. */
export const REFLECT_VALUE = namedType('reflect', 'Value', { kind: 'struct', fields: [] });

/** `fmt.Stringer`. */
const STRINGER: InterfaceType = {
  kind: 'interface',
  methods: [{ name: 'String', type: { kind: 'func', params: [], results: [BASIC.string], variadic: false } }],
};

const MISSING_TYPE = namedType('template', 'missingValType', { kind: 'struct', fields: [] });

/** The value standing for an argument that a pipeline does not pass. */
export const MISSING: RV = { type: MISSING_TYPE, value: new GoStruct([]) };

export function isMissing(value: RValue): boolean {
  return value?.type === MISSING_TYPE;
}

export function typeKind(type: Type): Kind {
  const under = underlying(type);
  switch (under.kind) {
    case 'basic': {
      const { basic } = under;
      if (basic === 'bool') return 'bool';
      if (basic === 'string') return 'string';
      if (basic === 'float32' || basic === 'float64') return 'float';
      if (basic === 'complex64' || basic === 'complex128') return 'complex';
      if (basic.startsWith('uint')) return 'uint';
      if (basic.startsWith('int')) return 'int';
      return 'invalid';
    }
    case 'pointer': {
      return 'pointer';
    }
    case 'array':
    case 'slice':
    case 'map':
    case 'struct':
    case 'interface':
    case 'func': {
      return under.kind;
    }
    default: {
      return 'invalid';
    }
  }
}

export function kindOf(value: RValue): Kind {
  return value ? typeKind(value.type) : 'invalid';
}

/** `reflect.ValueOf` of an `any` value. */
export function valueOf(value: Value): RValue {
  if (!(value instanceof Iface)) return undefined;
  return { type: value.type, value: value.value };
}

/** `Value.Interface`: the value as an `any`. */
export function interfaceOf(value: RValue): Value {
  if (!value) return undefined;
  if (isInterface(value.type)) return value.value;
  return new Iface(value.type, copyValue(value.value));
}

/** The value converted for a variable of type `to`, which it is assignable to. */
export function toGoValue(value: RValue, to: Type): Value {
  if (!value) return zeroValue(to);
  if (isInterface(to) && !isInterface(value.type)) return new Iface(value.type, copyValue(value.value));
  return copyValue(value.value);
}

/** `reflect.Zero`, where the zero `reflect.Value` holds the invalid value. */
export function zeroRV(type: Type): RValue {
  if (type === REFLECT_VALUE) return undefined;
  return { type, value: zeroValue(type) };
}

export function canBeNil(type: Type): boolean {
  if (type === REFLECT_VALUE) return true;
  return ['func', 'interface', 'map', 'pointer', 'slice'].includes(typeKind(type));
}

export function isNilValue(value: RV): boolean {
  return value.value === undefined;
}

/** `Value.Elem` of an interface or a pointer. */
export function elem(value: RV): RValue {
  if (typeKind(value.type) === 'interface') return valueOf(value.value);
  const pointer = value.value as Pointer | undefined;
  if (!pointer) return undefined;
  const element = (underlying(value.type) as { element: Type }).element;
  return { type: element, value: pointer.load(), addr: pointer };
}

/** Goes through pointers and interfaces to the value they hold, stopping at a nil one. */
export function indirect(value: RValue): [RValue, boolean] {
  let current = value;
  while (current && (kindOf(current) === 'pointer' || kindOf(current) === 'interface')) {
    if (isNilValue(current)) return [current, true];
    current = elem(current);
  }
  return [current, false];
}

export function indirectInterface(value: RValue): RValue {
  if (kindOf(value) !== 'interface') return value;
  return elem(value as RV);
}

export function addrOf(value: RV): RV {
  return { type: pointerTo(value.type), value: value.addr };
}

export function assignableTo(from: Type, to: Type): boolean {
  return !assignFailure(from, to);
}

export function implementsError(type: Type): boolean {
  return !missingMethod(type, ERROR_TYPE.underlying as InterfaceType);
}

export function implementsStringer(type: Type): boolean {
  return !missingMethod(type, STRINGER);
}

export function lengthOf(value: RV): number {
  const raw = value.value;
  if (typeof raw === 'string') return raw.length;
  if (raw instanceof Slice) return raw.length;
  if (raw instanceof GoArray) return raw.elements.length;
  if (raw instanceof GoMap) return raw.entries.size;
  return 0;
}

export function capOf(value: RV): number {
  const raw = value.value;
  if (raw instanceof Slice) return raw.capacity;
  return lengthOf(value);
}

/** `Value.Index` of a string, an array, or a slice. */
export function indexOf(value: RV, index: number): RV {
  const kind = kindOf(value);
  if (index < 0 || index >= lengthOf(value)) stringPanic(`reflect: ${kind} index out of range`);
  if (kind === 'string') return { type: BASIC.uint8, value: BigInt((value.value as string).charCodeAt(index)) };
  const element = (underlying(value.type) as { element: Type }).element;
  if (kind === 'slice') {
    const slice = value.value as Slice;
    return { type: element, value: slice.get(index), addr: new Pointer(slice.array, slice.offset + index) };
  }
  const array = value.value as GoArray;
  return {
    type: element,
    value: array.elements[index],
    addr: value.addr ? new Pointer(array.elements, index) : undefined,
  };
}

/** `Value.MapIndex`, or undefined when the map lacks the key. */
export function mapIndex(map: RV, key: Value): RValue {
  const raw = map.value as GoMap | undefined;
  const entry = raw?.entries.get(raw.keyOf(key));
  if (!entry) return undefined;
  return { type: (underlying(map.type) as { value: Type }).value, value: entry.value };
}

/** A struct field found by name through embedded structs, as `Type.FieldByName` finds it. */
export interface StructField {
  name: string;
  index: number[];
}

/** `Type.FieldByName`: the shallowest field of the name, which must be unique at its depth. */
// code-gauge-allow functionCognitiveComplexity 28 -- reflect's breadth-first search of embedded structs.
export function fieldByName(type: Type, name: string): StructField | undefined {
  let current: { type: Type; index: number[] }[] = [{ type, index: [] }];
  const visited = new Set<Type>();
  while (current.length > 0) {
    const found: StructField[] = [];
    const next: { type: Type; index: number[] }[] = [];
    for (const entry of current) {
      if (visited.has(entry.type)) continue;
      visited.add(entry.type);
      const fields = (underlying(entry.type) as StructType).fields;
      for (const [index, field] of fields.entries()) {
        if (field.name === name) found.push({ name, index: [...entry.index, index] });
        else if (field.embedded) {
          const embedded =
            underlying(field.type).kind === 'pointer' ? (field.type as { element: Type }).element : field.type;
          if (underlying(embedded).kind === 'struct') next.push({ type: embedded, index: [...entry.index, index] });
        }
      }
    }
    if (found.length === 1) return found[0];
    if (found.length > 1) return undefined;
    current = next;
  }
  return undefined;
}

/** `Value.FieldByIndexErr`. */
export function fieldByIndex(value: RV, index: number[]): [RValue, string | undefined] {
  let current: RV = value;
  for (const [position, fieldIndex] of index.entries()) {
    if (position > 0 && kindOf(current) === 'pointer') {
      const element = (underlying(current.type) as { element: Type }).element;
      if (isNilValue(current)) {
        return [
          undefined,
          `reflect: indirection through nil pointer to embedded struct field ${element.kind === 'named' ? element.name : ''}`,
        ];
      }
      current = elem(current) as RV;
    }
    const struct = current.value as GoStruct;
    const field = (underlying(current.type) as StructType).fields[fieldIndex];
    current = {
      type: field.type,
      value: struct.fields[fieldIndex],
      addr: current.addr ? new Pointer(struct.fields, fieldIndex) : undefined,
    };
  }
  return [current, undefined];
}

/** `Value.MethodByName`: a callable method value of an exported method in the value's method set. */
export function methodByName(value: RV, name: string): RV | undefined {
  if (!isExportedName(name)) return undefined;
  const selection = lookupFieldOrMethod(value.type, name);
  if (selection.kind !== 'method' && selection.kind !== 'interfaceMethod') return undefined;
  if (
    selection.kind === 'method' &&
    selection.method.pointerReceiver &&
    underlying(value.type).kind !== 'pointer' &&
    !selection.indirect
  ) {
    return undefined;
  }
  const call = dynamicMethod(value.type, name);
  if (!call) return undefined;
  const receiver = value.value;
  if (typeKind(value.type) === 'interface') {
    return {
      type: selection.method.type,
      value: new GoFunc((args) => {
        if (!(receiver instanceof Iface)) stringPanic('reflect: Method on nil interface value');
        return call(receiver.value, args);
      }),
    };
  }
  if (
    receiver === undefined &&
    selection.kind === 'method' &&
    !selection.method.pointerReceiver &&
    selection.path.length === 0
  ) {
    // Go's wrapper of a value method for the pointer type reports a nil receiver this way.
    const { name: typeName, pkg } = selection.receiverBase;
    const message = `value method ${pkg.split('/').at(-1)}.${typeName}.${name} called using nil *${typeName} pointer`;
    return { type: selection.method.type, value: new GoFunc(() => plainPanic(message)) };
  }
  return { type: selection.method.type, value: new GoFunc((args) => call(receiver, args), [receiver]) };
}

/** `Value.String`. */
export function rvString(value: RValue): string {
  if (!value) return '<invalid Value>';
  if (typeKind(value.type) === 'string') return value.value as string;
  return `<${typeString(value.type)} Value>`;
}

/** `Value.Int` and `Value.Uint`. */
export function integerOf(value: RV): bigint {
  return value.value as bigint;
}

/** Converts an integer value to another integer type, wrapping it to the type's size. */
export function convertInteger(value: RV, to: Type): RV {
  const kind = underlying(to);
  const { bits, signed } = integerBits(kind.kind === 'basic' ? kind.basic : 'int');
  const raw = value.value as bigint;
  return { type: to, value: signed ? BigInt.asIntN(bits, raw) : BigInt.asUintN(bits, raw) };
}

export function funcTypeOf(value: RV): FuncType {
  return underlying(value.type) as FuncType;
}

/** `token.IsExported` of a name held as UTF-8 bytes. */
export function isExportedName(name: string): boolean {
  return name !== '' && isUpper(decodeRune(name, 0).rune);
}
