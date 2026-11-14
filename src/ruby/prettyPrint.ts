import { ExecutionLimitError, LIMITS } from '../interpreter/limits';
import { addressOf, anonymousClassName, inspect, strInspect, symInspect } from './conversions';
import type { Gen } from './interp';
import { RArray, RBasic, RClass, RHash, RObject, RString, RSymbol, type Value } from './objects';
import { rt } from './runtime';
import { classOf, realClassOf, stringBytes, stringFromBytes } from './values';

/** A document for Ruby's PrettyPrint: text, a breakable space, or a group whose breakables break together. */
type Doc =
  | { kind: 'text'; text: string; deferred?: Value }
  | { kind: 'break'; text: string }
  | { kind: 'group'; indent: number; parts: Doc[]; source?: RArray | RHash; itemValues?: Value[] };

/** `pp` prints to a stream that is not a terminal, where Ruby's width is 80 columns less one. */
const WIDTH = 79;

/** The text `pp` writes for a value: its inspect, broken over lines as Ruby's PP does when it does not fit. */
export function* prettyInspect(value: Value): Gen<string> {
  const doc = yield* build(value, new Set(), { nodes: 0, textLength: 0 });
  return `${layout(doc)}\n`;
}

export function* writePretty(value: Value, write: (part: string) => Gen<void>): Gen<void> {
  const callbacks = inspectionCallbackCount(value, new Set(), { nodes: 0, textLength: 0 });
  if (callbacks === 0) {
    yield* write(yield* prettyInspect(value));
    return;
  }
  if (callbacks === 1) {
    const doc = yield* build(value, new Set(), { nodes: 0, textLength: 0 }, true);
    const hashes = new Set<RHash>();
    holdHashes(doc, hashes);
    try {
      const prefix = staticPrefix(doc);
      if (prefix) yield* write(prefix);
      const rendered = yield* prettyInspect(value);
      yield* write(rendered.slice(prefix.length));
    } finally {
      for (const hash of hashes) hash.iterating--;
    }
    return;
  }
  const doc = yield* build(value, new Set(), { nodes: 0, textLength: 0 }, true);
  const hashes = new Set<RHash>();
  holdHashes(doc, hashes);
  let textLength = documentTextLength(doc);
  let emitted = '';
  const flushPrefix = function* (): Gen<void> {
    const prefix = staticPrefix(doc);
    yield* write(prefix.slice(emitted.length));
    emitted = prefix;
  };
  try {
    yield* flushPrefix();
    for (let node = firstDeferred(doc); node; node = firstDeferred(doc)) {
      node.text = yield* inspect(node.deferred as Value);
      textLength += node.text.length;
      if (textLength > LIMITS.maxOutputLength) throw new ExecutionLimitError('output');
      node.deferred = undefined;
      yield* reconcileContainers(doc, node);
      textLength = documentTextLength(doc);
      if (textLength > LIMITS.maxOutputLength) throw new ExecutionLimitError('output');
      holdHashes(doc, hashes);
      yield* flushPrefix();
    }
    yield* write(`${layout(doc)}\n`.slice(emitted.length));
  } finally {
    for (const hash of hashes) hash.iterating--;
  }
}

function documentTextLength(doc: Doc): number {
  if (doc.kind === 'text') return doc.text.length;
  if (doc.kind === 'break') return doc.text.length;
  return doc.parts.reduce((length, part) => length + documentTextLength(part), 0);
}

function holdHashes(doc: Doc, held: Set<RHash>): void {
  if (doc.kind !== 'group') return;
  if (doc.source instanceof RHash && !held.has(doc.source)) {
    doc.source.iterating++;
    held.add(doc.source);
  }
  for (const part of doc.parts) holdHashes(part, held);
}

function firstDeferred(doc: Doc): Extract<Doc, { kind: 'text' }> | undefined {
  if (doc.kind === 'text') return doc.deferred === undefined ? undefined : doc;
  if (doc.kind === 'group')
    for (const part of doc.parts) {
      const found = firstDeferred(part);
      if (found) return found;
    }
  return undefined;
}

function* reconcileContainers(doc: Doc, resolved: Doc): Gen<boolean> {
  if (doc === resolved) return true;
  if (doc.kind !== 'group') return false;
  for (const [position, part] of doc.parts.entries()) {
    if (!(yield* reconcileContainers(part, resolved))) continue;
    const index = Math.floor((position - 1) / 3);
    if (doc.source instanceof RArray) yield* reconcileArray(doc, doc.source, index);
    if (doc.source instanceof RHash) yield* reconcileHash(doc, doc.source, index);
    return true;
  }
  return false;
}

function* reconcileArray(doc: Extract<Doc, { kind: 'group' }>, source: RArray, index: number): Gen<void> {
  const previous = doc.itemValues as Value[];
  let changed = index + 1;
  while (changed < previous.length && changed < source.items.length && previous[changed] === source.items[changed])
    changed++;
  if (changed === previous.length && changed === source.items.length) return;
  const end = doc.parts.at(-1) as Doc;
  const remainder: Doc[] = [];
  for (let next = changed; next < source.items.length; next++) {
    remainder.push({ kind: 'text', text: ',' }, breakable());
    remainder.push(yield* build(source.items[next], new Set([source]), { nodes: 0, textLength: 0 }, true));
  }
  doc.parts = [...doc.parts.slice(0, changed * 3 - 1), ...remainder, end];
  doc.itemValues = [...source.items];
}

function* reconcileHash(doc: Extract<Doc, { kind: 'group' }>, source: RHash, index: number): Gen<void> {
  const previous = doc.itemValues as Value[];
  const entries = [...source.map.values()];
  for (let next = index + 1; next < entries.length; next++) {
    const value = entries[next].value;
    if (previous[next] === value) continue;
    const pairDoc = doc.parts[next * 3 + 1];
    if (pairDoc.kind !== 'group') continue;
    const valueDoc = pairDoc.parts.at(-1);
    if (valueDoc?.kind !== 'group') continue;
    valueDoc.parts[1] = yield* build(value, new Set([source]), { nodes: 0, textLength: 0 }, true);
    previous[next] = value;
  }
}

function staticPrefix(doc: Doc): string {
  let prefix = '';
  let column = 0;
  const read = (node: Doc, indent: number): boolean => {
    if (node.kind === 'break') {
      if (column + 2 > WIDTH) prefix += `\n${' '.repeat(indent)}`;
      return false;
    }
    if (node.kind === 'text') {
      if (node.deferred) return false;
      prefix += node.text;
      column += node.text.length;
      return true;
    }
    for (const part of node.parts) if (!read(part, indent + node.indent)) return false;
    return true;
  };
  read(doc, 0);
  return prefix;
}

interface BuildBudget {
  nodes: number;
  textLength: number;
}

function text(value: string, budget: BuildBudget): Doc {
  budget.textLength += value.length;
  if (budget.textLength > LIMITS.maxOutputLength) throw new ExecutionLimitError('output');
  return { kind: 'text', text: value };
}

function breakable(separator = ' '): Doc {
  return { kind: 'break', text: separator };
}

function group(
  indent: number,
  open: string,
  parts: Doc[],
  close: string,
  budget: BuildBudget,
  source?: RArray | RHash
): Doc {
  const itemValues =
    source instanceof RArray
      ? [...source.items]
      : source instanceof RHash
        ? [...source.map.values()].map((entry) => entry.value)
        : undefined;
  return { kind: 'group', indent, parts: [text(open, budget), ...parts, text(close, budget)], source, itemValues };
}

/** Whether the program redefined how a value is shown, which then decides its text as a whole. */
function showsItself(value: Value): boolean {
  const method = classOf(value).findMethod('inspect');
  return method !== undefined && method.body.kind !== 'native';
}

function* build(value: Value, seen: Set<object>, budget: BuildBudget, defer = false): Gen<Doc> {
  rt().spend();
  if (++budget.nodes > LIMITS.maxOutputLength) throw new ExecutionLimitError('output');
  if (defer && showsItself(value)) return { kind: 'text', text: '', deferred: value };
  if (value instanceof RArray && !showsItself(value)) {
    if (seen.has(value)) return text('[...]', budget);
    seen.add(value);
    try {
      const parts: Doc[] = [];
      for (let index = 0; index < value.items.length; index++) {
        if (index > 0) parts.push(text(',', budget), breakable());
        parts.push(yield* build(value.items[index], seen, budget, defer));
      }
      return group(1, '[', parts, ']', budget, value);
    } finally {
      seen.delete(value);
    }
  }
  if (value instanceof RHash && !showsItself(value)) {
    if (seen.has(value)) return text('{...}', budget);
    seen.add(value);
    value.iterating++;
    try {
      const parts: Doc[] = [];
      let first = true;
      for (const { key, value: item } of value.map.values()) {
        if (!first) parts.push(text(',', budget), breakable());
        first = false;
        parts.push({ kind: 'group', indent: 0, parts: yield* pair(key, item, seen, budget, defer) });
      }
      return group(1, '{', parts, '}', budget, value);
    } finally {
      value.iterating--;
      seen.delete(value);
    }
  }
  if (value instanceof RString && !showsItself(value)) {
    const lines = stringLines(value);
    if (lines.length <= 1) return text(yield* inspect(value), budget);
    const parts: Doc[] = [];
    for (const [index, line] of lines.entries()) {
      if (index > 0) parts.push(text(' +', budget), breakable());
      parts.push(text(yield* inspect(line), budget));
    }
    return { kind: 'group', indent: 0, parts };
  }
  if (
    value instanceof RObject &&
    !value.exception &&
    value.data === undefined &&
    !showsItself(value) &&
    classOf(value).findMethod('to_s')?.body.kind === 'native' &&
    value.ivars &&
    value.ivars.size > 0
  ) {
    if (seen.has(value)) return text(yield* inspect(value), budget);
    seen.add(value);
    const cls = realClassOf(value);
    const parts: Doc[] = [];
    let first = true;
    for (const [name, item] of value.ivars) {
      if (name.startsWith('@__')) continue;
      if (!first) parts.push(text(',', budget));
      first = false;
      parts.push(breakable(), text(`${name}=`, budget), {
        kind: 'group',
        indent: 1,
        parts: [breakable(''), yield* build(item, seen, budget, defer)],
      });
    }
    seen.delete(value);
    return group(1, `#<${cls.name ?? anonymousClassName(cls)}:${addressOf(value)}`, parts, '>', budget);
  }
  return text(yield* inspect(value), budget);
}

function inspectionCallbackCount(value: Value, seen: Set<object>, budget: BuildBudget): number {
  rt().spend();
  if (++budget.nodes > LIMITS.maxOutputLength) throw new ExecutionLimitError('output');
  if (showsItself(value)) return 1;
  if (!(value instanceof RBasic) || seen.has(value)) return 0;
  seen.add(value);
  let count = 0;
  if (value instanceof RArray) {
    for (const item of value.items) {
      count += inspectionCallbackCount(item, seen, budget);
      if (count >= 2) return 2;
    }
  } else if (value instanceof RHash) {
    for (const entry of value.map.values()) {
      count += inspectionCallbackCount(entry.key, seen, budget);
      count += inspectionCallbackCount(entry.value, seen, budget);
      if (count >= 2) return 2;
    }
  } else {
    for (const item of value.ivars?.values() ?? []) {
      count += inspectionCallbackCount(item, seen, budget);
      if (count >= 2) return 2;
    }
  }
  return count;
}

function isSimplePrettySymbol(key: RSymbol): boolean {
  return !/^:["$@]|[%&*+\-/<=>@\]^`|~]$/.test(symInspect(key.name));
}

function stringLines(value: RString): RString[] {
  const bytes = stringBytes(value);
  const lines: RString[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] !== 10) continue;
    lines.push(stringFromBytes(bytes.slice(start, index + 1), value.binary));
    start = index + 1;
  }
  if (start < bytes.length || lines.length === 0) lines.push(stringFromBytes(bytes.slice(start), value.binary));
  return lines;
}

function* pair(key: Value, value: Value, seen: Set<object>, budget: BuildBudget, defer = false): Gen<Doc[]> {
  const parts: Doc[] = [];
  if (key instanceof RSymbol) {
    parts.push(text(`${isSimplePrettySymbol(key) ? key.name : strInspect(key.name)}:`, budget));
  } else {
    parts.push(yield* build(key, seen, budget, defer), text(' ', budget), text('=>', budget));
  }
  parts.push({ kind: 'group', indent: 1, parts: [breakable(), yield* build(value, seen, budget, defer)] });
  return parts;
}

/** Lays out a document as Ruby's PrettyPrint does: a group breaks all its breakables when it does not fit. */
function layout(doc: Doc): string {
  let output = '';
  let column = 0;
  const widths = new WeakMap<Doc, number>();
  const visit = (node: Doc, indent: number, flat: boolean, rest?: Rest): void => {
    rt().spend();
    switch (node.kind) {
      case 'text': {
        output += node.text;
        column += node.text.length;
        return;
      }
      case 'break': {
        if (flat) {
          output += node.text;
          column += node.text.length;
        } else {
          output += `\n${' '.repeat(indent)}`;
          column = indent;
        }
        return;
      }
      case 'group': {
        const fits = flat || column + flatWidth(node, widths) + trailingWidth(rest, widths) <= WIDTH;
        const inner = indent + node.indent;
        for (const [index, part] of node.parts.entries()) {
          visit(part, inner, fits, { parts: node.parts, index: index + 1, next: rest });
        }
      }
    }
  };
  visit(doc, 0, false);
  return output;
}

interface Rest {
  parts: Doc[];
  index: number;
  next?: Rest;
}

function flatWidth(doc: Doc, cache: WeakMap<Doc, number>): number {
  const cached = cache.get(doc);
  if (cached !== undefined) return cached;
  rt().spend();
  if (doc.kind !== 'group') return doc.text.length;
  const width = doc.parts.reduce((sum, part) => sum + flatWidth(part, cache), 0);
  cache.set(doc, width);
  return width;
}

/** The width of the text that follows a group up to the next place a line can break. */
function trailingWidth(rest: Rest | undefined, cache: WeakMap<Doc, number>): number {
  let width = 0;
  for (let frame = rest; frame; frame = frame.next) {
    for (let index = frame.index; index < frame.parts.length; index++) {
      const doc = frame.parts[index];
      rt().spend();
      if (doc.kind === 'break') return width;
      if (doc.kind === 'text') {
        width += doc.text.length;
        continue;
      }
      const firstBreak = doc.parts.findIndex((part) => part.kind === 'break' || part.kind === 'group');
      if (firstBreak === -1) width += flatWidth(doc, cache);
      else return width + trailingWidth({ parts: doc.parts, index: 0 }, cache);
    }
  }
  return width;
}

export { RBasic, RClass };
