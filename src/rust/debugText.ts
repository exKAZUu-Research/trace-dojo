/** A part of a `{:?}` text, written compactly (`indent` undefined) or at a nesting depth of `{:#?}`. */
export type DebugPart = (indent: number | undefined) => string;

/** Items between brackets, as std's `debug_list`, `debug_set`, and `debug_tuple` write them. */
export function list(open: string, close: string, items: DebugPart[], indent: number | undefined): string {
  if (indent === undefined) return `${open}${items.map((item) => item(undefined)).join(', ')}${close}`;
  if (items.length === 0) return `${open}${close}`;
  const pad4 = '    '.repeat(indent + 1);
  return `${open}\n${items.map((item) => `${pad4}${item(indent + 1)},\n`).join('')}${'    '.repeat(indent)}${close}`;
}

/** A struct with named fields, as std's `debug_struct` writes it, ending in `..` for `finish_non_exhaustive`. */
export function structText(
  name: string,
  fields: [string, DebugPart][],
  indent: number | undefined,
  nonExhaustive = false
): string {
  if (fields.length === 0) return nonExhaustive ? `${name} { .. }` : name;
  const items = fields.map(
    ([field, part]): DebugPart =>
      (inner) =>
        `${field}: ${part(inner)}`
  );
  const rest = nonExhaustive ? ', ..' : '';
  if (indent === undefined) return `${name} { ${items.map((item) => item(undefined)).join(', ')}${rest} }`;
  const text = list('{', '}', items, indent);
  if (!nonExhaustive) return `${name} ${text}`;
  const close = `${'    '.repeat(indent)}}`;
  return `${name} ${text.slice(0, -close.length)}${'    '.repeat(indent + 1)}..\n${close}`;
}

/** A tuple struct, as std's `debug_tuple` writes it. */
export function tupleText(name: string, fields: DebugPart[], indent: number | undefined): string {
  return name + list('(', ')', fields, indent);
}
