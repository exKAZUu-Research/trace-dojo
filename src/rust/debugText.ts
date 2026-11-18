/** A part of a `{:?}` text, written compactly (`indent` undefined) or at a nesting depth of `{:#?}`. */
export type DebugPart = (indent: number | undefined) => string;

/** Items between brackets, as std's `debug_list`, `debug_set`, and `debug_tuple` write them. */
export function list(open: string, close: string, items: DebugPart[], indent: number | undefined): string {
  if (indent === undefined) return `${open}${items.map((item) => item(undefined)).join(', ')}${close}`;
  if (items.length === 0) return `${open}${close}`;
  const pad4 = '    '.repeat(indent + 1);
  return `${open}\n${items.map((item) => `${pad4}${item(indent + 1)},\n`).join('')}${'    '.repeat(indent)}${close}`;
}

/** A struct with named fields, as std's `debug_struct` writes it. */
export function structText(name: string, fields: [string, DebugPart][], indent: number | undefined): string {
  if (fields.length === 0) return name;
  const items = fields.map(
    ([field, part]): DebugPart =>
      (inner) =>
        `${field}: ${part(inner)}`
  );
  if (indent === undefined) return `${name} { ${items.map((item) => item(undefined)).join(', ')} }`;
  return `${name} ${list('{', '}', items, indent)}`;
}

/** A tuple struct, as std's `debug_tuple` writes it. */
export function tupleText(name: string, fields: DebugPart[], indent: number | undefined): string {
  return name + list('(', ')', fields, indent);
}
