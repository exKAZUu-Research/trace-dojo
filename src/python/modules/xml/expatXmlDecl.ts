// A transcription of `doParseXmlDecl` and `parsePseudoAttribute` of expat's xmltok.c.

export interface XmlDecl {
  version: string | undefined;
  encoding: string | undefined;
  /** Where the encoding's name starts, where an encoding error is reported. */
  encodingStart: number;
  /** 1 for `yes`, 0 for `no`, -1 when the declaration has no `standalone`. */
  standalone: number;
}

interface PseudoAttribute {
  name?: [number, number];
  value: [number, number];
  next: number;
}

/** The parts of an XML declaration from `<?xml` to `?>`, or the index where it is not well-formed. */
// code-gauge-allow functionCognitiveComplexity 23 -- Transcribes expat's C code case by case, as its order of checks decides the errors and their positions.
// code-gauge-allow functionNcss 47 -- Transcribes expat's C code case by case, as its order of checks decides the errors and their positions.
export function parseXmlDecl(cs: ArrayLike<number>, start: number, end: number): XmlDecl | number {
  const text = (range: [number, number]): string => String.fromCodePoint(...Array.prototype.slice.call(cs, ...range));
  let ptr = start + 5;
  end -= 2;
  const result: XmlDecl = { version: undefined, encoding: undefined, encodingStart: 0, standalone: -1 };
  let attribute = parsePseudoAttribute(cs, ptr, end);
  if (typeof attribute === 'number') return attribute;
  if (!attribute.name) return start + 5;
  if (text(attribute.name) !== 'version') return attribute.name[0];
  if (text(attribute.value) !== '1.0') return attribute.value[0];
  result.version = text(attribute.value);
  ptr = attribute.next;
  attribute = parsePseudoAttribute(cs, ptr, end);
  if (typeof attribute === 'number') return attribute;
  if (!attribute.name) return result;
  if (text(attribute.name) === 'encoding') {
    const first = cs[attribute.value[0]] as number;
    if (!((first >= 0x61 && first <= 0x7a) || (first >= 0x41 && first <= 0x5a))) return attribute.value[0];
    result.encoding = text(attribute.value);
    result.encodingStart = attribute.value[0];
    ptr = attribute.next;
    attribute = parsePseudoAttribute(cs, ptr, end);
    if (typeof attribute === 'number') return attribute;
    if (!attribute.name) return result;
  }
  if (text(attribute.name) !== 'standalone') return attribute.name[0];
  const value = text(attribute.value);
  if (value === 'yes') result.standalone = 1;
  else if (value === 'no') result.standalone = 0;
  else return attribute.value[0];
  ptr = attribute.next;
  while (ptr < end && isSpace(cs[ptr] as number)) ptr++;
  return ptr === end ? result : ptr;
}

function isSpace(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
}

/** One `name="value"` with the spaces before it, or the index where it is not well-formed; no name at the end. */
function parsePseudoAttribute(cs: ArrayLike<number>, ptr: number, end: number): PseudoAttribute | number {
  if (ptr === end) return { value: [ptr, ptr], next: ptr };
  if (!isSpace(cs[ptr] as number)) return ptr;
  ptr = skipSpaces(cs, ptr + 1, end);
  if (ptr === end) return { value: [ptr, ptr], next: ptr };
  const nameStart = ptr;
  const name = scanPseudoName(cs, ptr, end);
  if (typeof name === 'number') return name;
  const [nameEnd, equals] = name;
  if (equals === nameStart) return equals;
  ptr = skipSpaces(cs, equals + 1, end);
  const open = cs[ptr];
  if (ptr >= end || (open !== 0x22 && open !== 0x27)) return ptr;
  const valueStart = ptr + 1;
  for (ptr = valueStart; ; ptr++) {
    if (ptr >= end) return ptr;
    const c = cs[ptr] as number;
    if (c === open) break;
    if (!isValueChar(c)) return ptr;
  }
  return { name: [nameStart, nameEnd], value: [valueStart, ptr], next: ptr + 1 };
}

function skipSpaces(cs: ArrayLike<number>, ptr: number, end: number): number {
  while (ptr < end && isSpace(cs[ptr] as number)) ptr++;
  return ptr;
}

/** A pseudo-attribute's name up to its `=`: where the name ends and where the `=` is, or where it is not well-formed. */
function scanPseudoName(cs: ArrayLike<number>, ptr: number, end: number): [number, number] | number {
  for (;;) {
    if (ptr >= end || (cs[ptr] as number) >= 0x80) return ptr;
    const c = cs[ptr] as number;
    if (c === 0x3d) return [ptr, ptr];
    if (isSpace(c)) {
      const equals = skipSpaces(cs, ptr + 1, end);
      return equals >= end || cs[equals] !== 0x3d ? equals : [ptr, equals];
    }
    ptr++;
  }
}

function isValueChar(c: number): boolean {
  return (
    (c >= 0x61 && c <= 0x7a) ||
    (c >= 0x41 && c <= 0x5a) ||
    (c >= 0x30 && c <= 0x39) ||
    c === 0x2e ||
    c === 0x2d ||
    c === 0x5f
  );
}
