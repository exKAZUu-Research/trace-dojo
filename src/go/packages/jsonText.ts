// code-gauge-allow-file fileNcss 837 -- One port of Go's encoding package source, whose parts share its state and helpers.
// oxlint-disable unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import { decodeRune, encodeRune, RUNE_ERROR } from '../literals';
import { currentRuntime } from '../native';
import { quote } from '../quote';
import type { Value } from '../values';
import { EOF, sameError } from './io';
import {
  consumeExactLiteral,
  consumeLiteral,
  consumeNumber,
  consumeNumberResumable,
  consumeSimpleNumber,
  consumeSimpleString,
  consumeString,
  consumeWhitespace,
  EOF_ERROR,
  type EscapeFlags,
  GoValueError,
  InvalidTextError,
  LibError,
  newInvalidCharacterError,
  NumberState,
  quoteJSON,
  reformatRawString,
  type StringFlags,
  TextError,
  UNEXPECTED_EOF,
  unquote,
} from './jsonWire';
import { byteSlice, bytesOf, callMethod, errorText } from './support';

export const ERR_NON_STRING_NAME = new TextError('object member name must be a string');
const ERR_MISSING_VALUE = new TextError('missing value after object name');
const ERR_MISMATCH_DELIM = new TextError('mismatching structural token for object or array');
const ERR_MAX_DEPTH = new TextError('exceeded max depth');
const MAX_NESTING_DEPTH = 10_000;

/** `jsontext.ioError`: a failure of the underlying reader, which v1 reports unwrapped. */
export class IoError extends LibError {
  constructor(
    readonly action: string,
    readonly err: GoValueError
  ) {
    super();
  }

  message(): string {
    return `jsontext: ${this.action} error: ${this.err.message()}`;
  }

  override unwrap(): LibError {
    return this.err;
  }
}

/** `jsontext.SyntacticError`. */
export class SyntacticError extends LibError {
  constructor(
    readonly offset: number,
    readonly pointer: string,
    readonly err: LibError
  ) {
    super();
  }

  message(): string {
    let text = `jsontext: ${this.err.message()}`;
    if (this.pointer !== '') text += ` within ${quote(truncatePointer(this.pointer, 100))}`;
    if (this.offset > 0) text += ` after offset ${this.offset}`;
    return text;
  }

  override unwrap(): LibError {
    return this.err;
  }
}

/** An error inside a value of an object or array, with the path to it in reverse. */
class PointerSuffixError extends LibError {
  readonly segments: string[] = [];

  constructor(readonly err: LibError) {
    super();
  }

  message(): string {
    return this.err.message();
  }
}

function wrapWithObjectName(err: LibError, quotedName: string): LibError {
  const suffix = err instanceof PointerSuffixError ? err : new PointerSuffixError(err);
  suffix.segments.unshift(escapePointerName(unquote(quotedName)[0]));
  return suffix;
}

function wrapWithArrayIndex(err: LibError, index: number): LibError {
  const suffix = err instanceof PointerSuffixError ? err : new PointerSuffixError(err);
  suffix.segments.unshift(String(index));
  return suffix;
}

export function escapePointerName(name: string): string {
  let out = '';
  for (let at = 0; at < name.length;) {
    const { rune, size } = decodeRune(name, at);
    at += size;
    if (rune === 0x7e) out += '~0';
    else if (rune === 0x2f) out += '~1';
    else out += size === 1 && rune === RUNE_ERROR ? encodeRune(RUNE_ERROR) : name.slice(at - size, at);
  }
  return out;
}

/** `jsontext.Pointer.LastToken`. */
export function pointerLastToken(pointer: string): string {
  const last = pointer.slice(Math.max(pointer.lastIndexOf('/'), 0));
  return last.replace(/^\//, '').replaceAll('~1', '/').replaceAll('~0', '~');
}

/** `jsonwire.TruncatePointer`. */
function truncatePointer(s: string, n: number): string {
  if (s.length <= n) return s;
  let i = n / 2;
  let j = s.length - n / 2;
  const k1 = s.slice(0, i).lastIndexOf('/');
  if (k1 > 0) i = k1;
  const k2 = s.slice(j).indexOf('/');
  if (k2 !== -1) j += k2 + 1;
  while (i > 0 && isContinuation(s.charCodeAt(i))) i--;
  while (j < s.length && isContinuation(s.charCodeAt(j))) j++;
  const middleText = s.slice(i, j);
  const slashes = middleText.split('/').length - 1;
  let middle = slashes === 0 ? '…' : slashes === 1 ? '…/…' : '…/…/…';
  if (middleText.startsWith('/') && middle !== '…') middle = middle.slice(1);
  if (middleText.endsWith('/') && middle !== '…') middle = middle.slice(0, -1);
  return s.slice(0, i) + encodeUtf8(middle) + s.slice(j);
}

function isContinuation(c: number): boolean {
  return c >= 0x80 && c < 0xc0;
}

function encodeUtf8(text: string): string {
  return Array.from(text, (char) => encodeRune(char.codePointAt(0) as number)).join('');
}

// State machine -------------------------------------------------------------------------------------------------------

export type Kind = 'n' | 'f' | 't' | '"' | '0' | '{' | '}' | '[' | ']' | '';

export function kindOf(c: string | undefined): Kind {
  if (c === undefined) return '';
  if (c === '-' || (c >= '0' && c <= '9')) return '0';
  return 'nft"{}[]'.includes(c) ? (c as Kind) : '';
}

/** One level of the token stack: an object or array and the number of tokens in it. */
class StateEntry {
  constructor(
    readonly isObject: boolean,
    public length = 0
  ) {}

  get needObjectName(): boolean {
    return this.isObject && this.length % 2 === 0;
  }

  get needObjectValue(): boolean {
    return this.isObject && this.length % 2 === 1;
  }

  needImplicitComma(next: Kind): boolean {
    return !this.needObjectValue && this.length > 0 && next !== '}' && next !== ']';
  }
}

/** `jsontext.stateMachine`, with the top-level values as the elements of a virtual array at index 0. */
export class StateMachine {
  readonly entries: StateEntry[] = [new StateEntry(false)];

  get last(): StateEntry {
    return this.entries.at(-1) as StateEntry;
  }

  get depth(): number {
    return this.entries.length;
  }

  appendLiteral(): LibError | undefined {
    if (this.last.needObjectName) return ERR_NON_STRING_NAME;
    this.last.length++;
    return undefined;
  }

  appendString(): undefined {
    this.last.length++;
    return undefined;
  }

  push(isObject: boolean): LibError | undefined {
    if (this.last.needObjectName) return ERR_NON_STRING_NAME;
    if (this.entries.length - 1 === MAX_NESTING_DEPTH) return ERR_MAX_DEPTH;
    this.last.length++;
    this.entries.push(new StateEntry(isObject));
    return undefined;
  }

  popObject(): LibError | undefined {
    if (!this.last.isObject) return ERR_MISMATCH_DELIM;
    if (this.last.needObjectValue) return ERR_MISSING_VALUE;
    this.entries.pop();
    return undefined;
  }

  popArray(): LibError | undefined {
    if (this.last.isObject || this.entries.length === 1) return ERR_MISMATCH_DELIM;
    this.entries.pop();
    return undefined;
  }

  needIndent(next: Kind): number {
    const willEnd = next === '}' || next === ']';
    if (this.depth === 1) return 0;
    if (this.last.length === 0 && willEnd) return 0;
    if (this.last.length === 0 || this.last.needImplicitComma(next)) return this.depth;
    if (willEnd) return this.depth - 1;
    return 0;
  }

  needDelim(next: Kind): string {
    if (this.last.needObjectValue) return ':';
    if (this.last.needImplicitComma(next) && this.entries.length > 1) return ',';
    return '';
  }
}

/** The state of an encoder or decoder: its tokens and the name of the current member of each object. */
abstract class CoderState {
  readonly tokens = new StateMachine();
  /** The unquoted name of the latest member of each open object. */
  readonly names: string[] = [];

  abstract offsetAt(pos: number): number;

  /** `appendStackPointer`: the JSON pointer to the current position, `where` being before, at, or after a value. */
  // code-gauge-allow functionCognitiveComplexity 16 -- A transcription of Go's stackPointer, step by step.
  stackPointer(where: number): string {
    let pointer = '';
    let objectDepth = 0;
    const { entries } = this.tokens;
    for (let i = 1; i < entries.length; i++) {
      const e = entries[i];
      let arrayDelta = -1;
      if (i === entries.length - 1) {
        if ((where < 0 && e.length === 0) || (where === 0 && !e.needObjectValue) || (where > 0 && e.needObjectName)) {
          return pointer;
        }
        if (where > 0 && !e.isObject) arrayDelta = 0;
      }
      pointer += e.isObject ? `/${escapePointerName(this.names[objectDepth++] ?? '')}` : `/${e.length + arrayDelta}`;
    }
    return pointer;
  }

  /** Records a whole value of the kind in the token state, with its raw text when it is an object member's name. */
  protected appendValue(kind: Kind, raw: string): LibError | undefined {
    if (kind === '"') {
      if (this.tokens.last.needObjectName) this.names[this.names.length - 1] = unquote(raw)[0];
      return this.tokens.appendString();
    }
    if (kind === '{' || kind === '[') {
      const err = this.tokens.push(kind === '{');
      if (!err) this.tokens.entries.pop();
      return err;
    }
    return this.tokens.appendLiteral();
  }

  /** `wrapSyntacticError` with v1's legacy offsets. */
  wrapSyntacticError(error: LibError, pos: number, where: number): LibError {
    let err = error;
    if (err === EOF_ERROR || err instanceof IoError) return err;
    let offset = this.offsetAt(pos);
    let pointer = this.stackPointer(where);
    if (err instanceof PointerSuffixError) {
      pointer += err.segments.map((segment) => `/${segment}`).join('');
      err = err.err;
    }
    if (this instanceof DecoderState && err === ERR_MISMATCH_DELIM) {
      let place = 'at start of value';
      if (this.tokens.depth > 1 && this.tokens.last.length > 0) {
        place = this.tokens.last.isObject
          ? "after object value (expecting ',' or '}')"
          : "after array element (expecting ',' or ']')";
        pointer = pointer.slice(0, Math.max(pointer.lastIndexOf('/'), 0));
      }
      err = newInvalidCharacterError(this.buf, pos, place);
    }
    if (err !== UNEXPECTED_EOF) offset += err instanceof InvalidTextError ? err.what.length : 1;
    return new SyntacticError(offset, pointer, err);
  }
}

const LITERALS: Record<string, string> = { n: 'null', f: 'false', t: 'true' };

export interface Token {
  kind: Kind;
  /** The raw bytes of a string or number token. */
  raw?: string;
}

const NO_TOKEN: Token = { kind: '' };

// Decoder -------------------------------------------------------------------------------------------------------------

/** `jsontext.decoderState` over in-memory bytes, or over an io.Reader that it reads as Go's decoder does. */
export class DecoderState extends CoderState {
  buf: string;
  private capacity = 0;
  peekPos = 0;
  peekErr: LibError | undefined;
  prevStart = 0;
  prevEnd = 0;
  baseOffset = 0;

  constructor(
    data: string,
    private readonly reader?: Value
  ) {
    super();
    this.buf = data;
  }

  offsetAt(pos: number): number {
    return this.baseOffset + pos;
  }

  inputOffset(): number {
    return this.baseOffset + this.prevEnd;
  }

  unreadBuffer(): string {
    return this.buf.slice(this.prevEnd);
  }

  /** `CountNextDelimWhitespace` for a decoder. */
  countNextDelimWhitespace(): number {
    this.peekKind();
    const unread = this.unreadBuffer();
    return unread.length - unread.replace(/^[,: \n\r\t]+/, '').length;
  }

  /** `PreviousTokenOrValue`. */
  previousTokenOrValue(): string {
    const b = this.buf.slice(this.prevStart, this.prevEnd);
    if (this.peekPos > 0) return '';
    if (b.length === 0) {
      const all = this.buf.slice(0, this.prevEnd);
      for (const token of ['null', 'false', 'true', '{', '}', '[', ']']) {
        if (all.endsWith(token)) return token;
      }
    }
    return b;
  }

  private needMore(pos: number): boolean {
    return pos === this.buf.length;
  }

  /** Reads more input, returning UNEXPECTED_EOF at its end. */
  private fetch(): LibError | undefined {
    if (this.reader === undefined) return UNEXPECTED_EOF;
    currentRuntime().spend();
    if (this.capacity === 0) this.capacity = 64;
    let grow = this.capacity <= 2048 && this.capacity < Math.floor((this.baseOffset + this.prevEnd) / 2);
    grow ||= this.prevStart === 0 && this.buf.length >= Math.floor((3 * this.capacity) / 4);
    if (grow) this.capacity *= 2;
    currentRuntime().checkStringLength(this.capacity);
    this.buf = this.buf.slice(this.prevStart);
    this.baseOffset += this.prevStart;
    this.prevEnd -= this.prevStart;
    this.prevStart = 0;
    for (;;) {
      const space = byteSlice('\0'.repeat(this.capacity - this.buf.length));
      const [count, error] = callMethod(this.reader, 'Read', [space]) as [bigint, Value];
      const n = Number(count);
      if (n > 0) {
        this.buf += bytesOf(space).slice(0, n);
        return undefined;
      }
      if (error !== undefined && sameError(error, EOF)) return UNEXPECTED_EOF;
      if (error !== undefined) return new IoError('read', new GoValueError(error, errorText(error)));
    }
  }

  private consumeWhitespaceFrom(start: number): [number, LibError | undefined] {
    let pos = start;
    for (;;) {
      pos += consumeWhitespace(this.buf, pos);
      if (this.needMore(pos)) {
        const abs = this.baseOffset + pos;
        const err = this.fetch();
        pos = abs - this.baseOffset;
        if (err) return [pos, err];
        continue;
      }
      return [pos, undefined];
    }
  }

  /** Skips whitespace and a delimiter before the next token, or reports why the next token cannot follow. */
  private advance(): [number, Kind, LibError | undefined] {
    let pos = this.prevEnd;
    pos += consumeWhitespace(this.buf, pos);
    let err: LibError | undefined;
    if (this.needMore(pos)) {
      [pos, err] = this.consumeWhitespaceFrom(pos);
      if (err) {
        if (err === UNEXPECTED_EOF && this.tokens.depth === 1) err = EOF_ERROR;
        return [pos, '', this.wrapSyntacticError(err, pos, 0)];
      }
    }
    let delim = '';
    const c = this.buf[pos];
    if (c === ':' || c === ',') {
      delim = c;
      pos++;
      pos += consumeWhitespace(this.buf, pos);
      if (this.needMore(pos)) {
        [pos, err] = this.consumeWhitespaceFrom(pos);
        if (err) return [pos, '', this.checkDelimBeforeIOError(delim, this.wrapSyntacticError(err, pos, 0))];
      }
    }
    const next = kindOf(this.buf[pos]);
    if (this.tokens.needDelim(next) !== delim) return [pos, '', this.checkDelim(delim, next)];
    return [pos, next, undefined];
  }

  peekKind(): Kind {
    if (this.peekPos > 0) return kindOf(this.buf[this.peekPos]);
    const [pos, next, err] = this.advance();
    if (err) {
      this.peekPos = -1;
      this.peekErr = err;
      return '';
    }
    this.peekPos = pos;
    this.peekErr = undefined;
    return next;
  }

  private checkDelimBeforeIOError(delim: string, err: LibError): LibError {
    if (this.tokens.needDelim('"') !== delim) return this.checkDelim(delim, '"');
    return err;
  }

  private checkDelim(delim: string, next: Kind): LibError {
    let where = 'at start of value';
    const needed = this.tokens.needDelim(next);
    if (needed === ':') where = "after object name (expecting ':')";
    else if (needed === ',') {
      where = this.tokens.last.isObject
        ? "after object value (expecting ',' or '}')"
        : "after array element (expecting ',' or ']')";
    }
    let pos = this.prevEnd;
    pos += consumeWhitespace(this.buf, pos);
    return this.wrapSyntacticError(newInvalidCharacterError(this.buf, pos, where), pos, 0);
  }

  /** The position and kind of the next token, from the cached peek or by advancing. */
  private nextPosition(): [number, Kind, LibError | undefined] {
    if (this.peekPos !== 0) {
      if (this.peekErr) {
        const err = this.peekErr;
        this.peekPos = 0;
        this.peekErr = undefined;
        return [0, '', err];
      }
      const pos = this.peekPos;
      this.peekPos = 0;
      return [pos, kindOf(this.buf[pos]), undefined];
    }
    return this.advance();
  }

  skipValue(): LibError | undefined {
    const kind = this.peekKind();
    if (kind === '{' || kind === '[') {
      const { depth } = this.tokens;
      for (;;) {
        const [, err] = this.readToken();
        if (err) return err;
        if (depth >= this.tokens.depth) return undefined;
      }
    }
    return this.readValue({ nonVerbatim: false })[1];
  }

  skipValueRemainder(): LibError | undefined {
    if (this.tokens.depth - 1 > 0 && this.tokens.last.length === 0) {
      const n = this.tokens.depth;
      while (this.tokens.depth >= n) {
        const [, err] = this.readToken();
        if (err) return err;
      }
    }
    return undefined;
  }

  /** `ReadToken`: the next token, or a syntax error, EOF at the end of the top-level values, or an I/O error. */
  readToken(): [Token, LibError | undefined] {
    currentRuntime().spend();
    const [pos, next, err] = this.nextPosition();
    if (err) return [NO_TOKEN, err];
    if (next === '{' || next === '[' || next === '}' || next === ']') return this.readDelimiter(next, pos);
    if (next === '') {
      return [NO_TOKEN, this.wrapSyntacticError(newInvalidCharacterError(this.buf, pos, 'at start of value'), pos, +1)];
    }
    const [start, end, consumeErr] = this.consumeToken(next, pos);
    if (consumeErr) return [NO_TOKEN, this.wrapSyntacticError(consumeErr, end, +1)];
    const raw = this.buf.slice(start, end);
    const appendErr = this.appendValue(next, raw);
    if (appendErr) return [NO_TOKEN, this.wrapSyntacticError(appendErr, start, +1)];
    const isLiteral = next !== '"' && next !== '0';
    this.prevStart = isLiteral ? end : start;
    this.prevEnd = end;
    return [isLiteral ? { kind: next } : { kind: next, raw }, undefined];
  }

  private readDelimiter(kind: '{' | '[' | '}' | ']', pos: number): [Token, LibError | undefined] {
    let err: LibError | undefined;
    if (kind === '{' || kind === '[') err = this.tokens.push(kind === '{');
    else err = kind === '}' ? this.tokens.popObject() : this.tokens.popArray();
    if (err) return [NO_TOKEN, this.wrapSyntacticError(err, pos, +1)];
    if (kind === '{') this.names.push('');
    else if (kind === '}') this.names.pop();
    this.prevStart = pos + 1;
    this.prevEnd = pos + 1;
    return [{ kind }, undefined];
  }

  /** Consumes the literal, string, or number at `pos`: its start and end, or the end and why it is invalid. */
  private consumeToken(kind: Kind, pos: number): [number, number, LibError | undefined] {
    const oldAbs = this.baseOffset + pos;
    if (kind === '"') {
      const n = consumeSimpleString(this.buf, pos);
      if (n > 0) return [pos, pos + n, undefined];
      const [end, err] = this.consumeStringFrom({ nonVerbatim: false }, pos);
      return [oldAbs - this.baseOffset, end, err];
    }
    if (kind === '0') {
      const n = consumeSimpleNumber(this.buf, pos);
      if (n > 0 && !this.needMore(pos + n)) return [pos, pos + n, undefined];
      const [end, err] = this.consumeNumberFrom(pos);
      return [oldAbs - this.baseOffset, end, err];
    }
    const lit = LITERALS[kind];
    if (consumeExactLiteral(this.buf, pos, lit) > 0) return [pos, pos + lit.length, undefined];
    const [end, err] = this.consumeLiteralFrom(pos, lit);
    return [oldAbs - this.baseOffset, end, err];
  }

  /** `ReadValue`: the raw bytes of the next whole value. */
  readValue(flags: StringFlags): [string, LibError | undefined] {
    currentRuntime().spend();
    let [pos, next, err] = this.nextPosition();
    if (err) return ['', err];
    const oldAbs = this.baseOffset + pos;
    [pos, err] = this.consumeValue(flags, pos, this.tokens.depth);
    const start = oldAbs - this.baseOffset;
    if (err) return ['', this.wrapSyntacticError(err, pos, +1)];
    const raw = this.buf.slice(start, pos);
    err = this.appendValue(next, raw);
    if (err) return ['', this.wrapSyntacticError(err, start, +1)];
    this.prevEnd = pos;
    this.prevStart = start;
    return [raw, undefined];
  }

  /** `CheckNextValue`: validates the next value without consuming it, and that nothing follows when `last`. */
  checkNextValue(last: boolean): LibError | undefined {
    this.peekKind();
    const pos = this.peekPos;
    const err = this.peekErr;
    this.peekPos = 0;
    this.peekErr = undefined;
    if (err) return err;
    const [end, err2] = this.consumeValue({ nonVerbatim: false }, pos, this.tokens.depth);
    if (err2) return this.wrapSyntacticError(err2, end, +1);
    if (last) return this.checkEOFAt(end);
    return undefined;
  }

  atEOF(): boolean {
    return this.consumeWhitespaceFrom(this.prevEnd)[1] === UNEXPECTED_EOF;
  }

  checkEOF(): LibError | undefined {
    return this.checkEOFAt(this.prevEnd);
  }

  private checkEOFAt(start: number): LibError | undefined {
    const [pos, err] = this.consumeWhitespaceFrom(start);
    if (err === undefined) {
      return this.wrapSyntacticError(newInvalidCharacterError(this.buf, pos, 'after top-level value'), pos, 0);
    }
    if (err === UNEXPECTED_EOF) return undefined;
    return err;
  }

  /** `consumeValue`: the end of the value at `pos`, fetching more input as needed, or why it is invalid. */
  private consumeValue(flags: StringFlags, pos: number, depth: number): [number, LibError | undefined] {
    currentRuntime().spend();
    const next = kindOf(this.buf[pos]);
    switch (next) {
      case 'n':
      case 'f':
      case 't': {
        const lit = LITERALS[next];
        if (consumeExactLiteral(this.buf, pos, lit) > 0) return [pos + lit.length, undefined];
        return this.consumeLiteralFrom(pos, lit);
      }
      case '"': {
        const n = consumeSimpleString(this.buf, pos);
        return n > 0 ? [pos + n, undefined] : this.consumeStringFrom(flags, pos);
      }
      case '0': {
        const n = consumeSimpleNumber(this.buf, pos);
        return n > 0 && !this.needMore(pos + n) ? [pos + n, undefined] : this.consumeNumberFrom(pos);
      }
      case '{': {
        return this.consumeObject(flags, pos, depth);
      }
      case '[': {
        return this.consumeArray(flags, pos, depth);
      }
      default: {
        const c = this.buf[pos];
        if ((this.tokens.last.isObject && c === ']') || (!this.tokens.last.isObject && c === '}')) {
          return [pos, ERR_MISMATCH_DELIM];
        }
        return [pos, newInvalidCharacterError(this.buf, pos, 'at start of value')];
      }
    }
  }

  private consumeLiteralFrom(start: number, lit: string): [number, LibError | undefined] {
    let pos = start;
    for (;;) {
      const [n, err] = consumeLiteral(this.buf, pos, lit);
      if (err === UNEXPECTED_EOF) {
        const abs = this.baseOffset + pos;
        const fetchErr = this.fetch();
        pos = abs - this.baseOffset;
        if (fetchErr) return [pos + n, fetchErr];
        continue;
      }
      return [pos + n, err];
    }
  }

  private consumeStringFrom(flags: StringFlags, start: number): [number, LibError | undefined] {
    let pos = start;
    let n = 0;
    for (;;) {
      let err: LibError | undefined;
      [n, err] = consumeString(flags, this.buf, pos, n);
      if (err === UNEXPECTED_EOF) {
        const abs = this.baseOffset + pos;
        const fetchErr = this.fetch();
        pos = abs - this.baseOffset;
        if (fetchErr) return [pos + n, fetchErr];
        continue;
      }
      return [pos + n, err];
    }
  }

  private consumeNumberFrom(start: number): [number, LibError | undefined] {
    let pos = start;
    let n = 0;
    let state = NumberState.Init;
    for (;;) {
      let err: LibError | undefined;
      [n, state, err] = consumeNumberResumable(this.buf, pos, n, state);
      if (err === UNEXPECTED_EOF || this.needMore(pos + n)) {
        const mayTerminate = err === undefined;
        const abs = this.baseOffset + pos;
        const fetchErr = this.fetch();
        pos = abs - this.baseOffset;
        if (fetchErr) {
          if (mayTerminate && fetchErr === UNEXPECTED_EOF) return [pos + n, undefined];
          return [pos, fetchErr];
        }
        continue;
      }
      return [pos + n, err];
    }
  }

  /** Skips whitespace inside a composite value, fetching more input as needed. */
  private skipSpace(start: number): [number, LibError | undefined] {
    const pos = start + consumeWhitespace(this.buf, start);
    if (this.needMore(pos)) return this.consumeWhitespaceFrom(pos);
    return [pos, undefined];
  }

  // code-gauge-allow functionCognitiveComplexity 30 -- A transcription of Go's decoderState.consumeObject.
  // code-gauge-allow functionNcss 49 -- A transcription of Go's consumeObject, step by step.
  private consumeObject(flags: StringFlags, start: number, depth: number): [number, LibError | undefined] {
    let pos = start;
    let err: LibError | undefined;
    if (depth === MAX_NESTING_DEPTH + 1) return [pos, ERR_MAX_DEPTH];
    pos++;
    [pos, err] = this.skipSpace(pos);
    if (err) return [pos, err];
    if (this.buf[pos] === '}') return [pos + 1, undefined];
    const inner = depth + 1;
    for (;;) {
      [pos, err] = this.skipSpace(pos);
      if (err) return [pos, err];
      let n = consumeSimpleString(this.buf, pos);
      if (n === 0) {
        const oldAbs = this.baseOffset + pos;
        [pos, err] = this.consumeStringFrom(flags, pos);
        n = this.baseOffset + pos - oldAbs;
        if (err) return [pos, err];
      } else {
        pos += n;
      }
      const quotedName = this.buf.slice(pos - n, pos);
      [pos, err] = this.skipSpace(pos);
      if (err) return [pos, wrapWithObjectName(err, quotedName)];
      if (this.buf[pos] !== ':') {
        err = newInvalidCharacterError(this.buf, pos, "after object name (expecting ':')");
        return [pos, wrapWithObjectName(err, quotedName)];
      }
      pos++;
      [pos, err] = this.skipSpace(pos);
      if (err) return [pos, wrapWithObjectName(err, quotedName)];
      [pos, err] = this.consumeValue(flags, pos, inner);
      if (err) return [pos, wrapWithObjectName(err, quotedName)];
      [pos, err] = this.skipSpace(pos);
      if (err) return [pos, err];
      const c = this.buf[pos];
      if (c === ',') {
        pos++;
        continue;
      }
      if (c === '}') return [pos + 1, undefined];
      return [pos, newInvalidCharacterError(this.buf, pos, "after object value (expecting ',' or '}')")];
    }
  }

  private consumeArray(flags: StringFlags, start: number, depth: number): [number, LibError | undefined] {
    let pos = start;
    let err: LibError | undefined;
    if (depth === MAX_NESTING_DEPTH + 1) return [pos, ERR_MAX_DEPTH];
    pos++;
    [pos, err] = this.skipSpace(pos);
    if (err) return [pos, err];
    if (this.buf[pos] === ']') return [pos + 1, undefined];
    const inner = depth + 1;
    for (let index = 0; ; index++) {
      [pos, err] = this.skipSpace(pos);
      if (err) return [pos, err];
      [pos, err] = this.consumeValue(flags, pos, inner);
      if (err) return [pos, wrapWithArrayIndex(err, index)];
      [pos, err] = this.skipSpace(pos);
      if (err) return [pos, err];
      const c = this.buf[pos];
      if (c === ',') {
        pos++;
        continue;
      }
      if (c === ']') return [pos + 1, undefined];
      return [pos, newInvalidCharacterError(this.buf, pos, "after array element (expecting ',' or ']')")];
    }
  }
}

// Encoder -------------------------------------------------------------------------------------------------------------

export interface EncoderOptions extends EscapeFlags {
  multiline: boolean;
  indent: string;
  prefix: string;
}

/** `jsontext.encoderState` writing to an in-memory buffer. */
export class EncoderState extends CoderState {
  buf = '';

  constructor(readonly options: EncoderOptions) {
    super();
  }

  offsetAt(pos: number): number {
    return pos;
  }

  /** `CountNextDelimWhitespace` for an encoder. */
  countNextDelimWhitespace(): number {
    const delim = this.tokens.needDelim('"');
    let n = delim === '' ? 0 : 1;
    if (delim === ':') {
      if (this.options.multiline) n++;
    } else if (this.options.multiline) {
      const m = this.tokens.needIndent('"');
      if (m > 0) n += 1 + this.options.prefix.length + (m - 1) * this.options.indent.length;
    }
    return n;
  }

  private prefixFor(kind: Kind): string {
    let b = '';
    const delim = this.tokens.needDelim(kind);
    if (delim === ':') b += ':';
    else if (delim === ',') b += ',';
    if (this.options.multiline) b += delim === ':' ? ' ' : this.indentation(this.tokens.needIndent(kind));
    return b;
  }

  private indentation(n: number): string {
    if (n === 0) return '';
    return `\n${this.options.prefix}${this.options.indent.repeat(n - 1)}`;
  }

  /** Writes a literal, delimiter, or (quoted) string or number token. */
  // code-gauge-allow functionNcss 44 -- A transcription of Go's writeToken, step by step.
  writeToken(kind: Kind, text = ''): LibError | undefined {
    currentRuntime().spend();
    let b = this.buf + this.prefixFor(kind);
    const pos = b.length;
    let err: LibError | undefined;
    switch (kind) {
      case 'n': {
        b += 'null';
        err = this.tokens.appendLiteral();
        break;
      }
      case 'f':
      case 't': {
        b += kind === 't' ? 'true' : 'false';
        err = this.tokens.appendLiteral();
        break;
      }
      case '"': {
        b += quoteJSON(text, this.options);
        if (this.tokens.last.needObjectName) this.names[this.names.length - 1] = text;
        this.tokens.appendString();
        break;
      }
      case '0': {
        b += text;
        err = this.tokens.appendLiteral();
        break;
      }
      case '{':
      case '[': {
        b += kind;
        err = this.tokens.push(kind === '{');
        if (!err && kind === '{') this.names.push('');
        break;
      }
      case '}':
      case ']': {
        b += kind;
        err = kind === '}' ? this.tokens.popObject() : this.tokens.popArray();
        if (!err && kind === '}') this.names.pop();
        break;
      }
    }
    if (err) return this.wrapSyntacticError(err, pos, +1);
    this.checkLength(b.length);
    this.buf = b;
    return undefined;
  }

  /** `AppendRaw` of a string whose unquoted text is `text` (escaped as needed), or of a number. */
  appendRaw(kind: '"' | '0', text: string): LibError | undefined {
    currentRuntime().spend();
    let b = this.buf + this.prefixFor(kind);
    if (kind === '"') {
      if (this.tokens.last.needObjectName) this.names[this.names.length - 1] = text;
      b += quoteJSON(text, this.options);
      this.tokens.appendString();
    } else {
      b += text;
      const pos = b.length - text.length;
      const err = this.tokens.appendLiteral();
      if (err) return this.wrapSyntacticError(err, pos, +1);
    }
    this.checkLength(b.length);
    this.buf = b;
    return undefined;
  }

  private checkLength(length: number): void {
    currentRuntime().checkStringLength(length);
  }

  /** Writes a raw JSON value after validating and reformatting it. */
  writeValue(v: string): LibError | undefined {
    currentRuntime().spend(1 + Math.floor(v.length / 16));
    let n = consumeWhitespace(v, 0);
    const kind = kindOf(v[n]);
    const b = this.buf + this.prefixFor(kind);
    const pos = b.length;
    const [out, m, reformatErr] = this.reformatValue(v, n, this.tokens.depth);
    if (reformatErr) return this.wrapSyntacticError(reformatErr, pos + n + m, +1);
    n += m;
    n += consumeWhitespace(v, n);
    if (v.length > n) {
      return this.wrapSyntacticError(newInvalidCharacterError(v, n, 'after top-level value'), pos + n, 0);
    }
    const err = this.appendValue(kind, out);
    if (err) return this.wrapSyntacticError(err, pos, +1);
    this.checkLength(b.length + out.length);
    this.buf = b + out;
    return undefined;
  }

  /** `reformatValue` of `src[at:]`: the reformatted text, the length consumed, and any error. */
  // code-gauge-allow functionNcss 31 -- A transcription of Go's reformatValue, step by step.
  private reformatValue(src: string, at: number, depth: number): [string, number, LibError | undefined] {
    currentRuntime().spend();
    if (at >= src.length) return ['', 0, UNEXPECTED_EOF];
    const c = src[at];
    switch (kindOf(c)) {
      case 'n':
      case 'f':
      case 't': {
        const lit = LITERALS[c];
        if (consumeExactLiteral(src, at, lit) === 0) {
          const [n, err] = consumeLiteral(src, at, lit);
          return ['', n, err];
        }
        return [lit, lit.length, undefined];
      }
      case '"': {
        const simple = consumeSimpleString(src, at);
        if (simple > 0) return [src.slice(at, at + simple), simple, undefined];
        return this.reformatString(src, at);
      }
      case '0': {
        const simple = consumeSimpleNumber(src, at);
        if (simple > 0) return [src.slice(at, at + simple), simple, undefined];
        const [n, err] = consumeNumber(src, at);
        return [err ? '' : src.slice(at, at + n), n, err];
      }
      case '{': {
        return this.reformatComposite(src, at, depth, true);
      }
      case '[': {
        return this.reformatComposite(src, at, depth, false);
      }
      default: {
        return ['', 0, newInvalidCharacterError(src, at, 'at start of value')];
      }
    }
  }

  /** `jsonwire.ReformatString`. */
  private reformatString(src: string, at: number): [string, number, LibError | undefined] {
    const [n, err] = consumeString({ nonVerbatim: false }, src, at, 0);
    if (err) return ['', n, err];
    return [reformatRawString(src.slice(at, at + n), this.options), n, undefined];
  }

  /** `reformatObject` and `reformatArray`. */
  // code-gauge-allow functionNcss 33 -- A transcription of Go's reformatComposite, step by step.
  // code-gauge-allow functionCognitiveComplexity 21 -- A transcription of Go's reformatComposite, step by step.
  private reformatComposite(
    src: string,
    at: number,
    depth: number,
    isObject: boolean
  ): [string, number, LibError | undefined] {
    const close = isObject ? '}' : ']';
    if (depth === MAX_NESTING_DEPTH + 1) return ['', 0, ERR_MAX_DEPTH];
    let dst = isObject ? '{' : '[';
    let n = 1 + consumeWhitespace(src, at + 1);
    if (at + n >= src.length) return ['', n, UNEXPECTED_EOF];
    if (src[at + n] === close) return [dst + close, n + 1, undefined];
    for (let index = 0; ; index++) {
      currentRuntime().spend();
      if (this.options.multiline) dst += this.indentation(depth + 1);
      const [out, m, err] = this.reformatMember(src, at + n, depth + 1, isObject, index);
      n += m;
      if (err) return ['', n, err];
      dst += out;
      n += consumeWhitespace(src, at + n);
      if (at + n >= src.length) return ['', n, UNEXPECTED_EOF];
      const c = src[at + n];
      if (c === ',') {
        dst += ',';
        n++;
        continue;
      }
      if (c === close) {
        if (this.options.multiline) dst += this.indentation(depth);
        return [dst + close, n + 1, undefined];
      }
      const where = isObject ? "after object value (expecting ',' or '}')" : "after array value (expecting ',' or ']')";
      return ['', n, newInvalidCharacterError(src, at + n, where)];
    }
  }

  /** An element of an array, or a name and value of an object, at `src[at:]` after whitespace. */
  private reformatMember(
    src: string,
    at: number,
    depth: number,
    isObject: boolean,
    index: number
  ): [string, number, LibError | undefined] {
    let n = consumeWhitespace(src, at);
    if (at + n >= src.length) return ['', n, UNEXPECTED_EOF];
    let name = '';
    let quotedName = '';
    if (isObject) {
      const [out, m, err, quoted] = this.reformatName(src, at + n);
      if (err) return ['', n + m, err];
      [name, quotedName] = [out, quoted];
      n += m;
    }
    const [out, m, err] = this.reformatValue(src, at + n, depth);
    if (err) return ['', n + m, isObject ? wrapWithObjectName(err, quotedName) : wrapWithArrayIndex(err, index)];
    return [name + out, n + m, undefined];
  }

  /** An object member's name, the colon, and the whitespace up to its value, and the quoted name for errors. */
  private reformatName(src: string, pos: number): [string, number, LibError | undefined, string] {
    let m = consumeSimpleString(src, pos);
    let out = src.slice(pos, pos + m);
    if (m === 0) {
      let err: LibError | undefined;
      [out, m, err] = this.reformatString(src, pos);
      if (err) return ['', m, err, ''];
    }
    const quotedName = src.slice(pos, pos + m);
    let n = m + consumeWhitespace(src, pos + m);
    if (pos + n >= src.length) return ['', n, wrapWithObjectName(UNEXPECTED_EOF, quotedName), quotedName];
    if (src[pos + n] !== ':') {
      const err = newInvalidCharacterError(src, pos + n, "after object name (expecting ':')");
      return ['', n, wrapWithObjectName(err, quotedName), quotedName];
    }
    n++;
    n += consumeWhitespace(src, pos + n);
    if (pos + n >= src.length) return ['', n, wrapWithObjectName(UNEXPECTED_EOF, quotedName), quotedName];
    return [out + (this.options.multiline ? ': ' : ':'), n, undefined, quotedName];
  }

  /** `UnwriteOnlyObjectMemberName` for a name written from buffer position `start`: removes and returns it. */
  unwriteObjectMemberName(start: number): string {
    const name = unquote(this.buf.slice(start))[0];
    this.buf = this.buf.slice(0, start);
    this.tokens.last.length--;
    this.names[this.names.length - 1] = '';
    return name;
  }
}
