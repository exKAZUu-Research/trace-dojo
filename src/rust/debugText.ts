export type DebugPart = (indent: number | undefined) => string;
export type WriteChunk = (text: string) => void;

export function emit(text: string, write?: WriteChunk): string {
  write?.(text);
  return text;
}

export function list(
  open: string,
  close: string,
  items: DebugPart[],
  indent: number | undefined,
  write?: WriteChunk,
  singletonComma = false
): string {
  let text = emit(open, write);
  if (indent === undefined) {
    for (const [index, item] of items.entries()) {
      if (index > 0) text += emit(', ', write);
      text += item(undefined);
    }
    if (singletonComma) text += emit(',', write);
  } else if (items.length > 0) {
    text += emit('\n', write);
    text += prettyFields(items, indent, write);
    text += emit('    '.repeat(indent), write);
  }
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
