import { type Scan, TOK, Tokenizer } from './expatTokenizer';

// The declarations of a document's DTD, the content models of element declarations, and the error codes of expat.

export const XML_ERROR = {
  NONE: 0,
  NO_MEMORY: 1,
  SYNTAX: 2,
  NO_ELEMENTS: 3,
  INVALID_TOKEN: 4,
  UNCLOSED_TOKEN: 5,
  PARTIAL_CHAR: 6,
  TAG_MISMATCH: 7,
  DUPLICATE_ATTRIBUTE: 8,
  JUNK_AFTER_DOC_ELEMENT: 9,
  PARAM_ENTITY_REF: 10,
  UNDEFINED_ENTITY: 11,
  RECURSIVE_ENTITY_REF: 12,
  ASYNC_ENTITY: 13,
  BAD_CHAR_REF: 14,
  BINARY_ENTITY_REF: 15,
  ATTRIBUTE_EXTERNAL_ENTITY_REF: 16,
  MISPLACED_XML_PI: 17,
  UNKNOWN_ENCODING: 18,
  INCORRECT_ENCODING: 19,
  UNCLOSED_CDATA_SECTION: 20,
  EXTERNAL_ENTITY_HANDLING: 21,
  NOT_STANDALONE: 22,
  UNEXPECTED_STATE: 23,
  ENTITY_DECLARED_IN_PE: 24,
  FEATURE_REQUIRES_XML_DTD: 25,
  CANT_CHANGE_FEATURE_ONCE_PARSING: 26,
  UNBOUND_PREFIX: 27,
  UNDECLARING_PREFIX: 28,
  INCOMPLETE_PE: 29,
  XML_DECL: 30,
  TEXT_DECL: 31,
  PUBLICID: 32,
  SUSPENDED: 33,
  NOT_SUSPENDED: 34,
  ABORTED: 35,
  FINISHED: 36,
  SUSPEND_PE: 37,
  RESERVED_PREFIX_XML: 38,
  RESERVED_PREFIX_XMLNS: 39,
  RESERVED_NAMESPACE_URI: 40,
  INVALID_ARGUMENT: 41,
  NO_BUFFER: 42,
  AMPLIFICATION_LIMIT_BREACH: 43,
  NOT_STARTED: 44,
} as const;

/** expat's `XML_ErrorString`, by error code. */
export const ERROR_MESSAGES: readonly string[] = [
  '',
  'out of memory',
  'syntax error',
  'no element found',
  'not well-formed (invalid token)',
  'unclosed token',
  'partial character',
  'mismatched tag',
  'duplicate attribute',
  'junk after document element',
  'illegal parameter entity reference',
  'undefined entity',
  'recursive entity reference',
  'asynchronous entity',
  'reference to invalid character number',
  'reference to binary entity',
  'reference to external entity in attribute',
  'XML or text declaration not at start of entity',
  'unknown encoding',
  'encoding specified in XML declaration is incorrect',
  'unclosed CDATA section',
  'error in processing external entity reference',
  'document is not standalone',
  'unexpected parser state - please send a bug report',
  'entity declared in parameter entity',
  'requested feature requires XML_DTD support in Expat',
  'cannot change setting once parsing has begun',
  'unbound prefix',
  'must not undeclare prefix',
  'incomplete markup in parameter entity',
  'XML declaration not well-formed',
  'text declaration not well-formed',
  'illegal character(s) in public id',
  'parser suspended',
  'parser not suspended',
  'parsing aborted',
  'parsing finished',
  'cannot suspend in external parameter entity',
  'reserved prefix (xml) must not be undeclared or bound to another namespace name',
  'reserved prefix (xmlns) must not be declared or undeclared',
  'prefix must not be bound to one of the reserved namespace names',
  'invalid argument',
  'a successful prior call to function XML_GetBuffer is required',
  'limit on input amplification factor (from DTD and entities) breached',
  'parser not started',
];

/** An error of the parse, at the position the parser's event pointer had when it was raised. */
export class XmlError extends Error {
  constructor(readonly code: number) {
    super(ERROR_MESSAGES[code]);
  }
}

export interface Entity {
  name: string;
  isParam: boolean;
  /** The replacement text of an internal entity, as code points. */
  text?: number[];
  systemId?: string;
  publicId?: string;
  base?: string;
  notation?: string;
  open: boolean;
  /** Whether the declaration is in the document's internal subset, not in a parameter entity's text. */
  isInternal: boolean;
}

export interface DefaultAttribute {
  name: string;
  isCdata: boolean;
  value?: string;
}

export interface ElementType {
  defaults: DefaultAttribute[];
}

/** A content model of an element declaration: its type, quantifier, name, and children. */
export interface ContentModel {
  type: number;
  quant: number;
  name?: string;
  children: ContentModel[];
}

export const CTYPE = { EMPTY: 1, ANY: 2, MIXED: 3, NAME: 4, CHOICE: 5, SEQ: 6 } as const;
export const CQUANT = { NONE: 0, OPT: 1, REP: 2, PLUS: 3 } as const;

export class Dtd {
  readonly generalEntities = new Map<string, Entity>();
  readonly paramEntities = new Map<string, Entity>();
  readonly elementTypes = new Map<string, ElementType>();
  standalone = false;
  hasParamEntityRefs = false;
  keepProcessing = true;

  elementType(name: string): ElementType {
    let type = this.elementTypes.get(name);
    if (!type) {
      type = { defaults: [] };
      this.elementTypes.set(name, type);
    }
    return type;
  }

  /** Whether an attribute of an element type is declared as other than CDATA, whose value is then normalized. */
  isTokenized(element: string, attribute: string): boolean {
    const declared = this.elementTypes.get(element)?.defaults.find((each) => each.name === attribute);
    return declared !== undefined && !declared.isCdata;
  }
}

/** The predefined entities, which need no declaration. */
export const PREDEFINED_ENTITIES: Record<string, number> = { lt: 0x3c, gt: 0x3e, amp: 0x26, quot: 0x22, apos: 0x27 };

/** `XmlCharRefNumber`: the character a reference `&#...;` stands for, or -1 when it is not a valid character. */
export function charRefNumber(cs: ArrayLike<number>, start: number, end: number): number {
  const hex = cs[start + 2] === 0x78;
  let result = 0;
  for (let index = start + (hex ? 3 : 2); index < end - 1; index++) {
    result = result * (hex ? 16 : 10) + Number.parseInt(String.fromCodePoint(cs[index] as number), 16);
    if (result >= 0x11_00_00) return -1;
  }
  const high = result >> 8;
  if (high >= 0xd8 && high <= 0xdf) return -1;
  if (high === 0 && result < 0x20 && result !== 9 && result !== 10 && result !== 13) return -1;
  if (result === 0xff_fe || result === 0xff_ff) return -1;
  return result;
}

/** `XmlIsPublicId`: the index of the first character a public identifier literal may not contain, if any. */
export function badPublicIdChar(cs: ArrayLike<number>, start: number, end: number): number | undefined {
  for (let index = start + 1; index < end - 1; index++) {
    const c = cs[index] as number;
    const ok =
      (c >= 0x30 && c <= 0x39) ||
      (c >= 0x41 && c <= 0x5a) ||
      (c >= 0x61 && c <= 0x7a) ||
      c === 0x20 ||
      c === 0x0d ||
      c === 0x0a ||
      "-'()+,./:=?;!*#@$_%".includes(String.fromCodePoint(c));
    if (!ok) return index;
  }
  return undefined;
}

/** Normalizes the spaces of a public identifier, as `normalizePublicId` does. */
export function normalizePublicId(text: string): string {
  return text.replaceAll(/[ \r\n]+/g, ' ').trim();
}

/** Text with its line breaks normalized to newlines, as `normalizeLines` does for comments and PIs. */
export function normalizeLines(text: string): string {
  return text.replaceAll(/\r\n?/g, '\n');
}

/** The tokens of an internal entity's text, scanned as code points that no namespace processing applies to. */
export function entityTokenizer(text: number[], ns: boolean): Tokenizer {
  return new Tokenizer(text, ns);
}

export type { Scan };
export { TOK };
