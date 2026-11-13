// oxlint-disable unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255, which charCodeAt reads as raw bytes.
import { Printer } from '../fmt';
import { decodeRune } from '../literals';
import { isPrint } from '../quote';
import { BASIC } from '../types';
import { Iface, type Value } from '../values';
import { isDigit, isLetter } from './unicodeSupport';

/** `fmt.Sprintf` for messages built from strings (Go byte strings), ints, and Go interface values. */
export function sprintf(format: string, ...args: (string | number | Iface | undefined)[]): string {
  return new Printer().printf(format, args.map(toInterface));
}

export function toInterface(arg: string | number | Iface | undefined): Value {
  if (typeof arg === 'string') return new Iface(BASIC.string, arg);
  if (typeof arg === 'number') return new Iface(BASIC.int, BigInt(arg));
  return arg;
}

// The item types of text/template/parse/lex.go, in Go's order: the keywords follow ITEM_KEYWORD.
export const ITEM_ERROR = 0;
export const ITEM_BOOL = 1;
export const ITEM_CHAR = 2;
export const ITEM_CHAR_CONSTANT = 3;
export const ITEM_COMMENT = 4;
export const ITEM_COMPLEX = 5;
export const ITEM_ASSIGN = 6;
export const ITEM_DECLARE = 7;
export const ITEM_EOF = 8;
export const ITEM_FIELD = 9;
export const ITEM_IDENTIFIER = 10;
export const ITEM_LEFT_DELIM = 11;
export const ITEM_LEFT_PAREN = 12;
export const ITEM_NUMBER = 13;
export const ITEM_PIPE = 14;
export const ITEM_RAW_STRING = 15;
export const ITEM_RIGHT_DELIM = 16;
export const ITEM_RIGHT_PAREN = 17;
export const ITEM_SPACE = 18;
export const ITEM_STRING = 19;
export const ITEM_TEXT = 20;
export const ITEM_VARIABLE = 21;
const ITEM_KEYWORD = 22;
export const ITEM_BLOCK = 23;
export const ITEM_BREAK = 24;
export const ITEM_CONTINUE = 25;
export const ITEM_DOT = 26;
export const ITEM_DEFINE = 27;
export const ITEM_ELSE = 28;
export const ITEM_END = 29;
export const ITEM_IF = 30;
export const ITEM_NIL = 31;
export const ITEM_RANGE = 32;
export const ITEM_TEMPLATE = 33;
export const ITEM_WITH = 34;

const KEY = new Map<string, number>([
  ['.', ITEM_DOT],
  ['block', ITEM_BLOCK],
  ['break', ITEM_BREAK],
  ['continue', ITEM_CONTINUE],
  ['define', ITEM_DEFINE],
  ['else', ITEM_ELSE],
  ['end', ITEM_END],
  ['if', ITEM_IF],
  ['range', ITEM_RANGE],
  ['nil', ITEM_NIL],
  ['template', ITEM_TEMPLATE],
  ['with', ITEM_WITH],
]);

export interface Item {
  typ: number;
  pos: number;
  val: string;
  line: number;
}

/** `item.String`, which error messages quote. */
export function itemString(item: Item): string {
  if (item.typ === ITEM_EOF) return 'EOF';
  if (item.typ === ITEM_ERROR) return item.val;
  if (item.typ > ITEM_KEYWORD) return sprintf('<%s>', item.val);
  if (item.val.length > 10) return sprintf('%.10q...', item.val);
  return sprintf('%q', item.val);
}

const EOF = -1;
const SPACE_CHARS = ' \t\r\n';
const TRIM_MARKER = '-';
const TRIM_MARKER_LEN = 2;
export const DEFAULT_LEFT_DELIM = '{{';
export const DEFAULT_RIGHT_DELIM = '}}';
const LEFT_COMMENT = '/*';
const RIGHT_COMMENT = '*/';

type StateFn = ((lexer: Lexer) => StateFn) | undefined;

export interface LexOptions {
  emitComment: boolean;
  breakOK: boolean;
  continueOK: boolean;
}

/** Go's template lexer, which the parser drives one item at a time. */
export class Lexer {
  pos = 0;
  start = 0;
  atEOF = false;
  parenDepth = 0;
  line = 1;
  startLine = 1;
  item: Item = { typ: ITEM_EOF, pos: 0, val: 'EOF', line: 1 };
  insideAction = false;
  options: LexOptions = { emitComment: false, breakOK: false, continueOK: false };

  constructor(
    public input: string,
    readonly leftDelim: string,
    readonly rightDelim: string
  ) {}

  next(): number {
    if (this.pos >= this.input.length) {
      this.atEOF = true;
      return EOF;
    }
    const { rune, size } = decodeRune(this.input, this.pos);
    this.pos += size;
    if (rune === 10) this.line++;
    return rune;
  }

  peek(): number {
    const rune = this.next();
    this.backup();
    return rune;
  }

  backup(): void {
    if (!this.atEOF && this.pos > 0) {
      const { rune, size } = decodeLastRune(this.input, this.pos);
      this.pos -= size;
      if (rune === 10) this.line--;
    }
  }

  thisItem(typ: number): Item {
    const item = { typ, pos: this.start, val: this.input.slice(this.start, this.pos), line: this.startLine };
    this.start = this.pos;
    this.startLine = this.line;
    return item;
  }

  emit(typ: number): StateFn {
    return this.emitItem(this.thisItem(typ));
  }

  emitItem(item: Item): StateFn {
    this.item = item;
    return undefined;
  }

  ignore(): void {
    this.line += countNewlines(this.input.slice(this.start, this.pos));
    this.start = this.pos;
    this.startLine = this.line;
  }

  accept(valid: string): boolean {
    if (containsRune(valid, this.next())) return true;
    this.backup();
    return false;
  }

  acceptRun(valid: string): void {
    while (containsRune(valid, this.next()));
    this.backup();
  }

  errorf(format: string, ...args: (string | number)[]): StateFn {
    this.item = { typ: ITEM_ERROR, pos: this.start, val: sprintf(format, ...args), line: this.startLine };
    this.start = 0;
    this.pos = 0;
    this.input = '';
    return undefined;
  }

  nextItem(): Item {
    this.item = { typ: ITEM_EOF, pos: this.pos, val: 'EOF', line: this.startLine };
    let state: StateFn = this.insideAction ? lexInsideAction : lexText;
    while (state) state = state(this);
    return this.item;
  }

  atRightDelim(): [delim: boolean, trimSpaces: boolean] {
    const rest = this.input.slice(this.pos);
    if (hasRightTrimMarker(rest) && rest.slice(TRIM_MARKER_LEN).startsWith(this.rightDelim)) return [true, true];
    if (rest.startsWith(this.rightDelim)) return [true, false];
    return [false, false];
  }

  atTerminator(): boolean {
    const rune = this.peek();
    if (isSpace(rune)) return true;
    if ([EOF, 0x2e, 0x2c, 0x7c, 0x3a, 0x29, 0x28].includes(rune)) return true;
    return this.input.slice(this.pos).startsWith(this.rightDelim);
  }

  scanNumber(): boolean {
    this.accept('+-');
    let digits = '0123456789_';
    if (this.accept('0')) {
      if (this.accept('xX')) digits = '0123456789abcdefABCDEF_';
      else if (this.accept('oO')) digits = '01234567_';
      else if (this.accept('bB')) digits = '01_';
    }
    this.acceptRun(digits);
    if (this.accept('.')) this.acceptRun(digits);
    if (digits.length === 10 + 1 && this.accept('eE')) {
      this.accept('+-');
      this.acceptRun('0123456789_');
    }
    if (digits.length === 16 + 6 + 1 && this.accept('pP')) {
      this.accept('+-');
      this.acceptRun('0123456789_');
    }
    this.accept('i');
    if (isAlphaNumeric(this.peek())) {
      this.next();
      return false;
    }
    return true;
  }
}

function decodeLastRune(input: string, end: number): { rune: number; size: number } {
  for (let size = 1; size <= 4 && size <= end; size++) {
    const start = end - size;
    const byte = input.charCodeAt(start);
    if (byte < 0x80 || byte >= 0xc0) {
      const decoded = decodeRune(input, start);
      return decoded.size === size ? decoded : { rune: 0xff_fd, size: 1 };
    }
  }
  return { rune: 0xff_fd, size: 1 };
}

function countNewlines(text: string): number {
  return text.split('\n').length - 1;
}

function containsRune(valid: string, rune: number): boolean {
  return rune >= 0 && rune < 0x80 && valid.includes(String.fromCharCode(rune));
}

function trimRightSpaces(text: string): string {
  let end = text.length;
  while (end > 0 && SPACE_CHARS.includes(text[end - 1])) end--;
  return text.slice(0, end);
}

function rightTrimLength(text: string): number {
  return text.length - trimRightSpaces(text).length;
}

function leftTrimLength(text: string): number {
  let start = 0;
  while (start < text.length && SPACE_CHARS.includes(text[start])) start++;
  return start;
}

function lexText(l: Lexer): StateFn {
  const x = l.input.indexOf(l.leftDelim, l.pos) - l.pos;
  if (x >= 0) {
    if (x > 0) {
      l.pos += x;
      let trimLength = 0;
      const delimEnd = l.pos + l.leftDelim.length;
      if (hasLeftTrimMarker(l.input.slice(delimEnd))) trimLength = rightTrimLength(l.input.slice(l.start, l.pos));
      l.pos -= trimLength;
      l.line += countNewlines(l.input.slice(l.start, l.pos));
      const item = l.thisItem(ITEM_TEXT);
      l.pos += trimLength;
      l.ignore();
      if (item.val.length > 0) return l.emitItem(item);
    }
    return lexLeftDelim;
  }
  l.pos = l.input.length;
  if (l.pos > l.start) {
    l.line += countNewlines(l.input.slice(l.start, l.pos));
    return l.emit(ITEM_TEXT);
  }
  return l.emit(ITEM_EOF);
}

function lexLeftDelim(l: Lexer): StateFn {
  l.pos += l.leftDelim.length;
  const trimSpace = hasLeftTrimMarker(l.input.slice(l.pos));
  const afterMarker = trimSpace ? TRIM_MARKER_LEN : 0;
  if (l.input.slice(l.pos + afterMarker).startsWith(LEFT_COMMENT)) {
    l.pos += afterMarker;
    l.ignore();
    return lexComment;
  }
  const item = l.thisItem(ITEM_LEFT_DELIM);
  l.insideAction = true;
  l.pos += afterMarker;
  l.ignore();
  l.parenDepth = 0;
  return l.emitItem(item);
}

function lexComment(l: Lexer): StateFn {
  l.pos += LEFT_COMMENT.length;
  const x = l.input.indexOf(RIGHT_COMMENT, l.pos) - l.pos;
  if (x < 0) return l.errorf('unclosed comment');
  l.pos += x + RIGHT_COMMENT.length;
  const [delim, trimSpace] = l.atRightDelim();
  if (!delim) return l.errorf('comment ends before closing delimiter');
  l.line += countNewlines(l.input.slice(l.start, l.pos));
  const item = l.thisItem(ITEM_COMMENT);
  if (trimSpace) l.pos += TRIM_MARKER_LEN;
  l.pos += l.rightDelim.length;
  if (trimSpace) l.pos += leftTrimLength(l.input.slice(l.pos));
  l.ignore();
  if (l.options.emitComment) return l.emitItem(item);
  return lexText;
}

function lexRightDelim(l: Lexer): StateFn {
  const [, trimSpace] = l.atRightDelim();
  if (trimSpace) {
    l.pos += TRIM_MARKER_LEN;
    l.ignore();
  }
  l.pos += l.rightDelim.length;
  const item = l.thisItem(ITEM_RIGHT_DELIM);
  if (trimSpace) {
    l.pos += leftTrimLength(l.input.slice(l.pos));
    l.ignore();
  }
  l.insideAction = false;
  return l.emitItem(item);
}

// code-gauge-allow functionCognitiveComplexity 30 -- A transcription of Go's lexInsideAction, one case per character class.
function lexInsideAction(l: Lexer): StateFn {
  const [delim] = l.atRightDelim();
  if (delim) {
    if (l.parenDepth === 0) return lexRightDelim;
    return l.errorf('unclosed left paren');
  }
  const r = l.next();
  if (r === EOF) return l.errorf('unclosed action');
  if (isSpace(r)) {
    l.backup();
    return lexSpace;
  }
  switch (r < 0x80 ? String.fromCharCode(r) : '') {
    case '=': {
      return l.emit(ITEM_ASSIGN);
    }
    case ':': {
      if (l.next() !== 0x3d) return l.errorf('expected :=');
      return l.emit(ITEM_DECLARE);
    }
    case '|': {
      return l.emit(ITEM_PIPE);
    }
    case '"': {
      return lexQuote;
    }
    case '`': {
      return lexRawQuote;
    }
    case '$': {
      return lexVariable;
    }
    case "'": {
      return lexChar;
    }
    case '(': {
      l.parenDepth++;
      return l.emit(ITEM_LEFT_PAREN);
    }
    case ')': {
      l.parenDepth--;
      if (l.parenDepth < 0) return l.errorf('unexpected right paren');
      return l.emit(ITEM_RIGHT_PAREN);
    }
  }
  if (r === 0x2e && l.pos < l.input.length) {
    const next = l.input.charCodeAt(l.pos);
    if (next < 0x30 || next > 0x39) return lexField;
  }
  if (r === 0x2e || r === 0x2b || r === 0x2d || (r >= 0x30 && r <= 0x39)) {
    l.backup();
    return lexNumber;
  }
  if (isAlphaNumeric(r)) {
    l.backup();
    return lexIdentifier;
  }
  if (r <= 0x7f && isPrint(r)) return l.emit(ITEM_CHAR);
  return l.errorf('unrecognized character in action: %#U', r);
}

function lexSpace(l: Lexer): StateFn {
  let numSpaces = 0;
  while (isSpace(l.peek())) {
    l.next();
    numSpaces++;
  }
  if (
    hasRightTrimMarker(l.input.slice(l.pos - 1)) &&
    l.input.slice(l.pos - 1 + TRIM_MARKER_LEN).startsWith(l.rightDelim)
  ) {
    l.backup();
    if (numSpaces === 1) return lexRightDelim;
  }
  return l.emit(ITEM_SPACE);
}

// code-gauge-allow functionCognitiveComplexity 18 -- A transcription of Go's lexIdentifier.
function lexIdentifier(l: Lexer): StateFn {
  for (;;) {
    const r = l.next();
    if (isAlphaNumeric(r)) continue;
    l.backup();
    const word = l.input.slice(l.start, l.pos);
    if (!l.atTerminator()) return l.errorf('bad character %#U', r);
    const keyword = KEY.get(word) ?? 0;
    if (keyword > ITEM_KEYWORD) {
      if ((keyword === ITEM_BREAK && !l.options.breakOK) || (keyword === ITEM_CONTINUE && !l.options.continueOK)) {
        return l.emit(ITEM_IDENTIFIER);
      }
      return l.emit(keyword);
    }
    if (word[0] === '.') return l.emit(ITEM_FIELD);
    if (word === 'true' || word === 'false') return l.emit(ITEM_BOOL);
    return l.emit(ITEM_IDENTIFIER);
  }
}

function lexField(l: Lexer): StateFn {
  return lexFieldOrVariable(l, ITEM_FIELD);
}

function lexVariable(l: Lexer): StateFn {
  if (l.atTerminator()) return l.emit(ITEM_VARIABLE);
  return lexFieldOrVariable(l, ITEM_VARIABLE);
}

function lexFieldOrVariable(l: Lexer, typ: number): StateFn {
  if (l.atTerminator()) return l.emit(typ === ITEM_VARIABLE ? ITEM_VARIABLE : ITEM_DOT);
  let r: number;
  for (;;) {
    r = l.next();
    if (!isAlphaNumeric(r)) {
      l.backup();
      break;
    }
  }
  if (!l.atTerminator()) return l.errorf('bad character %#U', r);
  return l.emit(typ);
}

function lexQuoted(l: Lexer, quote: number, typ: number, message: string): StateFn {
  for (;;) {
    let r = l.next();
    if (r === 0x5c) {
      r = l.next();
      if (r !== EOF && r !== 10) continue;
      return l.errorf(message);
    }
    if (r === EOF || r === 10) return l.errorf(message);
    if (r === quote) return l.emit(typ);
  }
}

function lexChar(l: Lexer): StateFn {
  return lexQuoted(l, 0x27, ITEM_CHAR_CONSTANT, 'unterminated character constant');
}

function lexQuote(l: Lexer): StateFn {
  return lexQuoted(l, 0x22, ITEM_STRING, 'unterminated quoted string');
}

function lexNumber(l: Lexer): StateFn {
  if (!l.scanNumber()) return l.errorf('bad number syntax: %q', l.input.slice(l.start, l.pos));
  const sign = l.peek();
  if (sign === 0x2b || sign === 0x2d) {
    if (!l.scanNumber() || l.input[l.pos - 1] !== 'i') {
      return l.errorf('bad number syntax: %q', l.input.slice(l.start, l.pos));
    }
    return l.emit(ITEM_COMPLEX);
  }
  return l.emit(ITEM_NUMBER);
}

function lexRawQuote(l: Lexer): StateFn {
  for (;;) {
    const r = l.next();
    if (r === EOF) return l.errorf('unterminated raw quoted string');
    if (r === 0x60) return l.emit(ITEM_RAW_STRING);
  }
}

function isSpace(r: number): boolean {
  return r === 0x20 || r === 0x09 || r === 0x0d || r === 0x0a;
}

function isAlphaNumeric(r: number): boolean {
  return r === 0x5f || isLetter(r) || isDigit(r);
}

function hasLeftTrimMarker(text: string): boolean {
  return text.length >= 2 && text[0] === TRIM_MARKER && isSpace(text.charCodeAt(1));
}

function hasRightTrimMarker(text: string): boolean {
  return text.length >= 2 && isSpace(text.charCodeAt(0)) && text[1] === TRIM_MARKER;
}
