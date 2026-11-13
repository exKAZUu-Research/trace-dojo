// code-gauge-allow-file fileNcss 494 -- It transcribes one of expat's C files.
import { ExpatBase } from './expatBase';
import {
  badPublicIdChar,
  charRefNumber,
  type ContentModel,
  CQUANT,
  CTYPE,
  type Entity,
  normalizePublicId,
  PREDEFINED_ENTITIES,
  XML_ERROR,
  XmlError,
} from './expatDocument';
import { type InputEncoding, knownEncoding } from './expatInput';
import type { Role } from './expatRoles';
import { TOK, Tokenizer } from './expatTokenizer';
import { parseXmlDecl } from './expatXmlDecl';

// The prolog of expat's xmlparse.c: the XML declaration and the DTD's declarations, by the role of each token.

export abstract class ExpatProlog extends ExpatBase {
  protected abstract doContent(
    tz: Tokenizer,
    startTagLevel: number,
    s: number,
    end: number,
    haveMore: boolean,
    internal: boolean
  ): number;

  protected prologProcessor(start: number, end: number): number {
    const [tok, next] =
      start === 0 && this.input.cs[0] === 0xfe_ff ? [TOK.BOM, 1] : this.tokenizer.prologTok(start, end);
    return this.doProlog(start, end, tok, next);
  }

  // code-gauge-allow functionCognitiveComplexity 22 -- Transcribes expat's C code case by case, as its order of checks decides the errors and their positions.
  protected doProlog(s: number, end: number, tok: number, next: number, inEntity = false): number {
    const haveMore = !this.finalBuffer && !inEntity;
    const tz = this.prologTz;
    for (;;) {
      if (!inEntity) {
        this.eventPtr = s;
        this.eventEndPtr = next;
      }
      if (tok <= 0) {
        const ended = this.prologEnd(tok, s, haveMore, inEntity);
        if (ended !== undefined) return ended;
        if (tok !== -TOK.PROLOG_S) next = end;
        tok = -tok;
      }
      this.accountToken(inEntity, next - s);
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

  /**
   * A token of the prolog that may be incomplete: where the parse stops for more input or at a parameter entity's end,
   * or undefined for a token that ends the input and so is complete.
   */
  private prologEnd(tok: number, s: number, haveMore: boolean, inEntity: boolean): number | undefined {
    if (haveMore && tok !== TOK.INVALID) return s;
    switch (tok) {
      case TOK.INVALID: {
        this.prologEvent(this.eventEndPtr ?? s);
        throw new XmlError(XML_ERROR.INVALID_TOKEN);
      }
      case TOK.NONE: {
        if (!inEntity) throw new XmlError(XML_ERROR.NO_ELEMENTS);
        if (this.prologState.role(TOK.NONE, '') === 'ERROR') throw new XmlError(XML_ERROR.INCOMPLETE_PE);
        return s;
      }
      case TOK.PARTIAL: {
        throw new XmlError(XML_ERROR.UNCLOSED_TOKEN);
      }
      case TOK.PARTIAL_CHAR: {
        throw new XmlError(XML_ERROR.PARTIAL_CHAR);
      }
      default: {
        return undefined;
      }
    }
  }

  /** The actions of a role in the prolog, telling whether the token goes to the default handler. */
  // code-gauge-allow functionNcss 31 -- Transcribes expat's C code case by case, as its order of checks decides the errors and their positions.
  protected prologRole(role: Role, tok: number, s: number, next: number): boolean {
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
  // code-gauge-allow functionCognitiveComplexity 25 -- Transcribes expat's C code case by case, as its order of checks decides the errors and their positions.
  // code-gauge-allow functionNcss 39 -- Transcribes expat's C code case by case, as its order of checks decides the errors and their positions.
  protected paramEntityReference(s: number, next: number): boolean {
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
  protected processParamEntity(entity: Entity): void {
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
  protected prologEvent(ptr: number): void {
    if (!this.prologInternal) this.eventPtr = ptr;
  }

  protected processXmlDecl(s: number, next: number): void {
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
  protected switchEncoding(name: string, nameStart: number, next: number): void {
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

  // code-gauge-allow functionCognitiveComplexity 22 -- Transcribes expat's C code case by case, as its order of checks decides the errors and their positions.
  // code-gauge-allow functionNcss 48 -- Transcribes expat's C code case by case, as its order of checks decides the errors and their positions.
  protected doctypeRole(role: Role, s: number, next: number): boolean {
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

  protected checkPublicId(s: number, next: number): void {
    const bad = badPublicIdChar(this.prologTz.cs, s, next);
    if (bad !== undefined) {
      this.prologEvent(bad);
      throw new XmlError(XML_ERROR.PUBLICID);
    }
  }

  // code-gauge-allow functionCognitiveComplexity 18 -- Transcribes expat's C code case by case, as its order of checks decides the errors and their positions.
  // code-gauge-allow functionNcss 41 -- Transcribes expat's C code case by case, as its order of checks decides the errors and their positions.
  protected entityRole(role: Role, s: number, next: number): boolean {
    const h = this.handlers;
    const dtd = this.dtd;
    const entity = this.declEntity;
    switch (role) {
      case 'GENERAL_ENTITY_NAME':
      case 'PARAM_ENTITY_NAME': {
        return this.entityName(role === 'PARAM_ENTITY_NAME', s, next);
      }
      case 'ENTITY_VALUE': {
        return this.entityValue(s, next);
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

  /** The name of an entity's declaration, of which the first counts and the predefined ones do not. */
  private entityName(isParam: boolean, s: number, next: number): boolean {
    const dtd = this.dtd;
    const name = this.text(this.prologTz, s, next);
    this.declEntity = undefined;
    if (!isParam && name in PREDEFINED_ENTITIES) return true;
    if (!dtd.keepProcessing) return true;
    const table = isParam ? dtd.paramEntities : dtd.generalEntities;
    if (table.has(name)) return true;
    this.declEntity = { name, isParam, open: false, isInternal: this.openParamEntities === 0 };
    table.set(name, this.declEntity);
    return !this.handlers.entityDecl;
  }

  /** An entity's literal value, which the handler gets even when the value is not well-formed, as in expat. */
  private entityValue(s: number, next: number): boolean {
    if (!this.dtd.keepProcessing) return true;
    const h = this.handlers;
    const entity = this.declEntity;
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

  /** `storeEntityValue`: adds the replacement text of an entity's literal, with character references replaced. */
  // code-gauge-allow functionNcss 31 -- Transcribes expat's C code case by case, as its order of checks decides the errors and their positions.
  protected storeEntityValue(start: number, end: number, text: number[]): void {
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

  protected notationRole(role: Role, s: number, next: number): boolean {
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

  // code-gauge-allow functionCognitiveComplexity 21 -- Transcribes expat's C code case by case, as its order of checks decides the errors and their positions.
  // code-gauge-allow functionNcss 53 -- Transcribes expat's C code case by case, as its order of checks decides the errors and their positions.
  protected elementRole(role: Role, tok: number, s: number, next: number): boolean {
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

  protected contentParticle(role: Role, tok: number, s: number, next: number): boolean {
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

  // code-gauge-allow functionCognitiveComplexity 25 -- Transcribes expat's C code case by case, as its order of checks decides the errors and their positions.
  // code-gauge-allow functionNcss 45 -- Transcribes expat's C code case by case, as its order of checks decides the errors and their positions.
  protected attlistRole(role: Role, s: number, next: number): boolean {
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
  protected defineAttribute(value: string | undefined): void {
    const type = this.dtd.elementType(this.declElementType);
    const isId = this.declAttributeType === 'ID';
    if ((value !== undefined || isId) && type.defaults.some((each) => each.name === this.declAttribute)) return;
    type.defaults.push({ name: this.declAttribute, isCdata: this.declAttributeIsCdata, value });
  }

  // Content ---------------------------------------------------------------------------------------------------------
}
