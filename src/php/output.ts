// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import type { ClassRef, Expr, FunctionDecl, Stmt } from './ast';
import { nestedBodies } from './astAnalysis';
import { callMethod } from './callables';
import { canAccessConstant } from './classConstants';
import {
  declForKey,
  findClass,
  nativePropertySlot,
  objectPropertyKeys,
  propNameOf,
  snapshotDynamicProperties,
} from './classes';
import { type Constant, foldedConstant } from './constantDefaults';
import { formatFloat, formatFloatRepr } from './conversions';
import { deprecated, E_ERROR, reportUncaughtWarning, warn, withCleanupExceptions } from './errors';
import { toStr } from './operators';
import { FatalError, PhpThrow, rt } from './runtime';
import { describePropertyType } from './types';
import { type ClosureData, isClosure, PhpArray, PhpObject, Ref, type Slot, UNINIT, type Value } from './values';

type DebugEntry = [string | bigint, Slot, string];

interface Inspection {
  active: Set<object>;
  capture: (error: PhpThrow) => void;
  pending?: PhpThrow;
}

function inspect<T>(run: (state: Inspection) => T): T {
  let result!: T;
  withCleanupExceptions(rt(), (capture) => {
    const state: Inspection = {
      active: new Set(),
      capture(error) {
        capture(error);
        state.pending = error;
      },
    };
    result = run(state);
  });
  return result;
}

// code-gauge-allow functionNcss 34 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
// code-gauge-allow functionCognitiveComplexity 23 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function debugEntries(object: PhpObject, state: Inspection): { entries: Iterable<DebugEntry>; initialized: number } {
  if (object.cls.findMethod('__debuginfo')) {
    if (state.pending) {
      reportUncaughtWarning(state.pending.object);
      failDebugInfo(false);
    }
    let info: Value;
    try {
      info = callMethod(object, '__debugInfo', []);
    } catch (error) {
      if (!(error instanceof PhpThrow)) throw error;
      reportUncaughtWarning(error.object);
      failDebugInfo(false);
    }
    if (info === null) {
      deprecated(`Returning null from ${object.cls.name}::__debugInfo() is deprecated, return an empty array instead`);
      return { entries: [], initialized: 0 };
    }
    if (!(info instanceof PhpArray)) failDebugInfo();
    const entries: DebugEntry[] = [...info.map].map(([key, slot]) => [
      key,
      slot,
      typeof key === 'string' ? `"${key}"` : `${key}`,
    ]);
    return { entries, initialized: entries.length };
  }
  if (isClosure(object)) {
    const entries = closureDebug(object);
    return { entries, initialized: entries.length };
  }
  const internal = object.internal as { debugEntries?: () => [string | bigint, Value][] } | undefined;
  if (internal?.debugEntries) {
    const entries: DebugEntry[] = internal
      .debugEntries()
      .map(([key, value]) => [typeof key === 'string' ? propNameOf(key) : key, value, debugLabel(key)]);
    return { entries, initialized: entries.length };
  }
  const keys: string[] = [];
  let initialized = 0;
  for (const [key, slot] of object.props) {
    rt().spend();
    keys.push(key);
    if (slot !== UNINIT) initialized++;
  }
  return { entries: debugPropertyEntries(object, keys, state), initialized };
}

function* debugPropertyEntries(object: PhpObject, keys: string[], state: Inspection): Generator<DebugEntry> {
  for (const [key, slot] of propertyEntries(object, keys, state, (key) => object.props.get(key))) {
    if (slot === UNINIT && !declForKey(object.cls, key)?.type) continue;
    const name = propNameOf(key);
    const decl = declForKey(object.cls, key);
    const label =
      decl?.visibility === 'protected'
        ? `"${name}":protected`
        : decl?.visibility === 'private'
          ? `"${name}":"${decl.cls.name}":private`
          : `"${name}"`;
    yield [name, slot, label];
  }
}

function failDebugInfo(withTrace = true): never {
  throw new FatalError(
    (rt().errorReporting & E_ERROR) !== 0n ? '__debuginfo() must return an array' : '',
    rt().row,
    false,
    withTrace
  );
}

/** The label `var_dump` shows for a key of a debug table, unmangling a private or protected property name. */
function debugLabel(key: string | bigint): string {
  if (typeof key === 'bigint') return `${key}`;
  if (!key.startsWith('\0')) return `"${key}"`;
  const owner = key.slice(1, key.indexOf('\0', 1));
  const name = propNameOf(key);
  return owner === '*' ? `"${name}":protected` : `"${name}":"${owner}":private`;
}

// code-gauge-allow functionCognitiveComplexity 25 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
function closureDebug(object: PhpObject): [string, Value, string][] {
  const data = object.internal as ClosureData;
  const entries: [string, Value, string][] = [];
  const fn = data.fn;
  if (fn.kind === 'user' && fn.decl.isClosure) {
    entries.push(
      ['name', fn.decl.name, '"name"'],
      ['file', '/main.php', '"file"'],
      ['line', BigInt(fn.decl.row + 1), '"line"']
    );
  } else {
    entries.push([
      'function',
      data.method
        ? `${data.method.scope.name}::${data.method.name}`
        : data.scope
          ? `${data.scope.name}::${fn.name}`
          : fn.name,
      '"function"',
    ]);
  }
  const statics = new PhpArray();
  for (const [name, slot] of closureStatics(data)) {
    statics.setSlot(name, slot instanceof Ref && (!slot.isRef || slot.rc <= 1) ? slot.v : slot);
  }
  if (statics.size > 0) entries.push(['static', statics, '"static"']);
  if (data.thisObj) entries.push(['this', data.thisObj, '"this"']);
  if (!data.omitParameters && fn.params.length > 0) {
    const params = new PhpArray();
    for (const param of fn.params)
      params.set(`${param.byRef ? '&' : ''}$${param.name}`, param.optional ? '<optional>' : '<required>');
    entries.push(['parameter', params, '"parameter"']);
  }
  return entries;
}

const staticDeclarations = new WeakMap<FunctionDecl, [string, Expr | undefined][]>();

function closureStatics(data: ClosureData): Map<string, Value | Ref> {
  const slots = new Map<string, Value | Ref>(data.bound);
  if (data.fn.kind === 'user') {
    for (const [name, init] of declaredStatics(data.fn.decl)) {
      const live = data.fn.statics.get(name);
      slots.set(name, live ?? previewStatic(init, data));
    }
    for (const [name, ref] of data.fn.statics) slots.set(name, ref);
  }
  return slots;
}

function declaredStatics(decl: FunctionDecl): [string, Expr | undefined][] {
  const cached = staticDeclarations.get(decl);
  if (cached) return cached;
  const entries: [string, Expr | undefined][] = [];
  const pending: Stmt[] = decl.body.toReversed();
  while (pending.length > 0) {
    const statement = pending.pop()!;
    if (statement.k === 'static') {
      for (const { name, init } of statement.vars) entries.push([name, init]);
    }
    for (const [body] of nestedBodies(statement).toReversed()) {
      for (let index = body.length - 1; index >= 0; index--) pending.push(body[index]);
    }
  }
  staticDeclarations.set(decl, entries);
  return entries;
}

function previewStatic(init: Expr | undefined, data: ClosureData): Value {
  if (!init) return null;
  if (init.k === 'magic') {
    if (init.name === '__CLASS__') return data.scope?.fullName ?? '';
    if (init.name === '__TRAIT__') return data.scope?.kind === 'trait' ? data.scope.name : '';
    return data.fn.kind === 'user' ? data.fn.decl.name : data.fn.name;
  }
  return materializeConstant(foldedConstant(init, { classConstant: (cls, name) => previewConstant(cls, name, data) }));
}

function previewConstant(ref: ClassRef, name: string, data: ClosureData): Constant | undefined {
  const cls =
    ref.k === 'named'
      ? findClass(ref.name)
      : ref.k === 'self'
        ? data.scope
        : ref.k === 'parent'
          ? data.scope?.parent
          : undefined;
  const entry = cls?.findConst(name);
  if (!entry || !canAccessConstant(entry, data.scope)) return undefined;
  const value = entry.value;
  if (value !== undefined && !(value instanceof PhpObject || value instanceof PhpArray)) return value;
  return entry.initializer ? foldedConstant(entry.initializer, {}) : undefined;
}

function materializeConstant(value: Constant | undefined): Value {
  if (!(value instanceof Map)) return value ?? null;
  const array = new PhpArray();
  for (const [key, slot] of value) array.set(key, materializeConstant(slot));
  return array;
}

function slotValue(slot: Slot): Value {
  if (slot instanceof Ref) return slot.v;
  if (slot === UNINIT) return null;
  return slot;
}

/**
 * Charges for one more element of a dump and refuses a dump past the string limit, as a structure whose arrays share
 * their elements may print far more than it holds.
 */
function grown(text: string): string {
  const runtime = rt();
  runtime.spend();
  runtime.ensureStringFits(text.length);
  return text;
}

// print_r ------------------------------------------------------------------------------------------------------------

export function printR(value: Value, returnText: boolean): string | true {
  return inspect((state) => {
    const text = printRValue(value, 0, state);
    if (returnText) return text;
    rt().echo(text);
    return true;
  });
}

function printRValue(value: Value, indent: number, state: Inspection): string {
  if (value instanceof PhpArray) {
    if (state.active.has(value)) return 'Array\n *RECURSION*';
    state.active.add(value);
    try {
      return `Array\n${printHash(printableArrayEntries(value), indent, state)}`;
    } finally {
      state.active.delete(value);
    }
  }
  if (value instanceof PhpObject && value.cls.name === '(stream)') return `Resource id #${value.id}`;
  if (value instanceof PhpObject) {
    const header = `${value.cls.name} Object\n`;
    if (state.active.has(value)) return `${header} *RECURSION*`;
    state.active.add(value);
    try {
      return header + printHash(printableDebugEntries(debugEntries(value, state).entries), indent, state);
    } finally {
      state.active.delete(value);
    }
  }
  if (typeof value === 'number') return formatFloat(value);
  return toStr(value);
}

function* printableArrayEntries(array: PhpArray): Generator<[string, Value]> {
  for (const [key, slot] of array.map) yield [String(key), slotValue(slot)];
}

function* printableDebugEntries(entries: Iterable<DebugEntry>): Generator<[string, Value]> {
  for (const [key, slot, label] of entries) {
    if (slot !== UNINIT) yield [printRLabel(key, label), slotValue(slot)];
  }
}

function printRLabel(key: string | bigint, label: string): string {
  if (typeof key === 'bigint') return String(key);
  const match = /^"(.*)":"(.*)":private$/s.exec(label);
  if (match) return `${match[1]}:${match[2]}:private`;
  if (label.endsWith(':protected')) return `${key}:protected`;
  return key;
}

function printHash(entries: Iterable<[string, Value]>, indent: number, state: Inspection): string {
  let text = `${' '.repeat(indent)}(\n`;
  for (const [key, item] of entries) {
    text = grown(`${text}${' '.repeat(indent + 4)}[${key}] => ${printRValue(item, indent + 8, state)}\n`);
  }
  return `${text}${' '.repeat(indent)})\n`;
}

// var_dump -----------------------------------------------------------------------------------------------------------

export function varDump(values: Value[]): void {
  const runtime = rt();
  const write = (text: string): void => runtime.echo(text);
  inspect((state) => {
    for (const value of values) dumpValue(value, 1, state, write);
  });
}

// code-gauge-allow functionNcss 32 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
// code-gauge-allow functionCognitiveComplexity 17 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function dumpValue(value: Value, level: number, state: Inspection, write: (text: string) => void, slot?: Slot): void {
  const indent = level > 1 ? ' '.repeat(level - 1) : '';
  const reference = slot instanceof Ref && slot.rc > 1 ? '&' : '';
  const pad = indent + reference;
  if (value === null) return write(`${pad}NULL\n`);
  switch (typeof value) {
    case 'boolean': {
      return write(`${pad}bool(${value})\n`);
    }
    case 'bigint': {
      return write(`${pad}int(${value})\n`);
    }
    case 'number': {
      return write(`${pad}float(${formatFloatRepr(value)})\n`);
    }
    case 'string': {
      return write(`${pad}string(${value.length}) "${value}"\n`);
    }
  }
  if (value instanceof PhpObject && value.isResource) return write(`${pad}resource(${value.id}) of type (stream)\n`);
  if (state.active.has(value)) return write(`${indent}*RECURSION*\n`);
  state.active.add(value);
  try {
    if (value instanceof PhpArray) {
      write(`${pad}array(${value.size}) {\n`);
      for (const [key, item] of value.map) {
        write(`${' '.repeat(level + 1)}[${typeof key === 'bigint' ? key : `"${key}"`}]=>\n`);
        dumpValue(slotValue(item), level + 2, state, write, item);
      }
    } else {
      if (indent) write(indent);
      dumpObject(value, level, state, write, reference);
    }
    write(`${indent}}\n`);
  } finally {
    state.active.delete(value);
  }
}

function dumpObject(
  object: PhpObject,
  level: number,
  state: Inspection,
  write: (text: string) => void,
  reference: string
): void {
  const { entries, initialized } = debugEntries(object, state);
  write(`${reference}object(${object.cls.name})#${object.id} (${initialized}) {\n`);
  const indent = ' '.repeat(level + 1);
  for (const [key, slot, label] of entries) {
    write(`${indent}[${typeof key === 'bigint' ? key : label}]=>\n`);
    if (slot === UNINIT) {
      const decl = declForKey(object.cls, typeof key === 'string' ? keyFor(key, label) : String(key));
      write(`${indent}uninitialized(${decl?.type ? describePropertyType(decl) : 'mixed'})\n`);
    } else dumpValue(slotValue(slot), level + 2, state, write, slot);
  }
}

function keyFor(name: string, label: string): string {
  const match = /^"(.*)":"(.*)":private$/s.exec(label);
  if (match) return `\0${match[2]}\0${name}`;
  return name;
}

// var_export ---------------------------------------------------------------------------------------------------------

export function varExport(value: Value, returnText: boolean): string | null {
  return inspect((state) => {
    const text = exportValue(value, 1, state);
    if (returnText) return text;
    rt().echo(text);
    return null;
  });
}

function quoteExport(text: string): string {
  return `'${text.replaceAll(/['\\]/g, String.raw`\$&`).replaceAll('\0', `' . "\\0" . '`)}'`;
}

// code-gauge-allow functionCognitiveComplexity 26 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
// code-gauge-allow functionNcss 39 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
function exportValue(value: Value, level: number, state: Inspection): string {
  if (value === null || (value instanceof PhpObject && value.isResource)) return 'NULL';
  switch (typeof value) {
    case 'boolean': {
      return value ? 'true' : 'false';
    }
    case 'bigint': {
      return value === -9_223_372_036_854_775_808n ? '-9223372036854775807-1' : value.toString();
    }
    case 'number': {
      return formatFloatRepr(value, 'E', true);
    }
    case 'string': {
      return quoteExport(value);
    }
  }
  const lead = level > 1 ? `\n${' '.repeat(level - 1)}` : '';
  const close = level > 1 ? ' '.repeat(level - 1) : '';
  if (value instanceof PhpArray) {
    if (state.active.has(value)) return circularExport();
    state.active.add(value);
    try {
      let text = `${lead}array (\n`;
      for (const [key, item] of value.entries()) {
        const keyText = typeof key === 'bigint' ? key.toString() : quoteExport(key);
        text = grown(`${text}${' '.repeat(level + 1)}${keyText} => ${exportValue(item, level + 2, state)},\n`);
      }
      return `${text}${close})`;
    } finally {
      state.active.delete(value);
    }
  }
  const object = value as PhpObject;
  if (state.active.has(object)) return circularExport();
  state.active.add(object);
  try {
    const isStd = object.cls.name === 'stdClass';
    let text = isStd ? `${lead}(object) array(\n` : `${lead}\\${object.cls.fullName}::__set_state(array(\n`;
    for (const [key, slot] of exportedProps(object, state)) {
      if (slot === UNINIT) continue;
      const keyText = typeof key === 'bigint' ? String(key) : quoteExport(propNameOf(key));
      text = grown(`${text}${' '.repeat(level + 2)}${keyText} => ${exportValue(slotValue(slot), level + 2, state)},\n`);
    }
    return `${text}${close}${isStd ? ')' : '))'}`;
  } finally {
    state.active.delete(object);
  }
}

function* exportedProps(object: PhpObject, state: Inspection): Generator<[string | bigint, Slot]> {
  const storage = object.internal as
    | {
        properties?: () => PhpArray;
        exportEntries?: () => [bigint, Value][];
      }
    | undefined;
  if (storage?.properties) {
    yield* storage.properties().map;
    return;
  }
  yield* storage?.exportEntries?.() ?? [];
  yield* propertyEntries(object, objectPropertyKeys(object), state, (key, decl) => {
    if (state.pending && decl.hooks?.get) throw state.pending;
    return nativePropertySlot(object, key, decl);
  });
}

function* propertyEntries(
  object: PhpObject,
  keys: string[],
  state: Inspection,
  readDeclared: (key: string, decl: NonNullable<ReturnType<typeof declForKey>>) => Slot | undefined
): Generator<[string, Slot]> {
  const dynamic = snapshotDynamicProperties(object);
  const runtime = rt();
  runtime.nativeHeld.push([dynamic]);
  let completed = false;
  try {
    for (const key of keys) {
      const decl = declForKey(object.cls, key);
      const slot = decl ? readDeclared(key, decl) : dynamic.map.get(key);
      if (slot !== undefined) yield [key, slot];
    }
    completed = true;
  } finally {
    runtime.nativeHeld.pop();
    runtime.release([dynamic]);
    if (completed && dynamic.composite) flushInspectionReleases(state);
  }
}

function flushInspectionReleases(state: Inspection): void {
  try {
    rt().flushReleases(true);
  } catch (error) {
    if (!(error instanceof PhpThrow)) throw error;
    state.capture(error);
  }
}

function circularExport(): string {
  warn('var_export does not handle circular references');
  return 'NULL';
}
