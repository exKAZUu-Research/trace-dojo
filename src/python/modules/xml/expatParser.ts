// code-gauge-allow-file fileNcss 410 -- It transcribes one of expat's C files.
import type { Binding, Tag } from './expatBase';
import { charRefNumber, PREDEFINED_ENTITIES, XML_ERROR, XmlError } from './expatDocument';
import { ExpatProlog } from './expatProlog';
import { TOK, Tokenizer } from './expatTokenizer';

// The processors of expat's xmlparse.c after the prolog: the content, CDATA sections, and the epilog, with the
// buffering that decides when a partial token is parsed again.

const CONTEXT_BYTES = 1024;
const INIT_BUFFER_SIZE = 1024;

/** What the tokens of one run of doContent share. */
interface ContentRun {
  tz: Tokenizer;
  startTagLevel: number;
  end: number;
  haveMore: boolean;
  internal: boolean;
}

export class ExpatParser extends ExpatProlog {
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

  // code-gauge-allow functionNcss 33 -- Transcribes expat's C code case by case, as its order of checks decides the errors and their positions.
  protected parse(length: number, isFinal: boolean, request = length): void {
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
  protected getBuffer(length: number): void {
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

  protected recordError(error: unknown): void {
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

  protected fail(code: number): never {
    this.errorCode = code;
    const [line, column] = this.position(this.eventPtr);
    this.errorLine = line;
    this.errorColumn = column;
    throw new XmlError(code);
  }

  protected runProcessor(start: number, end: number): number {
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

  /**
   * `doContent`: the content of the document or of an internal entity. While an entity's text is parsed, the event
   * pointer stays at the reference to it, as expat's internal event pointer leaves the parser's own alone.
   */
  protected doContent(
    tz: Tokenizer,
    startTagLevel: number,
    s: number,
    end: number,
    haveMore: boolean,
    internal: boolean
  ): number {
    const run: ContentRun = { tz, startTagLevel, end, haveMore, internal };
    let [tok, next] = this.scanToken(tz, 'contentTok', s, end, internal);
    for (;;) {
      if (!internal) {
        this.eventPtr = s;
        this.eventEndPtr = next;
      }
      if (tok <= 0) return this.contentEnd(run, tok, s, next);
      const after = this.contentToken(run, tok, s, next);
      if (typeof after !== 'number') return after.result;
      s = after;
      if (!internal) this.eventPtr = s;
      [tok, next] = this.scanToken(tz, 'contentTok', s, end, internal);
    }
  }

  /** The tokens that end the content: its end, a partial token, or an invalid one. */
  // code-gauge-allow functionCognitiveComplexity 19 -- Transcribes expat's C code case by case, as its order of checks decides the errors and their positions.
  private contentEnd(run: ContentRun, tok: number, s: number, next: number): number {
    const { tz, startTagLevel, end, haveMore, internal } = run;
    if (tok !== TOK.INVALID && haveMore) return s;
    switch (tok) {
      case TOK.TRAILING_CR:
      case TOK.TRAILING_RSQB: {
        this.characterData(tz, s, end, tok === TOK.TRAILING_CR ? '\n' : this.text(tz, s, end));
        if (!internal) this.eventPtr = end;
        if (startTagLevel === 0) throw new XmlError(XML_ERROR.NO_ELEMENTS);
        if (this.tags.length !== startTagLevel) throw new XmlError(XML_ERROR.ASYNC_ENTITY);
        return end;
      }
      case TOK.NONE: {
        if (startTagLevel === 0) throw new XmlError(XML_ERROR.NO_ELEMENTS);
        if (this.tags.length !== startTagLevel) throw new XmlError(XML_ERROR.ASYNC_ENTITY);
        return s;
      }
      case TOK.INVALID: {
        if (!internal) this.eventPtr = next;
        throw new XmlError(XML_ERROR.INVALID_TOKEN);
      }
      default: {
        throw new XmlError(tok === TOK.PARTIAL ? XML_ERROR.UNCLOSED_TOKEN : XML_ERROR.PARTIAL_CHAR);
      }
    }
  }

  /** Character data for the handler, or its text for the default handler when it has none. */
  private characterData(tz: Tokenizer, s: number, next: number, data: string): void {
    if (this.handlers.characterData) this.handlers.characterData(data);
    else this.reportDefault(tz, s, next);
  }

  /** A token of content: the index after it, or what doContent returns when the content ends with it. */
  private contentToken(run: ContentRun, tok: number, s: number, next: number): number | { result: number } {
    const { tz } = run;
    switch (tok) {
      case TOK.ENTITY_REF: {
        this.entityReference(tz, s, next);
        return next;
      }
      case TOK.CHAR_REF: {
        const code = charRefNumber(tz.cs, s, next);
        if (code < 0) throw new XmlError(XML_ERROR.BAD_CHAR_REF);
        this.characterData(tz, s, next, String.fromCodePoint(code));
        return next;
      }
      case TOK.XML_DECL: {
        throw new XmlError(XML_ERROR.MISPLACED_XML_PI);
      }
      case TOK.DATA_NEWLINE: {
        this.characterData(tz, s, next, '\n');
        return next;
      }
      case TOK.DATA_CHARS: {
        this.characterData(tz, s, next, this.text(tz, s, next));
        return next;
      }
      case TOK.PI: {
        this.reportProcessingInstruction(tz, s, next);
        return next;
      }
      case TOK.COMMENT: {
        this.reportComment(tz, s, next);
        return next;
      }
      default: {
        return this.markupToken(run, tok, s, next);
      }
    }
  }

  /** A tag or the start of a CDATA section, after which the content may end. */
  private markupToken(run: ContentRun, tok: number, s: number, next: number): number | { result: number } {
    const { tz, startTagLevel, end, haveMore, internal } = run;
    switch (tok) {
      case TOK.START_TAG_NO_ATTS:
      case TOK.START_TAG_WITH_ATTS: {
        this.startTag(tz, s, next, internal);
        return next;
      }
      case TOK.EMPTY_ELEMENT_NO_ATTS:
      case TOK.EMPTY_ELEMENT_WITH_ATTS: {
        this.emptyElement(tz, s, next, internal);
        return this.tags.length === 0 ? { result: this.epilogProcessor(next, end) } : next;
      }
      case TOK.END_TAG: {
        if (this.tags.length === startTagLevel) throw new XmlError(XML_ERROR.ASYNC_ENTITY);
        this.endTag(tz, s, next, internal);
        return this.tags.length === 0 ? { result: this.epilogProcessor(next, end) } : next;
      }
      case TOK.CDATA_SECT_OPEN: {
        if (this.handlers.startCdataSection) this.handlers.startCdataSection();
        else this.reportDefault(tz, s, next);
        const closed = this.doCdataSection(tz, next, end, haveMore, internal);
        if (closed !== undefined) return closed;
        this.processor = 'cdata';
        return { result: this.cdataResume };
      }
      default: {
        this.reportDefault(tz, s, next);
        return next;
      }
    }
  }

  // code-gauge-allow functionCognitiveComplexity 27 -- Transcribes expat's C code case by case, as its order of checks decides the errors and their positions.
  // code-gauge-allow functionNcss 46 -- Transcribes expat's C code case by case, as its order of checks decides the errors and their positions.
  protected entityReference(tz: Tokenizer, s: number, next: number): void {
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
  protected context(): string {
    const parts: string[] = [];
    const defaultBinding = this.prefixes.get('');
    if (defaultBinding) parts.push(`=${this.uriOf(defaultBinding)}`);
    for (const [prefix, binding] of this.prefixes) {
      if (prefix !== '' && binding) parts.push(`${prefix}=${this.uriOf(binding)}`);
    }
    for (const entity of this.dtd.generalEntities.values()) if (entity.open) parts.push(entity.name);
    return parts.join('\f');
  }

  protected uriOf(binding: Binding): string {
    return this.separator ? binding.uri.slice(0, -this.separator.length) : binding.uri;
  }

  protected startTag(tz: Tokenizer, s: number, next: number, internal: boolean): void {
    const rawName = this.nameAt(tz, s + 1);
    const tag: Tag = { rawName, name: rawName, bindings: [] };
    this.tags.push(tag);
    const [attributes, specified] = this.storeAtts(tz, s, tag, internal);
    if (this.handlers.startElement) this.handlers.startElement(tag.name, attributes, specified);
    else this.reportDefault(tz, s, next);
  }

  protected emptyElement(tz: Tokenizer, s: number, next: number, internal: boolean): void {
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

  protected endTag(tz: Tokenizer, s: number, next: number, internal: boolean): void {
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

  protected cdataSectionProcessor(start: number, end: number): number {
    const closed = this.doCdataSection(this.tokenizer, start, end, !this.finalBuffer, false);
    if (closed === undefined) return this.cdataResume;
    this.processor = 'content';
    return this.doContent(this.tokenizer, 0, closed, end, !this.finalBuffer, false);
  }

  /** `doCdataSection`: the section's text up to its end, whose index it returns, or undefined when more input is needed. */
  // code-gauge-allow functionCognitiveComplexity 26 -- Transcribes expat's C code case by case, as its order of checks decides the errors and their positions.
  // code-gauge-allow functionNcss 39 -- Transcribes expat's C code case by case, as its order of checks decides the errors and their positions.
  protected doCdataSection(
    tz: Tokenizer,
    s: number,
    end: number,
    haveMore: boolean,
    internal: boolean
  ): number | undefined {
    const h = this.handlers;
    if (!internal) this.eventPtr = s;
    for (;;) {
      const [tok, next] = this.scanToken(tz, 'cdataSectionTok', s, end, internal);
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

  // code-gauge-allow functionNcss 33 -- Transcribes expat's C code case by case, as its order of checks decides the errors and their positions.
  protected epilogProcessor(s: number, end: number): number {
    this.processor = 'epilog';
    this.eventPtr = s;
    for (;;) {
      const [tok, next] = this.scanToken(this.tokenizer, 'prologTok', s, end, false);
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
