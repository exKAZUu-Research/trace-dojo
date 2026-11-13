// code-gauge-allow-file fileNcss 512 -- One port of Go's encoding package source, whose parts share its state and helpers.
// oxlint-disable unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import { formatFloat } from '../floatFormat';
import { decodeRune, RUNE_ERROR } from '../literals';
import { currentRuntime } from '../native';
import { type Field, pointerTo, type Type, typeIdentityKey, typeString, underlying } from '../types';
import { type GoArray, GoStruct, type Iface, Pointer, Slice, type Value } from '../values';
import { ERR_SHORT_WRITE } from './io';
import { TEXT_MARSHALER } from './jsonArshalCore';
import {
  bitsOf,
  callValueMethod,
  exported,
  fieldName,
  implementsInterface,
  kindOf,
  newVariable,
  structOf,
  typeName,
} from './reflection';
import { byteSlice, bytesOf, callMethod } from './support';
import { isInCharacterRange, isName, XML_URL } from './xmlDecoder';
import {
  attrsToGo,
  MARSHALER,
  NAME,
  nameToGo,
  plainError,
  tagPathError,
  unsupportedTypeError,
  type XAttr,
  type XName,
  type XToken,
} from './xmlTypes';

// Type information ----------------------------------------------------------------------------------------------------

export interface FieldInfo {
  /** The indexes of the embedded fields to go through and then of the field itself. */
  idx: number[];
  name: string;
}

export interface TypeInfo {
  xmlname?: FieldInfo;
  fields: FieldInfo[];
}

const typeInfoCache = new Map<string, TypeInfo>();

/** `getTypeInfo` for structs without tags: an element for each exported field, and the XMLName field. */
export function getTypeInfo(type: Type): TypeInfo | { err: Value } {
  const key = typeIdentityKey(type);
  const cached = typeInfoCache.get(key);
  if (cached) return cached;
  const info: TypeInfo = { fields: [] };
  const struct = structOf(type);
  if (struct && type !== NAME) {
    for (const [i, field] of struct.fields.entries()) {
      const err = addField(type, info, i, field);
      if (err !== undefined) return { err };
    }
  }
  typeInfoCache.set(key, info);
  return info;
}

/** Adds a struct field, or the fields an embedded struct promotes, returning a TagPathError for a conflict. */
function addField(type: Type, info: TypeInfo, i: number, field: Field): Value {
  if (!exported(field.name) && !field.embedded) return undefined;
  const inner = kindOf(field.type) === 'pointer' ? elementType(field.type) : field.type;
  if (field.embedded && kindOf(inner) === 'struct') {
    const innerInfo = getTypeInfo(inner);
    if ('err' in innerInfo) return innerInfo.err;
    info.xmlname ??= innerInfo.xmlname;
    for (const finfo of innerInfo.fields) {
      const err = addFieldInfo(type, info, { idx: [i, ...finfo.idx], name: finfo.name });
      if (err !== undefined) return err;
    }
    return undefined;
  }
  const name = fieldName(field.name);
  if (name !== 'XMLName') return addFieldInfo(type, info, { idx: [i], name });
  info.xmlname = { idx: [i], name: '' };
  return undefined;
}

function addFieldInfo(type: Type, info: TypeInfo, field: FieldInfo): Value {
  const conflicts = info.fields.flatMap((old, index) => (old.name === field.name ? [index] : []));
  if (conflicts.length === 0) {
    info.fields.push(field);
    return undefined;
  }
  if (conflicts.some((index) => info.fields[index].idx.length < field.idx.length)) return undefined;
  for (const index of conflicts) {
    const old = info.fields[index];
    if (old.idx.length === field.idx.length) {
      return tagPathError(type, fieldNameAt(type, old.idx), fieldNameAt(type, field.idx));
    }
  }
  for (const index of conflicts.toReversed()) info.fields.splice(index, 1);
  info.fields.push(field);
  return undefined;
}

function fieldNameAt(type: Type, idx: number[]): string {
  let current = type;
  let name = '';
  for (const i of idx) {
    if (kindOf(current) === 'pointer') current = elementType(current);
    const field = (structOf(current) as { fields: { name: string; type: Type }[] }).fields[i];
    name = fieldName(field.name);
    current = field.type;
  }
  return name;
}

export function elementType(type: Type): Type {
  return (underlying(type) as { element: Type }).element;
}

/** A value being marshaled or unmarshaled: its type, its variable when addressable, and whether methods may be called. */
export interface XVal {
  type: Type;
  value: Value;
  pointer?: Pointer;
  /** Reached through an unexported field, so that reflection cannot call its methods. */
  readOnly: boolean;
}

/** `fieldInfo.value`: the field's value, going through embedded pointers and allocating nil ones when asked. */
export function fieldValue(val: XVal, finfo: FieldInfo, initNilPointers: boolean): XVal | undefined {
  let current = val;
  for (const [step, i] of finfo.idx.entries()) {
    if (step > 0 && kindOf(current.type) === 'pointer' && kindOf(elementType(current.type)) === 'struct') {
      if (current.value === undefined) {
        if (!initNilPointers) return undefined;
        const target = newVariable(elementType(current.type));
        current.pointer?.store(target);
        current = { ...current, value: target };
      }
      const target = current.value as Pointer;
      current = { type: elementType(current.type), value: target.load(), pointer: target, readOnly: current.readOnly };
    }
    const struct = current.value as GoStruct;
    const field = (structOf(current.type) as { fields: { name: string; type: Type; embedded: boolean }[] }).fields[i];
    current = {
      type: field.type,
      value: struct.fields[i],
      pointer: current.pointer ? new Pointer(struct.fields, i) : undefined,
      readOnly: current.readOnly || (!exported(field.name) && kindOf(field.type) !== 'struct'),
    };
  }
  return current;
}

// Printer -------------------------------------------------------------------------------------------------------------

/** Writes bytes to the destination of an encoder, returning the count written and any error. */
export type WriteFunction = (bytes: string) => [number, Value];

/** A write function calling an io.Writer's Write method. */
export function goWriter(writer: Value): WriteFunction {
  return (bytes) => {
    const [count, err] = callMethod(writer, 'Write', [byteSlice(bytes)]) as [bigint, Value];
    return [Number(count), err];
  };
}

/** `bufio.Writer` over the encoder's io.Writer, with Go's 4096-byte buffer. */
class BufferedWriter {
  private buf = '';
  err: Value;

  constructor(private readonly writeTo: WriteFunction) {}

  buffered(): number {
    return this.buf.length;
  }

  write(data: string): Value {
    let p = data;
    while (p.length > 4096 - this.buf.length && this.err === undefined) {
      let n: number;
      if (this.buf.length === 0) {
        [n, this.err] = this.writeTo(p);
      } else {
        n = 4096 - this.buf.length;
        this.buf += p.slice(0, n);
        this.flush();
      }
      p = p.slice(n);
    }
    if (this.err !== undefined) return this.err;
    this.buf += p;
    return undefined;
  }

  flush(): Value {
    if (this.err !== undefined) return this.err;
    if (this.buf.length === 0) return undefined;
    const [n, err] = this.writeTo(this.buf);
    let error = err;
    if (n < this.buf.length && error === undefined) error = ERR_SHORT_WRITE;
    if (error !== undefined) {
      if (n > 0 && n < this.buf.length) this.buf = this.buf.slice(n);
      this.err = error;
      return error;
    }
    this.buf = '';
    return undefined;
  }
}

/** `xml.printer`: the state of an Encoder. */
export class Printer {
  readonly w: BufferedWriter;
  /** The pointer to the Encoder that MarshalXML methods receive. */
  encoder: Value;
  private seq = 0;
  indent = '';
  prefix = '';
  private depth = 0;
  private indentedIn = false;
  private putNewline = false;
  private readonly attrNS = new Map<string, string>();
  private readonly attrPrefix = new Map<string, string>();
  private prefixes: string[] = [];
  tags: XName[] = [];
  private closed = false;
  err: Value;

  constructor(writeTo: WriteFunction) {
    this.w = new BufferedWriter(writeTo);
  }

  writeString(s: string): void {
    currentRuntime().spend(1 + Math.floor(s.length / 64));
    if (this.closed && this.err === undefined) this.err = plainError('use of closed Encoder');
    if (this.err === undefined && s.length > 0) this.err = this.w.write(s);
  }

  cachedWriteError(): Value {
    this.writeString('');
    return this.err;
  }

  close(): Value {
    if (this.closed) return undefined;
    this.closed = true;
    const err = this.w.flush();
    if (err !== undefined) return err;
    if (this.tags.length > 0) return plainError(`unclosed tag <${(this.tags.at(-1) as XName).local}>`);
    return undefined;
  }

  private createAttrPrefix(url: string): string {
    const existing = this.attrPrefix.get(url);
    if (existing) return existing;
    if (url === XML_URL) return 'xml';
    let prefix = url.replace(/\/+$/, '');
    const slash = prefix.lastIndexOf('/');
    if (slash !== -1) prefix = prefix.slice(slash + 1);
    if (prefix === '' || !isName(prefix) || prefix.includes(':')) prefix = '_';
    if (prefix.length >= 3 && prefix.slice(0, 3).toLowerCase() === 'xml') prefix = `_${prefix}`;
    if (this.attrNS.get(prefix)) {
      for (this.seq++; ; this.seq++) {
        const id = `${prefix}_${this.seq}`;
        if (!this.attrNS.get(id)) {
          prefix = id;
          break;
        }
      }
    }
    this.attrPrefix.set(url, prefix);
    this.attrNS.set(prefix, url);
    this.writeString(`xmlns:${prefix}="`);
    this.writeString(escapeText(url, true));
    this.writeString('" ');
    this.prefixes.push(prefix);
    return prefix;
  }

  private popPrefix(): void {
    while (this.prefixes.length > 0) {
      const prefix = this.prefixes.pop() as string;
      if (prefix === '') break;
      this.attrPrefix.delete(this.attrNS.get(prefix) as string);
      this.attrNS.delete(prefix);
    }
  }

  writeStart(start: { name: XName; attr: XAttr[] }): Value {
    if (start.name.local === '') return plainError('xml: start tag with no name');
    this.tags.push(start.name);
    this.prefixes.push('');
    this.writeIndent(1);
    this.writeString(`<${start.name.local}`);
    if (start.name.space !== '') this.writeString(` xmlns="${escapeString(start.name.space)}"`);
    for (const attr of start.attr) {
      if (attr.name.local === '') continue;
      this.writeString(' ');
      if (attr.name.space !== '') this.writeString(`${this.createAttrPrefix(attr.name.space)}:`);
      this.writeString(`${attr.name.local}="${escapeString(attr.value)}"`);
    }
    this.writeString('>');
    return undefined;
  }

  writeEnd(name: XName): Value {
    if (name.local === '') return plainError('xml: end tag with no name');
    const top = this.tags.at(-1);
    if (top === undefined || top.local === '') return plainError(`xml: end tag </${name.local}> without start tag`);
    if (top.local !== name.local || top.space !== name.space) {
      if (top.local !== name.local) {
        return plainError(`xml: end tag </${name.local}> does not match start tag <${top.local}>`);
      }
      return plainError(
        `xml: end tag </${name.local}> in namespace ${name.space} does not match start tag <${top.local}> in namespace ${top.space}`
      );
    }
    this.tags.pop();
    this.writeIndent(-1);
    this.writeString(`</${name.local}>`);
    this.popPrefix();
    return undefined;
  }

  private writeIndent(depthDelta: number): void {
    if (this.prefix.length === 0 && this.indent.length === 0) return;
    if (depthDelta < 0) {
      this.depth--;
      if (this.indentedIn) {
        this.indentedIn = false;
        return;
      }
      this.indentedIn = false;
    }
    if (this.putNewline) this.writeString('\n');
    else this.putNewline = true;
    if (this.prefix.length > 0) this.writeString(this.prefix);
    if (this.indent.length > 0) this.writeString(this.indent.repeat(this.depth));
    if (depthDelta > 0) {
      this.depth++;
      this.indentedIn = true;
    }
  }

  /** `EncodeToken`. */
  // code-gauge-allow functionNcss 36 -- A transcription of Go's encodeToken, step by step.
  // code-gauge-allow functionCognitiveComplexity 16 -- A transcription of Go's encodeToken, step by step.
  encodeToken(token: XToken | undefined): Value {
    if (token === undefined) return plainError('xml: EncodeToken of invalid token type');
    let err: Value;
    switch (token.kind) {
      case 'start': {
        err = this.writeStart(token);
        break;
      }
      case 'end': {
        err = this.writeEnd(token.name);
        break;
      }
      case 'chardata': {
        this.writeString(escapeText(token.data, false));
        break;
      }
      case 'comment': {
        if (token.data.includes('-->')) return plainError('xml: EncodeToken of Comment containing --> marker');
        this.writeString(`<!--${token.data}-->`);
        break;
      }
      case 'procinst': {
        if (token.target === 'xml' && this.w.buffered() !== 0) {
          return plainError(
            'xml: EncodeToken of ProcInst xml target only valid for xml declaration, first token encoded'
          );
        }
        if (!isName(token.target)) return plainError('xml: EncodeToken of ProcInst with invalid Target');
        if (token.inst.includes('?>')) return plainError('xml: EncodeToken of ProcInst containing ?> marker');
        this.writeString(`<?${token.target}${token.inst.length > 0 ? ` ${token.inst}` : ''}?>`);
        break;
      }
      case 'directive': {
        if (!isValidDirective(token.data)) {
          return plainError('xml: EncodeToken of Directive containing wrong < or > markers');
        }
        this.writeString(`<!${token.data}>`);
        break;
      }
    }
    if (err !== undefined) return err;
    return this.cachedWriteError();
  }

  // Marshaling ---------------------------------------------------------------------------------------------------------

  /** `marshalValue`. */
  // code-gauge-allow functionNcss 32 -- A transcription of Go's marshalValue, step by step.
  // code-gauge-allow functionCognitiveComplexity 16 -- A transcription of Go's marshalValue, step by step.
  marshalValue(initial: XVal | undefined, finfo: FieldInfo | undefined, startTemplate: XToken | undefined): Value {
    currentRuntime().spend();
    if (startTemplate?.kind === 'start' && startTemplate.name.local === '') {
      return plainError('xml: EncodeElement of StartElement with missing name');
    }
    const val = initial && indirect(initial);
    if (val === undefined) return undefined;
    const { type } = val;
    const kind = kindOf(type);
    const methodResult = this.marshalWithMethods(val, finfo, startTemplate);
    if (methodResult !== NO_METHOD) return methodResult;
    if ((kind === 'slice' || kind === 'array') && !isByteKind(elementType(type))) {
      return this.marshalElements(val, finfo, startTemplate);
    }
    const tinfo = getTypeInfo(type);
    if ('err' in tinfo) return tinfo.err;
    const start = this.startElementOf(val, tinfo, finfo, startTemplate);
    if (!('name' in start)) return start.err;
    let err = this.writeStart(start);
    if (err !== undefined) return err;
    if (kind === 'struct') {
      err = this.marshalStruct(tinfo, val);
    } else {
      const [text, simpleErr] = marshalSimple(val);
      if (simpleErr !== undefined) err = simpleErr;
      else this.writeString(escapeText(text, true));
    }
    return err ?? this.writeEnd(start.name) ?? this.cachedWriteError();
  }

  /** Marshals each element of a slice or array with the same field and start element. */
  private marshalElements(val: XVal, finfo: FieldInfo | undefined, startTemplate: XToken | undefined): Value {
    const list = val.value as Slice | GoArray | undefined;
    if (list === undefined) return undefined;
    const isSlice = list instanceof Slice;
    const values = isSlice ? list.values() : list.elements;
    for (const [i, element] of values.entries()) {
      let pointer: Pointer | undefined;
      if (isSlice) pointer = new Pointer(list.array, list.offset + i);
      else if (val.pointer) pointer = new Pointer(list.elements, i);
      const err = this.marshalValue(
        { type: elementType(val.type), value: element, pointer, readOnly: val.readOnly },
        finfo,
        startTemplate
      );
      if (err !== undefined) return err;
    }
    return undefined;
  }

  /** The start element of a value: the template, the XMLName field's value, the field's name, or the type's name. */
  private startElementOf(
    val: XVal,
    tinfo: TypeInfo,
    finfo: FieldInfo | undefined,
    startTemplate: XToken | undefined
  ): { name: XName; attr: XAttr[] } | { err: Value } {
    const start: { name: XName; attr: XAttr[] } = { name: { space: '', local: '' }, attr: [] };
    if (startTemplate?.kind === 'start') {
      start.name = { ...startTemplate.name };
      start.attr = [...startTemplate.attr];
    } else if (tinfo.xmlname) {
      const fv = fieldValue(val, tinfo.xmlname, false);
      const [space, local] = fv?.type === NAME ? ((fv.value as GoStruct).fields as [string, string]) : ['', ''];
      if (local !== '') start.name = { space, local };
    }
    if (start.name.local === '' && finfo) start.name = { space: '', local: finfo.name };
    if (start.name.local === '') {
      const name = typeName(val.type).replace(/\[.*$/, '');
      if (name === '') return { err: unsupportedTypeError(val.type) };
      start.name.local = name;
    }
    if (tinfo.xmlname && start.name.space === '' && this.tags.length > 0 && (this.tags.at(-1) as XName).space !== '') {
      start.attr.push({ name: { space: '', local: 'xmlns' }, value: '' });
    }
    return start;
  }
  // code-gauge-allow duplicateLines 15 -- Marshaling and unmarshaling each try the methods of a value and of its address, as Go does.
  /** The MarshalXML and MarshalText methods of a value or its address, as marshalValue tries them. */
  private marshalWithMethods(
    val: XVal,
    finfo: FieldInfo | undefined,
    startTemplate: XToken | undefined
  ): Value | typeof NO_METHOD {
    if (val.readOnly) return NO_METHOD;
    const pointerType = pointerTo(val.type);
    if (implementsInterface(val.type, MARSHALER)) {
      return this.marshalInterface(val.type, val.value, defaultStart(val.type, finfo, startTemplate));
    }
    if (val.pointer && implementsInterface(pointerType, MARSHALER)) {
      return this.marshalInterface(pointerType, val.pointer, defaultStart(pointerType, finfo, startTemplate));
    }
    if (implementsInterface(val.type, TEXT_MARSHALER)) {
      return this.marshalText(val.type, val.value, defaultStart(val.type, finfo, startTemplate));
    }
    if (val.pointer && implementsInterface(pointerType, TEXT_MARSHALER)) {
      return this.marshalText(pointerType, val.pointer, defaultStart(pointerType, finfo, startTemplate));
    }
    return NO_METHOD;
  }

  private marshalInterface(type: Type, receiver: Value, start: { name: XName; attr: XAttr[] }): Value {
    this.tags.push({ space: '', local: '' });
    const n = this.tags.length;
    const startValue = new GoStruct([nameToGo(start.name), attrsToGo(start.attr)]);
    const err = callValueMethod(type, receiver, 'MarshalXML', [this.encoder, startValue]) as Value;
    if (err !== undefined) return err;
    if (this.tags.length > n) {
      const typeText = typeName(type) === '' ? `(${typeString(type)})` : typeString(type);
      return plainError(
        `xml: ${typeText}.MarshalXML wrote invalid XML: <${(this.tags.at(-1) as XName).local}> not closed`
      );
    }
    this.tags = this.tags.slice(0, n - 1);
    return undefined;
  }

  private marshalText(type: Type, receiver: Value, start: { name: XName; attr: XAttr[] }): Value {
    const err = this.writeStart(start);
    if (err !== undefined) return err;
    const [text, textErr] = callValueMethod(type, receiver, 'MarshalText', []) as [Value, Value];
    if (textErr !== undefined) return textErr;
    this.writeString(escapeText(bytesOf(text), true));
    return this.writeEnd(start.name);
  }

  private marshalStruct(tinfo: TypeInfo, val: XVal): Value {
    for (const finfo of tinfo.fields) {
      const vf = fieldValue(val, finfo, false);
      if (!vf) continue;
      const err = this.marshalValue(vf, finfo, undefined);
      if (err !== undefined) return err;
    }
    return this.cachedWriteError();
  }
}

const NO_METHOD = Symbol('no method');

/** Follows interfaces and pointers to the value they hold, or undefined for a nil one. */
function indirect(initial: XVal): XVal | undefined {
  let val = initial;
  for (;;) {
    const kind = kindOf(val.type);
    if (kind !== 'interface' && kind !== 'pointer') return val;
    if (val.value === undefined) return undefined;
    if (kind === 'interface') {
      const iface = val.value as Iface;
      val = { type: iface.type, value: iface.value, readOnly: val.readOnly };
    } else {
      const pointer = val.value as Pointer;
      val = { type: elementType(val.type), value: pointer.load(), pointer, readOnly: val.readOnly };
    }
  }
}

function isByteKind(type: Type): boolean {
  return kindOf(type) === 'uint' && bitsOf(type) === 8;
}

/** `defaultStart`: the start element for a value marshaled by its methods. */
function defaultStart(
  type: Type,
  finfo: FieldInfo | undefined,
  startTemplate: XToken | undefined
): { name: XName; attr: XAttr[] } {
  if (startTemplate?.kind === 'start') return { name: { ...startTemplate.name }, attr: [...startTemplate.attr] };
  if (finfo && finfo.name !== '') return { name: { space: '', local: finfo.name }, attr: [] };
  if (typeName(type) !== '') return { name: { space: '', local: typeName(type) }, attr: [] };
  return { name: { space: '', local: typeName(elementType(type)) }, attr: [] };
}

/** `marshalSimple`: the text of a basic value or byte array, or UnsupportedTypeError. */
function marshalSimple(val: XVal): [string, Value] {
  const { type, value } = val;
  switch (kindOf(type)) {
    case 'int':
    case 'uint': {
      return [String(value as bigint), undefined];
    }
    case 'float': {
      return [formatFloat(value as number, 'g', -1, bitsOf(type) as 32 | 64), undefined];
    }
    case 'string': {
      return [value as string, undefined];
    }
    case 'bool': {
      return [value ? 'true' : 'false', undefined];
    }
    case 'array': {
      if (isByteKind(elementType(type))) {
        return [(value as GoArray).elements.map((byte) => String.fromCharCode(Number(byte))).join(''), undefined];
      }
      break;
    }
    case 'slice': {
      if (isByteKind(elementType(type))) return [bytesOf(value), undefined];
      break;
    }
  }
  return ['', unsupportedTypeError(type)];
}

const ESCAPES: Record<string, string> = {
  '"': '&#34;',
  "'": '&#39;',
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '\t': '&#x9;',
  '\n': '&#xA;',
  '\r': '&#xD;',
};

/** `escapeText`: the text with XML's special characters escaped, newlines too when `escapeNewline`. */
export function escapeText(s: string, escapeNewline: boolean): string {
  return escapePieces(s, escapeNewline).join('');
}

/** The pieces that Go's escapeText writes with one Write call each: text and escapes alternating, then the rest. */
export function escapePieces(s: string, escapeNewline: boolean): string[] {
  const pieces: string[] = [];
  let last = 0;
  for (let i = 0; i < s.length;) {
    const { rune, size } = decodeRune(s, i);
    i += size;
    let esc: string | undefined = rune < 0x80 ? ESCAPES[String.fromCharCode(rune)] : undefined;
    if (rune === 0x0a && !escapeNewline) continue;
    if (esc === undefined) {
      if (!isInCharacterRange(rune) || (rune === RUNE_ERROR && size === 1)) esc = '\u00EF\u00BF\u00BD';
      else continue;
    }
    pieces.push(s.slice(last, i - size), esc);
    last = i;
  }
  pieces.push(s.slice(last));
  return pieces;
}

/** `EscapeString`, which always escapes newlines. */
export function escapeString(s: string): string {
  return escapeText(s, true);
}

// code-gauge-allow functionCognitiveComplexity 28 -- A transcription of Go's isValidDirective, step by step.
function isValidDirective(dir: string): boolean {
  let depth = 0;
  let inquote = '';
  let incomment = false;
  for (let i = 0; i < dir.length; i++) {
    const c = dir[i];
    if (incomment) {
      if (c === '>') {
        const n = 1 + i - 3;
        if (n >= 0 && dir.slice(n, i + 1) === '-->') incomment = false;
      }
    } else if (inquote !== '') {
      if (c === inquote) inquote = '';
    } else if (c === "'" || c === '"') inquote = c;
    else if (c === '<') {
      if (i + 4 < dir.length && dir.slice(i, i + 4) === '<!--') incomment = true;
      else depth++;
    } else if (c === '>') {
      if (depth === 0) return false;
      depth--;
    }
  }
  return depth === 0 && inquote === '' && !incomment;
}
