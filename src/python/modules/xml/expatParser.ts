import {
  badPublicIdChar,
  charRefNumber,
  type ContentModel,
  CQUANT,
  CTYPE,
  Dtd,
  type Entity,
  normalizeLines,
  normalizePublicId,
  PREDEFINED_ENTITIES,
  XML_ERROR,
  XmlError,
} from './expatDocument';
import type { ExpatHandlers } from './expatHandlers';
import { ExpatInput, type InputEncoding, knownEncoding } from './expatInput';
import { PrologState, type Role } from './expatRoles';
import { BT, TOK, Tokenizer } from './expatTokenizer';
import { parseXmlDecl } from './expatXmlDecl';

// A transcription of expat's xmlparse.c over the tokenizer and the prolog state machine: the processors of the prolog,
// the content, CDATA sections, and the epilog, with entities, default attributes, namespaces, the positions of events,
// and the buffering that decides when a partial token is parsed again.

type Processor = 'prolog' | 'content' | 'cdata' | 'epilog' | 'error' | 'finished';

interface Tag {
  rawName: string;
  name: string;
  bindings: Binding[];
}

interface Binding {
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
const CONTEXT_BYTES = 1024;
const INIT_BUFFER_SIZE = 1024;

/** An unknown encoding's byte table, which the binding finds for an encoding name, as pyexpat's handler does. */
export type UnknownEncodingHandler = (name: string) => number[];

export class ExpatParser {
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

  private readonly input = new ExpatInput();
  private readonly tokenizer: Tokenizer;
  private readonly separator: string | undefined;
  private readonly dtd = new Dtd();
  private readonly prologState = new PrologState();
  private readonly prefixes = new Map<string, Binding | undefined>();
  private processor: Processor = 'prolog';
  /** Whether the encoding is the one the parser was given, which an XML declaration does not change. */
  private encodingFixed = false;
  private foreignDTD = false;
  private pendingEncoding: string | undefined;
  private started = false;
  private finalBuffer = false;
  private bufferPtr = 0;
  private positionPtr = 0;
  private line = 0;
  private column = 0;
  private readonly tags: Tag[] = [];
  private readonly buffer = { size: 0, start: 0, end: 0, lastRequest: 0, partialBefore: 0 };

  // The declaration being parsed in the DTD.
  private doctypeName: string | undefined;
  private doctypeSysid: string | undefined;
  private doctypePubid: string | undefined;
  /** The system and public identifiers of the external DTD subset, if the DOCTYPE names one. */
  private externalSubset: [string, string | undefined] | undefined;
  private externalPublicId: string | undefined;
  private declEntity: Entity | undefined;
  private declNotationName: string | undefined;
  private declNotationPublicId: string | undefined;
  private declElementType = '';
  private declAttribute = '';
  private declAttributeIsCdata = false;
  private declAttributeType: string | undefined;
  private elementDecl: { name: string; groups: ContentModel[] } | undefined;
  private readonly groupConnector: number[] = [];
  /** The tokenizer of the prolog's text: the document's, or a parameter entity's while its text is parsed. */
  private prologTz: Tokenizer;
  /** Whether the prolog's text is a parameter entity's, whose events the reference's position stands for. */
  private prologInternal = false;
  /** Where a CDATA section that needs more input resumes. */
  private cdataResume = 0;
  private openParamEntities = 0;

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

  /** `XML_Parse` of text, which pyexpat passes as UTF-8 and so fixes the encoding. */
  parseText(text: string, isFinal: boolean): void {
    if (!this.started) {
      this.encodingFixed = true;
      this.pendingEncoding = undefined;
      this.input.encoding = 'utf8';
    }
    const before = this.input.byteLength;
    this.input.addText(text);
    this.parse(this.input.byteLength - before, isFinal);
  }

  /** `XML_Parse` of bytes, or `XML_ParseBuffer` after `XML_GetBuffer(request)`. */
  parseBytes(bytes: ArrayLike<number>, isFinal: boolean, request?: number): void {
    if (!this.started && this.pendingEncoding !== undefined) {
      this.input.encoding = { table: this.unknownEncoding?.(this.pendingEncoding) ?? [] };
      this.pendingEncoding = undefined;
    }
    this.input.addBytes(bytes, isFinal);
    this.parse(bytes.length, isFinal, request);
  }

  /** `XML_SetEncoding`, for an encoding expat decodes itself or else one the unknown-encoding handler maps. */
  setProtocolEncoding(encoding: InputEncoding | undefined, name: string): void {
    this.encodingFixed = true;
    if (encoding !== undefined) this.input.encoding = encoding;
    else if (name.toLowerCase().replaceAll('_', '-') !== 'utf-16') this.pendingEncoding = name;
  }

  /** `XML_UseForeignDTD`, which a parse that has started refuses with an error code. */
  useForeignDTD(flag: boolean): number {
    if (this.started) return XML_ERROR.CANT_CHANGE_FEATURE_ONCE_PARSING;
    this.foreignDTD = flag;
    return 0;
  }

  /** `XML_GetInputContext`: the bytes from the current event to the end of the input received. */
  inputContext(): Uint8Array {
    return this.input.rawFrom(this.input.offsets[this.eventPtr ?? this.bufferPtr] as number);
  }

  // code-gauge-allow functionCognitiveComplexity 20 -- Follows XML_Parse, XML_ParseBuffer, and callProcessor.
  private parse(length: number, isFinal: boolean, request = length): void {
    if (this.processor === 'finished') this.fail(XML_ERROR.FINISHED);
    this.started = true;
    if (length === 0 && !isFinal) return;
    if (length > 0 || request !== length) this.getBuffer(request);
    // XML_ParseBuffer counts positions again from the start of the unparsed input.
    this.positionPtr = this.bufferPtr;
    if (this.processor === 'error') this.fail(this.errorCode);
    this.buffer.end += length;
    this.finalBuffer = isFinal;
    const start = this.bufferPtr;
    const end = this.input.cs.length;
    const haveBytes = this.input.byteLength - (this.input.offsets[start] as number);
    if (this.reparseDeferral && !isFinal && length > 0) {
      // Heuristic of expat's callProcessor: a partial token is parsed again only once the input has grown enough.
      const available = Math.max(0, this.buffer.start - CONTEXT_BYTES) + (this.buffer.size - this.buffer.end);
      const enough = haveBytes >= 2 * this.buffer.partialBefore || this.buffer.lastRequest > available;
      if (!enough) return;
    }
    let next: number;
    try {
      next = this.runProcessor(start, end);
    } catch (error) {
      this.recordError(error);
      throw error;
    }
    const consumed = this.input.offsets[next] - this.input.offsets[start];
    this.buffer.partialBefore = next === start ? haveBytes : 0;
    this.buffer.start += consumed;
    this.bufferPtr = next;
    this.updatePosition(next);
    if (isFinal) this.processor = 'finished';
  }

  /** `XML_GetBuffer`: how expat makes room for `length` more bytes, keeping some context before the unparsed ones. */
  private getBuffer(length: number): void {
    const buffer = this.buffer;
    buffer.lastRequest = length;
    if (length <= buffer.size - buffer.end) return;
    const keep = Math.min(buffer.start, CONTEXT_BYTES);
    const needed = length + (buffer.end - buffer.start) + keep;
    if (buffer.size > 0 && needed <= buffer.size) {
      if (keep < buffer.start) {
        const offset = buffer.start - keep;
        buffer.end -= offset;
        buffer.start -= offset;
      }
      this.eventPtr = undefined;
      this.eventEndPtr = undefined;
      return;
    }
    let size = buffer.size === 0 ? INIT_BUFFER_SIZE : buffer.size;
    do size *= 2;
    while (size < needed);
    const hadData = buffer.size > 0;
    buffer.size = size;
    this.eventPtr = undefined;
    this.eventEndPtr = undefined;
    buffer.end = hadData ? buffer.end - buffer.start + keep : 0;
    buffer.start = hadData ? keep : 0;
  }

  private recordError(error: unknown): void {
    if (error instanceof XmlError) {
      this.errorCode = error.code;
      const [line, column] = this.position(this.eventPtr);
      this.errorLine = line;
      this.errorColumn = column;
      this.errorByte = this.byteIndex();
      this.processor = 'error';
    } else {
      // A handler raised an exception, which stops the parser as `XML_StopParser` does.
      this.errorCode = XML_ERROR.ABORTED;
      this.processor = 'finished';
      this.eventPtr = this.eventEndPtr;
    }
  }

  private fail(code: number): never {
    this.errorCode = code;
    const [line, column] = this.position(this.eventPtr);
    this.errorLine = line;
    this.errorColumn = column;
    throw new XmlError(code);
  }

  private runProcessor(start: number, end: number): number {
    switch (this.processor) {
      case 'prolog': {
        return this.prologProcessor(start, end);
      }
      case 'content': {
        return this.doContent(this.tokenizer, 0, start, end, !this.finalBuffer, false);
      }
      case 'cdata': {
        return this.cdataSectionProcessor(start, end);
      }
      default: {
        return this.epilogProcessor(start, end);
      }
    }
  }

  // Positions -------------------------------------------------------------------------------------------------------

  /** The line (from 1) and column (from 0) of a position, which expat counts in characters. */
  position(ptr: number | undefined): [number, number] {
    if (ptr !== undefined && ptr >= this.positionPtr) this.updatePosition(ptr);
    return [this.line + 1, this.column];
  }

  /** `XML_GetCurrentByteIndex`. */
  byteIndex(): number {
    return this.eventPtr === undefined ? -1 : (this.input.offsets[this.eventPtr] as number);
  }

  private updatePosition(to: number): void {
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

  private text(tz: Tokenizer, start: number, end: number): string {
    let result = '';
    for (let index = start; index < end; index++) result += String.fromCodePoint(tz.cs[index] as number);
    return result;
  }

  private reportDefault(tz: Tokenizer, start: number, end: number): void {
    this.handlers.default?.(this.text(tz, start, end));
  }

  // Prolog ----------------------------------------------------------------------------------------------------------

  private prologProcessor(start: number, end: number): number {
    const [tok, next] =
      start === 0 && this.input.cs[0] === 0xfe_ff ? [TOK.BOM, 1] : this.tokenizer.prologTok(start, end);
    return this.doProlog(start, end, tok, next);
  }

  // code-gauge-allow functionCognitiveComplexity 22 -- Follows doProlog of xmlparse.c.
  private doProlog(s: number, end: number, tok: number, next: number, inEntity = false): number {
    const haveMore = !this.finalBuffer && !inEntity;
    const tz = this.prologTz;
    for (;;) {
      if (!inEntity) {
        this.eventPtr = s;
        this.eventEndPtr = next;
      }
      if (tok <= 0) {
        if (haveMore && tok !== TOK.INVALID) return s;
        if (tok === TOK.INVALID) {
          this.prologEvent(next);
          throw new XmlError(XML_ERROR.INVALID_TOKEN);
        }
        if (tok === TOK.NONE && inEntity) {
          if (this.prologState.role(TOK.NONE, '') === 'ERROR') throw new XmlError(XML_ERROR.INCOMPLETE_PE);
          return s;
        }
        if (tok === TOK.PARTIAL) throw new XmlError(XML_ERROR.UNCLOSED_TOKEN);
        if (tok === TOK.PARTIAL_CHAR) throw new XmlError(XML_ERROR.PARTIAL_CHAR);
        if (tok === TOK.NONE) throw new XmlError(XML_ERROR.NO_ELEMENTS);
        if (tok !== -TOK.PROLOG_S) next = end;
        tok = -tok;
      }
      const role = this.prologState.role(tok, this.text(tz, s, next));
      if (role === 'INSTANCE_START') {
        if (this.foreignDTD) this.dtd.hasParamEntityRefs = true;
        this.processor = 'content';
        return this.doContent(this.tokenizer, 0, s, end, haveMore, false);
      }
      const handleDefault = this.prologRole(role, tok, s, next);
      if (handleDefault && this.handlers.default) this.reportDefault(tz, s, next);
      if (role === 'XML_DECL') end = this.input.cs.length;
      s = next;
      [tok, next] = tz.prologTok(s, end);
    }
  }

  /** The actions of a role in the prolog, telling whether the token goes to the default handler. */
  // code-gauge-allow functionCognitiveComplexity 30 -- Dispatches the roles of doProlog of xmlparse.c.
  // code-gauge-allow functionNcss 60 -- Dispatches the roles of doProlog of xmlparse.c.
  private prologRole(role: Role, tok: number, s: number, next: number): boolean {
    switch (role) {
      case 'XML_DECL': {
        this.processXmlDecl(s, next);
        return false;
      }
      case 'ERROR': {
        if (tok === TOK.PARAM_ENTITY_REF) throw new XmlError(XML_ERROR.PARAM_ENTITY_REF);
        if (tok === TOK.XML_DECL) throw new XmlError(XML_ERROR.MISPLACED_XML_PI);
        throw new XmlError(XML_ERROR.SYNTAX);
      }
      case 'NONE': {
        return tok !== TOK.BOM;
      }
      case 'PI': {
        this.reportProcessingInstruction(this.prologTz, s, next);
        return false;
      }
      case 'COMMENT': {
        this.reportComment(this.prologTz, s, next);
        return false;
      }
      case 'PARAM_ENTITY_REF': {
        return this.paramEntityReference(s, next);
      }
      default: {
        if (role.startsWith('DOCTYPE')) return this.doctypeRole(role, s, next);
        if (role.includes('ENTITY')) return this.entityRole(role, s, next);
        if (role.startsWith('NOTATION')) return this.notationRole(role, s, next);
        if (role.startsWith('ELEMENT') || role.startsWith('CONTENT') || role.startsWith('GROUP')) {
          return this.elementRole(role, tok, s, next);
        }
        return this.attlistRole(role, s, next);
      }
    }
  }

  /** A parameter entity reference between declarations, which expat expands unless parameter entities are off. */
  // code-gauge-allow functionCognitiveComplexity 24 -- Follows the PARAM_ENTITY_REF role of doProlog of xmlparse.c.
  private paramEntityReference(s: number, next: number): boolean {
    const h = this.handlers;
    const dtd = this.dtd;
    dtd.hasParamEntityRefs = true;
    let handleDefault = true;
    if (this.paramEntityParsing === 0) {
      dtd.keepProcessing = dtd.standalone;
    } else {
      const name = this.text(this.prologTz, s + 1, next - 1);
      const entity = dtd.paramEntities.get(name);
      if (dtd.standalone && this.openParamEntities === 0) {
        if (!entity) throw new XmlError(XML_ERROR.UNDEFINED_ENTITY);
        if (!entity.isInternal) throw new XmlError(XML_ERROR.ENTITY_DECLARED_IN_PE);
      } else if (!entity) {
        dtd.keepProcessing = dtd.standalone;
        if (h.skippedEntity) h.skippedEntity(name, true);
        return !h.skippedEntity;
      }
      if (entity.open) throw new XmlError(XML_ERROR.RECURSIVE_ENTITY_REF);
      if (entity.text) {
        this.processParamEntity(entity);
        return false;
      }
      if (!h.externalEntityRef) {
        dtd.keepProcessing = dtd.standalone;
        return true;
      }
      entity.open = true;
      const read = h.externalEntityRef(undefined as unknown as string, entity.base, entity.systemId, entity.publicId);
      entity.open = false;
      if (!read) throw new XmlError(XML_ERROR.EXTERNAL_ENTITY_HANDLING);
      dtd.keepProcessing = dtd.standalone;
      return false;
    }
    if (!dtd.standalone && h.notStandalone && !h.notStandalone()) throw new XmlError(XML_ERROR.NOT_STANDALONE);
    return handleDefault;
  }

  /** `processEntity` of an internal parameter entity: its text as declarations, which must be complete. */
  private processParamEntity(entity: Entity): void {
    const text = entity.text as number[];
    const saved = [this.prologTz, this.prologInternal] as const;
    entity.open = true;
    this.openParamEntities++;
    this.prologTz = new Tokenizer(text, this.namespaces);
    this.prologInternal = true;
    try {
      const [tok, next] = this.prologTz.prologTok(0, text.length);
      this.doProlog(0, text.length, tok, next, true);
    } finally {
      [this.prologTz, this.prologInternal] = saved;
      this.openParamEntities--;
      entity.open = false;
    }
  }

  /** Moves the event pointer to a position of the document's own text, as expat does for its own encoding only. */
  private prologEvent(ptr: number): void {
    if (!this.prologInternal) this.eventPtr = ptr;
  }

  private processXmlDecl(s: number, next: number): void {
    const decl = parseXmlDecl(this.input.cs, s, next);
    if (typeof decl === 'number') {
      this.eventPtr = decl;
      throw new XmlError(XML_ERROR.XML_DECL);
    }
    if (decl.standalone === 1) {
      this.dtd.standalone = true;
      if (this.paramEntityParsing === 1) this.paramEntityParsing = 0;
    }
    if (this.handlers.xmlDecl) this.handlers.xmlDecl(decl.version, decl.encoding, decl.standalone);
    else this.reportDefault(this.prologTz, s, next);
    if (this.encodingFixed || decl.encoding === undefined) return;
    this.switchEncoding(decl.encoding, decl.encodingStart, next);
  }

  /** Decodes the rest of the input in the encoding an XML declaration names, as expat's encoding switch does. */
  private switchEncoding(name: string, nameStart: number, next: number): void {
    const known = knownEncoding(name);
    const current = this.input.encoding ?? 'utf8';
    const isWide = current === 'utf-16le' || current === 'utf-16be';
    if (known === 'utf-16') {
      if (isWide) return;
      this.eventPtr = nameStart;
      throw new XmlError(XML_ERROR.INCORRECT_ENCODING);
    }
    let encoding: InputEncoding | undefined = known;
    if (encoding === undefined) {
      const table = this.unknownEncoding?.(name);
      if (table === undefined) {
        this.eventPtr = nameStart;
        throw new XmlError(XML_ERROR.UNKNOWN_ENCODING);
      }
      encoding = { table };
    }
    const wide = encoding === 'utf-16le' || encoding === 'utf-16be';
    if (wide !== isWide || (wide && encoding !== current)) {
      this.eventPtr = nameStart;
      throw new XmlError(XML_ERROR.INCORRECT_ENCODING);
    }
    if (encoding !== current) this.input.switchEncoding(encoding, next, this.finalBuffer);
  }

  // code-gauge-allow functionCognitiveComplexity 22 -- Follows the DOCTYPE roles of doProlog of xmlparse.c.
  private doctypeRole(role: Role, s: number, next: number): boolean {
    const h = this.handlers;
    switch (role) {
      case 'DOCTYPE_NAME': {
        if (h.startDoctypeDecl) {
          this.doctypeName = this.text(this.prologTz, s, next);
          this.doctypePubid = undefined;
        }
        this.doctypeSysid = undefined;
        return !h.startDoctypeDecl;
      }
      case 'DOCTYPE_INTERNAL_SUBSET': {
        if (!h.startDoctypeDecl) return true;
        h.startDoctypeDecl(this.doctypeName as string, this.doctypeSysid, this.doctypePubid, true);
        this.doctypeName = undefined;
        return false;
      }
      case 'DOCTYPE_PUBLIC_ID': {
        this.checkPublicId(s, next);
        this.externalPublicId = normalizePublicId(this.text(this.prologTz, s + 1, next - 1));
        this.declEntity = undefined;
        if (!h.startDoctypeDecl) return true;
        this.doctypePubid = normalizePublicId(this.text(this.prologTz, s + 1, next - 1));
        return false;
      }
      case 'DOCTYPE_SYSTEM_ID': {
        this.dtd.hasParamEntityRefs = true;
        this.externalSubset = [this.text(this.prologTz, s + 1, next - 1), this.externalPublicId];
        let handleDefault = true;
        if (h.startDoctypeDecl) {
          this.doctypeSysid = this.text(this.prologTz, s + 1, next - 1);
          handleDefault = false;
        }
        if (!this.dtd.standalone && this.paramEntityParsing === 0 && h.notStandalone && !h.notStandalone()) {
          throw new XmlError(XML_ERROR.NOT_STANDALONE);
        }
        return handleDefault;
      }
      case 'DOCTYPE_CLOSE': {
        let handleDefault = true;
        if (this.doctypeName !== undefined) {
          h.startDoctypeDecl?.(this.doctypeName, this.doctypeSysid, this.doctypePubid, false);
          handleDefault = false;
        }
        if (this.externalSubset !== undefined && this.paramEntityParsing !== 0 && h.externalEntityRef) {
          const [systemId, publicId] = this.externalSubset;
          if (!h.externalEntityRef(undefined as unknown as string, this.base, systemId, publicId)) {
            throw new XmlError(XML_ERROR.EXTERNAL_ENTITY_HANDLING);
          }
        }
        if (h.endDoctypeDecl) {
          h.endDoctypeDecl();
          handleDefault = false;
        }
        return handleDefault;
      }
      default: {
        return !h.startDoctypeDecl;
      }
    }
  }

  private checkPublicId(s: number, next: number): void {
    const bad = badPublicIdChar(this.prologTz.cs, s, next);
    if (bad !== undefined) {
      this.prologEvent(bad);
      throw new XmlError(XML_ERROR.PUBLICID);
    }
  }

  // code-gauge-allow functionCognitiveComplexity 30 -- Follows the ENTITY roles of doProlog of xmlparse.c.
  // code-gauge-allow functionNcss 50 -- Follows the ENTITY roles of doProlog of xmlparse.c.
  private entityRole(role: Role, s: number, next: number): boolean {
    const h = this.handlers;
    const dtd = this.dtd;
    const entity = this.declEntity;
    switch (role) {
      case 'GENERAL_ENTITY_NAME':
      case 'PARAM_ENTITY_NAME': {
        const name = this.text(this.prologTz, s, next);
        const isParam = role === 'PARAM_ENTITY_NAME';
        this.declEntity = undefined;
        if (!isParam && name in PREDEFINED_ENTITIES) return true;
        if (!dtd.keepProcessing) return true;
        const table = isParam ? dtd.paramEntities : dtd.generalEntities;
        if (table.has(name)) return true;
        this.declEntity = { name, isParam, open: false, isInternal: this.openParamEntities === 0 };
        table.set(name, this.declEntity);
        return !h.entityDecl;
      }
      case 'ENTITY_VALUE': {
        if (!dtd.keepProcessing) return true;
        let error: XmlError | undefined;
        const text: number[] = [];
        try {
          this.storeEntityValue(s + 1, next - 1, text);
        } catch (error_) {
          if (!(error_ instanceof XmlError)) throw error_;
          error = error_;
        }
        let handleDefault = true;
        if (entity) {
          entity.text = text;
          if (h.entityDecl) {
            this.eventEndPtr = s;
            h.entityDecl(
              entity.name,
              entity.isParam,
              String.fromCodePoint(...text),
              this.base,
              undefined,
              undefined,
              undefined
            );
            handleDefault = false;
          }
        }
        if (error) throw error;
        return handleDefault;
      }
      case 'ENTITY_PUBLIC_ID': {
        this.checkPublicId(s, next);
        if (!dtd.keepProcessing || !entity) return true;
        entity.publicId = normalizePublicId(this.text(this.prologTz, s + 1, next - 1));
        return !h.entityDecl;
      }
      case 'ENTITY_SYSTEM_ID': {
        if (!dtd.keepProcessing || !entity) return true;
        entity.systemId = this.text(this.prologTz, s + 1, next - 1);
        entity.base = this.base;
        return !h.entityDecl;
      }
      case 'ENTITY_COMPLETE': {
        if (!dtd.keepProcessing || !entity || !h.entityDecl) return true;
        this.eventEndPtr = s;
        h.entityDecl(entity.name, entity.isParam, undefined, entity.base, entity.systemId, entity.publicId, undefined);
        return false;
      }
      case 'ENTITY_NOTATION_NAME': {
        if (!dtd.keepProcessing || !entity) return true;
        entity.notation = this.text(this.prologTz, s, next);
        if (h.unparsedEntityDecl) {
          h.unparsedEntityDecl(entity.name, entity.base, entity.systemId, entity.publicId, entity.notation);
          return false;
        }
        if (!h.entityDecl) return true;
        h.entityDecl(entity.name, false, undefined, entity.base, entity.systemId, entity.publicId, entity.notation);
        return false;
      }
      default: {
        return !(dtd.keepProcessing && h.entityDecl);
      }
    }
  }

  /** `storeEntityValue`: adds the replacement text of an entity's literal, with character references replaced. */
  private storeEntityValue(start: number, end: number, text: number[]): void {
    const tz = this.prologTz;
    let ptr = start;
    for (;;) {
      const [tok, next] = tz.entityValueTok(ptr, end);
      switch (tok) {
        case TOK.NONE: {
          return;
        }
        case TOK.PARAM_ENTITY_REF: {
          this.prologEvent(ptr);
          throw new XmlError(XML_ERROR.PARAM_ENTITY_REF);
        }
        case TOK.ENTITY_REF:
        case TOK.DATA_CHARS: {
          for (let index = ptr; index < next; index++) text.push(tz.cs[index] as number);
          break;
        }
        case TOK.TRAILING_CR:
        case TOK.DATA_NEWLINE: {
          text.push(0x0a);
          break;
        }
        case TOK.CHAR_REF: {
          const code = charRefNumber(tz.cs, ptr, next);
          if (code < 0) {
            this.prologEvent(ptr);
            throw new XmlError(XML_ERROR.BAD_CHAR_REF);
          }
          text.push(code);
          break;
        }
        default: {
          this.prologEvent(tok === TOK.INVALID ? next : ptr);
          throw new XmlError(XML_ERROR.INVALID_TOKEN);
        }
      }
      ptr = tok === TOK.TRAILING_CR ? ptr + 1 : next;
    }
  }

  private notationRole(role: Role, s: number, next: number): boolean {
    const h = this.handlers;
    switch (role) {
      case 'NOTATION_NAME': {
        this.declNotationPublicId = undefined;
        this.declNotationName = h.notationDecl ? this.text(this.prologTz, s, next) : undefined;
        return !h.notationDecl;
      }
      case 'NOTATION_PUBLIC_ID': {
        this.checkPublicId(s, next);
        if (this.declNotationName === undefined) return true;
        this.declNotationPublicId = normalizePublicId(this.text(this.prologTz, s + 1, next - 1));
        return false;
      }
      case 'NOTATION_SYSTEM_ID': {
        if (this.declNotationName === undefined || !h.notationDecl) return true;
        const systemId = this.text(this.prologTz, s + 1, next - 1);
        this.eventEndPtr = s;
        h.notationDecl(this.declNotationName, this.base, systemId, this.declNotationPublicId);
        return false;
      }
      case 'NOTATION_NO_SYSTEM_ID': {
        if (this.declNotationPublicId === undefined || !h.notationDecl) return true;
        this.eventEndPtr = s;
        h.notationDecl(this.declNotationName as string, this.base, undefined, this.declNotationPublicId);
        return false;
      }
      default: {
        return !h.notationDecl;
      }
    }
  }

  // code-gauge-allow functionCognitiveComplexity 30 -- Follows the ELEMENT roles of doProlog of xmlparse.c.
  // code-gauge-allow functionNcss 50 -- Follows the ELEMENT roles of doProlog of xmlparse.c.
  private elementRole(role: Role, tok: number, s: number, next: number): boolean {
    const h = this.handlers;
    const decl = this.elementDecl;
    const level = this.prologState.level;
    const top = decl?.groups.at(-1);
    switch (role) {
      case 'ELEMENT_NAME': {
        if (!h.elementDecl) return true;
        this.elementDecl = { name: this.text(this.prologTz, s, next), groups: [] };
        return false;
      }
      case 'CONTENT_ANY':
      case 'CONTENT_EMPTY': {
        if (!decl) return true;
        this.elementDecl = undefined;
        if (!h.elementDecl) return true;
        this.eventEndPtr = s;
        const type = role === 'CONTENT_ANY' ? CTYPE.ANY : CTYPE.EMPTY;
        h.elementDecl(decl.name, { type, quant: CQUANT.NONE, children: [] });
        return false;
      }
      case 'CONTENT_PCDATA': {
        if (!top) return true;
        top.type = CTYPE.MIXED;
        return !h.elementDecl;
      }
      case 'GROUP_OPEN': {
        this.groupConnector[level] = 0;
        if (!decl) return true;
        const group: ContentModel = { type: CTYPE.SEQ, quant: CQUANT.NONE, children: [] };
        top?.children.push(group);
        decl.groups.push(group);
        return !h.elementDecl;
      }
      case 'GROUP_SEQUENCE': {
        if (this.groupConnector[level] === 0x7c) throw new XmlError(XML_ERROR.SYNTAX);
        this.groupConnector[level] = 0x2c;
        return !(decl && h.elementDecl);
      }
      case 'GROUP_CHOICE': {
        if (this.groupConnector[level] === 0x2c) throw new XmlError(XML_ERROR.SYNTAX);
        let handleDefault = true;
        if (top && !this.groupConnector[level] && top.type !== CTYPE.MIXED) {
          top.type = CTYPE.CHOICE;
          handleDefault = !h.elementDecl;
        }
        this.groupConnector[level] = 0x7c;
        return handleDefault;
      }
      case 'ELEMENT_NONE': {
        return !h.elementDecl;
      }
      default: {
        return this.contentParticle(role, tok, s, next);
      }
    }
  }

  private contentParticle(role: Role, tok: number, s: number, next: number): boolean {
    const decl = this.elementDecl;
    const top = decl?.groups.at(-1);
    const quantifiers: Partial<Record<Role, number>> = {
      CONTENT_ELEMENT: CQUANT.NONE,
      CONTENT_ELEMENT_OPT: CQUANT.OPT,
      CONTENT_ELEMENT_REP: CQUANT.REP,
      CONTENT_ELEMENT_PLUS: CQUANT.PLUS,
      GROUP_CLOSE: CQUANT.NONE,
      GROUP_CLOSE_OPT: CQUANT.OPT,
      GROUP_CLOSE_REP: CQUANT.REP,
      GROUP_CLOSE_PLUS: CQUANT.PLUS,
    };
    const quant = quantifiers[role] ?? CQUANT.NONE;
    if (!decl || !top) return true;
    if (role.startsWith('CONTENT_ELEMENT')) {
      const nameEnd = tok === TOK.NAME || tok === TOK.PREFIXED_NAME ? next : next - 1;
      top.children.push({ type: CTYPE.NAME, quant, name: this.text(this.prologTz, s, nameEnd), children: [] });
      return !this.handlers.elementDecl;
    }
    decl.groups.pop();
    top.quant = quant;
    if (decl.groups.length === 0) {
      this.elementDecl = undefined;
      if (this.handlers.elementDecl) {
        this.eventEndPtr = s;
        this.handlers.elementDecl(decl.name, top);
      }
    }
    return !this.handlers.elementDecl;
  }

  // code-gauge-allow functionCognitiveComplexity 26 -- Follows the ATTLIST roles of doProlog of xmlparse.c.
  private attlistRole(role: Role, s: number, next: number): boolean {
    const h = this.handlers;
    const dtd = this.dtd;
    const text = this.text(this.prologTz, s, next);
    switch (role) {
      case 'ATTLIST_ELEMENT_NAME': {
        this.declElementType = text;
        dtd.elementType(text);
        return !(dtd.keepProcessing && h.attlistDecl);
      }
      case 'ATTRIBUTE_NAME': {
        this.declAttribute = text;
        this.declAttributeIsCdata = false;
        this.declAttributeType = undefined;
        return !(dtd.keepProcessing && h.attlistDecl);
      }
      case 'ATTRIBUTE_TYPE': {
        this.declAttributeIsCdata = text === 'CDATA';
        this.declAttributeType = text;
        return !(dtd.keepProcessing && h.attlistDecl);
      }
      case 'ATTRIBUTE_ENUM_VALUE':
      case 'ATTRIBUTE_NOTATION_VALUE': {
        if (!(dtd.keepProcessing && h.attlistDecl)) return true;
        const prefix =
          this.declAttributeType === undefined ? (role === 'ATTRIBUTE_NOTATION_VALUE' ? 'NOTATION(' : '(') : '|';
        this.declAttributeType = (this.declAttributeType ?? '') + prefix + text;
        return false;
      }
      case 'IMPLIED_ATTRIBUTE_VALUE':
      case 'REQUIRED_ATTRIBUTE_VALUE':
      case 'DEFAULT_ATTRIBUTE_VALUE':
      case 'FIXED_ATTRIBUTE_VALUE': {
        if (!dtd.keepProcessing) return true;
        const hasValue = role === 'DEFAULT_ATTRIBUTE_VALUE' || role === 'FIXED_ATTRIBUTE_VALUE';
        const value = hasValue
          ? this.storeAttributeValue(
              this.prologTz,
              this.declAttributeIsCdata,
              s + 1,
              next - 1,
              this.prologInternal,
              true
            )
          : undefined;
        this.defineAttribute(value);
        let type = this.declAttributeType;
        if (!h.attlistDecl || type === undefined) return true;
        if (type.startsWith('(') || type.startsWith('NO')) type += ')';
        this.eventEndPtr = s;
        const required = role === 'REQUIRED_ATTRIBUTE_VALUE' || role === 'FIXED_ATTRIBUTE_VALUE';
        h.attlistDecl(this.declElementType, this.declAttribute, type, value, required);
        return false;
      }
      default: {
        return !(dtd.keepProcessing && h.attlistDecl);
      }
    }
  }

  /** `defineAttribute`: the first declaration of an attribute with a default value is the one that counts. */
  private defineAttribute(value: string | undefined): void {
    const type = this.dtd.elementType(this.declElementType);
    const isId = this.declAttributeType === 'ID';
    if ((value !== undefined || isId) && type.defaults.some((each) => each.name === this.declAttribute)) return;
    type.defaults.push({ name: this.declAttribute, isCdata: this.declAttributeIsCdata, value });
  }

  // Content ---------------------------------------------------------------------------------------------------------

  /**
   * `doContent`: the content of the document or of an internal entity. While an entity's text is parsed, the event
   * pointer stays at the reference to it, as expat's internal event pointer leaves the parser's own alone.
   */
  // code-gauge-allow functionCognitiveComplexity 30 -- Follows doContent of xmlparse.c case by case.
  // code-gauge-allow functionNcss 60 -- Follows doContent of xmlparse.c case by case.
  private doContent(
    tz: Tokenizer,
    startTagLevel: number,
    s: number,
    end: number,
    haveMore: boolean,
    internal: boolean
  ): number {
    const h = this.handlers;
    let [tok, next] = tz.contentTok(s, end);
    for (;;) {
      if (!internal) {
        this.eventPtr = s;
        this.eventEndPtr = next;
      }
      switch (tok) {
        case TOK.TRAILING_CR:
        case TOK.TRAILING_RSQB: {
          if (haveMore) return s;
          if (h.characterData) h.characterData(tok === TOK.TRAILING_CR ? '\n' : this.text(tz, s, end));
          else this.reportDefault(tz, s, end);
          if (!internal) this.eventPtr = end;
          if (startTagLevel === 0) throw new XmlError(XML_ERROR.NO_ELEMENTS);
          if (this.tags.length !== startTagLevel) throw new XmlError(XML_ERROR.ASYNC_ENTITY);
          return end;
        }
        case TOK.NONE: {
          if (haveMore) return s;
          if (startTagLevel > 0) {
            if (this.tags.length !== startTagLevel) throw new XmlError(XML_ERROR.ASYNC_ENTITY);
            return s;
          }
          throw new XmlError(XML_ERROR.NO_ELEMENTS);
        }
        case TOK.INVALID: {
          if (!internal) this.eventPtr = next;
          throw new XmlError(XML_ERROR.INVALID_TOKEN);
        }
        case TOK.PARTIAL:
        case TOK.PARTIAL_CHAR: {
          if (haveMore) return s;
          throw new XmlError(tok === TOK.PARTIAL ? XML_ERROR.UNCLOSED_TOKEN : XML_ERROR.PARTIAL_CHAR);
        }
        case TOK.ENTITY_REF: {
          this.entityReference(tz, s, next);
          break;
        }
        case TOK.CHAR_REF: {
          const code = charRefNumber(tz.cs, s, next);
          if (code < 0) throw new XmlError(XML_ERROR.BAD_CHAR_REF);
          if (h.characterData) h.characterData(String.fromCodePoint(code));
          else this.reportDefault(tz, s, next);
          break;
        }
        case TOK.XML_DECL: {
          throw new XmlError(XML_ERROR.MISPLACED_XML_PI);
        }
        case TOK.DATA_NEWLINE: {
          if (h.characterData) h.characterData('\n');
          else this.reportDefault(tz, s, next);
          break;
        }
        case TOK.START_TAG_NO_ATTS:
        case TOK.START_TAG_WITH_ATTS: {
          this.startTag(tz, s, next, internal);
          break;
        }
        case TOK.EMPTY_ELEMENT_NO_ATTS:
        case TOK.EMPTY_ELEMENT_WITH_ATTS: {
          this.emptyElement(tz, s, next, internal);
          if (this.tags.length === 0) return this.epilogProcessor(next, end);
          break;
        }
        case TOK.END_TAG: {
          if (this.tags.length === startTagLevel) throw new XmlError(XML_ERROR.ASYNC_ENTITY);
          this.endTag(tz, s, next, internal);
          if (this.tags.length === 0) return this.epilogProcessor(next, end);
          break;
        }
        case TOK.CDATA_SECT_OPEN: {
          if (h.startCdataSection) h.startCdataSection();
          else this.reportDefault(tz, s, next);
          const closed = this.doCdataSection(tz, next, end, haveMore, internal);
          if (closed === undefined) {
            this.processor = 'cdata';
            return this.cdataResume;
          }
          next = closed;
          break;
        }
        case TOK.DATA_CHARS: {
          if (h.characterData) h.characterData(this.text(tz, s, next));
          else this.reportDefault(tz, s, next);
          break;
        }
        case TOK.PI: {
          this.reportProcessingInstruction(tz, s, next);
          break;
        }
        case TOK.COMMENT: {
          this.reportComment(tz, s, next);
          break;
        }
        default: {
          this.reportDefault(tz, s, next);
        }
      }
      s = next;
      if (!internal) this.eventPtr = s;
      [tok, next] = tz.contentTok(s, end);
    }
  }

  // code-gauge-allow functionCognitiveComplexity 24 -- Follows the ENTITY_REF case of doContent of xmlparse.c.
  private entityReference(tz: Tokenizer, s: number, next: number): void {
    const h = this.handlers;
    const name = this.text(tz, s + 1, next - 1);
    const predefined = PREDEFINED_ENTITIES[name];
    if (predefined !== undefined) {
      if (h.characterData) h.characterData(String.fromCodePoint(predefined));
      else this.reportDefault(tz, s, next);
      return;
    }
    const entity = this.dtd.generalEntities.get(name);
    if (!this.dtd.hasParamEntityRefs || this.dtd.standalone) {
      if (!entity) throw new XmlError(XML_ERROR.UNDEFINED_ENTITY);
      if (!entity.isInternal) throw new XmlError(XML_ERROR.ENTITY_DECLARED_IN_PE);
    } else if (!entity) {
      if (h.skippedEntity) h.skippedEntity(name, false);
      else this.reportDefault(tz, s, next);
      return;
    }
    if (entity.open) throw new XmlError(XML_ERROR.RECURSIVE_ENTITY_REF);
    if (entity.notation !== undefined) throw new XmlError(XML_ERROR.BINARY_ENTITY_REF);
    if (entity.text) {
      if (!this.defaultExpandInternalEntities) {
        if (h.skippedEntity) h.skippedEntity(entity.name, false);
        else this.reportDefault(tz, s, next);
        return;
      }
      entity.open = true;
      this.doContent(new Tokenizer(entity.text, this.namespaces), this.tags.length, 0, entity.text.length, false, true);
      entity.open = false;
    } else if (h.externalEntityRef) {
      entity.open = true;
      const context = this.context();
      entity.open = false;
      if (!h.externalEntityRef(context, entity.base, entity.systemId, entity.publicId)) {
        throw new XmlError(XML_ERROR.EXTERNAL_ENTITY_HANDLING);
      }
    } else {
      this.reportDefault(tz, s, next);
    }
  }

  /** `getContext`: the namespace bindings and the open entities, which an external entity parser starts from. */
  private context(): string {
    const parts: string[] = [];
    const defaultBinding = this.prefixes.get('');
    if (defaultBinding) parts.push(`=${this.uriOf(defaultBinding)}`);
    for (const [prefix, binding] of this.prefixes) {
      if (prefix !== '' && binding) parts.push(`${prefix}=${this.uriOf(binding)}`);
    }
    for (const entity of this.dtd.generalEntities.values()) if (entity.open) parts.push(entity.name);
    return parts.join('\f');
  }

  private uriOf(binding: Binding): string {
    return this.separator ? binding.uri.slice(0, -this.separator.length) : binding.uri;
  }

  private startTag(tz: Tokenizer, s: number, next: number, internal: boolean): void {
    const rawName = this.nameAt(tz, s + 1);
    const tag: Tag = { rawName, name: rawName, bindings: [] };
    this.tags.push(tag);
    const [attributes, specified] = this.storeAtts(tz, s, tag, internal);
    if (this.handlers.startElement) this.handlers.startElement(tag.name, attributes, specified);
    else this.reportDefault(tz, s, next);
  }

  private emptyElement(tz: Tokenizer, s: number, next: number, internal: boolean): void {
    const h = this.handlers;
    const rawName = this.nameAt(tz, s + 1);
    const tag: Tag = { rawName, name: rawName, bindings: [] };
    let stored: [string[], number];
    try {
      stored = this.storeAtts(tz, s, tag, internal);
    } catch (error) {
      if (error instanceof XmlError) this.freeBindings(tag);
      throw error;
    }
    const [attributes, specified] = stored;
    let noHandlers = true;
    if (h.startElement) {
      h.startElement(tag.name, attributes, specified);
      noHandlers = false;
    }
    if (h.endElement) {
      if (h.startElement && !internal) this.eventPtr = this.eventEndPtr;
      h.endElement(tag.name);
      noHandlers = false;
    }
    if (noHandlers) this.reportDefault(tz, s, next);
    this.freeBindings(tag);
  }

  private endTag(tz: Tokenizer, s: number, next: number, internal: boolean): void {
    const rawName = this.nameAt(tz, s + 2);
    const tag = this.tags.at(-1) as Tag;
    if (rawName !== tag.rawName) {
      if (!internal) this.eventPtr = s + 2;
      throw new XmlError(XML_ERROR.TAG_MISMATCH);
    }
    this.tags.pop();
    if (this.handlers.endElement) this.handlers.endElement(tag.name);
    else this.reportDefault(tz, s, next);
    this.freeBindings(tag);
  }

  private freeBindings(tag: Tag): void {
    for (const binding of tag.bindings.toReversed()) {
      this.handlers.endNamespaceDecl?.(binding.prefix);
      this.prefixes.set(binding.prefix ?? '', binding.previous);
    }
  }

  /** `XmlNameLength`: the name at `start`, whose characters include colons. */
  private nameAt(tz: Tokenizer, start: number): string {
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
  private getAtts(tz: Tokenizer, s: number): RawAttribute[] {
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

  private nameEnd(tz: Tokenizer, start: number): number {
    let end = start;
    while (tz.isNameChar(tz.type(end)) || tz.type(end) === BT.COLON) end++;
    return end;
  }

  /**
   * `storeAtts`: the attributes of a start tag as names and values, then the defaults its element type declares, with
   * namespaces applied; and the number of the specified ones' entries.
   */
  // code-gauge-allow functionCognitiveComplexity 22 -- Follows storeAtts of xmlparse.c.
  private storeAtts(tz: Tokenizer, s: number, tag: Tag, internal: boolean): [string[], number] {
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

  private expandNames(entries: { name: string; value: string; prefixed: boolean }[], tag: Tag): void {
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
  private expandName(name: string, isElement: boolean): string {
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
  private addBinding(prefix: string | undefined, uri: string, tag: Tag): void {
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
  private storeAttributeValue(
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

  // code-gauge-allow functionCognitiveComplexity 30 -- Follows appendAttributeValue of xmlparse.c.
  // code-gauge-allow functionNcss 50 -- Follows appendAttributeValue of xmlparse.c.
  private appendAttributeValue(
    tz: Tokenizer,
    isCdata: boolean,
    ptr: number,
    end: number,
    pool: number[],
    internal: boolean,
    inProlog: boolean
  ): void {
    for (;;) {
      const [tok, next] = tz.attributeValueTok(ptr, end);
      switch (tok) {
        case TOK.NONE: {
          return;
        }
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
          if (!isCdata && code === 0x20 && (pool.length === 0 || pool.at(-1) === 0x20)) break;
          pool.push(code);
          break;
        }
        case TOK.DATA_CHARS: {
          for (let index = ptr; index < next; index++) pool.push(tz.cs[index] as number);
          break;
        }
        case TOK.TRAILING_CR:
        case TOK.ATTRIBUTE_VALUE_S:
        case TOK.DATA_NEWLINE: {
          if (!isCdata && (pool.length === 0 || pool.at(-1) === 0x20)) break;
          pool.push(0x20);
          break;
        }
        case TOK.ENTITY_REF: {
          this.attributeEntity(tz, isCdata, ptr, next, pool, internal, inProlog);
          break;
        }
        default: {
          if (!internal) this.eventPtr = ptr;
          throw new XmlError(XML_ERROR.UNEXPECTED_STATE);
        }
      }
      ptr = tok === TOK.TRAILING_CR ? ptr + 1 : next;
    }
  }

  // code-gauge-allow functionParameterCount 7 -- Carries the arguments of appendAttributeValue of xmlparse.c.
  private attributeEntity(
    tz: Tokenizer,
    isCdata: boolean,
    ptr: number,
    next: number,
    pool: number[],
    internal: boolean,
    inProlog: boolean
  ): void {
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

  private reportComment(tz: Tokenizer, s: number, next: number): void {
    if (!this.handlers.comment) {
      this.reportDefault(tz, s, next);
      return;
    }
    this.handlers.comment(normalizeLines(this.text(tz, s + 4, next - 3)));
  }

  private reportProcessingInstruction(tz: Tokenizer, s: number, next: number): void {
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

  private cdataSectionProcessor(start: number, end: number): number {
    const closed = this.doCdataSection(this.tokenizer, start, end, !this.finalBuffer, false);
    if (closed === undefined) return this.cdataResume;
    this.processor = 'content';
    return this.doContent(this.tokenizer, 0, closed, end, !this.finalBuffer, false);
  }

  /** `doCdataSection`: the section's text up to its end, whose index it returns, or undefined when more input is needed. */
  private doCdataSection(
    tz: Tokenizer,
    s: number,
    end: number,
    haveMore: boolean,
    internal: boolean
  ): number | undefined {
    const h = this.handlers;
    if (!internal) this.eventPtr = s;
    for (;;) {
      const [tok, next] = tz.cdataSectionTok(s, end);
      if (!internal) this.eventEndPtr = next;
      switch (tok) {
        case TOK.CDATA_SECT_CLOSE: {
          if (h.endCdataSection) h.endCdataSection();
          else this.reportDefault(tz, s, next);
          return next;
        }
        case TOK.DATA_NEWLINE: {
          if (h.characterData) h.characterData('\n');
          else this.reportDefault(tz, s, next);
          break;
        }
        case TOK.DATA_CHARS: {
          if (h.characterData) h.characterData(this.text(tz, s, next));
          else this.reportDefault(tz, s, next);
          break;
        }
        case TOK.INVALID: {
          if (!internal) this.eventPtr = next;
          throw new XmlError(XML_ERROR.INVALID_TOKEN);
        }
        default: {
          if (haveMore) {
            this.cdataResume = s;
            return undefined;
          }
          throw new XmlError(XML_ERROR.UNCLOSED_CDATA_SECTION);
        }
      }
      s = next;
      if (!internal) this.eventPtr = s;
    }
  }

  private epilogProcessor(s: number, end: number): number {
    this.processor = 'epilog';
    this.eventPtr = s;
    for (;;) {
      const [tok, next] = this.tokenizer.prologTok(s, end);
      this.eventEndPtr = next;
      switch (tok) {
        case -TOK.PROLOG_S: {
          this.reportDefault(this.tokenizer, s, next);
          return next;
        }
        case TOK.NONE: {
          return s;
        }
        case TOK.PROLOG_S: {
          this.reportDefault(this.tokenizer, s, next);
          break;
        }
        case TOK.PI: {
          this.reportProcessingInstruction(this.tokenizer, s, next);
          break;
        }
        case TOK.COMMENT: {
          this.reportComment(this.tokenizer, s, next);
          break;
        }
        case TOK.INVALID: {
          this.eventPtr = next;
          throw new XmlError(XML_ERROR.INVALID_TOKEN);
        }
        case TOK.PARTIAL:
        case TOK.PARTIAL_CHAR: {
          if (!this.finalBuffer) return s;
          throw new XmlError(tok === TOK.PARTIAL ? XML_ERROR.UNCLOSED_TOKEN : XML_ERROR.PARTIAL_CHAR);
        }
        default: {
          throw new XmlError(XML_ERROR.JUNK_AFTER_DOC_ELEMENT);
        }
      }
      this.eventPtr = next;
      s = next;
    }
  }
}

function isXmlns(name: string): boolean {
  return name === 'xmlns' || name.startsWith('xmlns:');
}

function xmlnsPrefix(name: string): string | undefined {
  return name === 'xmlns' ? undefined : name.slice(6);
}
