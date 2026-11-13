import { equalityOf } from '../equality';
import { newError } from '../errorValues';
import { formatFloat } from '../floatFormat';
import { Printer } from '../fmt';
import { addMethod, fn, namedType, opaqueType } from '../native';
import { ANY, BASIC, funcType, identical, missingMethod, sliceOf, type Type, typeString } from '../types';
import { GoArray, GoStruct, Iface, type Value } from '../values';
import * as goTime from './goTime';
import { format } from './goTimeFormat';
import { BOOL, callMethod, INT, sliceOfValues, sliceValues, STRING, stringPanic } from './support';
import { DURATION, TIME, timeOf, timeValue } from './time';

/**
 * slog's Value (Go 1.27.3, value.go and attr.go): each kind keeps its payload here, and a Go `slog.Value` struct keeps
 * one of these in `native`, so that its zero value reads as the empty value of kind Any.
 */
export type SlogValue =
  | { kind: 'string'; s: string }
  | { kind: 'int64' | 'uint64' | 'duration'; n: bigint }
  | { kind: 'float64'; f: number }
  | { kind: 'bool'; b: boolean }
  | { kind: 'time'; t: goTime.Time }
  | { kind: 'group'; attrs: SlogAttr[] }
  | { kind: 'any' | 'logValuer'; v: Value };

export interface SlogAttr {
  key: string;
  value: SlogValue;
}

/** The kinds in the order of slog's Kind constants. */
export const KIND_NAMES = [
  'Any',
  'Bool',
  'Duration',
  'Float64',
  'Int64',
  'String',
  'Time',
  'Uint64',
  'Group',
  'LogValuer',
];
const KIND_INDEX: Record<SlogValue['kind'], number> = {
  any: 0,
  bool: 1,
  duration: 2,
  float64: 3,
  int64: 4,
  string: 5,
  time: 6,
  uint64: 7,
  group: 8,
  logValuer: 9,
};

export const NIL_VALUE: SlogValue = { kind: 'any', v: undefined };

export const KIND = namedType('slog', 'Kind', INT);
addMethod(KIND, 'String', fn([], [STRING]), (receiver) => kindString(Number(receiver as bigint)));

function kindString(kind: number): string {
  return KIND_NAMES[kind] ?? '<unknown slog.Kind>';
}

export const LEVEL = namedType('slog', 'Level', INT);

export const VALUE = opaqueType(
  namedType('slog', 'Value', {
    kind: 'struct',
    fields: [{ name: '_', type: { kind: 'array', element: funcType([], []), length: 0 }, embedded: false }],
  })
);

export const ATTR = namedType('slog', 'Attr', {
  kind: 'struct',
  fields: [
    { name: 'Key', type: STRING, embedded: false },
    { name: 'Value', type: VALUE, embedded: false },
  ],
});
export const ATTRS = sliceOf(ATTR);

export const LOG_VALUER = namedType('slog', 'LogValuer', {
  kind: 'interface',
  methods: [{ name: 'LogValue', type: fn([], [VALUE]) }],
});

// Conversions between Go values and slog values --------------------------------------------------------------------

export function valueToGo(value: SlogValue): GoStruct {
  return new GoStruct([new GoArray([])], { slog: value });
}

export function valueOf(value: Value): SlogValue {
  return ((value as GoStruct | undefined)?.native?.slog as SlogValue | undefined) ?? NIL_VALUE;
}

export function attrToGo(attr: SlogAttr): GoStruct {
  return new GoStruct([attr.key, valueToGo(attr.value)]);
}

export function attrOf(value: Value): SlogAttr {
  const [key, inner] = (value as GoStruct).fields;
  return { key: key as string, value: valueOf(inner) };
}

export function attrsToGo(attrs: SlogAttr[]): Value {
  return attrs.length === 0 ? undefined : sliceOfValues(attrs.map(attrToGo));
}

export function attrsOf(slice: Value): SlogAttr[] {
  return sliceValues(slice).map(attrOf);
}

export function kindOf(value: SlogValue): number {
  return KIND_INDEX[value.kind];
}

// Constructors ------------------------------------------------------------------------------------------------------

const SIGNED = new Set<Type>([BASIC.int, BASIC.int8, BASIC.int16, BASIC.int32, BASIC.int64]);
const UNSIGNED = new Set<Type>([BASIC.uint, BASIC.uint8, BASIC.uint16, BASIC.uint32, BASIC.uint64, BASIC.uintptr]);

export function timeSlogValue(t: goTime.Time): SlogValue {
  return { kind: 'time', t: goTime.round(t, 0n) };
}

/** `slog.AnyValue`: the kind of the dynamic type, or Any with the value itself. */
export function anyValue(value: Value): SlogValue {
  if (!(value instanceof Iface)) return NIL_VALUE;
  const { type } = value;
  const payload = value.value;
  if (type === BASIC.string) return { kind: 'string', s: payload as string };
  if (SIGNED.has(type)) return { kind: 'int64', n: payload as bigint };
  if (UNSIGNED.has(type)) return { kind: 'uint64', n: payload as bigint };
  if (type === BASIC.bool) return { kind: 'bool', b: payload as boolean };
  if (type === BASIC.float64 || type === BASIC.float32) return { kind: 'float64', f: payload as number };
  if (type === DURATION) return { kind: 'duration', n: payload as bigint };
  if (type === TIME) return timeSlogValue(timeOf(payload));
  if (identical(type, ATTRS)) return groupValue(attrsOf(payload));
  if (type === VALUE) return valueOf(payload);
  if (missingMethod(type, LOG_VALUER.underlying as never) === undefined) return { kind: 'logValuer', v: value };
  return { kind: 'any', v: value };
}

/** `slog.GroupValue`, which drops the empty groups among its attrs. */
export function groupValue(attrs: SlogAttr[]): SlogValue {
  return { kind: 'group', attrs: attrs.filter((attr) => !isEmptyGroup(attr.value)) };
}

export function isEmptyGroup(value: SlogValue): boolean {
  return value.kind === 'group' && value.attrs.length === 0;
}

export function isEmptyAttr(attr: SlogAttr): boolean {
  return attr.key === '' && attr.value.kind === 'any' && attr.value.v === undefined;
}

const BAD_KEY = '!BADKEY';

/** `argsToAttr`: the attr that the first arguments make, and the arguments after them. */
export function argsToAttr(args: Value[]): [SlogAttr, Value[]] {
  const first = args[0] as Iface | undefined;
  if (first?.type === BASIC.string) {
    if (args.length === 1) return [{ key: BAD_KEY, value: { kind: 'string', s: first.value as string } }, []];
    return [{ key: first.value as string, value: anyValue(args[1]) }, args.slice(2)];
  }
  if (first?.type === ATTR) return [attrOf(first.value), args.slice(1)];
  return [{ key: BAD_KEY, value: anyValue(first) }, args.slice(1)];
}

export function argsToAttrSlice(args: Value[]): SlogAttr[] {
  const attrs: SlogAttr[] = [];
  let rest = args;
  while (rest.length > 0) {
    const [attr, next] = argsToAttr(rest);
    attrs.push(attr);
    rest = next;
  }
  return attrs;
}

const MAX_LOG_VALUES = 100;

/** `Value.Resolve`: calls LogValue until the value is not a LogValuer. */
export function resolve(value: SlogValue): SlogValue {
  let current = value;
  for (let count = 0; count < MAX_LOG_VALUES; count++) {
    if (current.kind !== 'logValuer') return current;
    current = valueOf(callMethod(current.v, 'LogValue') as Value);
  }
  const original = value as { v: Iface };
  return anyValue(newError(`LogValue called too many times on Value of type ${typeString(original.v.type)}`));
}

// Reading values ----------------------------------------------------------------------------------------------------

/** `Value.Any`. */
export function anyOf(value: SlogValue): Value {
  switch (value.kind) {
    case 'string': {
      return new Iface(BASIC.string, value.s);
    }
    case 'int64': {
      return new Iface(BASIC.int64, value.n);
    }
    case 'uint64': {
      return new Iface(BASIC.uint64, value.n);
    }
    case 'duration': {
      return new Iface(DURATION, value.n);
    }
    case 'float64': {
      return new Iface(BASIC.float64, value.f);
    }
    case 'bool': {
      return new Iface(BASIC.bool, value.b);
    }
    case 'time': {
      return new Iface(TIME, timeValue(value.t));
    }
    case 'group': {
      return new Iface(ATTRS, attrsToGo(value.attrs));
    }
    default: {
      return value.v;
    }
  }
}

const TIME_LAYOUT = '2006-01-02 15:04:05.999999999 -0700 MST';

/** `Value.append`, which Value.String and the text handler use. */
export function valueText(value: SlogValue): string {
  switch (value.kind) {
    case 'string': {
      return value.s;
    }
    case 'int64':
    case 'uint64': {
      return value.n.toString();
    }
    case 'float64': {
      return formatFloat(value.f, 'g', -1, 64);
    }
    case 'bool': {
      return String(value.b);
    }
    case 'duration': {
      return goTime.durationString(value.n);
    }
    case 'time': {
      return format(value.t, TIME_LAYOUT);
    }
    case 'group': {
      return new Printer().print([anyOf(value)]);
    }
    default: {
      return new Printer().print([value.v]);
    }
  }
}

export function levelString(level: bigint): string {
  if (level < 0n) return levelName('DEBUG', level + 4n);
  if (level < 4n) return levelName('INFO', level);
  if (level < 8n) return levelName('WARN', level - 4n);
  return levelName('ERROR', level - 8n);
}

function levelName(base: string, offset: bigint): string {
  if (offset === 0n) return base;
  return `${base}${offset > 0n ? '+' : ''}${offset}`;
}

// Methods of Value and Attr -----------------------------------------------------------------------------------------

function kindPanic(value: SlogValue, wanted: number): never {
  stringPanic(`Value kind is ${kindString(kindOf(value))}, not ${kindString(wanted)}`);
}

function accessor(name: string, result: Type, kind: SlogValue['kind'], read: (value: SlogValue) => Value): void {
  addMethod(VALUE, name, fn([], [result]), (receiver) => {
    const value = valueOf(receiver);
    if (value.kind !== kind) kindPanic(value, KIND_INDEX[kind]);
    return read(value);
  });
}

accessor('Int64', BASIC.int64, 'int64', (value) => (value as { n: bigint }).n);
accessor('Uint64', BASIC.uint64, 'uint64', (value) => (value as { n: bigint }).n);
accessor('Float64', BASIC.float64, 'float64', (value) => (value as { f: number }).f);
accessor('Bool', BOOL, 'bool', (value) => (value as { b: boolean }).b);
accessor('Duration', DURATION, 'duration', (value) => (value as { n: bigint }).n);
accessor('Time', TIME, 'time', (value) => timeValue((value as { t: goTime.Time }).t));
addMethod(VALUE, 'Kind', fn([], [KIND]), (receiver) => BigInt(kindOf(valueOf(receiver))));
addMethod(VALUE, 'Any', fn([], [ANY]), (receiver) => anyOf(valueOf(receiver)));
addMethod(VALUE, 'String', fn([], [STRING]), (receiver) => valueText(valueOf(receiver)));
addMethod(VALUE, 'Group', fn([], [ATTRS]), (receiver) => {
  const value = valueOf(receiver);
  if (value.kind !== 'group') stringPanic('Group: bad kind');
  return attrsToGo(value.attrs);
});
addMethod(VALUE, 'LogValuer', fn([], [LOG_VALUER]), (receiver) => {
  const value = valueOf(receiver);
  if (value.kind !== 'logValuer') stringPanic(`interface conversion: interface {} is not slog.LogValuer`);
  return value.v;
});
addMethod(VALUE, 'Resolve', fn([], [VALUE]), (receiver) => valueToGo(resolve(valueOf(receiver))));
addMethod(VALUE, 'Equal', fn([VALUE], [BOOL]), (receiver, [other]) => valuesEqual(valueOf(receiver), valueOf(other)));

export function valuesEqual(a: SlogValue, b: SlogValue): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'string': {
      return a.s === (b as { s: string }).s;
    }
    case 'float64': {
      return a.f === (b as { f: number }).f;
    }
    case 'bool': {
      return a.b === (b as { b: boolean }).b;
    }
    case 'time': {
      return goTime.compare(a.t, (b as { t: goTime.Time }).t) === 0;
    }
    case 'group': {
      const other = (b as { attrs: SlogAttr[] }).attrs;
      return (
        a.attrs.length === other.length &&
        a.attrs.every((attr, index) => attr.key === other[index].key && valuesEqual(attr.value, other[index].value))
      );
    }
    case 'any':
    case 'logValuer': {
      return equalityOf(ANY)(a.v, (b as { v: Value }).v);
    }
    default: {
      return a.n === (b as { n: bigint }).n;
    }
  }
}

addMethod(ATTR, 'String', fn([], [STRING]), (receiver) => {
  const attr = attrOf(receiver);
  return `${attr.key}=${valueText(attr.value)}`;
});
addMethod(ATTR, 'Equal', fn([ATTR], [BOOL]), (receiver, [other]) => {
  const a = attrOf(receiver);
  const b = attrOf(other);
  return a.key === b.key && valuesEqual(a.value, b.value);
});
