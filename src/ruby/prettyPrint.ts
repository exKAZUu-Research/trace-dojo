import { ExecutionLimitError, LIMITS } from '../interpreter/limits';
import { addressOf, anonymousClassName, inspect, strInspect, symInspect } from './conversions';
import type { Gen } from './interp';
import { RArray, RBasic, RClass, RHash, RObject, RString, RSymbol, type Value } from './objects';
import { rt } from './runtime';
import { classOf, realClassOf, stringBytes, stringFromBytes } from './values';

/** A document for Ruby's PrettyPrint: text, a breakable space, or a group whose breakables break together. */
type Doc =
  | { kind: 'text'; text: string }
  | { kind: 'break'; text: string }
  | { kind: 'group'; indent: number; parts: Doc[] };

/** `pp` prints to a stream that is not a terminal, where Ruby's width is 80 columns less one. */
const WIDTH = 79;

/** The text `pp` writes for a value: its inspect, broken over lines as Ruby's PP does when it does not fit. */
export function* prettyInspect(value: Value): Gen<string> {
  const doc = yield* build(value, new Set(), { nodes: 0, textLength: 0 });
  return `${layout(doc)}\n`;
}

export function* writePretty(value: Value, write: (part: string) => Gen<void>): Gen<void> {
  if (!hasInspectionCallbacks(value, new Set(), { nodes: 0, textLength: 0 })) {
    yield* write(yield* prettyInspect(value));
    return;
  }
  const budget: BuildBudget = { nodes: 0, textLength: 0 };
  const state = { column: 0 };
  const emit = function* (part: string): Gen<void> {
    text(part, budget);
    yield* write(part);
    const newline = part.lastIndexOf('\n');
    state.column = newline === -1 ? state.column + part.length : part.length - newline - 1;
  };
  yield* streamPretty(value, { emit, seen: new Set(), budget, state }, 0);
  yield* emit('\n');
}

interface BuildBudget {
  nodes: number;
  textLength: number;
}

interface StreamContext {
  emit: (part: string) => Gen<void>;
  seen: Set<object>;
  budget: BuildBudget;
  state: { column: number };
}

function text(value: string, budget: BuildBudget): Doc {
  budget.textLength += value.length;
  if (budget.textLength > LIMITS.maxOutputLength) throw new ExecutionLimitError('output');
  return { kind: 'text', text: value };
}

function breakable(separator = ' '): Doc {
  return { kind: 'break', text: separator };
}

function group(indent: number, open: string, parts: Doc[], close: string, budget: BuildBudget): Doc {
  return { kind: 'group', indent, parts: [text(open, budget), ...parts, text(close, budget)] };
}

/** Whether the program redefined how a value is shown, which then decides its text as a whole. */
function showsItself(value: Value): boolean {
  const method = classOf(value).findMethod('inspect');
  return method !== undefined && method.body.kind !== 'native';
}

function* build(value: Value, seen: Set<object>, budget: BuildBudget): Gen<Doc> {
  rt().spend();
  if (++budget.nodes > LIMITS.maxOutputLength) throw new ExecutionLimitError('output');
  if (value instanceof RArray && !showsItself(value)) {
    if (seen.has(value)) return text('[...]', budget);
    seen.add(value);
    try {
      const parts: Doc[] = [];
      for (let index = 0; index < value.items.length; index++) {
        if (index > 0) parts.push(text(',', budget), breakable());
        parts.push(yield* build(value.items[index], seen, budget));
      }
      return group(1, '[', parts, ']', budget);
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
        parts.push({ kind: 'group', indent: 0, parts: yield* pair(key, item, seen, budget) });
      }
      return group(1, '{', parts, '}', budget);
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
        parts: [breakable(''), yield* build(item, seen, budget)],
      });
    }
    seen.delete(value);
    return group(1, `#<${cls.name ?? anonymousClassName(cls)}:${addressOf(value)}`, parts, '>', budget);
  }
  return text(yield* inspect(value), budget);
}

function hasInspectionCallbacks(value: Value, seen: Set<object>, budget: BuildBudget): boolean {
  rt().spend();
  if (++budget.nodes > LIMITS.maxOutputLength) throw new ExecutionLimitError('output');
  if (showsItself(value)) return true;
  if (!(value instanceof RBasic) || seen.has(value)) return false;
  seen.add(value);
  if (value instanceof RArray) {
    for (const item of value.items) if (hasInspectionCallbacks(item, seen, budget)) return true;
  } else if (value instanceof RHash) {
    for (const entry of value.map.values())
      if (hasInspectionCallbacks(entry.key, seen, budget) || hasInspectionCallbacks(entry.value, seen, budget))
        return true;
  } else {
    for (const item of value.ivars?.values() ?? []) if (hasInspectionCallbacks(item, seen, budget)) return true;
  }
  return false;
}

function* streamPretty(value: Value, context: StreamContext, indent: number): Gen<void> {
  rt().spend();
  if (++context.budget.nodes > LIMITS.maxOutputLength) throw new ExecutionLimitError('output');
  if (value instanceof RArray && !showsItself(value)) return yield* streamArray(value, context, indent);
  if (value instanceof RHash && !showsItself(value)) return yield* streamHash(value, context, indent);
  if (
    value instanceof RObject &&
    !value.exception &&
    value.data === undefined &&
    !showsItself(value) &&
    classOf(value).findMethod('to_s')?.body.kind === 'native' &&
    value.ivars &&
    value.ivars.size > 0
  )
    return yield* streamObject(value, context, indent);
  yield* context.emit(
    value instanceof RString && !showsItself(value)
      ? layout(yield* build(value, new Set(), { nodes: 0, textLength: 0 }))
      : yield* inspect(value)
  );
}

function* streamArray(value: RArray, context: StreamContext, indent: number): Gen<void> {
  const { emit, seen } = context;
  if (seen.has(value)) return yield* emit('[...]');
  seen.add(value);
  yield* emit('[');
  try {
    for (let index = 0; index < value.items.length; index++) {
      if (index > 0) yield* emit(',');
      yield* streamPrettyPart(value.items[index], index > 0, context, indent + 1);
    }
  } finally {
    seen.delete(value);
  }
  yield* emit(']');
}

function* streamHash(value: RHash, context: StreamContext, indent: number): Gen<void> {
  const { emit, seen } = context;
  if (seen.has(value)) return yield* emit('{...}');
  seen.add(value);
  value.iterating++;
  yield* emit('{');
  try {
    let index = 0;
    for (const { key, value: item } of value.map.values()) {
      if (index++ > 0) yield* emit(',');
      if (key instanceof RSymbol) yield* emit(`${isSimplePrettySymbol(key) ? key.name : strInspect(key.name)}:`);
      else {
        yield* streamPrettyPart(key, false, context, indent + 1);
        yield* emit(' =>');
      }
      yield* streamPrettyPart(item, true, context, indent + 1);
    }
  } finally {
    value.iterating--;
    seen.delete(value);
  }
  yield* emit('}');
}

function* streamObject(value: RObject, context: StreamContext, indent: number): Gen<void> {
  const { emit, seen } = context;
  if (seen.has(value)) return yield* emit(yield* inspect(value));
  seen.add(value);
  const cls = realClassOf(value);
  yield* emit(`#<${cls.name ?? anonymousClassName(cls)}:${addressOf(value)}`);
  try {
    for (const [name, item] of value.ivars ?? []) {
      if (name.startsWith('@__')) continue;
      yield* emit(` ${name}=`);
      yield* streamPretty(item, context, indent + 1);
    }
  } finally {
    seen.delete(value);
  }
  yield* emit('>');
}

function* streamPrettyPart(value: Value, separated: boolean, context: StreamContext, indent: number): Gen<void> {
  const { emit, state } = context;
  if (showsItself(value)) {
    const breakBefore = separated && state.column + 2 > WIDTH;
    if (breakBefore) yield* emit(`\n${' '.repeat(indent)}`);
    const shown = yield* inspect(value);
    if (separated && !breakBefore) yield* emit(' '.repeat(indent));
    yield* emit(shown);
    return;
  }
  if (separated) yield* emit(state.column + 2 > WIDTH ? `\n${' '.repeat(indent)}` : ' ');
  yield* streamPretty(value, context, indent);
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

function* pair(key: Value, value: Value, seen: Set<object>, budget: BuildBudget): Gen<Doc[]> {
  const parts: Doc[] = [];
  if (key instanceof RSymbol) {
    parts.push(text(`${isSimplePrettySymbol(key) ? key.name : strInspect(key.name)}:`, budget));
  } else {
    parts.push(yield* build(key, seen, budget), text(' ', budget), text('=>', budget));
  }
  parts.push({ kind: 'group', indent: 1, parts: [breakable(), yield* build(value, seen, budget)] });
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
