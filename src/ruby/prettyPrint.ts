import { addressOf, anonymousClassName, inspect, strInspect, symInspect } from './conversions';
import type { Gen } from './interp';
import { RArray, RBasic, RClass, RHash, RObject, RString, RSymbol, type Value } from './objects';
import { classOf, realClassOf } from './values';

/** A document for Ruby's PrettyPrint: text, a breakable space, or a group whose breakables break together. */
type Doc = { kind: 'text'; text: string } | { kind: 'break'; text: string } | { kind: 'group'; indent: number; parts: Doc[] };

/** `pp` prints to a stream that is not a terminal, where Ruby's width is 80 columns less one. */
const WIDTH = 79;

/** The text `pp` writes for a value: its inspect, broken over lines as Ruby's PP does when it does not fit. */
export function* prettyInspect(value: Value): Gen<string> {
  const doc = yield* build(value, new Set());
  return `${layout(doc)}\n`;
}

function text(value: string): Doc {
  return { kind: 'text', text: value };
}

function breakable(separator = ' '): Doc {
  return { kind: 'break', text: separator };
}

function group(indent: number, open: string, parts: Doc[], close: string): Doc {
  return { kind: 'group', indent, parts: [text(open), ...parts, text(close)] };
}

/** Whether the program redefined how a value is shown, which then decides its text as a whole. */
function showsItself(value: Value): boolean {
  const method = classOf(value).findMethod('inspect');
  return method !== undefined && method.body.kind !== 'native';
}

// code-gauge-allow functionCognitiveComplexity 20 -- One case per kind of value PP lays out.
function* build(value: Value, seen: Set<object>): Gen<Doc> {
  if (value instanceof RArray && !showsItself(value)) {
    if (seen.has(value)) return text('[...]');
    seen.add(value);
    const parts: Doc[] = [];
    for (const [index, item] of value.items.entries()) {
      if (index > 0) parts.push(text(','), breakable());
      parts.push(yield* build(item, seen));
    }
    seen.delete(value);
    return group(1, '[', parts, ']');
  }
  if (value instanceof RHash && !showsItself(value)) {
    if (seen.has(value)) return text('{...}');
    seen.add(value);
    const parts: Doc[] = [];
    let first = true;
    for (const { key, value: item } of value.map.values()) {
      if (!first) parts.push(text(','), breakable());
      first = false;
      parts.push({ kind: 'group', indent: 0, parts: yield* pair(key, item, seen) });
    }
    seen.delete(value);
    return group(1, '{', parts, '}');
  }
  if (value instanceof RString && !showsItself(value)) {
    const lines = value.s.split(/(?<=\n)/);
    if (lines.length <= 1) return text(strInspect(value.s));
    const parts: Doc[] = [];
    for (const [index, line] of lines.entries()) {
      if (index > 0) parts.push(text(' +'), breakable());
      parts.push(text(strInspect(line)));
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
    if (seen.has(value)) return text(yield* inspect(value));
    seen.add(value);
    const cls = realClassOf(value);
    const parts: Doc[] = [];
    let first = true;
    for (const [name, item] of value.ivars) {
      if (name.startsWith('@__')) continue;
      if (!first) parts.push(text(','));
      first = false;
      parts.push(breakable(), text(`${name}=`), { kind: 'group', indent: 1, parts: [breakable(''), yield* build(item, seen)] });
    }
    seen.delete(value);
    return group(1, `#<${cls.name ?? anonymousClassName(cls)}:${addressOf(value)}`, parts, '>');
  }
  return text(yield* inspect(value));
}

function* pair(key: Value, value: Value, seen: Set<object>): Gen<Doc[]> {
  const parts: Doc[] = [];
  if (key instanceof RSymbol) {
    const shown = symInspect(key.name);
    const simple = !/^:["$@]|[%&*+\-/<=>@\]^`|~]$/.test(shown);
    parts.push(text(`${simple ? key.name : strInspect(key.name)}:`));
  } else {
    parts.push(yield* build(key, seen), text(' '), text('=>'));
  }
  parts.push({ kind: 'group', indent: 1, parts: [breakable(), yield* build(value, seen)] });
  return parts;
}

/** Lays out a document as Ruby's PrettyPrint does: a group breaks all its breakables when it does not fit. */
function layout(doc: Doc): string {
  let output = '';
  let column = 0;
  const visit = (node: Doc, indent: number, flat: boolean, rest: Doc[]): void => {
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
        const fits = flat || column + flatWidth(node) + trailingWidth(rest) <= WIDTH;
        const inner = indent + node.indent;
        for (const [index, part] of node.parts.entries()) {
          visit(part, inner, fits, [...node.parts.slice(index + 1), ...rest]);
        }
      }
    }
  };
  visit(doc, 0, false, []);
  return output;
}

function flatWidth(doc: Doc): number {
  if (doc.kind !== 'group') return doc.text.length;
  return doc.parts.reduce((sum, part) => sum + flatWidth(part), 0);
}

/** The width of the text that follows a group up to the next place a line can break. */
function trailingWidth(rest: Doc[]): number {
  let width = 0;
  for (const doc of rest) {
    if (doc.kind === 'break') return width;
    if (doc.kind === 'text') {
      width += doc.text.length;
      continue;
    }
    const firstBreak = doc.parts.findIndex((part) => part.kind === 'break' || part.kind === 'group');
    if (firstBreak === -1) width += flatWidth(doc);
    else return width + trailingWidth(doc.parts);
  }
  return width;
}

export { RBasic, RClass };
