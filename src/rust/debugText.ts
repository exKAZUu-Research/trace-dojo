import type { RangeValue, Value } from './values';

export type DebugPart = (indent: number | undefined) => string;
export type WriteChunk = (text: string) => void;

export function emit(text: string, write?: WriteChunk): string {
  write?.(text);
  return text;
}

export function rangeText(range: RangeValue, debug: (value: Value) => string, write?: WriteChunk): string {
  const start = range.start === undefined ? '' : debug(range.start);
  const separator = emit(range.inclusive ? '..=' : '..', write);
  const end = range.end === undefined ? '' : debug(range.end);
  return start + separator + end + (range.exhausted ? emit(' (exhausted)', write) : '');
}

export function list(
  open: string,
  close: string,
  items: Iterable<DebugPart>,
  indent: number | undefined,
  write?: WriteChunk,
  singletonComma = false
): string {
  let text = emit(open, write);
  let started = false;
  const padding = indent === undefined ? '' : '    '.repeat(indent + 1);
  for (const item of items) {
    if (indent === undefined) {
      if (started) text += emit(', ', write);
      text += item(undefined);
    } else {
      if (!started) text += emit('\n', write);
      text += emit(padding, write) + item(indent + 1) + emit(',\n', write);
    }
    started = true;
  }
  if (indent === undefined && singletonComma) text += emit(',', write);
  else if (indent !== undefined && started) text += emit('    '.repeat(indent), write);
  return text + emit(close, write);
}

export function structText(
  name: string,
  fields: [string, DebugPart][],
  indent: number | undefined,
  nonExhaustive = false,
  write?: WriteChunk
): string {
  let text = emit(name, write);
  if (fields.length === 0) return nonExhaustive ? text + emit(' { .. }', write) : text;
  if (indent === undefined) {
    for (const [index, [field, part]] of fields.entries()) {
      text += emit(index === 0 ? ' { ' : ', ', write) + emit(field, write) + emit(': ', write) + part(undefined);
    }
    if (nonExhaustive) text += emit(', ..', write);
    return text + emit(' }', write);
  }
  const items = fields.map(
    ([field, part]): DebugPart =>
      (inner) =>
        emit(field, write) + emit(': ', write) + part(inner)
  );
  if (nonExhaustive) {
    // Pretty-print's last placeholder has no comma.
    return (
      text +
      emit(' {\n', write) +
      prettyFields(items, indent, write) +
      emit('    '.repeat(indent + 1) + '..\n', write) +
      emit('    '.repeat(indent) + '}', write)
    );
  }
  return text + emit(' ', write) + list('{', '}', items, indent, write);
}

function prettyFields(items: DebugPart[], indent: number, write?: WriteChunk): string {
  const padding = '    '.repeat(indent + 1);
  return items.map((item) => emit(padding, write) + item(indent + 1) + emit(',\n', write)).join('');
}

export function tupleText(name: string, fields: DebugPart[], indent: number | undefined, write?: WriteChunk): string {
  return emit(name, write) + list('(', ')', fields, indent, write);
}
