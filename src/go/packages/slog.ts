import type { Entity, FuncEntity } from '../entities';
import { newError } from '../errorValues';
import { addMethod, currentRuntime, definePackage, fn, namedType, nativeFunc, opaqueType, typeEntity } from '../native';
import type { FunctionInfo, Runtime } from '../runtime';
import { BASIC, ERROR_TYPE, pointerTo, sliceOf, type Type } from '../types';
import { Cell, GoStruct, Iface, type NativeState, Pointer, type Value } from '../values';
import { ERRORS_PACKAGE } from './errors';
import { FMT_PACKAGE } from './fmt';
import { IO_WRITER, libraryVariable } from './io';
import {
  LOG_LOGGER_POINTER,
  logCallLine,
  newLogger,
  output,
  setStandardOutput,
  standardLogger,
  standardLoggerReportsFiles,
} from './log';
import {
  type CommonHandler,
  CONTEXT,
  HANDLER,
  HANDLER_OPTIONS,
  handlerPointer,
  HandleState,
  JSON_HANDLER,
  KEYS,
  LEVELER,
  newCommonHandler,
  RECORD,
  recordOf,
  recordToGo,
  type SlogRecord,
  SOURCE,
  sourceOf,
  TEXT_HANDLER,
  withAttrs,
  withGroup,
} from './slogHandler';
import {
  anyValue,
  argsToAttr,
  argsToAttrSlice,
  ATTR,
  ATTRS,
  attrsOf,
  attrToGo,
  groupValue,
  isEmptyGroup,
  KIND,
  KIND_NAMES,
  LEVEL,
  levelString,
  LOG_VALUER,
  type SlogAttr,
  type SlogValue,
  timeSlogValue,
  VALUE,
  valueToGo,
} from './slogValue';
import { STRCONV_PACKAGE } from './strconv';
import {
  ANY,
  ANY_SLICE,
  BOOL,
  BYTES,
  byteSlice,
  bytesOf,
  callFunction,
  callMethod,
  FLOAT64,
  INT,
  receiverStruct,
  sliceOfValues,
  sliceValues,
  STRING,
  stringPanic,
} from './support';
import { DURATION, now, TIME, timeOf } from './time';

const INT64 = BASIC.int64;
const UINT64 = BASIC.uint64;

// Level and LevelVar ------------------------------------------------------------------------------------------------

function callLibrary(pkg: { members: ReadonlyMap<string, Entity> }, name: string, args: Value[]): Value | Value[] {
  return (pkg.members.get(name) as FuncEntity).direct?.(args, undefined) as Value | Value[];
}

/** `Level.parse`, with Go's error wrapping. */
function parseLevel(text: string): [bigint, Value] {
  const fail = (error: Value): [bigint, Value] => {
    const args = sliceOfValues([new Iface(STRING, text), error]);
    return [0n, callLibrary(FMT_PACKAGE, 'Errorf', ['slog: level string %q: %w', args]) as Value];
  };
  let name = text;
  let offset = 0n;
  const index = text.search(/[+-]/);
  if (index >= 0) {
    name = text.slice(0, index);
    const [value, error] = callLibrary(STRCONV_PACKAGE, 'Atoi', [text.slice(index)]) as [bigint, Value];
    if (error !== undefined) return fail(error);
    offset = value;
  }
  const base = ({ DEBUG: -4n, INFO: 0n, WARN: 4n, ERROR: 8n } as Record<string, bigint>)[name.toUpperCase()];
  if (base === undefined) return fail(newError('unknown name'));
  return [BigInt.asIntN(64, base + offset), undefined];
}

addMethod(LEVEL, 'String', fn([], [STRING]), (receiver) => levelString(receiver as bigint));
addMethod(LEVEL, 'Level', fn([], [LEVEL]), (receiver) => receiver);
addMethod(LEVEL, 'MarshalJSON', fn([], [BYTES, ERROR_TYPE]), (receiver) => [
  byteSlice(`"${levelString(receiver as bigint)}"`),
  undefined,
]);
addMethod(LEVEL, 'MarshalText', fn([], [BYTES, ERROR_TYPE]), (receiver) => [
  byteSlice(levelString(receiver as bigint)),
  undefined,
]);
addMethod(LEVEL, 'AppendText', fn([BYTES], [BYTES, ERROR_TYPE]), (receiver, [bytes]) => [
  byteSlice(bytesOf(bytes) + levelString(receiver as bigint)),
  undefined,
]);
addMethod(
  LEVEL,
  'UnmarshalText',
  fn([BYTES], [ERROR_TYPE]),
  (receiver, [bytes]) => storeParsedLevel(receiver as Pointer, bytesOf(bytes)),
  true
);
addMethod(
  LEVEL,
  'UnmarshalJSON',
  fn([BYTES], [ERROR_TYPE]),
  (receiver, [bytes]) => {
    const [text, error] = callLibrary(STRCONV_PACKAGE, 'Unquote', [bytesOf(bytes)]) as [string, Value];
    if (error !== undefined) return error;
    return storeParsedLevel(receiver as Pointer, text);
  },
  true
);

function storeParsedLevel(pointer: Pointer, text: string): Value {
  const [level, error] = parseLevel(text);
  if (error === undefined) pointer.store(level);
  return error;
}

const LEVEL_VAR = opaqueType(namedType('slog', 'LevelVar', { kind: 'struct', fields: [] }));

interface LevelVarState extends NativeState {
  level: bigint;
}

function levelVarOf(receiver: Value): LevelVarState {
  const struct = receiverStruct(receiver);
  struct.native ??= newLevelVarState(0n);
  return struct.native as LevelVarState;
}

function newLevelVarState(level: bigint): LevelVarState {
  const state: LevelVarState = { level, clone: () => newLevelVarState(state.level) };
  return state;
}

addMethod(LEVEL_VAR, 'Level', fn([], [LEVEL]), (receiver) => levelVarOf(receiver).level, true);
addMethod(
  LEVEL_VAR,
  'Set',
  fn([LEVEL], []),
  (receiver, [level]) => {
    levelVarOf(receiver).level = level as bigint;
    return [];
  },
  true
);
addMethod(
  LEVEL_VAR,
  'String',
  fn([], [STRING]),
  (receiver) => `LevelVar(${levelString(levelVarOf(receiver).level)})`,
  true
);
addMethod(
  LEVEL_VAR,
  'MarshalText',
  fn([], [BYTES, ERROR_TYPE]),
  (receiver) => [byteSlice(levelString(levelVarOf(receiver).level)), undefined],
  true
);
addMethod(
  LEVEL_VAR,
  'AppendText',
  fn([BYTES], [BYTES, ERROR_TYPE]),
  (receiver, [bytes]) => [byteSlice(bytesOf(bytes) + levelString(levelVarOf(receiver).level)), undefined],
  true
);
addMethod(
  LEVEL_VAR,
  'UnmarshalText',
  fn([BYTES], [ERROR_TYPE]),
  (receiver, [bytes]) => {
    const [level, error] = parseLevel(bytesOf(bytes));
    if (error === undefined) levelVarOf(receiver).level = level;
    return error;
  },
  true
);

// The default handler, the discard handler, and MultiHandler -------------------------------------------------------

/** `defaultHandler`, which writes through the log package's standard logger. */
const DEFAULT_HANDLER = opaqueType(namedType('slog', 'defaultHandler', { kind: 'struct', fields: [] }));

function commonOf(receiver: Value): CommonHandler {
  return receiverStruct(receiver).native?.handler as CommonHandler;
}

addMethod(
  DEFAULT_HANDLER,
  'Enabled',
  fn([CONTEXT, LEVEL], [BOOL]),
  (_, [, level]) => (level as bigint) >= logLoggerLevel(),
  true
);
addMethod(
  DEFAULT_HANDLER,
  'Handle',
  fn([CONTEXT, RECORD], [ERROR_TYPE]),
  (receiver, [, value]) => {
    const record = recordOf(value);
    const state = new HandleState(commonOf(receiver), `${levelString(record.level)} ${record.message}`, ' ');
    state.appendNonBuiltIns(record);
    return output(standardLogger(), record.pc === 0 ? undefined : record.pc, state.buf);
  },
  true
);
addMethod(
  DEFAULT_HANDLER,
  'WithAttrs',
  fn([ATTRS], [HANDLER]),
  (receiver, [attrs]) => handlerPointer(DEFAULT_HANDLER, withAttrs(commonOf(receiver), attrsOf(attrs))),
  true
);
addMethod(
  DEFAULT_HANDLER,
  'WithGroup',
  fn([STRING], [HANDLER]),
  (receiver, [name]) => handlerPointer(DEFAULT_HANDLER, withGroup(commonOf(receiver), name as string)),
  true
);

const DISCARD_HANDLER = namedType('slog', 'discardHandler', { kind: 'struct', fields: [] });
const DISCARD = new Iface(DISCARD_HANDLER, new GoStruct([]));
addMethod(DISCARD_HANDLER, 'Enabled', fn([CONTEXT, LEVEL], [BOOL]), () => false);
addMethod(DISCARD_HANDLER, 'Handle', fn([CONTEXT, RECORD], [ERROR_TYPE]), () => {});
addMethod(DISCARD_HANDLER, 'WithAttrs', fn([ATTRS], [HANDLER]), () => DISCARD);
addMethod(DISCARD_HANDLER, 'WithGroup', fn([STRING], [HANDLER]), () => DISCARD);

const MULTI_HANDLER = opaqueType(namedType('slog', 'MultiHandler', { kind: 'struct', fields: [] }));

function multiOf(receiver: Value): Value[] {
  return receiverStruct(receiver).native?.handlers as Value[];
}

function newMulti(handlers: Value[]): Pointer {
  return new Pointer(new Cell(new GoStruct([], { handlers })), 'v');
}

function multiIface(handlers: Value[]): Iface {
  return new Iface(pointerTo(MULTI_HANDLER), newMulti(handlers));
}

addMethod(
  MULTI_HANDLER,
  'Enabled',
  fn([CONTEXT, LEVEL], [BOOL]),
  (receiver, [ctx, level]) => multiOf(receiver).some((h) => callMethod(h, 'Enabled', [ctx, level]) === true),
  true
);
addMethod(
  MULTI_HANDLER,
  'Handle',
  fn([CONTEXT, RECORD], [ERROR_TYPE]),
  (receiver, [ctx, value]) => {
    const record = recordOf(value);
    const errors: Value[] = [];
    for (const h of multiOf(receiver)) {
      if (callMethod(h, 'Enabled', [ctx, record.level]) !== true) continue;
      const error = callMethod(h, 'Handle', [ctx, recordToGo({ ...record, attrs: [...record.attrs] })]) as Value;
      if (error !== undefined) errors.push(error);
    }
    return callLibrary(ERRORS_PACKAGE, 'Join', [sliceOfValues(errors)]) as Value;
  },
  true
);
addMethod(
  MULTI_HANDLER,
  'WithAttrs',
  fn([ATTRS], [HANDLER]),
  (receiver, [attrs]) => multiIface(multiOf(receiver).map((h) => callMethod(h, 'WithAttrs', [attrs]) as Value)),
  true
);
addMethod(
  MULTI_HANDLER,
  'WithGroup',
  fn([STRING], [HANDLER]),
  (receiver, [name]) => multiIface(multiOf(receiver).map((h) => callMethod(h, 'WithGroup', [name]) as Value)),
  true
);

/** `handlerWriter`, the io.Writer that SetDefault gives the standard logger. */
const HANDLER_WRITER = opaqueType(namedType('slog', 'handlerWriter', { kind: 'struct', fields: [] }));

interface HandlerWriterState extends NativeState {
  handler: Value;
  level: () => bigint;
  capturePC: boolean;
}

addMethod(
  HANDLER_WRITER,
  'Write',
  fn([BYTES], [INT, ERROR_TYPE]),
  (receiver, [bytes]) => {
    const { handler, level, capturePC } = receiverStruct(receiver).native as HandlerWriterState;
    const current = level();
    if (callMethod(handler, 'Enabled', [undefined, current]) !== true) return [0n, undefined];
    const text = bytesOf(bytes);
    const message = text.endsWith('\n') ? text.slice(0, -1) : text;
    const record = newRecord(current, message, capturePC ? logCallLine() : undefined);
    return [BigInt(text.length), callMethod(handler, 'Handle', [undefined, recordToGo(record)]) as Value];
  },
  true
);

function handlerWriter(handler: Value, level: () => bigint, capturePC: boolean): Iface {
  const state: HandlerWriterState = { handler, level, capturePC };
  return new Iface(pointerTo(HANDLER_WRITER), new Pointer(new Cell(new GoStruct([], state)), 'v'));
}

// Logger ------------------------------------------------------------------------------------------------------------

const LOGGER = opaqueType(
  namedType('slog', 'Logger', { kind: 'struct', fields: [{ name: 'handler', type: HANDLER, embedded: false }] })
);
const LOGGER_POINTER = pointerTo(LOGGER);

function newSlogLogger(handler: Value): Pointer {
  if (handler === undefined) stringPanic('nil Handler');
  return new Pointer(new Cell(new GoStruct([handler])), 'v');
}

function handlerOfLogger(logger: Value): Value {
  return receiverStruct(logger).fields[0];
}

interface SlogState {
  defaultLogger: Pointer;
  logLoggerLevel: bigint;
}

const states = new WeakMap<Runtime, SlogState>();

function slogState(): SlogState {
  const runtime = currentRuntime();
  let state = states.get(runtime);
  if (!state) {
    const handler = handlerPointer(DEFAULT_HANDLER, newCommonHandler(false, undefined, undefined));
    state = { defaultLogger: newSlogLogger(handler), logLoggerLevel: 0n };
    states.set(runtime, state);
  }
  return state;
}

function logLoggerLevel(): bigint {
  return slogState().logLoggerLevel;
}

function newRecord(level: bigint, message: string, line: number | undefined): SlogRecord {
  const frame = currentRuntime().frames.at(-1);
  return {
    time: now(),
    level,
    message,
    pc: line ?? 0,
    attrs: [],
    function: frame && line !== undefined ? functionName(frame.info) : '',
  };
}

/** The name runtime.Frame gives a function: `main.f`, `main.T.M`, or `main.(*T).M` for a pointer receiver. */
function functionName(info: FunctionInfo): string {
  const receiver = info.locals.find((local) => local.isReceiver);
  if (receiver?.type.kind !== 'pointer') return `main.${info.name}`;
  const dot = info.name.lastIndexOf('.');
  return `main.(*${info.name.slice(0, dot)})${info.name.slice(dot)}`;
}

// Record ------------------------------------------------------------------------------------------------------------

function recordState(receiver: Value): SlogRecord {
  const struct = receiver instanceof Pointer ? receiverStruct(receiver) : (receiver as GoStruct);
  const record = recordOf(struct);
  struct.native = recordToGo(record).native;
  return (struct.native as { record: SlogRecord }).record;
}

/** `Record.Add` and `Record.AddAttrs`, which drop empty groups. */
function addAttrs(receiver: Value, attrs: SlogAttr[]): Value[] {
  const record = recordState(receiver);
  record.attrs.push(...attrs.filter((attr) => !isEmptyGroup(attr.value)));
  return [];
}

addMethod(RECORD, 'Add', fn([ANY_SLICE], [], true), (receiver, [args]) => addAttrs(receiver, argsAttrs(args)()), true);
addMethod(RECORD, 'AddAttrs', fn([ATTRS], [], true), (receiver, [attrs]) => addAttrs(receiver, attrsOf(attrs)), true);
addMethod(RECORD, 'NumAttrs', fn([], [INT]), (receiver) => BigInt(recordState(receiver).attrs.length));
addMethod(RECORD, 'Clone', fn([], [RECORD]), (receiver) => {
  const record = recordState(receiver);
  return recordToGo({ ...record, attrs: [...record.attrs] });
});
addMethod(RECORD, 'Attrs', fn([fn([ATTR], [BOOL])], []), (receiver, [visit]) => {
  for (const attr of recordState(receiver).attrs) {
    if (callFunction(visit, [attrToGo(attr)]) !== true) break;
  }
  return [];
});
addMethod(RECORD, 'Source', fn([], [pointerTo(SOURCE)]), (receiver) => {
  const record = recordState(receiver);
  return record.pc === 0 ? undefined : sourceOf(record).value;
});

/** `Logger.log` and `Logger.logAttrs`, where `attrs` turns the arguments into the record's attrs. */
function log(
  logger: Value,
  ctx: Value,
  level: bigint,
  message: string,
  attrs: () => SlogAttr[],
  callRow: number | undefined
): void {
  const handler = handlerOfLogger(logger);
  if (callMethod(handler, 'Enabled', [ctx, level]) !== true) return;
  const record = newRecord(level, message, callRow === undefined ? undefined : callRow + 1);
  record.attrs = attrs().filter((attr) => !isEmptyGroup(attr.value));
  callMethod(handler, 'Handle', [ctx, recordToGo(record)]);
}

function argsAttrs(args: Value): () => SlogAttr[] {
  return () => {
    const result: SlogAttr[] = [];
    let rest = sliceValues(args);
    while (rest.length > 0) {
      const [attr, next] = argsToAttr(rest);
      result.push(attr);
      rest = next;
    }
    return result;
  };
}

type LoggerImpl = (logger: Value, args: Value[], callRow: number | undefined) => Value | Value[];

const LEVEL_METHODS: [string, bigint][] = [
  ['Debug', -4n],
  ['Info', 0n],
  ['Warn', 4n],
  ['Error', 8n],
];

/** The methods of *Logger that the package also offers as functions of the default logger. */
function loggingMembers(): Record<string, { params: Type[]; results: Type[]; variadic: boolean; impl: LoggerImpl }> {
  const result: Record<string, { params: Type[]; results: Type[]; variadic: boolean; impl: LoggerImpl }> = {};
  for (const [name, level] of LEVEL_METHODS) {
    result[name] = {
      params: [STRING, ANY_SLICE],
      results: [],
      variadic: true,
      impl: (logger, [message, args], row) => {
        log(logger, undefined, level, message as string, argsAttrs(args), row);
        return [];
      },
    };
    result[`${name}Context`] = {
      params: [CONTEXT, STRING, ANY_SLICE],
      results: [],
      variadic: true,
      impl: (logger, [ctx, message, args], row) => {
        log(logger, ctx, level, message as string, argsAttrs(args), row);
        return [];
      },
    };
  }
  result.Log = {
    params: [CONTEXT, LEVEL, STRING, ANY_SLICE],
    results: [],
    variadic: true,
    impl: (logger, [ctx, level, message, args], row) => {
      log(logger, ctx, level as bigint, message as string, argsAttrs(args), row);
      return [];
    },
  };
  result.LogAttrs = {
    params: [CONTEXT, LEVEL, STRING, ATTRS],
    results: [],
    variadic: true,
    impl: (logger, [ctx, level, message, attrs], row) => {
      log(logger, ctx, level as bigint, message as string, () => attrsOf(attrs), row);
      return [];
    },
  };
  result.With = {
    params: [ANY_SLICE],
    results: [LOGGER_POINTER],
    variadic: true,
    impl: (logger, [args]) => {
      const values = sliceValues(args);
      if (values.length === 0) return logger;
      const attrs = sliceOfValues(argsToAttrSlice(values).map(attrToGo));
      return newSlogLogger(callMethod(handlerOfLogger(logger), 'WithAttrs', [attrs]) as Value);
    },
  };
  return result;
}

addMethod(LOGGER, 'Handler', fn([], [HANDLER]), (receiver) => handlerOfLogger(receiver), true);
addMethod(
  LOGGER,
  'WithGroup',
  fn([STRING], [LOGGER_POINTER]),
  (receiver, [name]) =>
    name === '' ? receiver : newSlogLogger(callMethod(handlerOfLogger(receiver), 'WithGroup', [name]) as Value),
  true
);
addMethod(
  LOGGER,
  'Enabled',
  fn([CONTEXT, LEVEL], [BOOL]),
  (receiver, [ctx, level]) => callMethod(handlerOfLogger(receiver), 'Enabled', [ctx, level]),
  true
);

/** A library function that receives the row of its call, which records report as their source line. */
function functionWithRow(
  name: string,
  params: Type[],
  results: Type[],
  impl: (args: Value[], callRow: number | undefined) => Value | Value[],
  variadic = false
): FuncEntity {
  const value = nativeFunc((args, callRow) => impl(args, callRow));
  return {
    kind: 'func',
    name,
    type: fn(params, results, variadic),
    value: () => value,
    direct: (args, callRow) => impl(args, callRow),
  };
}

function simple(
  name: string,
  params: Type[],
  results: Type[],
  impl: (args: Value[]) => Value | Value[],
  variadic = false
): FuncEntity {
  return functionWithRow(name, params, results, (args) => impl(args), variadic);
}

// Package -----------------------------------------------------------------------------------------------------------

function constant(name: string, type: Type, value: bigint | string): Entity {
  return {
    kind: 'const',
    name,
    type,
    value: typeof value === 'string' ? { kind: 'string', value } : { kind: 'int', value },
    span: { row: 0, column: 0 },
    used: true,
  };
}

function attrConstructor(name: string, type: Type, make: (value: Value) => SlogValue): FuncEntity {
  return simple(name, [STRING, type], [ATTR], ([key, value]) => attrToGo({ key: key as string, value: make(value) }));
}

function valueConstructor(name: string, type: Type, make: (value: Value) => SlogValue): FuncEntity {
  return simple(name, [type], [VALUE], ([value]) => valueToGo(make(value)));
}

const int64Value = (value: Value): SlogValue => ({ kind: 'int64', n: value as bigint });
const uint64Value = (value: Value): SlogValue => ({ kind: 'uint64', n: value as bigint });
const float64Value = (value: Value): SlogValue => ({ kind: 'float64', f: value as number });
const stringValue = (value: Value): SlogValue => ({ kind: 'string', s: value as string });
const boolValue = (value: Value): SlogValue => ({ kind: 'bool', b: value as boolean });
const durationValue = (value: Value): SlogValue => ({ kind: 'duration', n: value as bigint });
const timeValueOf = (value: Value): SlogValue => timeSlogValue(timeOf(value));

function setDefault(logger: Value): void {
  if (logger === undefined) {
    // SetDefault dereferences the logger through its Handler method.
    receiverStruct(logger);
  }
  const state = slogState();
  state.defaultLogger = logger as Pointer;
  const handler = handlerOfLogger(logger) as Iface | undefined;
  const isDefault = handler?.type.kind === 'pointer' && (handler.type as { element: Type }).element === DEFAULT_HANDLER;
  if (!isDefault) {
    const capturePC = standardLoggerReportsFiles();
    setStandardOutput(
      handlerWriter(handler, () => slogState().logLoggerLevel, capturePC),
      0
    );
  }
}

const members: Record<string, Entity> = {
  Logger: typeEntity(LOGGER),
  Handler: typeEntity(HANDLER),
  TextHandler: typeEntity(TEXT_HANDLER as never),
  JSONHandler: typeEntity(JSON_HANDLER as never),
  MultiHandler: typeEntity(MULTI_HANDLER),
  HandlerOptions: typeEntity(HANDLER_OPTIONS),
  Attr: typeEntity(ATTR),
  Value: typeEntity(VALUE),
  Kind: typeEntity(KIND),
  Level: typeEntity(LEVEL),
  LevelVar: typeEntity(LEVEL_VAR),
  Leveler: typeEntity(LEVELER),
  LogValuer: typeEntity(LOG_VALUER),
  Record: typeEntity(RECORD),
  Source: typeEntity(SOURCE),
  LevelDebug: constant('LevelDebug', LEVEL, -4n),
  LevelInfo: constant('LevelInfo', LEVEL, 0n),
  LevelWarn: constant('LevelWarn', LEVEL, 4n),
  LevelError: constant('LevelError', LEVEL, 8n),
  ...Object.fromEntries(KIND_NAMES.map((name, index) => [`Kind${name}`, constant(`Kind${name}`, KIND, BigInt(index))])),
  ...Object.fromEntries(
    Object.entries(KEYS).map(([name, value]) => [name, constant(name, BASIC.untypedString, value)])
  ),
  DiscardHandler: libraryVariable('DiscardHandler', HANDLER, DISCARD),
  New: simple('New', [HANDLER], [LOGGER_POINTER], ([handler]) => newSlogLogger(handler)),
  Default: simple('Default', [], [LOGGER_POINTER], () => slogState().defaultLogger),
  SetDefault: simple('SetDefault', [LOGGER_POINTER], [], ([logger]) => {
    setDefault(logger);
    return [];
  }),
  SetLogLoggerLevel: simple('SetLogLoggerLevel', [LEVEL], [LEVEL], ([level]) => {
    const state = slogState();
    const old = state.logLoggerLevel;
    state.logLoggerLevel = level as bigint;
    return old;
  }),
  NewTextHandler: simple(
    'NewTextHandler',
    [IO_WRITER, pointerTo(HANDLER_OPTIONS)],
    [pointerTo(TEXT_HANDLER)],
    ([w, options]) => handlerPointer(TEXT_HANDLER, newCommonHandler(false, w, options)).value
  ),
  NewJSONHandler: simple(
    'NewJSONHandler',
    [IO_WRITER, pointerTo(HANDLER_OPTIONS)],
    [pointerTo(JSON_HANDLER)],
    ([w, options]) => handlerPointer(JSON_HANDLER, newCommonHandler(true, w, options)).value
  ),
  NewMultiHandler: simple(
    'NewMultiHandler',
    [sliceOf(HANDLER)],
    [pointerTo(MULTI_HANDLER)],
    ([handlers]) => newMulti(sliceValues(handlers)),
    true
  ),
  NewLogLogger: simple('NewLogLogger', [HANDLER, LEVEL], [LOG_LOGGER_POINTER], ([handler, level]) =>
    newLogger(
      handlerWriter(handler, () => level as bigint, true),
      '',
      0n
    )
  ),
  String: attrConstructor('String', STRING, stringValue),
  Int: attrConstructor('Int', INT, int64Value),
  Int64: attrConstructor('Int64', INT64, int64Value),
  Uint64: attrConstructor('Uint64', UINT64, uint64Value),
  Float64: attrConstructor('Float64', FLOAT64, float64Value),
  Bool: attrConstructor('Bool', BOOL, boolValue),
  Time: attrConstructor('Time', TIME, timeValueOf),
  Duration: attrConstructor('Duration', DURATION, durationValue),
  Any: attrConstructor('Any', ANY, anyValue),
  Group: simple(
    'Group',
    [STRING, ANY_SLICE],
    [ATTR],
    ([key, args]) => attrToGo({ key: key as string, value: groupValue(argsToAttrSlice(sliceValues(args))) }),
    true
  ),
  GroupAttrs: simple(
    'GroupAttrs',
    [STRING, ATTRS],
    [ATTR],
    ([key, attrs]) => attrToGo({ key: key as string, value: groupValue(attrsOf(attrs)) }),
    true
  ),
  StringValue: valueConstructor('StringValue', STRING, stringValue),
  IntValue: valueConstructor('IntValue', INT, int64Value),
  Int64Value: valueConstructor('Int64Value', INT64, int64Value),
  Uint64Value: valueConstructor('Uint64Value', UINT64, uint64Value),
  Float64Value: valueConstructor('Float64Value', FLOAT64, float64Value),
  BoolValue: valueConstructor('BoolValue', BOOL, boolValue),
  TimeValue: valueConstructor('TimeValue', TIME, timeValueOf),
  DurationValue: valueConstructor('DurationValue', DURATION, durationValue),
  AnyValue: valueConstructor('AnyValue', ANY, anyValue),
  GroupValue: simple('GroupValue', [ATTRS], [VALUE], ([attrs]) => valueToGo(groupValue(attrsOf(attrs))), true),
};

for (const [name, { params, results, variadic, impl }] of Object.entries(loggingMembers())) {
  const signature = fn(params, results, variadic);
  addMethod(LOGGER, name, signature, (receiver, args, callRow?: number) => impl(receiver, args, callRow), true);
  members[name] = functionWithRow(
    name,
    params,
    results,
    (args, callRow) => impl(slogState().defaultLogger, args, callRow),
    variadic
  );
}

members.NewRecord = simple('NewRecord', [TIME, LEVEL, STRING, BASIC.uintptr], [RECORD], ([t, level, message, pc]) =>
  recordToGo({
    time: timeOf(t),
    level: level as bigint,
    message: message as string,
    pc: Number(pc as bigint),
    attrs: [],
    function: '',
  })
);

export const SLOG_PACKAGE = definePackage('log/slog', members);
