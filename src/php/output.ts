// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import { callMethod } from './callables';
import { declForKey, propNameOf } from './classes';
import { formatFloat, formatFloatRepr } from './conversions';
import { warn } from './errors';
import { toStr } from './operators';
import { rt } from './runtime';
import { describeType } from './types';
import { type ClosureData, isClosure, PhpArray, PhpObject, Ref, type Slot, UNINIT, type Value } from './values';

/** The properties an object shows to `var_dump` and `print_r`: `__debugInfo`'s array, or its property table. */
// code-gauge-allow functionCognitiveComplexity 16 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
function debugEntries(object: PhpObject): [string | bigint, Slot, string][] {
  if (object.cls.findMethod('__debuginfo')) {
    const info = callMethod(object, '__debugInfo', []);
    if (info instanceof PhpArray)
      return [...info.entries()].map(([key, value]) => [key, value, typeof key === 'string' ? `"${key}"` : `${key}`]);
  }
  if (isClosure(object)) return closureDebug(object);
  const internal = object.internal as { debugEntries?: () => [string | bigint, Value][] } | undefined;
  if (internal?.debugEntries) {
    return internal
      .debugEntries()
      .map(([key, value]) => [typeof key === 'string' ? propNameOf(key) : key, value, debugLabel(key)]);
  }
  const entries: [string | bigint, Slot, string][] = [];
  for (const [key, slot] of object.props) {
    const name = propNameOf(key);
    const decl = declForKey(object.cls, key);
    let label = `"${name}"`;
    if (decl?.visibility === 'protected') label = `"${name}":protected`;
    else if (decl?.visibility === 'private') label = `"${name}":"${decl.cls.name}":private`;
    entries.push([name, slot, label]);
  }
  return entries;
}

/** The label `var_dump` shows for a key of a debug table, unmangling a private or protected property name. */
function debugLabel(key: string | bigint): string {
  if (typeof key === 'bigint') return `${key}`;
  if (!key.startsWith('\0')) return `"${key}"`;
  const owner = key.slice(1, key.indexOf('\0', 1));
  const name = propNameOf(key);
  return owner === '*' ? `"${name}":protected` : `"${name}":"${owner}":private`;
}

// code-gauge-allow functionCognitiveComplexity 20 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
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
    entries.push(['function', data.method ? `${data.method.scope.name}::${data.method.name}` : fn.name, '"function"']);
  }
  const statics = new PhpArray();
  for (const [name, ref] of data.bound) statics.set(name, ref.v);
  if (fn.kind === 'user') for (const [name, ref] of fn.statics) statics.set(name, ref.v);
  if (statics.size > 0) entries.push(['static', statics, '"static"']);
  if (data.thisObj) entries.push(['this', data.thisObj, '"this"']);
  if (fn.params.length > 0) {
    const params = new PhpArray();
    for (const param of fn.params)
      params.set(`${param.byRef ? '&' : ''}$${param.name}`, param.optional ? '<optional>' : '<required>');
    entries.push(['parameter', params, '"parameter"']);
  }
  return entries;
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

export function printR(value: Value): string {
  return printRValue(value, 0, new Set());
}

function printRValue(value: Value, indent: number, active: Set<object>): string {
  if (value instanceof PhpArray) {
    if (active.has(value)) return 'Array\n *RECURSION*';
    active.add(value);
    try {
      const entries = [...value.entries()].map(([key, item]): [string, Value] => [String(key), item]);
      return `Array\n${printHash(entries, indent, active)}`;
    } finally {
      active.delete(value);
    }
  }
  if (value instanceof PhpObject && value.cls.name === '(stream)') return `Resource id #${value.id}`;
  if (value instanceof PhpObject) {
    const header = `${value.cls.name} Object\n`;
    if (active.has(value)) return `${header} *RECURSION*`;
    active.add(value);
    try {
      const entries = debugEntries(value)
        .filter(([, slot]) => slot !== UNINIT)
        .map(([key, slot, label]): [string, Value] => [printRLabel(key, label), slotValue(slot)]);
      return header + printHash(entries, indent, active);
    } finally {
      active.delete(value);
    }
  }
  if (typeof value === 'number') return formatFloat(value);
  return toStr(value);
}

function printRLabel(key: string | bigint, label: string): string {
  if (typeof key === 'bigint') return String(key);
  const match = /^"(.*)":"(.*)":private$/s.exec(label);
  if (match) return `${match[1]}:${match[2]}:private`;
  if (label.endsWith(':protected')) return `${key}:protected`;
  return key;
}

function printHash(entries: [string, Value][], indent: number, active: Set<object>): string {
  let text = `${' '.repeat(indent)}(\n`;
  for (const [key, item] of entries) {
    text = grown(`${text}${' '.repeat(indent + 4)}[${key}] => ${printRValue(item, indent + 8, active)}\n`);
  }
  return `${text}${' '.repeat(indent)})\n`;
}

// var_dump -----------------------------------------------------------------------------------------------------------

export function varDump(value: Value): string {
  return dumpValue(value, 1, new Set());
}

// code-gauge-allow functionCognitiveComplexity 28 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
// code-gauge-allow functionNcss 43 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
function dumpValue(value: Value, level: number, active: Set<object>, slot?: Slot): string {
  const indent = level > 1 ? ' '.repeat(level - 1) : '';
  // PHP marks a value that a reference shares with another holder.
  const pad = slot instanceof Ref && slot.rc > 1 ? `${indent}&` : indent;
  if (value === null) return `${pad}NULL\n`;
  switch (typeof value) {
    case 'boolean': {
      return `${pad}bool(${value})\n`;
    }
    case 'bigint': {
      return `${pad}int(${value})\n`;
    }
    case 'number': {
      return `${pad}float(${formatFloatRepr(value)})\n`;
    }
    case 'string': {
      return `${pad}string(${value.length}) "${value}"\n`;
    }
  }
  if (value instanceof PhpArray) {
    if (active.has(value)) return `${indent}*RECURSION*\n`;
    active.add(value);
    try {
      let text = `${pad}array(${value.size}) {\n`;
      for (const [key, item] of value.map) {
        text = grown(
          `${text}${' '.repeat(level + 1)}[${typeof key === 'bigint' ? key : `"${key}"`}]=>\n${dumpValue(slotValue(item), level + 2, active, item)}`
        );
      }
      return `${text}${indent}}\n`;
    } finally {
      active.delete(value);
    }
  }
  const object = value as PhpObject;
  if (object.cls.name === '(stream)') return `${pad}resource(${object.id}) of type (stream)\n`;
  if (active.has(object)) return `${indent}*RECURSION*\n`;
  active.add(object);
  try {
    const entries = debugEntries(object);
    const count = entries.filter(([, slot]) => slot !== UNINIT).length;
    let text = `${pad}object(${object.cls.name})#${object.id} (${count}) {\n`;
    for (const [key, slot, label] of entries) {
      text += `${' '.repeat(level + 1)}[${typeof key === 'bigint' ? key : label}]=>\n`;
      if (slot === UNINIT) {
        const decl = declForKey(object.cls, typeof key === 'string' ? keyFor(key, label) : String(key));
        text += `${' '.repeat(level + 1)}uninitialized(${decl?.type ? describeType(decl.type, decl.cls) : 'mixed'})\n`;
      } else text = grown(text + dumpValue(slotValue(slot), level + 2, active, slot));
    }
    return `${text}${indent}}\n`;
  } finally {
    active.delete(object);
  }
}

function keyFor(name: string, label: string): string {
  const match = /^"(.*)":"(.*)":private$/s.exec(label);
  if (match) return `\0${match[2]}\0${name}`;
  return name;
}

// var_export ---------------------------------------------------------------------------------------------------------

export function varExport(value: Value): string {
  return exportValue(value, 1, new Set());
}

function quoteExport(text: string): string {
  return `'${text.replaceAll(/['\\]/g, String.raw`\$&`).replaceAll('\0', `' . "\\0" . '`)}'`;
}

// code-gauge-allow functionCognitiveComplexity 24 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
// code-gauge-allow functionNcss 39 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
function exportValue(value: Value, level: number, active: Set<object>): string {
  if (value === null) return 'NULL';
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
    if (active.has(value)) return circularExport();
    active.add(value);
    try {
      let text = `${lead}array (\n`;
      for (const [key, item] of value.entries()) {
        const keyText = typeof key === 'bigint' ? key.toString() : quoteExport(key);
        text = grown(`${text}${' '.repeat(level + 1)}${keyText} => ${exportValue(item, level + 2, active)},\n`);
      }
      return `${text}${close})`;
    } finally {
      active.delete(value);
    }
  }
  const object = value as PhpObject;
  if (active.has(object)) return circularExport();
  active.add(object);
  try {
    const isStd = object.cls.name === 'stdClass';
    let text = isStd ? `${lead}(object) array(\n` : `${lead}\\${object.cls.name}::__set_state(array(\n`;
    for (const [key, slot] of exportedProps(object)) {
      if (slot === UNINIT) continue;
      const keyText = typeof key === 'bigint' ? String(key) : quoteExport(propNameOf(key));
      text = grown(
        `${text}${' '.repeat(level + 2)}${keyText} => ${exportValue(slotValue(slot), level + 2, active)},\n`
      );
    }
    return `${text}${close}${isStd ? ')' : '))'}`;
  } finally {
    active.delete(object);
  }
}

/** The properties `var_export` writes: an ArrayObject's or ArrayIterator's are the array it holds. */
function exportedProps(object: PhpObject): Iterable<[string | bigint, Slot]> {
  const storage = (object.internal as { properties?: () => PhpArray } | undefined)?.properties;
  return typeof storage === 'function' ? storage.call(object.internal).map : object.props;
}

function circularExport(): string {
  warn('var_export does not handle circular references');
  return 'NULL';
}
