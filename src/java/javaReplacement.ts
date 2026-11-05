/** A failure of a replacement string, which Java reports as `exception` with `message`. */
export class ReplacementError extends Error {
  constructor(
    readonly exception: 'IllegalArgumentException' | 'IndexOutOfBoundsException',
    message: string
  ) {
    super(message);
  }
}

type ReplacementPart = string | number | { name: string };

/**
 * A function for `String.replace` that expands a Java replacement as `Matcher.appendReplacement` does: `\x` quotes
 * `x`, `$n` names a group, taking more digits while the number stays a group, and `${name}` a named group. An invalid
 * reference throws {@link ReplacementError} when a match first needs the replacement, as in Java.
 */
export function javaReplacer(replacement: string): (...args: unknown[]) => string {
  let parts: ReplacementPart[] | undefined;
  return (...args) => {
    const hasGroups = typeof args.at(-1) === 'object' && args.at(-1) !== undefined;
    const groups = (hasGroups ? args.at(-1) : undefined) as Record<string, string | undefined> | undefined;
    const captures = args.slice(0, hasGroups ? -3 : -2) as (string | undefined)[];
    parts ??= parseReplacement(replacement, captures.length - 1, groups ? Object.keys(groups) : []);
    return parts
      .map((part) => {
        if (typeof part === 'string') return part;
        if (typeof part === 'number') return captures[part] ?? '';
        return groups?.[part.name] ?? '';
      })
      .join('');
  };
}

function parseReplacement(replacement: string, groupCount: number, names: readonly string[]): ReplacementPart[] {
  const parts: ReplacementPart[] = [];
  for (let index = 0; index < replacement.length;) {
    const char = replacement[index] as string;
    if (char === '\\') {
      if (index + 1 >= replacement.length)
        throw new ReplacementError('IllegalArgumentException', 'character to be escaped is missing');
      parts.push(replacement[index + 1] as string);
      index += 2;
    } else if (char === '$') {
      index = readGroupReference(replacement, index + 1, groupCount, names, parts);
    } else {
      parts.push(char);
      index++;
    }
  }
  return parts;
}

/** Reads the group reference after a `$`, returning the index after it. */
function readGroupReference(
  replacement: string,
  start: number,
  groupCount: number,
  names: readonly string[],
  parts: ReplacementPart[]
): number {
  const next = replacement[start];
  if (next === undefined)
    throw new ReplacementError('IllegalArgumentException', 'Illegal group reference: group index is missing');
  if (next === '{') {
    const name = /^\{([a-zA-Z][a-zA-Z0-9]*)\}/.exec(replacement.slice(start))?.[1];
    if (name === undefined)
      throw new ReplacementError('IllegalArgumentException', "named capturing group is missing trailing '}'");
    if (!names.includes(name)) throw new ReplacementError('IllegalArgumentException', `No group with name {${name}}`);
    parts.push({ name });
    return start + name.length + 2;
  }
  if (!/\d/.test(next)) throw new ReplacementError('IllegalArgumentException', 'Illegal group reference');
  let group = Number(next);
  if (group > groupCount) throw new ReplacementError('IndexOutOfBoundsException', `No group ${group}`);
  let index = start + 1;
  // Further digits belong to the number while it still names a group.
  while (index < replacement.length && /\d/.test(replacement[index] as string)) {
    const longer = group * 10 + Number(replacement[index]);
    if (longer > groupCount) break;
    group = longer;
    index++;
  }
  parts.push(group);
  return index;
}
