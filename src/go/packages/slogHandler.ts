// oxlint-disable unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import { Printer } from '../fmt';
import { decodeRune, RUNE_ERROR } from '../literals';
import { addMethod, fn, namedType, opaqueType } from '../native';
import { isPrint, quote } from '../quote';
import { nilPointerPanic } from '../runtimeErrors';
import {
  BASIC,
  ERROR_TYPE,
  type InterfaceType,
  missingMethod,
  pointerTo,
  sliceOf,
  type Type,
  underlying,
} from '../types';
import { Cell, GoStruct, Iface, Pointer, type Value } from '../values';
import * as goTime from './goTime';
import { format, LAYOUTS } from './goTimeFormat';
import { encodeFloat, isJsonMarshaler, JsonError, marshalJson, REPLACEMENT_CHARACTER } from './slogJson';
import {
  anyOf,
  anyValue,
  attrOf,
  ATTRS,
  attrsOf,
  attrToGo,
  isEmptyAttr,
  LEVEL,
  levelString,
  resolve,
  type SlogAttr,
  type SlogValue,
  timeSlogValue,
  valueText,
} from './slogValue';
import {
  BOOL,
  BYTES,
  byteSlice,
  bytesOf,
  callFunction,
  callMethod,
  errorText,
  INT,
  receiverStruct,
  sliceOfValues,
  spendFor,
  STRING,
} from './support';
import { TIME, timeOf, timeValue } from './time';
import { isSpace } from './unicodeSupport';

// Types -------------------------------------------------------------------------------------------------------------

/** `context.Context`, which programs here cannot create, so that they pass nil where slog takes one. */
export const CONTEXT = namedType('context', 'Context', {
  kind: 'interface',
  methods: [
    { name: 'Err', type: fn([], [ERROR_TYPE]) },
    { name: 'Value', type: fn([{ kind: 'interface', methods: [] }], [{ kind: 'interface', methods: [] }]) },
  ],
});

export const LEVELER = namedType('slog', 'Leveler', {
  kind: 'interface',
  methods: [{ name: 'Level', type: fn([], [LEVEL]) }],
});

/** `slog.Record`, whose attrs live in `native`. */
export const RECORD = namedType('slog', 'Record', {
  kind: 'struct',
  fields: [
    { name: 'Time', type: TIME, embedded: false },
    { name: 'Message', type: STRING, embedded: false },
    { name: 'Level', type: LEVEL, embedded: false },
    { name: 'PC', type: BASIC.uintptr, embedded: false },
  ],
});

export const SOURCE = namedType('slog', 'Source', {
  kind: 'struct',
  fields: [
    { name: 'Function', type: STRING, embedded: false },
    { name: 'File', type: STRING, embedded: false },
    { name: 'Line', type: INT, embedded: false },
  ],
});
const SOURCE_POINTER = pointerTo(SOURCE);

export const HANDLER = namedType('slog', 'Handler', { kind: 'interface', methods: [] });
(HANDLER.underlying as InterfaceType).methods.push(
  { name: 'Enabled', type: fn([CONTEXT, LEVEL], [BOOL]) },
  { name: 'Handle', type: fn([CONTEXT, RECORD], [ERROR_TYPE]) },
  { name: 'WithAttrs', type: fn([ATTRS], [HANDLER]) },
  { name: 'WithGroup', type: fn([STRING], [HANDLER]) }
);

export const HANDLER_OPTIONS = namedType('slog', 'HandlerOptions', {
  kind: 'struct',
  fields: [
    { name: 'AddSource', type: BOOL, embedded: false },
    { name: 'Level', type: LEVELER, embedded: false },
    { name: 'ReplaceAttr', type: fn([sliceOf(STRING), namedAttr()], [namedAttr()]), embedded: false },
  ],
});

function namedAttr(): Type {
  return ATTRS.element;
}

// Records -----------------------------------------------------------------------------------------------------------

export interface SlogRecord {
  time: goTime.Time;
  message: string;
  level: bigint;
  /** The 1-based line of the logging call, or 0 when unknown. */
  pc: number;
  attrs: SlogAttr[];
  /** The name of the function that logged, for AddSource. */
  function: string;
}

export function recordToGo(record: SlogRecord): GoStruct {
  const native = { record, clone: () => ({ ...native, record: { ...record, attrs: [...record.attrs] } }) };
  return new GoStruct(
    [timeValue(record.time), record.message, record.level, BigInt(record.pc)],
    native as unknown as GoStruct['native']
  );
}

export function recordOf(value: Value): SlogRecord {
  const struct = value as GoStruct;
  const kept = struct.native?.record as SlogRecord | undefined;
  const [time, message, level, pc] = struct.fields;
  return {
    time: timeOf(time),
    message: message as string,
    level: level as bigint,
    pc: Number(pc as bigint),
    attrs: kept?.attrs ?? [],
    function: kept?.function ?? '',
  };
}

// The common handler ------------------------------------------------------------------------------------------------

export interface CommonHandler {
  json: boolean;
  addSource: boolean;
  level: Value;
  replaceAttr: Value;
  preformattedAttrs: string;
  groupPrefix: string;
  groups: string[];
  nOpenGroups: number;
  w: Value;
}

export function newCommonHandler(json: boolean, w: Value, options: Value): CommonHandler {
  const fields = options instanceof Pointer ? (options.load() as GoStruct).fields : [false, undefined, undefined];
  return {
    json,
    addSource: fields[0] as boolean,
    level: fields[1],
    replaceAttr: fields[2],
    preformattedAttrs: '',
    groupPrefix: '',
    groups: [],
    nOpenGroups: 0,
    w,
  };
}

export function enabled(h: CommonHandler, level: bigint): boolean {
  const minLevel = h.level === undefined ? 0n : (callMethod(h.level, 'Level') as bigint);
  return level >= minLevel;
}

export function withAttrs(h: CommonHandler, attrs: SlogAttr[]): CommonHandler {
  if (attrs.every((attr) => attr.value.kind === 'group' && attr.value.attrs.length === 0)) return h;
  const h2: CommonHandler = { ...h, groups: [...h.groups] };
  const state = new HandleState(h2, h2.preformattedAttrs, '');
  state.prefix += h.groupPrefix;
  const pfa = h2.preformattedAttrs;
  if (pfa.length > 0) {
    state.sep = attrSep(h);
    if (h2.json && pfa.endsWith('{')) state.sep = '';
  }
  const pos = state.buf.length;
  state.openGroups();
  if (state.appendAttrs(attrs)) {
    h2.groupPrefix = state.prefix;
    h2.nOpenGroups = h2.groups.length;
  } else {
    state.buf = state.buf.slice(0, pos);
  }
  h2.preformattedAttrs = state.buf;
  return h2;
}

export function withGroup(h: CommonHandler, name: string): CommonHandler {
  return { ...h, groups: [...h.groups, name] };
}

const TIME_KEY = 'time';
const LEVEL_KEY = 'level';
const MESSAGE_KEY = 'msg';
const SOURCE_KEY = 'source';
export const KEYS = { TimeKey: TIME_KEY, LevelKey: LEVEL_KEY, MessageKey: MESSAGE_KEY, SourceKey: SOURCE_KEY };

/** `commonHandler.handle`: the built-in attributes, then the handler's and the record's, written in one Write call. */
export function handle(h: CommonHandler, record: SlogRecord): Value {
  const state = new HandleState(h, h.json ? '{' : '', '');
  const stateGroups = state.groups;
  state.groups = undefined;
  const rep = h.replaceAttr;
  if (!goTime.isZero(record.time)) {
    const value = goTime.round(record.time, 0n);
    if (rep === undefined) {
      state.appendKey(TIME_KEY);
      state.appendTime(value);
    } else {
      state.appendAttr({ key: TIME_KEY, value: timeSlogValue(value) });
    }
  }
  if (rep === undefined) {
    state.appendKey(LEVEL_KEY);
    state.appendString(levelString(record.level));
  } else {
    state.appendAttr({ key: LEVEL_KEY, value: anyValue(new Iface(LEVEL, record.level)) });
  }
  if (h.addSource) state.appendAttr({ key: SOURCE_KEY, value: { kind: 'any', v: sourceOf(record) } });
  if (rep === undefined) {
    state.appendKey(MESSAGE_KEY);
    state.appendString(record.message);
  } else {
    state.appendAttr({ key: MESSAGE_KEY, value: { kind: 'string', s: record.message } });
  }
  state.groups = stateGroups;
  state.appendNonBuiltIns(record);
  state.buf += '\n';
  return write(h.w, state.buf);
}

export function write(writer: Value, text: string): Value {
  if (writer === undefined) nilPointerPanic();
  spendFor(text.length);
  return (callMethod(writer, 'Write', [byteSlice(text)]) as Value[])[1];
}

/** The name of the program's source file, which AddSource reports. */
const SOURCE_FILE = 'main.go';

export function sourceOf(record: SlogRecord): Iface {
  const fields: Value[] = record.function === '' ? ['', '', 0n] : [record.function, SOURCE_FILE, BigInt(record.pc)];
  return new Iface(SOURCE_POINTER, new Pointer(new Cell(new GoStruct(fields)), 'v'));
}

function attrSep(h: CommonHandler): string {
  return h.json ? ',' : ' ';
}

/** `handleState`: the output being built, the separator before the next key, and the text handler's key prefix. */
export class HandleState {
  prefix = '';
  /** The groups ReplaceAttr receives, kept only when there is a ReplaceAttr. */
  groups: string[] | undefined;

  constructor(
    readonly h: CommonHandler,
    public buf: string,
    public sep: string
  ) {
    if (h.replaceAttr !== undefined) this.groups = h.groups.slice(0, h.nOpenGroups);
  }

  appendNonBuiltIns(record: SlogRecord): void {
    const { h } = this;
    const pfa = h.preformattedAttrs;
    if (pfa.length > 0) {
      this.buf += this.sep + pfa;
      this.sep = attrSep(h);
      if (h.json && pfa.endsWith('{')) this.sep = '';
    }
    let nOpenGroups = h.nOpenGroups;
    if (record.attrs.length > 0) {
      this.prefix += h.groupPrefix;
      const pos = this.buf.length;
      this.openGroups();
      nOpenGroups = h.groups.length;
      let empty = true;
      for (const attr of record.attrs) {
        if (this.appendAttr(attr)) empty = false;
      }
      if (empty) {
        this.buf = this.buf.slice(0, pos);
        nOpenGroups = h.nOpenGroups;
      }
    }
    if (h.json) this.buf += `${'}'.repeat(nOpenGroups)}}`;
  }

  openGroups(): void {
    for (const name of this.h.groups.slice(this.h.nOpenGroups)) this.openGroup(name);
  }

  private openGroup(name: string): void {
    if (this.h.json) {
      this.appendKey(name);
      this.buf += '{';
      this.sep = '';
    } else {
      this.prefix += `${name}.`;
    }
    this.groups?.push(name);
  }

  private closeGroup(name: string): void {
    if (this.h.json) this.buf += '}';
    else this.prefix = this.prefix.slice(0, this.prefix.length - name.length - 1);
    this.sep = attrSep(this.h);
    this.groups?.pop();
  }

  appendAttrs(attrs: SlogAttr[]): boolean {
    let nonEmpty = false;
    for (const attr of attrs) {
      if (this.appendAttr(attr)) nonEmpty = true;
    }
    return nonEmpty;
  }

  // code-gauge-allow functionCognitiveComplexity 22 -- A transcription of Go's handleState.appendAttr.
  appendAttr(original: SlogAttr): boolean {
    spendFor(1);
    let attr: SlogAttr = { key: original.key, value: resolve(original.value) };
    const rep = this.h.replaceAttr;
    if (rep !== undefined && attr.value.kind !== 'group') {
      const groups = this.groups === undefined ? undefined : sliceOfValues([...this.groups]);
      attr = attrOf(callFunction(rep, [groups, attrToGo(attr)]) as Value);
      attr = { key: attr.key, value: resolve(attr.value) };
    }
    if (isEmptyAttr(attr)) return false;
    const source = sourceValue(attr.value);
    if (source) {
      if (source.every((field) => field === '' || field === 0n)) return false;
      attr = { key: attr.key, value: sourceAttrValue(source as [string, string, bigint], this.h.json) };
    }
    if (attr.value.kind === 'group') {
      const { attrs } = attr.value;
      if (attrs.length > 0) {
        const pos = this.buf.length;
        if (attr.key !== '') this.openGroup(attr.key);
        if (!this.appendAttrs(attrs)) {
          this.buf = this.buf.slice(0, pos);
          return false;
        }
        if (attr.key !== '') this.closeGroup(attr.key);
      }
    } else {
      this.appendKey(attr.key);
      this.appendValue(attr.value);
    }
    return true;
  }

  private appendError(message: string): void {
    this.appendString(`!ERROR:${message}`);
  }

  appendKey(key: string): void {
    this.buf += this.sep;
    if (this.prefix.length > 0) this.appendTwoStrings(this.prefix, key);
    else this.appendString(key);
    this.buf += this.h.json ? ':' : '=';
    this.sep = attrSep(this.h);
  }

  private appendTwoStrings(x: string, y: string): void {
    if (this.h.json) this.buf += `"${escapeJson(x)}${escapeJson(y)}"`;
    else if (!needsQuoting(x) && !needsQuoting(y)) this.buf += x + y;
    else this.buf += quote(x + y);
  }

  appendString(text: string): void {
    if (this.h.json) this.buf += `"${escapeJson(text)}"`;
    else this.buf += needsQuoting(text) ? quote(text) : text;
  }

  private appendValue(value: SlogValue): void {
    try {
      if (this.h.json) this.appendJsonValue(value);
      else this.appendTextValue(value);
    } catch (error) {
      if (!(error instanceof JsonError)) throw error;
      this.appendError(error.message);
    }
  }

  appendTime(t: goTime.Time): void {
    if (this.h.json) {
      const { year } = goTime.date(t);
      if (year < 0n || year >= 10_000n) {
        this.appendError('time.Time year outside of range [0,9999]');
        return;
      }
      this.buf += `"${format(t, LAYOUTS.RFC3339Nano)}"`;
    } else {
      this.buf += rfc3339Millis(t);
    }
  }

  private appendTextValue(value: SlogValue): void {
    switch (value.kind) {
      case 'string': {
        this.appendString(value.s);
        return;
      }
      case 'time': {
        this.appendTime(value.t);
        return;
      }
      case 'any': {
        this.appendTextAny(value.v);
        return;
      }
      default: {
        this.buf += valueText(value);
      }
    }
  }

  private appendTextAny(value: Value): void {
    const iface = value as Iface | undefined;
    if (iface && implementsMethod(iface.type, 'AppendText', [BYTES])) {
      const [bytes, error] = callMethod(iface, 'AppendText', [undefined]) as [Value, Value];
      if (error === undefined) this.appendString(bytesOf(bytes));
      else this.appendError(errorText(error));
      return;
    }
    if (iface && implementsMethod(iface.type, 'MarshalText', [])) {
      const [bytes, error] = callMethod(iface, 'MarshalText') as [Value, Value];
      if (error === undefined) this.appendString(bytesOf(bytes));
      else this.appendError(errorText(error));
      return;
    }
    if (iface && isByteSlice(iface.type)) {
      this.buf += quote(bytesOf(iface.value));
      return;
    }
    this.appendString(new Printer().printf('%+v', [value]));
  }

  private appendJsonValue(value: SlogValue): void {
    if (value.kind === 'string') this.appendString(value.s);
    else if (value.kind === 'time') this.appendTime(value.t);
    else if (value.kind === 'float64') this.buf += encodeFloat(value.f, 64);
    else if (value.kind === 'duration') this.buf += value.n.toString();
    else if (value.kind === 'int64' || value.kind === 'uint64' || value.kind === 'bool') this.buf += valueText(value);
    else this.appendJsonAny(anyOf(value) as Iface | undefined);
  }

  private appendJsonAny(any: Iface | undefined): void {
    const isError = any && missingMethod(any.type, ERROR_TYPE.underlying as InterfaceType) === undefined;
    if (isError && !isJsonMarshaler(any.type)) this.appendString(errorText(any));
    else this.buf += marshalJson(any);
  }
}

function sourceValue(value: SlogValue): Value[] | undefined {
  if (value.kind !== 'any' || !(value.v instanceof Iface) || value.v.type.kind !== 'pointer') return undefined;
  if ((value.v.type as { element: Type }).element !== SOURCE) return undefined;
  const pointer = value.v.value;
  if (!(pointer instanceof Pointer)) return ['', '', 0n];
  return (pointer.load() as GoStruct).fields;
}

/** How the handlers write a `*slog.Source`: a group for JSON, `file:line` for text. */
function sourceAttrValue([func, file, line]: [string, string, bigint], json: boolean): SlogValue {
  if (!json) return { kind: 'string', s: `${file}:${line}` };
  const attrs: SlogAttr[] = [];
  if (func !== '') attrs.push({ key: 'function', value: { kind: 'string', s: func } });
  if (file !== '') attrs.push({ key: 'file', value: { kind: 'string', s: file } });
  if (line !== 0n) attrs.push({ key: 'line', value: { kind: 'int64', n: line } });
  return { kind: 'group', attrs };
}

function implementsMethod(type: Type, name: string, params: Type[]): boolean {
  return (
    missingMethod(type, { kind: 'interface', methods: [{ name, type: fn(params, [BYTES, ERROR_TYPE]) }] }) === undefined
  );
}

function isByteSlice(type: Type): boolean {
  const under = underlying(type);
  if (under.kind !== 'slice') return false;
  const element = underlying(under.element);
  return element.kind === 'basic' && element.basic === 'uint8';
}

/** `appendRFC3339Millis`: RFC3339Nano with exactly three fractional digits. */
function rfc3339Millis(t: goTime.Time): string {
  const prefixLength = '2006-01-02T15:04:05.000'.length;
  const rounded = goTime.add(goTime.truncate(t, 1_000_000n), 100_000n);
  const text = format(rounded, LAYOUTS.RFC3339Nano);
  return text.slice(0, prefixLength) + text.slice(prefixLength + 1);
}

// Quoting -----------------------------------------------------------------------------------------------------------

/** slog's safeSet: the printable ASCII characters except `"` and `\`, plus DEL. */
function isSafe(byte: number): boolean {
  return (byte >= 0x20 && byte <= 0x7f && byte !== 0x22 && byte !== 0x5c) || false;
}

/** The text handler's `needsQuoting`. */
export function needsQuoting(text: string): boolean {
  if (text.length === 0) return true;
  for (let at = 0; at < text.length;) {
    const byte = text.charCodeAt(at);
    if (byte < 0x80) {
      if (byte !== 0x5c && (byte === 0x20 || byte === 0x3d || !isSafe(byte))) return true;
      at++;
      continue;
    }
    const { rune, size } = decodeRune(text, at);
    if (rune === RUNE_ERROR || isSpace(rune) || !isPrint(rune)) return true;
    at += size;
  }
  return false;
}

const HEX = '0123456789abcdef';

/** `appendEscapedJSONString`. */
export function escapeJson(text: string): string {
  let result = '';
  for (let at = 0; at < text.length;) {
    const byte = text.charCodeAt(at);
    if (byte < 0x80) {
      at++;
      if (isSafe(byte)) {
        result += text[at - 1];
        continue;
      }
      const named = {
        0x5c: String.raw`\\`,
        0x22: String.raw`\"`,
        0x0a: String.raw`\n`,
        0x0d: String.raw`\r`,
        0x09: String.raw`\t`,
      }[byte];
      result += named ?? `\\u00${HEX[byte >> 4]}${HEX[byte & 0xf]}`;
      continue;
    }
    const { rune, size } = decodeRune(text, at);
    if (rune === RUNE_ERROR && size === 1) result += REPLACEMENT_CHARACTER;
    else if (rune === 0x20_28 || rune === 0x20_29) result += `\\u202${HEX[rune & 0xf]}`;
    else result += text.slice(at, at + size);
    at += size;
  }
  return result;
}

// Built-in handler types --------------------------------------------------------------------------------------------

function handlerOf(receiver: Value): CommonHandler {
  return receiverStruct(receiver).native?.handler as CommonHandler;
}

export function handlerPointer(type: Type, handler: CommonHandler): Iface {
  return new Iface(pointerTo(type), new Pointer(new Cell(new GoStruct([], { handler })), 'v'));
}

function defineCommonHandler(name: string): Type {
  const type = opaqueType(namedType('slog', name, { kind: 'struct', fields: [] }));
  addMethod(
    type,
    'Enabled',
    fn([CONTEXT, LEVEL], [BOOL]),
    (receiver, [, level]) => enabled(handlerOf(receiver), level as bigint),
    true
  );
  addMethod(
    type,
    'Handle',
    fn([CONTEXT, RECORD], [ERROR_TYPE]),
    (receiver, [, record]) => handle(handlerOf(receiver), recordOf(record)),
    true
  );
  addMethod(
    type,
    'WithAttrs',
    fn([ATTRS], [HANDLER]),
    (receiver, [attrs]) => handlerPointer(type, withAttrs(handlerOf(receiver), attrsOf(attrs))),
    true
  );
  addMethod(
    type,
    'WithGroup',
    fn([STRING], [HANDLER]),
    (receiver, [name]) => handlerPointer(type, withGroup(handlerOf(receiver), name as string)),
    true
  );
  return type;
}

export const TEXT_HANDLER = defineCommonHandler('TextHandler');
export const JSON_HANDLER = defineCommonHandler('JSONHandler');
