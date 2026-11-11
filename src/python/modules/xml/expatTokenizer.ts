import { NAME_RANGES, NAME_START_RANGES } from './expatNameData';

// A transcription of expat's xmltok_impl.c over code points: each scanner returns a token and the index after it, or a
// negative token when the input ends inside it. `ns` selects expat's namespace-aware encoding, where a colon is not a
// name character but separates a prefix.

export const TOK = {
  TRAILING_RSQB: -5,
  NONE: -4,
  TRAILING_CR: -3,
  PARTIAL_CHAR: -2,
  PARTIAL: -1,
  INVALID: 0,
  START_TAG_WITH_ATTS: 1,
  START_TAG_NO_ATTS: 2,
  EMPTY_ELEMENT_WITH_ATTS: 3,
  EMPTY_ELEMENT_NO_ATTS: 4,
  END_TAG: 5,
  DATA_CHARS: 6,
  DATA_NEWLINE: 7,
  CDATA_SECT_OPEN: 8,
  ENTITY_REF: 9,
  CHAR_REF: 10,
  PI: 11,
  XML_DECL: 12,
  COMMENT: 13,
  BOM: 14,
  PROLOG_S: 15,
  DECL_OPEN: 16,
  DECL_CLOSE: 17,
  NAME: 18,
  NMTOKEN: 19,
  POUND_NAME: 20,
  OR: 21,
  PERCENT: 22,
  OPEN_PAREN: 23,
  CLOSE_PAREN: 24,
  OPEN_BRACKET: 25,
  CLOSE_BRACKET: 26,
  LITERAL: 27,
  PARAM_ENTITY_REF: 28,
  INSTANCE_START: 29,
  NAME_QUESTION: 30,
  NAME_ASTERISK: 31,
  NAME_PLUS: 32,
  COND_SECT_OPEN: 33,
  COND_SECT_CLOSE: 34,
  CLOSE_PAREN_QUESTION: 35,
  CLOSE_PAREN_ASTERISK: 36,
  CLOSE_PAREN_PLUS: 37,
  COMMA: 38,
  ATTRIBUTE_VALUE_S: 39,
  CDATA_SECT_CLOSE: 40,
  PREFIXED_NAME: 41,
} as const;

/** The character classes of expat's byte type tables. */
export const BT = {
  NONXML: 0,
  LT: 2,
  AMP: 3,
  RSQB: 4,
  CR: 9,
  LF: 10,
  GT: 11,
  QUOT: 12,
  APOS: 13,
  EQUALS: 14,
  QUEST: 15,
  EXCL: 16,
  SOL: 17,
  SEMI: 18,
  NUM: 19,
  LSQB: 20,
  S: 21,
  NMSTRT: 22,
  COLON: 23,
  HEX: 24,
  DIGIT: 25,
  NAME: 26,
  MINUS: 27,
  OTHER: 28,
  PERCNT: 30,
  LPAR: 31,
  RPAR: 32,
  AST: 33,
  PLUS: 34,
  COMMA: 35,
  VERBAR: 36,
} as const;

const ASCII_TYPES: number[] = buildAsciiTypes();

function buildAsciiTypes(): number[] {
  const types: number[] = Array.from({ length: 128 }, () => BT.OTHER);
  for (let c = 0; c < 32; c++) types[c] = BT.NONXML;
  types[9] = BT.S;
  types[10] = BT.LF;
  types[13] = BT.CR;
  const fixed: Record<string, number> = {
    ' ': BT.S,
    '!': BT.EXCL,
    '"': BT.QUOT,
    '#': BT.NUM,
    '%': BT.PERCNT,
    '&': BT.AMP,
    "'": BT.APOS,
    '(': BT.LPAR,
    ')': BT.RPAR,
    '*': BT.AST,
    '+': BT.PLUS,
    ',': BT.COMMA,
    '-': BT.MINUS,
    '.': BT.NAME,
    '/': BT.SOL,
    ':': BT.COLON,
    ';': BT.SEMI,
    '<': BT.LT,
    '=': BT.EQUALS,
    '>': BT.GT,
    '?': BT.QUEST,
    '[': BT.LSQB,
    ']': BT.RSQB,
    _: BT.NMSTRT,
    '|': BT.VERBAR,
  };
  for (const [char, type] of Object.entries(fixed)) types[char.codePointAt(0) as number] = type;
  for (let c = 0x30; c <= 0x39; c++) types[c] = BT.DIGIT;
  for (let c = 0x41; c <= 0x5a; c++) types[c] = c <= 0x46 ? BT.HEX : BT.NMSTRT;
  for (let c = 0x61; c <= 0x7a; c++) types[c] = c <= 0x66 ? BT.HEX : BT.NMSTRT;
  return types;
}

const nameStartSet = rangeSet(NAME_START_RANGES);
const nameSet = rangeSet(NAME_RANGES);

function rangeSet(ranges: string): Uint8Array {
  const set = new Uint8Array(0x1_00_00);
  for (const range of ranges.split(' ')) {
    const [low, high = low] = range.split('-').map((hex) => Number.parseInt(hex, 16));
    set.fill(1, low, high + 1);
  }
  return set;
}

/** Whether expat rejects a character anywhere in a document. */
export function isInvalidChar(c: number): boolean {
  if (c < 0x80) return ASCII_TYPES[c] === BT.NONXML;
  return (c >= 0xd8_00 && c <= 0xdf_ff) || c === 0xff_fe || c === 0xff_ff;
}

/** The byte type of a character: ASCII by expat's table, others a name start, a name character, or other. */
export function byteType(c: number, ns: boolean): number {
  if (c < 0x80) {
    const type = ASCII_TYPES[c] as number;
    return type === BT.COLON && !ns ? BT.NMSTRT : type;
  }
  if (isInvalidChar(c)) return BT.NONXML;
  if (c < 0x1_00_00 && nameStartSet[c] === 1) return BT.NMSTRT;
  if (c < 0x1_00_00 && nameSet[c] === 1) return BT.NAME;
  return BT.OTHER;
}

/** A scanner's result: the token, and the index where it ends or where the invalid character is. */
export type Scan = [token: number, next: number];

/** The code points one scan reads, with the namespace mode of the encoding. */
export class Tokenizer {
  constructor(
    readonly cs: ArrayLike<number>,
    readonly ns: boolean
  ) {}

  type(index: number): number {
    return byteType(this.cs[index] as number, this.ns);
  }

  isNameStart(type: number): boolean {
    return type === BT.NMSTRT || type === BT.HEX;
  }

  isNameChar(type: number): boolean {
    return type === BT.NMSTRT || type === BT.HEX || type === BT.DIGIT || type === BT.NAME || type === BT.MINUS;
  }

  isSpace(type: number): boolean {
    return type === BT.S || type === BT.CR || type === BT.LF;
  }

  // Content ---------------------------------------------------------------------------------------------------------

  // code-gauge-allow functionCognitiveComplexity 28 -- Follows contentTok of xmltok_impl.c case by case.
  contentTok(ptr: number, end: number): Scan {
    if (ptr >= end) return [TOK.NONE, ptr];
    switch (this.type(ptr)) {
      case BT.LT: {
        return this.scanLt(ptr + 1, end);
      }
      case BT.AMP: {
        return this.scanRef(ptr + 1, end);
      }
      case BT.CR: {
        ptr++;
        if (ptr >= end) return [TOK.TRAILING_CR, ptr];
        if (this.type(ptr) === BT.LF) ptr++;
        return [TOK.DATA_NEWLINE, ptr];
      }
      case BT.LF: {
        return [TOK.DATA_NEWLINE, ptr + 1];
      }
      case BT.RSQB: {
        ptr++;
        if (ptr >= end) return [TOK.TRAILING_RSQB, ptr];
        if (this.cs[ptr] !== 0x5d) break;
        ptr++;
        if (ptr >= end) return [TOK.TRAILING_RSQB, ptr];
        if (this.cs[ptr] !== 0x3e) {
          ptr--;
          break;
        }
        return [TOK.INVALID, ptr];
      }
      case BT.NONXML: {
        return [TOK.INVALID, ptr];
      }
      default: {
        ptr++;
      }
    }
    return this.dataChars(ptr, end);
  }

  private dataChars(ptr: number, end: number): Scan {
    while (ptr < end) {
      const type = this.type(ptr);
      if (type === BT.RSQB) {
        if (ptr + 1 < end) {
          if (this.cs[ptr + 1] !== 0x5d) {
            ptr++;
            continue;
          }
          if (ptr + 2 < end) {
            if (this.cs[ptr + 2] !== 0x3e) {
              ptr++;
              continue;
            }
            return [TOK.INVALID, ptr + 2];
          }
        }
        return [TOK.DATA_CHARS, ptr];
      }
      if (type === BT.AMP || type === BT.LT || type === BT.NONXML || type === BT.CR || type === BT.LF) {
        return [TOK.DATA_CHARS, ptr];
      }
      ptr++;
    }
    return [TOK.DATA_CHARS, ptr];
  }

  /** After `<` in content: a start tag, an end tag, a comment, a CDATA section, or a processing instruction. */
  // code-gauge-allow functionCognitiveComplexity 30 -- Follows scanLt of xmltok_impl.c.
  scanLt(ptr: number, end: number): Scan {
    if (ptr >= end) return [TOK.PARTIAL, ptr];
    const first = this.type(ptr);
    if (this.isNameStart(first)) ptr++;
    else if (first === BT.EXCL) {
      ptr++;
      if (ptr >= end) return [TOK.PARTIAL, ptr];
      const type = this.type(ptr);
      if (type === BT.MINUS) return this.scanComment(ptr + 1, end);
      if (type === BT.LSQB) return this.scanCdataSection(ptr + 1, end);
      return [TOK.INVALID, ptr];
    } else if (first === BT.QUEST) return this.scanPi(ptr + 1, end);
    else if (first === BT.SOL) return this.scanEndTag(ptr + 1, end);
    else return [TOK.INVALID, ptr];
    let hadColon = false;
    while (ptr < end) {
      const type = this.type(ptr);
      if (this.isNameChar(type)) {
        ptr++;
        continue;
      }
      if (type === BT.COLON) {
        const scanned = this.qualifiedColon(ptr, end, hadColon);
        if (scanned) return scanned;
        hadColon = true;
        ptr += 2;
        continue;
      }
      if (this.isSpace(type)) {
        ptr++;
        while (ptr < end) {
          const next = this.type(ptr);
          if (this.isNameStart(next)) return this.scanAtts(ptr + 1, end);
          if (next === BT.GT) return [TOK.START_TAG_NO_ATTS, ptr + 1];
          if (next === BT.SOL) return this.emptyElementEnd(ptr + 1, end, TOK.EMPTY_ELEMENT_NO_ATTS);
          if (!this.isSpace(next)) return [TOK.INVALID, ptr];
          ptr++;
        }
        return [TOK.PARTIAL, ptr];
      }
      if (type === BT.GT) return [TOK.START_TAG_NO_ATTS, ptr + 1];
      if (type === BT.SOL) return this.emptyElementEnd(ptr + 1, end, TOK.EMPTY_ELEMENT_NO_ATTS);
      return [TOK.INVALID, ptr];
    }
    return [TOK.PARTIAL, ptr];
  }

  /** A colon in a qualified name: an error when the name had one, else undefined when a name start follows it. */
  private qualifiedColon(ptr: number, end: number, hadColon: boolean): Scan | undefined {
    if (hadColon) return [TOK.INVALID, ptr];
    ptr++;
    if (ptr >= end) return [TOK.PARTIAL, ptr];
    if (!this.isNameStart(this.type(ptr))) return [TOK.INVALID, ptr];
    return undefined;
  }

  private emptyElementEnd(ptr: number, end: number, token: number): Scan {
    if (ptr >= end) return [TOK.PARTIAL, ptr];
    if (this.cs[ptr] !== 0x3e) return [TOK.INVALID, ptr];
    return [token, ptr + 1];
  }

  // code-gauge-allow functionCognitiveComplexity 30 -- Follows scanAtts of xmltok_impl.c.
  // code-gauge-allow functionNcss 45 -- Follows scanAtts of xmltok_impl.c.
  private scanAtts(ptr: number, end: number): Scan {
    let hadColon = false;
    while (ptr < end) {
      let type = this.type(ptr);
      if (this.isNameChar(type)) {
        ptr++;
        continue;
      }
      if (type === BT.COLON) {
        const scanned = this.qualifiedColon(ptr, end, hadColon);
        if (scanned) return scanned;
        hadColon = true;
        ptr += 2;
        continue;
      }
      if (this.isSpace(type)) {
        for (;;) {
          ptr++;
          if (ptr >= end) return [TOK.PARTIAL, ptr];
          type = this.type(ptr);
          if (type === BT.EQUALS) break;
          if (!this.isSpace(type)) return [TOK.INVALID, ptr];
        }
      }
      if (type !== BT.EQUALS) return [TOK.INVALID, ptr];
      hadColon = false;
      let open: number;
      for (;;) {
        ptr++;
        if (ptr >= end) return [TOK.PARTIAL, ptr];
        open = this.type(ptr);
        if (open === BT.QUOT || open === BT.APOS) break;
        if (!this.isSpace(open)) return [TOK.INVALID, ptr];
      }
      ptr++;
      for (;;) {
        if (ptr >= end) return [TOK.PARTIAL, ptr];
        const value = this.type(ptr);
        if (value === open) break;
        if (value === BT.NONXML || value === BT.LT) return [TOK.INVALID, ptr];
        if (value === BT.AMP) {
          const [token, next] = this.scanRef(ptr + 1, end);
          if (token <= 0) return [token, next];
          ptr = next;
        } else {
          ptr++;
        }
      }
      ptr++;
      if (ptr >= end) return [TOK.PARTIAL, ptr];
      const after = this.type(ptr);
      if (after === BT.SOL) return this.emptyElementEnd(ptr + 1, end, TOK.EMPTY_ELEMENT_WITH_ATTS);
      if (after === BT.GT) return [TOK.START_TAG_WITH_ATTS, ptr + 1];
      if (!this.isSpace(after)) return [TOK.INVALID, ptr];
      let nameFound = false;
      while (!nameFound) {
        ptr++;
        if (ptr >= end) return [TOK.PARTIAL, ptr];
        const next = this.type(ptr);
        if (this.isNameStart(next)) {
          ptr++;
          nameFound = true;
        } else if (next === BT.GT) return [TOK.START_TAG_WITH_ATTS, ptr + 1];
        else if (next === BT.SOL) return this.emptyElementEnd(ptr + 1, end, TOK.EMPTY_ELEMENT_WITH_ATTS);
        else if (!this.isSpace(next)) return [TOK.INVALID, ptr];
      }
    }
    return [TOK.PARTIAL, ptr];
  }

  /** After `&`: an entity reference or a character reference. */
  scanRef(ptr: number, end: number): Scan {
    if (ptr >= end) return [TOK.PARTIAL, ptr];
    const first = this.type(ptr);
    if (first === BT.NUM) return this.scanCharRef(ptr + 1, end);
    if (!this.isNameStart(first)) return [TOK.INVALID, ptr];
    ptr++;
    while (ptr < end) {
      const type = this.type(ptr);
      if (this.isNameChar(type)) ptr++;
      else if (type === BT.SEMI) return [TOK.ENTITY_REF, ptr + 1];
      else return [TOK.INVALID, ptr];
    }
    return [TOK.PARTIAL, ptr];
  }

  private scanCharRef(ptr: number, end: number): Scan {
    if (ptr >= end) return [TOK.PARTIAL, ptr];
    const hex = this.cs[ptr] === 0x78;
    if (hex) ptr++;
    const isDigit = (type: number): boolean => type === BT.DIGIT || (hex && type === BT.HEX);
    if (ptr >= end) return [TOK.PARTIAL, ptr];
    if (!isDigit(this.type(ptr))) return [TOK.INVALID, ptr];
    for (ptr++; ptr < end; ptr++) {
      const type = this.type(ptr);
      if (type === BT.SEMI) return [TOK.CHAR_REF, ptr + 1];
      if (!isDigit(type)) return [TOK.INVALID, ptr];
    }
    return [TOK.PARTIAL, ptr];
  }

  private scanEndTag(ptr: number, end: number): Scan {
    if (ptr >= end) return [TOK.PARTIAL, ptr];
    if (!this.isNameStart(this.type(ptr))) return [TOK.INVALID, ptr];
    ptr++;
    while (ptr < end) {
      const type = this.type(ptr);
      if (this.isNameChar(type) || type === BT.COLON) ptr++;
      else if (type === BT.GT) return [TOK.END_TAG, ptr + 1];
      else if (this.isSpace(type)) {
        for (ptr++; ptr < end; ptr++) {
          const next = this.type(ptr);
          if (next === BT.GT) return [TOK.END_TAG, ptr + 1];
          if (!this.isSpace(next)) return [TOK.INVALID, ptr];
        }
        return [TOK.PARTIAL, ptr];
      } else return [TOK.INVALID, ptr];
    }
    return [TOK.PARTIAL, ptr];
  }

  /** After `<!-`. */
  private scanComment(ptr: number, end: number): Scan {
    if (ptr >= end) return [TOK.PARTIAL, ptr];
    if (this.cs[ptr] !== 0x2d) return [TOK.INVALID, ptr];
    ptr++;
    while (ptr < end) {
      const type = this.type(ptr);
      if (type === BT.NONXML) return [TOK.INVALID, ptr];
      ptr++;
      if (type !== BT.MINUS) continue;
      if (ptr >= end) return [TOK.PARTIAL, ptr];
      if (this.cs[ptr] !== 0x2d) continue;
      ptr++;
      if (ptr >= end) return [TOK.PARTIAL, ptr];
      if (this.cs[ptr] !== 0x3e) return [TOK.INVALID, ptr];
      return [TOK.COMMENT, ptr + 1];
    }
    return [TOK.PARTIAL, ptr];
  }

  /** After `<![`. */
  private scanCdataSection(ptr: number, end: number): Scan {
    if (end - ptr < 6) return [TOK.PARTIAL, ptr];
    for (const char of 'CDATA[') {
      if (this.cs[ptr] !== char.codePointAt(0)) return [TOK.INVALID, ptr];
      ptr++;
    }
    return [TOK.CDATA_SECT_OPEN, ptr];
  }

  /** After `<?`: a processing instruction, or the XML declaration when its target is `xml`. */
  // code-gauge-allow functionCognitiveComplexity 22 -- Follows scanPi of xmltok_impl.c.
  scanPi(ptr: number, end: number): Scan {
    const target = ptr;
    if (ptr >= end) return [TOK.PARTIAL, ptr];
    if (!this.isNameStart(this.type(ptr))) return [TOK.INVALID, ptr];
    ptr++;
    while (ptr < end) {
      const type = this.type(ptr);
      if (this.isNameChar(type)) {
        ptr++;
        continue;
      }
      const token = this.piTarget(target, ptr);
      if (this.isSpace(type)) {
        if (token === undefined) return [TOK.INVALID, ptr];
        for (ptr++; ptr < end;) {
          const next = this.type(ptr);
          if (next === BT.NONXML) return [TOK.INVALID, ptr];
          ptr++;
          if (next !== BT.QUEST) continue;
          if (ptr >= end) return [TOK.PARTIAL, ptr];
          if (this.cs[ptr] === 0x3e) return [token, ptr + 1];
        }
        return [TOK.PARTIAL, ptr];
      }
      if (type === BT.QUEST) {
        if (token === undefined) return [TOK.INVALID, ptr];
        ptr++;
        if (ptr >= end) return [TOK.PARTIAL, ptr];
        if (this.cs[ptr] === 0x3e) return [token, ptr + 1];
      }
      return [TOK.INVALID, ptr];
    }
    return [TOK.PARTIAL, ptr];
  }

  /** `checkPiTarget`: PI, or XML_DECL for `xml`, or undefined for another casing of `xml`. */
  private piTarget(start: number, end: number): number | undefined {
    if (end - start !== 3) return TOK.PI;
    const text = String.fromCodePoint(...Array.from({ length: 3 }, (_, index) => this.cs[start + index] as number));
    if (text === 'xml') return TOK.XML_DECL;
    return text.toLowerCase() === 'xml' ? undefined : TOK.PI;
  }

  /** Inside a CDATA section. */
  cdataSectionTok(ptr: number, end: number): Scan {
    if (ptr >= end) return [TOK.NONE, ptr];
    const first = this.type(ptr);
    if (first === BT.RSQB) {
      if (ptr + 1 >= end) return [TOK.PARTIAL, ptr + 1];
      if (this.cs[ptr + 1] === 0x5d) {
        if (ptr + 2 >= end) return [TOK.PARTIAL, ptr + 2];
        if (this.cs[ptr + 2] === 0x3e) return [TOK.CDATA_SECT_CLOSE, ptr + 3];
      }
      ptr++;
    } else if (first === BT.CR) {
      ptr++;
      if (ptr >= end) return [TOK.PARTIAL, ptr];
      if (this.type(ptr) === BT.LF) ptr++;
      return [TOK.DATA_NEWLINE, ptr];
    } else if (first === BT.LF) {
      return [TOK.DATA_NEWLINE, ptr + 1];
    } else if (first === BT.NONXML) {
      return [TOK.INVALID, ptr];
    } else {
      ptr++;
    }
    while (ptr < end) {
      const type = this.type(ptr);
      if (type === BT.NONXML || type === BT.CR || type === BT.LF || type === BT.RSQB) return [TOK.DATA_CHARS, ptr];
      ptr++;
    }
    return [TOK.DATA_CHARS, ptr];
  }

  // Prolog ----------------------------------------------------------------------------------------------------------

  // code-gauge-allow functionCognitiveComplexity 30 -- Follows prologTok of xmltok_impl.c case by case.
  // code-gauge-allow functionNcss 60 -- Follows prologTok of xmltok_impl.c case by case.
  prologTok(ptr: number, end: number): Scan {
    if (ptr >= end) return [TOK.NONE, ptr];
    const first = this.type(ptr);
    switch (first) {
      case BT.QUOT:
      case BT.APOS: {
        return this.scanLit(first, ptr + 1, end);
      }
      case BT.LT: {
        ptr++;
        if (ptr >= end) return [TOK.PARTIAL, ptr];
        const type = this.type(ptr);
        if (type === BT.EXCL) return this.scanDecl(ptr + 1, end);
        if (type === BT.QUEST) return this.scanPi(ptr + 1, end);
        if (type === BT.NMSTRT || type === BT.HEX) return [TOK.INSTANCE_START, ptr - 1];
        if ((this.cs[ptr] as number) >= 0x80 && !isInvalidChar(this.cs[ptr] as number)) {
          return [TOK.INSTANCE_START, ptr - 1];
        }
        return [TOK.INVALID, ptr];
      }
      case BT.CR:
      case BT.S:
      case BT.LF: {
        return this.prologSpace(ptr, end);
      }
      case BT.PERCNT: {
        return this.scanPercent(ptr + 1, end);
      }
      case BT.COMMA: {
        return [TOK.COMMA, ptr + 1];
      }
      case BT.LSQB: {
        return [TOK.OPEN_BRACKET, ptr + 1];
      }
      case BT.RSQB: {
        ptr++;
        if (ptr >= end) return [-TOK.CLOSE_BRACKET, ptr];
        if (this.cs[ptr] === 0x5d) {
          if (end - ptr < 2) return [TOK.PARTIAL, ptr];
          if (this.cs[ptr + 1] === 0x3e) return [TOK.COND_SECT_CLOSE, ptr + 2];
        }
        return [TOK.CLOSE_BRACKET, ptr];
      }
      case BT.LPAR: {
        return [TOK.OPEN_PAREN, ptr + 1];
      }
      case BT.RPAR: {
        return this.closeParen(ptr + 1, end);
      }
      case BT.VERBAR: {
        return [TOK.OR, ptr + 1];
      }
      case BT.GT: {
        return [TOK.DECL_CLOSE, ptr + 1];
      }
      case BT.NUM: {
        return this.scanPoundName(ptr + 1, end);
      }
      default: {
        return this.prologName(first, ptr, end);
      }
    }
  }

  private prologSpace(ptr: number, end: number): Scan {
    if (this.type(ptr) === BT.CR && ptr + 1 === end) return [-TOK.PROLOG_S, end];
    for (;;) {
      ptr++;
      if (ptr >= end) break;
      const type = this.type(ptr);
      if (type === BT.S || type === BT.LF) continue;
      if (type === BT.CR && ptr + 1 !== end) continue;
      return [TOK.PROLOG_S, ptr];
    }
    return [TOK.PROLOG_S, ptr];
  }

  private closeParen(ptr: number, end: number): Scan {
    if (ptr >= end) return [-TOK.CLOSE_PAREN, ptr];
    switch (this.type(ptr)) {
      case BT.AST: {
        return [TOK.CLOSE_PAREN_ASTERISK, ptr + 1];
      }
      case BT.QUEST: {
        return [TOK.CLOSE_PAREN_QUESTION, ptr + 1];
      }
      case BT.PLUS: {
        return [TOK.CLOSE_PAREN_PLUS, ptr + 1];
      }
      case BT.CR:
      case BT.LF:
      case BT.S:
      case BT.GT:
      case BT.COMMA:
      case BT.VERBAR:
      case BT.RPAR: {
        return [TOK.CLOSE_PAREN, ptr];
      }
      default: {
        return [TOK.INVALID, ptr];
      }
    }
  }

  // code-gauge-allow functionCognitiveComplexity 26 -- Follows the name part of prologTok of xmltok_impl.c.
  private prologName(first: number, ptr: number, end: number): Scan {
    let token: number;
    if (this.isNameStart(first)) token = TOK.NAME;
    else if (this.isNameChar(first) || first === BT.COLON) token = TOK.NMTOKEN;
    else return [TOK.INVALID, ptr];
    ptr++;
    while (ptr < end) {
      const type = this.type(ptr);
      if (this.isNameChar(type)) {
        ptr++;
        continue;
      }
      switch (type) {
        case BT.GT:
        case BT.RPAR:
        case BT.COMMA:
        case BT.VERBAR:
        case BT.LSQB:
        case BT.PERCNT:
        case BT.S:
        case BT.CR:
        case BT.LF: {
          return [token, ptr];
        }
        case BT.COLON: {
          ptr++;
          if (token === TOK.NAME) {
            if (ptr >= end) return [TOK.PARTIAL, ptr];
            token = TOK.PREFIXED_NAME;
            if (this.isNameChar(this.type(ptr))) ptr++;
            else token = TOK.NMTOKEN;
          } else if (token === TOK.PREFIXED_NAME) {
            token = TOK.NMTOKEN;
          }
          break;
        }
        case BT.PLUS:
        case BT.AST:
        case BT.QUEST: {
          if (token === TOK.NMTOKEN) return [TOK.INVALID, ptr];
          const suffix = { [BT.PLUS]: TOK.NAME_PLUS, [BT.AST]: TOK.NAME_ASTERISK, [BT.QUEST]: TOK.NAME_QUESTION };
          return [suffix[type], ptr + 1];
        }
        default: {
          return [TOK.INVALID, ptr];
        }
      }
    }
    return [-token, ptr];
  }

  private scanLit(open: number, ptr: number, end: number): Scan {
    while (ptr < end) {
      const type = this.type(ptr);
      if (type === BT.NONXML) return [TOK.INVALID, ptr];
      ptr++;
      if ((type === BT.QUOT || type === BT.APOS) && type === open) {
        if (ptr >= end) return [-TOK.LITERAL, ptr];
        const after = this.type(ptr);
        const ends = after === BT.S || after === BT.CR || after === BT.LF || after === BT.GT;
        return [ends || after === BT.PERCNT || after === BT.LSQB ? TOK.LITERAL : TOK.INVALID, ptr];
      }
    }
    return [TOK.PARTIAL, ptr];
  }

  /** After `<!`. */
  private scanDecl(ptr: number, end: number): Scan {
    if (ptr >= end) return [TOK.PARTIAL, ptr];
    const first = this.type(ptr);
    if (first === BT.MINUS) return this.scanComment(ptr + 1, end);
    if (first === BT.LSQB) return [TOK.COND_SECT_OPEN, ptr + 1];
    if (first !== BT.NMSTRT && first !== BT.HEX) return [TOK.INVALID, ptr];
    ptr++;
    while (ptr < end) {
      const type = this.type(ptr);
      if (type === BT.PERCNT) {
        if (end - ptr < 2) return [TOK.PARTIAL, ptr];
        const next = this.type(ptr + 1);
        if (this.isSpace(next) || next === BT.PERCNT) return [TOK.INVALID, ptr];
        return [TOK.DECL_OPEN, ptr];
      }
      if (this.isSpace(type)) return [TOK.DECL_OPEN, ptr];
      if (type !== BT.NMSTRT && type !== BT.HEX) return [TOK.INVALID, ptr];
      ptr++;
    }
    return [TOK.PARTIAL, ptr];
  }

  /** After `%`. */
  scanPercent(ptr: number, end: number): Scan {
    if (ptr >= end) return [TOK.PARTIAL, ptr];
    const first = this.type(ptr);
    if (this.isSpace(first) || first === BT.PERCNT) return [TOK.PERCENT, ptr];
    if (!this.isNameStart(first)) return [TOK.INVALID, ptr];
    ptr++;
    while (ptr < end) {
      const type = this.type(ptr);
      if (this.isNameChar(type)) ptr++;
      else if (type === BT.SEMI) return [TOK.PARAM_ENTITY_REF, ptr + 1];
      else return [TOK.INVALID, ptr];
    }
    return [TOK.PARTIAL, ptr];
  }

  /** After `#`. */
  private scanPoundName(ptr: number, end: number): Scan {
    if (ptr >= end) return [TOK.PARTIAL, ptr];
    if (!this.isNameStart(this.type(ptr))) return [TOK.INVALID, ptr];
    ptr++;
    while (ptr < end) {
      const type = this.type(ptr);
      if (this.isNameChar(type)) {
        ptr++;
        continue;
      }
      const ends = this.isSpace(type) || type === BT.RPAR || type === BT.GT || type === BT.PERCNT || type === BT.VERBAR;
      return [ends ? TOK.POUND_NAME : TOK.INVALID, ptr];
    }
    return [-TOK.POUND_NAME, ptr];
  }

  // Values ----------------------------------------------------------------------------------------------------------

  /** The text of an attribute value, or of an internal entity a value refers to. */
  attributeValueTok(ptr: number, end: number): Scan {
    if (ptr >= end) return [TOK.NONE, ptr];
    const start = ptr;
    while (ptr < end) {
      const type = this.type(ptr);
      if (type === BT.AMP) return ptr === start ? this.scanRef(ptr + 1, end) : [TOK.DATA_CHARS, ptr];
      if (type === BT.LT) return [TOK.INVALID, ptr];
      if (type === BT.LF || type === BT.CR || type === BT.S) {
        if (ptr !== start) return [TOK.DATA_CHARS, ptr];
        if (type === BT.S) return [TOK.ATTRIBUTE_VALUE_S, ptr + 1];
        return this.newline(ptr, end);
      }
      ptr++;
    }
    return [TOK.DATA_CHARS, ptr];
  }

  private newline(ptr: number, end: number): Scan {
    if (this.type(ptr) === BT.LF) return [TOK.DATA_NEWLINE, ptr + 1];
    ptr++;
    if (ptr >= end) return [TOK.TRAILING_CR, ptr];
    if (this.type(ptr) === BT.LF) ptr++;
    return [TOK.DATA_NEWLINE, ptr];
  }

  /** The text of an entity's literal value. */
  entityValueTok(ptr: number, end: number): Scan {
    if (ptr >= end) return [TOK.NONE, ptr];
    const start = ptr;
    while (ptr < end) {
      const type = this.type(ptr);
      if (type === BT.AMP) return ptr === start ? this.scanRef(ptr + 1, end) : [TOK.DATA_CHARS, ptr];
      if (type === BT.PERCNT) {
        if (ptr !== start) return [TOK.DATA_CHARS, ptr];
        const [token, next] = this.scanPercent(ptr + 1, end);
        return [token === TOK.PERCENT ? TOK.INVALID : token, next];
      }
      if (type === BT.LF || type === BT.CR) return ptr === start ? this.newline(ptr, end) : [TOK.DATA_CHARS, ptr];
      ptr++;
    }
    return [TOK.DATA_CHARS, ptr];
  }
}
