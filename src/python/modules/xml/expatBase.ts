import {
  charRefNumber,
  type ContentModel,
  Dtd,
  type Entity,
  normalizeLines,
  PREDEFINED_ENTITIES,
  XML_ERROR,
  XmlError,
} from './expatDocument';
import type { ExpatHandlers } from './expatHandlers';
import { ExpatInput, type InputEncoding } from './expatInput';
import { PrologState } from './expatRoles';
import { BT, TOK, Tokenizer } from './expatTokenizer';

// A transcription of expat's xmlparse.c over the tokenizer and the prolog state machine, in three layers: this one's
// state, positions, and attributes; expatProlog.ts's prolog; and expatParser.ts's content, CDATA sections, epilog, and
// buffering.

export type Processor = 'prolog' | 'content' | 'cdata' | 'epilog' | 'error' | 'finished';

export interface Tag {
  rawName: string;
  name: string;
  bindings: Binding[];
}

/** What the tokens of one attribute value share as `appendAttributeValue` adds them. */
interface AttributeValue {
  tz: Tokenizer;
  isCdata: boolean;
  pool: number[];
  internal: boolean;
  inProlog: boolean;
}

export interface Binding {
  prefix: string | undefined;
  uri: string;
  previous: Binding | undefined;
}

interface RawAttribute {
  name: string;
  nameStart: number;
  valueStart: number;
  valueEnd: number;
}

const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_NAMESPACE = 'http://www.w3.org/2000/xmlns/';

/** An unknown encoding's byte table, which the binding finds for an encoding name, as pyexpat's handler does. */
export type UnknownEncodingHandler = (name: string) => number[];

export abstract class ExpatBase {
  handlers: ExpatHandlers = {};
  /** Whether internal entities in content expand when a default handler is set, as `XML_SetDefaultHandlerExpand`. */
  defaultExpandInternalEntities = true;
  base: string | undefined;
  returnTriplets = false;
  paramEntityParsing = 0;
  reparseDeferral = true;
  unknownEncoding: UnknownEncodingHandler | undefined;

  errorCode = 0;
  errorLine = 1;
  errorColumn = 0;
  errorByte = -1;
  eventPtr: number | undefined;
  eventEndPtr: number | undefined;

  protected readonly input = new ExpatInput();
  protected readonly tokenizer: Tokenizer;
  protected readonly separator: string | undefined;
  protected readonly dtd = new Dtd();
  protected readonly prologState = new PrologState();
  protected readonly prefixes = new Map<string, Binding | undefined>();
  protected processor: Processor = 'prolog';
  /** Whether the encoding is the one the parser was given, which an XML declaration does not change. */
  protected encodingFixed = false;
  protected foreignDTD = false;
  protected pendingEncoding: string | undefined;
  protected started = false;
  protected finalBuffer = false;
  protected bufferPtr = 0;
  protected positionPtr = 0;
  protected line = 0;
  protected column = 0;
  protected readonly tags: Tag[] = [];
  protected readonly buffer = { size: 0, start: 0, end: 0, lastRequest: 0, partialBefore: 0 };

  // The declaration being parsed in the DTD.
  protected doctypeName: string | undefined;
  protected doctypeSysid: string | undefined;
  protected doctypePubid: string | undefined;
  /** The system and public identifiers of the external DTD subset, if the DOCTYPE names one. */
  protected externalSubset: [string, string | undefined] | undefined;
  protected externalPublicId: string | undefined;
  protected declEntity: Entity | undefined;
  protected declNotationName: string | undefined;
  protected declNotationPublicId: string | undefined;
  protected declElementType = '';
  protected declAttribute = '';
  protected declAttributeIsCdata = false;
  protected declAttributeType: string | undefined;
  protected elementDecl: { name: string; groups: ContentModel[] } | undefined;
  protected readonly groupConnector: number[] = [];
  /** The tokenizer of the prolog's text: the document's, or a parameter entity's while its text is parsed. */
  protected prologTz: Tokenizer;
  /** Whether the prolog's text is a parameter entity's, whose events the reference's position stands for. */
  protected prologInternal = false;
  /** Where a CDATA section that needs more input resumes. */
  protected cdataResume = 0;
  protected openParamEntities = 0;

  constructor(separator: string | undefined, encoding: InputEncoding | undefined) {
    this.separator = separator;
    if (encoding !== undefined) this.setProtocolEncoding(encoding, '');
    this.tokenizer = new Tokenizer(this.input.cs, separator !== undefined);
    this.prologTz = this.tokenizer;
    if (separator !== undefined)
      this.prefixes.set('xml', { prefix: 'xml', uri: XML_NAMESPACE + separator, previous: undefined });
  }

  get namespaces(): boolean {
    return this.separator !== undefined;
  }

  /** `XML_SetEncoding`, for an encoding expat decodes itself or else one the unknown-encoding handler maps. */
  setProtocolEncoding(encoding: InputEncoding | undefined, name: string): void {
    this.encodingFixed = true;
    if (encoding !== undefined) this.input.encoding = encoding;
    else if (name.toLowerCase().replaceAll('_', '-') !== 'utf-16') this.pendingEncoding = name;
  }

  /** The line (from 1) and column (from 0) of a position, which expat counts in characters. */
  position(ptr: number | undefined): [number, number] {
    if (ptr !== undefined && ptr >= this.positionPtr) this.updatePosition(ptr);
    return [this.line + 1, this.column];
  }

  /** `XML_GetCurrentByteIndex`. */
  byteIndex(): number {
    return this.eventPtr === undefined ? -1 : (this.input.offsets[this.eventPtr] as number);
  }

  protected updatePosition(to: number): void {
    const cs = this.input.cs;
    let ptr = this.positionPtr;
    while (ptr < to) {
      const c = cs[ptr];
      ptr++;
      if (c === 0x0a) {
        this.line++;
        this.column = 0;
      } else if (c === 0x0d) {
        this.line++;
        this.column = 0;
        if (ptr < to && cs[ptr] === 0x0a) ptr++;
      } else {
        this.column++;
      }
    }
    this.positionPtr = Math.max(this.positionPtr, to);
  }

  protected text(tz: Tokenizer, start: number, end: number): string {
    let result = '';
    for (let index = start; index < end; index++) result += String.fromCodePoint(tz.cs[index] as number);
    return result;
  }

  protected reportDefault(tz: Tokenizer, start: number, end: number): void {
    this.handlers.default?.(this.text(tz, start, end));
  }

  // Prolog ----------------------------------------------------------------------------------------------------------

  /** `XmlNameLength`: the name at `start`, whose characters include colons. */
  protected nameAt(tz: Tokenizer, start: number): string {
    let end = start;
    for (;;) {
      const type = tz.type(end);
      if (!tz.isNameChar(type) && type !== BT.COLON) break;
      end++;
    }
    return this.text(tz, start, end);
  }

  // Attributes ------------------------------------------------------------------------------------------------------

  /** `XmlGetAttributes`: the names and the raw values of a start tag's attributes. */
  protected getAtts(tz: Tokenizer, s: number): RawAttribute[] {
    const attributes: RawAttribute[] = [];
    let ptr = this.nameEnd(tz, s + 1);
    for (;;) {
      while (tz.isSpace(tz.type(ptr))) ptr++;
      const type = tz.type(ptr);
      if (type === BT.GT || type === BT.SOL) return attributes;
      const nameStart = ptr;
      ptr = this.nameEnd(tz, ptr);
      const name = this.text(tz, nameStart, ptr);
      while (tz.cs[ptr] !== 0x22 && tz.cs[ptr] !== 0x27) ptr++;
      const quote = tz.cs[ptr];
      const valueStart = ptr + 1;
      ptr = valueStart;
      while (tz.cs[ptr] !== quote) ptr++;
      attributes.push({ name, nameStart, valueStart, valueEnd: ptr });
      ptr++;
    }
  }

  protected nameEnd(tz: Tokenizer, start: number): number {
    let end = start;
    while (tz.isNameChar(tz.type(end)) || tz.type(end) === BT.COLON) end++;
    return end;
  }

  /**
   * `storeAtts`: the attributes of a start tag as names and values, then the defaults its element type declares, with
   * namespaces applied; and the number of the specified ones' entries.
   */
  // code-gauge-allow functionCognitiveComplexity 21 -- Transcribes expat's C code case by case, as its order of checks decides the errors and their positions.
  protected storeAtts(tz: Tokenizer, s: number, tag: Tag, internal: boolean): [string[], number] {
    const entries: { name: string; value: string; prefixed: boolean }[] = [];
    const seen = new Set<string>();
    for (const attribute of this.getAtts(tz, s)) {
      if (seen.has(attribute.name)) {
        if (!internal) this.eventPtr = attribute.nameStart;
        throw new XmlError(XML_ERROR.DUPLICATE_ATTRIBUTE);
      }
      seen.add(attribute.name);
      const isCdata = !this.dtd.isTokenized(tag.rawName, attribute.name);
      const value = this.storeAttributeValue(tz, isCdata, attribute.valueStart, attribute.valueEnd, internal, false);
      if (this.namespaces && isXmlns(attribute.name)) this.addBinding(xmlnsPrefix(attribute.name), value, tag);
      else entries.push({ name: attribute.name, value, prefixed: this.namespaces && attribute.name.includes(':') });
    }
    const specified = entries.length * 2;
    for (const declared of this.dtd.elementTypes.get(tag.rawName)?.defaults ?? []) {
      if (seen.has(declared.name) || declared.value === undefined) continue;
      seen.add(declared.name);
      if (this.namespaces && isXmlns(declared.name)) this.addBinding(xmlnsPrefix(declared.name), declared.value, tag);
      else
        entries.push({
          name: declared.name,
          value: declared.value,
          prefixed: this.namespaces && declared.name.includes(':'),
        });
    }
    if (this.namespaces) this.expandNames(entries, tag);
    return [entries.flatMap((entry) => [entry.name, entry.value]), specified];
  }

  protected expandNames(entries: { name: string; value: string; prefixed: boolean }[], tag: Tag): void {
    const expanded = new Set<string>();
    for (const entry of entries) {
      if (!entry.prefixed) continue;
      entry.name = this.expandName(entry.name, false);
      if (expanded.has(entry.name)) throw new XmlError(XML_ERROR.DUPLICATE_ATTRIBUTE);
      expanded.add(entry.name);
    }
    tag.name = this.expandName(tag.rawName, true);
  }

  /** A qualified name as `URI separator local`, with the prefix after another separator when triplets are returned. */
  protected expandName(name: string, isElement: boolean): string {
    const colon = name.indexOf(':');
    if (colon === -1) {
      const binding = isElement ? this.prefixes.get('') : undefined;
      return binding ? binding.uri + name : name;
    }
    const prefix = name.slice(0, colon);
    const binding = this.prefixes.get(prefix);
    if (!binding) throw new XmlError(XML_ERROR.UNBOUND_PREFIX);
    const local = name.slice(colon + 1);
    return this.returnTriplets ? `${binding.uri}${local}${this.separator}${prefix}` : binding.uri + local;
  }

  /** `addBinding`: binds a prefix, or the default namespace for no prefix, for the element's scope. */
  protected addBinding(prefix: string | undefined, uri: string, tag: Tag): void {
    if (uri === '' && prefix !== undefined) throw new XmlError(XML_ERROR.UNDECLARING_PREFIX);
    if (prefix === 'xmlns') throw new XmlError(XML_ERROR.RESERVED_PREFIX_XMLNS);
    const mustBeXml = prefix === 'xml';
    const isXml = uri === XML_NAMESPACE;
    if (mustBeXml !== isXml) {
      throw new XmlError(mustBeXml ? XML_ERROR.RESERVED_PREFIX_XML : XML_ERROR.RESERVED_NAMESPACE_URI);
    }
    if (uri === XMLNS_NAMESPACE) throw new XmlError(XML_ERROR.RESERVED_NAMESPACE_URI);
    const key = prefix ?? '';
    const binding: Binding = { prefix, uri: uri + (this.separator ?? ''), previous: this.prefixes.get(key) };
    this.prefixes.set(key, uri === '' ? undefined : binding);
    tag.bindings.push(binding);
    this.handlers.startNamespaceDecl?.(prefix, uri === '' ? undefined : uri);
  }

  /** `storeAttributeValue`: a value with its references replaced and, unless it is CDATA, its spaces normalized. */
  protected storeAttributeValue(
    tz: Tokenizer,
    isCdata: boolean,
    start: number,
    end: number,
    internal: boolean,
    inProlog: boolean
  ): string {
    const pool: number[] = [];
    this.appendAttributeValue(tz, isCdata, start, end, pool, internal, inProlog);
    if (!isCdata && pool.at(-1) === 0x20) pool.pop();
    return String.fromCodePoint(...pool);
  }

  // code-gauge-allow functionParameterCount 7 -- Transcribes expat's C code case by case, as its order of checks decides the errors and their positions.
  protected appendAttributeValue(
    tz: Tokenizer,
    isCdata: boolean,
    ptr: number,
    end: number,
    pool: number[],
    internal: boolean,
    inProlog: boolean
  ): void {
    const value: AttributeValue = { tz, isCdata, pool, internal, inProlog };
    for (;;) {
      const [tok, next] = tz.attributeValueTok(ptr, end);
      if (tok === TOK.NONE) return;
      this.attributeValueToken(value, tok, ptr, next);
      ptr = tok === TOK.TRAILING_CR ? ptr + 1 : next;
    }
  }

  /** One token of an attribute's value, added to its pool as `appendAttributeValue` adds it. */
  // code-gauge-allow functionCognitiveComplexity 23 -- Transcribes expat's C code case by case, as its order of checks decides the errors and their positions.
  // code-gauge-allow functionNcss 34 -- Transcribes expat's C code case by case, as its order of checks decides the errors and their positions.
  private attributeValueToken(value: AttributeValue, tok: number, ptr: number, next: number): void {
    const { tz, isCdata, pool, internal } = value;
    switch (tok) {
      case TOK.INVALID:
      case TOK.PARTIAL: {
        if (!internal) this.eventPtr = tok === TOK.INVALID ? next : ptr;
        throw new XmlError(XML_ERROR.INVALID_TOKEN);
      }
      case TOK.CHAR_REF: {
        const code = charRefNumber(tz.cs, ptr, next);
        if (code < 0) {
          if (!internal) this.eventPtr = ptr;
          throw new XmlError(XML_ERROR.BAD_CHAR_REF);
        }
        if (isCdata || code !== 0x20 || (pool.length > 0 && pool.at(-1) !== 0x20)) pool.push(code);
        return;
      }
      case TOK.DATA_CHARS: {
        for (let index = ptr; index < next; index++) pool.push(tz.cs[index] as number);
        return;
      }
      case TOK.TRAILING_CR:
      case TOK.ATTRIBUTE_VALUE_S:
      case TOK.DATA_NEWLINE: {
        if (isCdata || (pool.length > 0 && pool.at(-1) !== 0x20)) pool.push(0x20);
        return;
      }
      case TOK.ENTITY_REF: {
        this.attributeEntity(value, ptr, next);
        return;
      }
      default: {
        if (!internal) this.eventPtr = ptr;
        throw new XmlError(XML_ERROR.UNEXPECTED_STATE);
      }
    }
  }

  // code-gauge-allow functionCognitiveComplexity 19 -- Transcribes expat's C code case by case, as its order of checks decides the errors and their positions.
  // code-gauge-allow functionNcss 35 -- Transcribes expat's C code case by case, as its order of checks decides the errors and their positions.
  protected attributeEntity(value: AttributeValue, ptr: number, next: number): void {
    const { tz, isCdata, pool, internal, inProlog } = value;
    const name = this.text(tz, ptr + 1, next - 1);
    const predefined = PREDEFINED_ENTITIES[name];
    if (predefined !== undefined) {
      pool.push(predefined);
      return;
    }
    const dtd = this.dtd;
    const entity = dtd.generalEntities.get(name);
    const checkEntityDecl = inProlog
      ? dtd.standalone || !dtd.hasParamEntityRefs
      : !dtd.hasParamEntityRefs || dtd.standalone;
    if (checkEntityDecl) {
      if (!entity) throw new XmlError(XML_ERROR.UNDEFINED_ENTITY);
      if (!entity.isInternal) throw new XmlError(XML_ERROR.ENTITY_DECLARED_IN_PE);
    } else if (!entity) {
      return;
    }
    if (entity.open) {
      if (!internal) this.eventPtr = ptr;
      throw new XmlError(XML_ERROR.RECURSIVE_ENTITY_REF);
    }
    if (entity.notation !== undefined) {
      if (!internal) this.eventPtr = ptr;
      throw new XmlError(XML_ERROR.BINARY_ENTITY_REF);
    }
    if (!entity.text) {
      if (!internal) this.eventPtr = ptr;
      throw new XmlError(XML_ERROR.ATTRIBUTE_EXTERNAL_ENTITY_REF);
    }
    entity.open = true;
    try {
      const text = new Tokenizer(entity.text, this.namespaces);
      this.appendAttributeValue(text, isCdata, 0, entity.text.length, pool, true, inProlog);
    } finally {
      entity.open = false;
    }
  }

  // Comments, processing instructions, CDATA sections, and the epilog ------------------------------------------------

  protected reportComment(tz: Tokenizer, s: number, next: number): void {
    if (!this.handlers.comment) {
      this.reportDefault(tz, s, next);
      return;
    }
    this.handlers.comment(normalizeLines(this.text(tz, s + 4, next - 3)));
  }

  protected reportProcessingInstruction(tz: Tokenizer, s: number, next: number): void {
    if (!this.handlers.processingInstruction) {
      this.reportDefault(tz, s, next);
      return;
    }
    const targetEnd = this.nameEnd(tz, s + 2);
    let dataStart = targetEnd;
    while (dataStart < next - 2 && tz.isSpace(tz.type(dataStart))) dataStart++;
    const target = this.text(tz, s + 2, targetEnd);
    this.handlers.processingInstruction(target, normalizeLines(this.text(tz, dataStart, next - 2)));
  }

  protected freeBindings(tag: Tag): void {
    for (const binding of tag.bindings.toReversed()) {
      this.handlers.endNamespaceDecl?.(binding.prefix);
      this.prefixes.set(binding.prefix ?? '', binding.previous);
    }
  }
}

function isXmlns(name: string): boolean {
  return name === 'xmlns' || name.startsWith('xmlns:');
}

function xmlnsPrefix(name: string): string | undefined {
  return name === 'xmlns' ? undefined : name.slice(6);
}
