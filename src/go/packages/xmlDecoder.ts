// oxlint-disable unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import { mapKeyOf } from '../equality';
import { decodeRune, encodeRune, RUNE_ERROR } from '../literals';
import { currentRuntime, fn } from '../native';
import { quote } from '../quote';
import { nilPointerPanic } from '../runtimeErrors';
import { BASIC, ERROR_TYPE, missingMethod, type Type } from '../types';
import { GoMap, type GoStruct, Iface, Slice, type Value } from '../values';
import { BYTES_PACKAGE } from './bytes';
import { FMT_PACKAGE } from './fmt';
import { EOF, sameError } from './io';
import { equalFold } from './strings';
import { byteSlice, bytesOf, callFunction, callMethod, sliceValues, stringPanic } from './support';
import { NAME_FIRST, NAME_SECOND } from './xmlTables';
import { plainError, syntaxError, tokenFromGo, type XAttr, type XName, type XToken } from './xmlTypes';

export const XML_URL = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_PREFIX = 'xmlns';
const XML_PREFIX = 'xml';

/** Where the decoder reads bytes from: memory, an io.ByteReader, or an io.Reader through a bufio.Reader. */
export interface ByteSource {
  /** The next byte, or the reader's error. */
  readByte(): number | { err: Value };
  /** The io.Reader of the unread input, which a CharsetReader receives. */
  reader(): Value;
}

/** The source of an io.Reader: its ReadByte method when it has one, and a bufio.Reader otherwise. */
export function sourceOf(reader: Value): ByteSource {
  if (reader === undefined) nilPointerPanic();
  const byteReader = missingMethod((reader as Iface).type, BYTE_READER) === undefined;
  return byteReader ? new ByteReaderSource(reader) : new BufferedSource(reader);
}

const BYTE_READER = {
  kind: 'interface' as const,
  methods: [{ name: 'ReadByte', type: fn([], [BASIC.uint8, ERROR_TYPE]) }],
};

/** A `*bytes.Reader` of the bytes. */
function bytesReader(data: string): Value {
  const newReader = BYTES_PACKAGE.members.get('NewReader') as unknown as {
    direct: (args: Value[]) => Value;
    type: { results: Type[] };
  };
  return new Iface(newReader.type.results[0], newReader.direct([byteSlice(data)]));
}

/** `fmt.Errorf`. */
function errorf(format: string, args: Value[]): Value {
  const fmtErrorf = FMT_PACKAGE.members.get('Errorf') as unknown as { direct: (args: Value[]) => Value };
  return fmtErrorf.direct([format, new Slice(args, 0, args.length, args.length)]);
}

export class StringSource implements ByteSource {
  private pos = 0;

  constructor(private readonly data: string) {}

  readByte(): number | { err: Value } {
    if (this.pos >= this.data.length) return { err: EOF };
    return this.data.charCodeAt(this.pos++);
  }

  reader(): Value {
    return bytesReader(this.data.slice(this.pos));
  }
}

export class ByteReaderSource implements ByteSource {
  constructor(private readonly goReader: Value) {}

  readByte(): number | { err: Value } {
    const [byte, err] = callMethod(this.goReader, 'ReadByte') as [bigint, Value];
    if (err !== undefined) return { err };
    return Number(byte);
  }

  reader(): Value {
    return this.goReader;
  }
}

/** `bufio.NewReader(r)` read a byte at a time. */
export class BufferedSource implements ByteSource {
  private buf = '';
  private pos = 0;
  private err: Value;

  constructor(private readonly goReader: Value) {}

  /** The reader after the buffered bytes, or a reader of those bytes while some remain. */
  reader(): Value {
    return this.pos < this.buf.length ? bytesReader(this.buf.slice(this.pos)) : this.goReader;
  }

  readByte(): number | { err: Value } {
    while (this.pos === this.buf.length) {
      if (this.err !== undefined) {
        const err = this.err;
        this.err = undefined;
        return { err };
      }
      this.fill();
    }
    return this.buf.charCodeAt(this.pos++);
  }

  private fill(): void {
    this.buf = '';
    this.pos = 0;
    for (let i = 100; i > 0; i--) {
      currentRuntime().spend();
      const space = byteSlice('\0'.repeat(4096));
      const [count, err] = callMethod(this.goReader, 'Read', [space]) as [bigint, Value];
      const n = Number(count);
      this.buf = bytesOf(space).slice(0, n);
      if (err !== undefined) {
        this.err = err;
        return;
      }
      if (n > 0) return;
    }
    this.err = plainError('multiple Read calls return no data or error');
  }
}

interface StackEntry {
  kind: 'start' | 'ns' | 'eof';
  name: XName;
  ok: boolean;
}

interface DirectiveState {
  data: string;
  inquote: number;
  depth: number;
}

const DIRECTIVE_DONE = -1;
const DIRECTIVE_ERROR = -2;

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', apos: "'", quot: '"' };

/** The state of an `xml.Decoder`: Go's tokenizer, namespace translation, and element stack. */
export class XmlDecoder {
  private readonly stack: StackEntry[] = [];
  stackDepth = 0;
  private needClose = false;
  private toClose: XName = { space: '', local: '' };
  private nextToken: XToken | undefined;
  private nextByte = -1;
  private readonly ns = new Map<string, string>();
  err: Value;
  line = 1;
  lineStart = 0;
  offset = 0;
  inUnmarshalXML = false;
  /** The raw bytes read while an `,innerxml` field is being filled. */
  saved: string | undefined;
  private buf = '';

  constructor(
    /** The Go struct of the decoder, whose exported fields programs set. */
    readonly struct: GoStruct,
    private source: ByteSource | undefined,
    private readonly tokenReader?: Value
  ) {}

  private get strict(): boolean {
    return this.struct.fields[0] as boolean;
  }

  private get autoCloseNames(): string[] {
    return sliceValues(this.struct.fields[1]) as string[];
  }

  private entity(name: string): string | undefined {
    const map = this.struct.fields[2] as GoMap | undefined;
    if (!(map instanceof GoMap)) return undefined;
    return map.entries.get(mapKeyOf(BASIC.string)(name))?.value as string | undefined;
  }

  private get defaultSpace(): string {
    return this.struct.fields[4] as string;
  }

  private syntaxError(msg: string): Value {
    return syntaxError(msg, this.line);
  }

  /** `Token`: the next token with namespaces translated, or an error. */
  // code-gauge-allow functionCognitiveComplexity 30 -- A transcription of Go's Decoder.Token.
  token(): [XToken | undefined, Value] {
    currentRuntime().spend();
    let t: XToken | undefined;
    let err: Value;
    if (this.stack.length > 0 && this.stack.at(-1)?.kind === 'eof') return [undefined, EOF];
    if (this.nextToken) {
      t = this.nextToken;
      this.nextToken = undefined;
    } else {
      [t, err] = this.rawToken();
      if (t === undefined && err !== undefined) {
        if (sameError(err, EOF) && this.stack.length > 0 && this.stack.at(-1)?.kind !== 'eof') {
          err = this.syntaxError('unexpected EOF');
        }
        return [undefined, err];
      }
      err = undefined;
    }
    if (!this.strict) {
      const closed = this.autoClose(t as XToken);
      if (closed) {
        this.nextToken = t;
        t = closed;
      }
    }
    if (t?.kind === 'start') {
      for (const a of t.attr) {
        if (a.name.space === XMLNS_PREFIX) {
          this.pushNs(a.name.local, this.ns.get(a.name.local), this.ns.has(a.name.local));
          this.ns.set(a.name.local, a.value);
        }
        if (a.name.space === '' && a.name.local === XMLNS_PREFIX) {
          this.pushNs('', this.ns.get(''), this.ns.has(''));
          this.ns.set('', a.value);
        }
      }
      const name = { ...t.name };
      this.pushElement(name);
      t = {
        kind: 'start',
        name: this.translate({ ...t.name }, true),
        attr: t.attr.map((a) => ({ name: this.translate({ ...a.name }, false), value: a.value })),
      };
    } else if (t?.kind === 'end') {
      const end = { kind: 'end' as const, name: { ...t.name } };
      if (!this.popElement(end)) return [undefined, this.err];
      t = end;
    }
    return [t, err];
  }

  private translate(n: XName, isElementName: boolean): XName {
    if (n.space === XMLNS_PREFIX) return n;
    if (n.space === '' && !isElementName) return n;
    if (n.space === XML_PREFIX) n.space = XML_URL;
    else if (n.space === '' && n.local === XMLNS_PREFIX) return n;
    if (this.ns.has(n.space)) n.space = this.ns.get(n.space) as string;
    else if (n.space === '') n.space = this.defaultSpace;
    return n;
  }

  private push(entry: StackEntry): void {
    if (entry.kind === 'start') this.stackDepth++;
    this.stack.push(entry);
  }

  private pop(): StackEntry | undefined {
    const entry = this.stack.pop();
    if (entry?.kind === 'start') this.stackDepth--;
    return entry;
  }

  /** `pushEOF`: marks the end of the element being unmarshaled, below its namespace entries. */
  pushEOF(): void {
    let index = this.stack.length - 1;
    while (this.stack[index].kind !== 'start') index--;
    while (index > 0 && this.stack[index - 1].kind === 'ns') index--;
    this.stack.splice(index, 0, { kind: 'eof', name: { space: '', local: '' }, ok: false });
  }

  popEOF(): boolean {
    if (this.stack.at(-1)?.kind !== 'eof') return false;
    this.pop();
    return true;
  }

  private pushElement(name: XName): void {
    this.push({ kind: 'start', name, ok: false });
  }

  private pushNs(local: string, url: string | undefined, ok: boolean): void {
    this.push({ kind: 'ns', name: { space: url ?? '', local }, ok });
  }

  private popElement(t: { name: XName }): boolean {
    const s = this.pop();
    const { name } = t;
    if (s === undefined || s.kind !== 'start') {
      this.err = this.syntaxError(`unexpected end element </${name.local}>`);
      return false;
    }
    if (s.name.local !== name.local) {
      if (!this.strict) {
        this.needClose = true;
        this.toClose = t.name;
        t.name = s.name;
        return true;
      }
      this.err = this.syntaxError(`element <${s.name.local}> closed by </${name.local}>`);
      return false;
    }
    if (s.name.space !== name.space) {
      const ns = name.space === '' ? '""' : name.space;
      this.err = this.syntaxError(
        `element <${s.name.local}> in space ${s.name.space} closed by </${name.local}> in space ${ns}`
      );
      return false;
    }
    t.name = this.translate(t.name, true);
    while (this.stack.length > 0 && this.stack.at(-1)?.kind !== 'start' && this.stack.at(-1)?.kind !== 'eof') {
      const entry = this.pop() as StackEntry;
      if (entry.ok) this.ns.set(entry.name.local, entry.name.space);
      else this.ns.delete(entry.name.local);
    }
    return true;
  }

  private autoClose(t: XToken): XToken | undefined {
    const top = this.stack.at(-1);
    if (!top || top.kind !== 'start') return undefined;
    for (const s of this.autoCloseNames) {
      if (equalFold(s, top.name.local)) {
        if (t.kind !== 'end' || !equalFold(t.name.local, top.name.local)) return { kind: 'end', name: top.name };
        break;
      }
    }
    return undefined;
  }

  /** `RawToken`'s tokenizer. */
  /** `RawToken`'s tokenizer. */
  rawToken(): [XToken | undefined, Value] {
    if (this.tokenReader !== undefined) {
      const [token, err] = callMethod(this.tokenReader, 'Token') as [Value, Value];
      return [tokenFromGo(token), err];
    }
    if (this.err !== undefined) return [undefined, this.err];
    if (this.needClose) {
      this.needClose = false;
      return [{ kind: 'end', name: this.toClose }, undefined];
    }
    const b = this.getc();
    if (b < 0) return [undefined, this.err];
    let token: XToken | undefined;
    if (b === 0x3c) {
      token = this.markup();
    } else {
      this.ungetc(b);
      const data = this.text(-1, false);
      token = data === undefined ? undefined : { kind: 'chardata', data };
    }
    return token === undefined ? [undefined, this.err] : [token, undefined];
  }

  /** The token after `<`, or undefined with the error stored. */
  private markup(): XToken | undefined {
    const b = this.mustgetc();
    if (b < 0) return undefined;
    if (b === 0x2f) return this.endElement();
    if (b === 0x3f) return this.procInst();
    if (b === 0x21) return this.bang();
    this.ungetc(b);
    return this.startElement();
  }

  private endElement(): XToken | undefined {
    const name = this.nsname();
    if (!name) return this.failUnlessErr('expected element name after </');
    this.space();
    const b = this.mustgetc();
    if (b < 0) return undefined;
    if (b !== 0x3e) return this.fail(`invalid characters between </${name.local} and >`);
    return { kind: 'end', name };
  }

  /** Records a syntax error unless reading already stored one, and returns undefined. */
  private failUnlessErr(msg: string): undefined {
    this.err ??= this.syntaxError(msg);
    return undefined;
  }

  private startElement(): XToken | undefined {
    const name = this.nsname();
    if (!name) return this.failUnlessErr('expected element name after <');
    const attr: XAttr[] = [];
    for (;;) {
      this.space();
      let b = this.mustgetc();
      if (b < 0) return undefined;
      if (b === 0x2f) {
        if ((b = this.mustgetc()) < 0) return undefined;
        if (b !== 0x3e) return this.fail('expected /> in element');
        this.needClose = true;
        this.toClose = name;
        break;
      }
      if (b === 0x3e) break;
      this.ungetc(b);
      const a = this.attribute();
      if (a === undefined) return undefined;
      attr.push(a);
    }
    return { kind: 'start', name, attr };
  }

  private attribute(): XAttr | undefined {
    const name = this.nsname();
    if (!name) return this.failUnlessErr('expected attribute name in element');
    this.space();
    const b = this.mustgetc();
    if (b < 0) return undefined;
    if (b !== 0x3d) {
      if (this.strict) return this.fail('attribute name without = in element');
      this.ungetc(b);
      return { name, value: name.local };
    }
    this.space();
    const value = this.attrval();
    return value === undefined ? undefined : { name, value };
  }

  private procInst(): XToken | undefined {
    const target = this.name();
    if (target === undefined) return this.failUnlessErr('expected target name after <?');
    this.space();
    let data = '';
    let b0 = -1;
    for (;;) {
      const b = this.mustgetc();
      if (b < 0) return undefined;
      data += String.fromCharCode(b);
      if (b0 === 0x3f && b === 0x3e) break;
      b0 = b;
    }
    data = data.slice(0, -2);
    if (target === 'xml' && !this.checkDeclaration(data)) return undefined;
    return { kind: 'procinst', target, inst: data };
  }

  /** Checks the version and encoding of an `<?xml` declaration, switching to the CharsetReader's reader if needed. */
  private checkDeclaration(data: string): boolean {
    const ver = procInstParam('version', data);
    if (ver !== '' && ver !== '1.0') {
      this.err = plainError(`xml: unsupported version ${quote(ver)}; only version 1.0 is supported`);
      return false;
    }
    const enc = procInstParam('encoding', data);
    // oxlint-disable-next-line unicorn/text-encoding-identifier-case -- Go compares the declared name with "utf-8".
    if (enc === '' || equalFold(enc, 'utf-8')) return true;
    if (this.struct.fields[3] === undefined) {
      this.err = plainError(`xml: encoding ${quote(enc)} declared but Decoder.CharsetReader is nil`);
      return false;
    }
    const [reader, err] = callFunction(this.struct.fields[3], [enc, (this.source as ByteSource).reader()]) as [
      Value,
      Value,
    ];
    if (err !== undefined) {
      this.err = errorf('xml: opening charset %q: %w', [new Iface(BASIC.string, enc), err]);
      return false;
    }
    if (reader === undefined) stringPanic(`CharsetReader returned a nil Reader for charset ${enc}`);
    this.source = sourceOf(reader);
    return true;
  }

  /** The token after `<!`: a comment, a CDATA section, or a directive. */
  private bang(): XToken | undefined {
    const b = this.mustgetc();
    if (b < 0) return undefined;
    if (b === 0x2d) return this.comment();
    if (b === 0x5b) {
      for (let i = 0; i < 6; i++) {
        const c = this.mustgetc();
        if (c < 0) return undefined;
        if (c !== 'CDATA['.charCodeAt(i)) return this.fail('invalid <![ sequence');
      }
      const data = this.text(-1, true);
      return data === undefined ? undefined : { kind: 'chardata', data };
    }
    return this.directive(b);
  }

  private comment(): XToken | undefined {
    let b = this.mustgetc();
    if (b < 0) return undefined;
    if (b !== 0x2d) return this.fail('invalid sequence <!- not part of <!--');
    let data = '';
    let b0 = -1;
    let b1 = -1;
    for (;;) {
      if ((b = this.mustgetc()) < 0) return undefined;
      data += String.fromCharCode(b);
      if (b0 === 0x2d && b1 === 0x2d) {
        if (b !== 0x3e) return this.fail('invalid sequence "--" not allowed in comments');
        return { kind: 'comment', data: data.slice(0, -3) };
      }
      b0 = b1;
      b1 = b;
    }
  }

  /** A directive after `<!` and its first byte, skipping comments inside it as Go does. */
  private directive(first: number): XToken | undefined {
    const state: DirectiveState = { data: String.fromCharCode(first), inquote: 0, depth: 0 };
    for (;;) {
      let b = this.mustgetc();
      if (b < 0) return undefined;
      if (state.inquote === 0 && b === 0x3e && state.depth === 0) return { kind: 'directive', data: state.data };
      while (b >= 0) b = this.directiveByte(state, b);
      if (b === DIRECTIVE_ERROR) return undefined;
    }
  }

  /** Adds a byte to a directive: returns the next byte to handle, DIRECTIVE_DONE, or DIRECTIVE_ERROR. */
  private directiveByte(state: DirectiveState, b: number): number {
    state.data += String.fromCharCode(b);
    if (b === state.inquote) state.inquote = 0;
    else if (state.inquote !== 0) return DIRECTIVE_DONE;
    else if (b === 0x27 || b === 0x22) state.inquote = b;
    else if (b === 0x3e) state.depth--;
    else if (b === 0x3c) return this.directiveComment(state);
    return DIRECTIVE_DONE;
  }

  /** After `<` in a directive: skips a comment, or counts the nesting and returns the byte that ends `<!--`. */
  private directiveComment(state: DirectiveState): number {
    for (let i = 0; i < 3; i++) {
      const c = this.mustgetc();
      if (c < 0) return DIRECTIVE_ERROR;
      if (c !== '!--'.charCodeAt(i)) {
        state.data += '!--'.slice(0, i);
        state.depth++;
        return c;
      }
    }
    state.data = state.data.slice(0, -1);
    let b0 = -1;
    let b1 = -1;
    for (;;) {
      const b = this.mustgetc();
      if (b < 0) return DIRECTIVE_ERROR;
      if (b0 === 0x2d && b1 === 0x2d && b === 0x3e) break;
      b0 = b1;
      b1 = b;
    }
    state.data += ' ';
    return DIRECTIVE_DONE;
  }

  private attrval(): string | undefined {
    let b = this.mustgetc();
    if (b < 0) return undefined;
    if (b === 0x22 || b === 0x27) return this.text(b, false);
    if (this.strict) {
      this.err = this.syntaxError('unquoted or missing attribute value in element');
      return undefined;
    }
    this.ungetc(b);
    let data = '';
    for (;;) {
      if ((b = this.mustgetc()) < 0) return undefined;
      const c = String.fromCharCode(b);
      if (/[a-zA-Z0-9_:-]/.test(c)) data += c;
      else {
        this.ungetc(b);
        break;
      }
    }
    return data;
  }

  private space(): void {
    for (;;) {
      const b = this.getc();
      if (b < 0) return;
      if (b !== 0x20 && b !== 0x0d && b !== 0x0a && b !== 0x09) {
        this.ungetc(b);
        return;
      }
    }
  }

  /** `getc`: the next byte, or -1 with the error stored. */
  private getc(): number {
    if (this.err !== undefined) return -1;
    let b: number;
    if (this.nextByte >= 0) {
      b = this.nextByte;
      this.nextByte = -1;
    } else {
      const read = (this.source as ByteSource).readByte();
      if (typeof read !== 'number') {
        this.err = read.err;
        return -1;
      }
      b = read;
      if (this.saved !== undefined) this.saved += String.fromCharCode(b);
    }
    if (b === 0x0a) {
      this.line++;
      this.lineStart = this.offset + 1;
    }
    this.offset++;
    return b;
  }

  savedOffset(): number {
    let n = (this.saved as string).length;
    if (this.nextByte >= 0) n--;
    return n;
  }

  private mustgetc(): number {
    const b = this.getc();
    if (b < 0 && sameError(this.err, EOF)) this.err = this.syntaxError('unexpected EOF');
    return b;
  }

  private ungetc(b: number): void {
    if (b === 0x0a) this.line--;
    this.nextByte = b;
    this.offset--;
  }

  /** `text`: character data up to `<`, the closing quote, or the end of a CDATA section, with entities replaced. */
  private text(quoteChar: number, cdata: boolean): string | undefined {
    let b0 = 0;
    let b1 = 0;
    let trunc = 0;
    let buf = '';
    for (;;) {
      currentRuntime().spend();
      const b = this.getc();
      if (b < 0) {
        if (!cdata) break;
        if (sameError(this.err, EOF)) this.err = this.syntaxError('unexpected EOF in CDATA section');
        return undefined;
      }
      if (quoteChar < 0 && b0 === 0x5d && b1 === 0x5d && b === 0x3e) {
        if (!cdata) return this.fail('unescaped ]]> not in CDATA section');
        trunc = 2;
        break;
      }
      if (b === 0x3c && !cdata) {
        if (quoteChar >= 0) return this.fail('unescaped < inside quoted string');
        this.ungetc(0x3c);
        break;
      }
      if (quoteChar >= 0 && b === quoteChar) break;
      if (b === 0x26 && !cdata) {
        const entity = this.entityReference();
        if (entity === undefined) return undefined;
        buf += entity;
        b0 = 0;
        b1 = 0;
        continue;
      }
      if (b === 0x0d) buf += '\n';
      else if (!(b1 === 0x0d && b === 0x0a)) buf += String.fromCharCode(b);
      b0 = b1;
      b1 = b;
    }
    const data = buf.slice(0, buf.length - trunc);
    return this.checkCharacters(data) ? data : undefined;
  }

  /** Records a syntax error and returns undefined, for the parsers that report failure so. */
  private fail(msg: string): undefined {
    this.err = this.syntaxError(msg);
    return undefined;
  }

  /**
   * The text of the entity or character reference after `&`, its raw text when it is unknown and the decoder is not
   * strict, or undefined with the error stored.
   */
  private entityReference(): string | undefined {
    let raw = '&';
    let b = this.mustgetc();
    if (b < 0) return undefined;
    let text: string | undefined;
    if (b === 0x23) {
      const reference = this.characterReference();
      if (reference === undefined) return undefined;
      raw += reference.raw;
      text = reference.text;
    } else {
      this.ungetc(b);
      this.buf = '';
      if (!this.readName() && this.err !== undefined) return undefined;
      raw += this.buf;
      if ((b = this.mustgetc()) < 0) return undefined;
      if (b === 0x3b) {
        const name = raw.slice(1);
        raw += ';';
        if (isName(name)) text = ENTITIES[name] ?? this.entity(name);
      } else {
        this.ungetc(b);
      }
    }
    if (text !== undefined || !this.strict) return text ?? raw;
    return this.fail(`invalid character entity ${raw.endsWith(';') ? raw : `${raw} (no semicolon)`}`);
  }

  /** The raw text after `&` of a `#` reference, and the character it stands for when it is valid. */
  private characterReference(): { raw: string; text?: string } | undefined {
    let raw = '#';
    let b = this.mustgetc();
    if (b < 0) return undefined;
    let base = 10;
    if (b === 0x78) {
      base = 16;
      raw += 'x';
      if ((b = this.mustgetc()) < 0) return undefined;
    }
    let digits = '';
    while ((b >= 0x30 && b <= 0x39) || (base === 16 && /^[a-fA-F]$/.test(String.fromCharCode(b)))) {
      digits += String.fromCharCode(b);
      if ((b = this.mustgetc()) < 0) return undefined;
    }
    raw += digits;
    if (b !== 0x3b) {
      this.ungetc(b);
      return { raw };
    }
    const n = digits === '' ? -1n : BigInt(base === 16 ? `0x${digits}` : digits);
    if (n < 0n || n > 0x10_ff_ffn) return { raw: `${raw};` };
    return { raw: `${raw};`, text: encodeRune(n >= 0xd8_00n && n < 0xe0_00n ? RUNE_ERROR : Number(n)) };
  }

  /** Whether character data is valid UTF-8 of XML characters, storing the syntax error when it is not. */
  private checkCharacters(data: string): boolean {
    for (let i = 0; i < data.length; ) {
      const { rune, size } = decodeRune(data, i);
      if (rune === RUNE_ERROR && size === 1) return this.fail('invalid UTF-8') ?? false;
      i += size;
      if (!isInCharacterRange(rune)) {
        return this.fail(`illegal character code U+${rune.toString(16).toUpperCase().padStart(4, '0')}`) ?? false;
      }
    }
    return true;
  }

  private nsname(): XName | undefined {
    const s = this.name();
    if (s === undefined) return undefined;
    if (s.split(':').length - 1 > 1) return undefined;
    const colon = s.indexOf(':');
    if (colon <= 0 || colon === s.length - 1) return { space: '', local: s };
    return { space: s.slice(0, colon), local: s.slice(colon + 1) };
  }

  private name(): string | undefined {
    this.buf = '';
    if (!this.readName()) return undefined;
    if (!isName(this.buf)) {
      this.err = this.syntaxError(`invalid XML name: ${this.buf}`);
      return undefined;
    }
    return this.buf;
  }

  private readName(): boolean {
    let b = this.mustgetc();
    if (b < 0) return false;
    if (b < 0x80 && !isNameByte(b)) {
      this.ungetc(b);
      return false;
    }
    this.buf += String.fromCharCode(b);
    for (;;) {
      if ((b = this.mustgetc()) < 0) return false;
      if (b < 0x80 && !isNameByte(b)) {
        this.ungetc(b);
        break;
      }
      this.buf += String.fromCharCode(b);
    }
    return true;
  }

  inputPos(): [number, number] {
    return [this.line, this.offset - this.lineStart + 1];
  }
}

export function isInCharacterRange(r: number): boolean {
  return (
    r === 0x09 ||
    r === 0x0a ||
    r === 0x0d ||
    (r >= 0x20 && r <= 0xd7_ff) ||
    (r >= 0xe0_00 && r <= 0xff_fd) ||
    (r >= 0x1_00_00 && r <= 0x10_ff_ff)
  );
}

function isNameByte(c: number): boolean {
  return (
    (c >= 0x41 && c <= 0x5a) ||
    (c >= 0x61 && c <= 0x7a) ||
    (c >= 0x30 && c <= 0x39) ||
    c === 0x5f ||
    c === 0x3a ||
    c === 0x2e ||
    c === 0x2d
  );
}

function inTable(table: readonly (readonly [number, number, number])[], r: number): boolean {
  return table.some(([lo, hi, stride]) => r >= lo && r <= hi && (r - lo) % stride === 0);
}

/** `isName`: whether the bytes are an XML name. */
export function isName(s: string): boolean {
  if (s.length === 0) return false;
  for (let i = 0; i < s.length;) {
    const { rune, size } = decodeRune(s, i);
    if (rune === RUNE_ERROR && size === 1) return false;
    if (!inTable(NAME_FIRST, rune) && (i === 0 || !inTable(NAME_SECOND, rune))) return false;
    i += size;
  }
  return true;
}

/** `procInst`: the value of a parameter of an `<?xml` instruction. */
function procInstParam(param: string, s: string): string {
  const key = `${param}=`;
  let i = 0;
  let sep = '';
  while (i < s.length) {
    const sub = s.slice(i);
    const k = sub.indexOf(key);
    if (k === -1 || key.length + k >= sub.length) return '';
    i += key.length + k + 1;
    const c = sub[key.length + k];
    if (c === "'" || c === '"') {
      sep = c;
      break;
    }
  }
  if (sep === '') return '';
  const j = s.slice(i).indexOf(sep);
  if (j === -1) return '';
  return s.slice(i, i + j);
}
