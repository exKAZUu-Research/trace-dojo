// oxlint-disable unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import { decodeRune } from '../literals';
import { currentRuntime } from '../native';
import { grownCapacity } from '../sliceOps';
import { pointerTo, type Type, typeString } from '../types';
import { GoStruct, type Iface, Pointer, Slice, type Value } from '../values';
import { TEXT_UNMARSHALER } from './jsonArshalCore';
import { bitsOf, callValueMethod, implementsInterface, kindOf, newVariable, typeName, zeroValue } from './reflection';
import { parseFloat, parseInt, parseUint, STRCONV_PACKAGE } from './strconv';
import { byteSlice } from './support';
import { isSpace } from './unicodeSupport';
import type { XmlDecoder } from './xmlDecoder';
import { elementType, fieldValue, getTypeInfo, type TypeInfo, type XVal } from './xmlMarshal';
import { attrsToGo, NAME, nameToGo, plainError, UNMARSHALER, type XToken } from './xmlTypes';

type StartToken = Extract<XToken, { kind: 'start' }>;

/** Unmarshals XML elements into a program's values, with the decoder and the Go pointer to it. */
export class XmlUnmarshaler {
  constructor(
    private readonly d: XmlDecoder,
    private readonly decoderPointer: Value
  ) {}

  /** `DecodeElement`. */
  decodeElement(v: Value, start: StartToken | undefined): Value {
    const iface = v as Iface | undefined;
    if (iface === undefined || kindOf(iface.type) !== 'pointer') return plainError('non-pointer passed to Unmarshal');
    if (iface.value === undefined) return plainError('nil pointer passed to Unmarshal');
    const pointer = iface.value as Pointer;
    return this.unmarshal({ type: elementType(iface.type), value: pointer.load(), pointer, readOnly: false }, start);
  }

  /** `Skip`: reads tokens up to the end of the current element. */
  skip(): Value {
    let depth = 0;
    for (;;) {
      const [token, err] = this.d.token();
      if (err !== undefined) return err;
      if (token?.kind === 'start') depth++;
      else if (token?.kind === 'end') {
        if (depth === 0) return undefined;
        depth--;
      }
    }
  }

  // code-gauge-allow functionCognitiveComplexity 60 -- A transcription of Go's Decoder.unmarshal.
  private unmarshal(initial: XVal, startArg: StartToken | undefined): Value {
    currentRuntime().spend();
    if (this.d.stackDepth > 10_000) return plainError('exceeded max depth');
    let start = startArg;
    while (start === undefined) {
      const [token, err] = this.d.token();
      if (err !== undefined) return err;
      if (token?.kind === 'start') start = token;
    }
    let val = initial;
    if (kindOf(val.type) === 'interface' && val.value !== undefined) {
      const inner = val.value as Iface;
      if (kindOf(inner.type) === 'pointer' && inner.value !== undefined) {
        val = { type: inner.type, value: inner.value, readOnly: val.readOnly };
      }
    }
    if (kindOf(val.type) === 'pointer') {
      let target = val.value as Pointer | undefined;
      if (target === undefined) {
        target = newVariable(elementType(val.type));
        val.pointer?.store(target);
      }
      val = { type: elementType(val.type), value: target.load(), pointer: target, readOnly: val.readOnly };
    }
    const methodResult = this.unmarshalWithMethods(val, start);
    if (methodResult !== NO_METHOD) return methodResult;
    let saveData: XVal | undefined;
    let structVal: XVal | undefined;
    let tinfo: TypeInfo | undefined;
    switch (kindOf(val.type)) {
      case 'interface': {
        return this.skip();
      }
      case 'slice': {
        if (isByteKind(elementType(val.type))) {
          saveData = val;
          break;
        }
        return this.unmarshalSliceElement(val, start);
      }
      case 'bool':
      case 'float':
      case 'int':
      case 'uint':
      case 'string': {
        saveData = val;
        break;
      }
      case 'struct': {
        if (val.type === NAME) {
          val.pointer?.store(nameToGo(start.name));
          break;
        }
        structVal = val;
        const info = getTypeInfo(val.type);
        if ('err' in info) return info.err;
        tinfo = info;
        if (info.xmlname) {
          const fv = fieldValue(val, info.xmlname, true);
          if (fv?.type === NAME) fv.pointer?.store(nameToGo(start.name));
        }
        break;
      }
      default: {
        return plainError(`unknown type ${typeString(val.type)}`);
      }
    }
    let data = '';
    for (;;) {
      const [token, err] = this.d.token();
      if (err !== undefined) return err;
      if (token?.kind === 'start') {
        let consumed = false;
        if (structVal && tinfo) {
          const [pathConsumed, pathErr] = this.unmarshalPath(tinfo, structVal, token);
          if (pathErr !== undefined) return pathErr;
          consumed = pathConsumed;
        }
        if (!consumed) {
          const skipErr = this.skip();
          if (skipErr !== undefined) return skipErr;
        }
      } else if (token?.kind === 'end') {
        break;
      } else if (token?.kind === 'chardata' && saveData) {
        data += token.data;
      }
    }
    if (saveData && !saveData.readOnly) {
      if (implementsInterface(saveData.type, TEXT_UNMARSHALER)) {
        const err = callValueMethod(saveData.type, saveData.value, 'UnmarshalText', [byteSlice(data)]) as Value;
        if (err !== undefined) return err;
        saveData = undefined;
      } else if (saveData.pointer && implementsInterface(pointerTo(saveData.type), TEXT_UNMARSHALER)) {
        const err = callValueMethod(pointerTo(saveData.type), saveData.pointer, 'UnmarshalText', [
          byteSlice(data),
        ]) as Value;
        if (err !== undefined) return err;
        saveData = undefined;
      }
    }
    return saveData ? copyValue(saveData, data) : undefined;
  }

  private unmarshalSliceElement(val: XVal, start: StartToken): Value {
    const slice = val.value as Slice | undefined;
    const n = slice?.length ?? 0;
    const capacity = slice?.capacity ?? 0;
    const element = elementType(val.type);
    let grown: Slice;
    if (n + 1 <= capacity && slice) {
      grown = new Slice(slice.array, slice.offset, n + 1, capacity);
    } else {
      const newCapacity = grownCapacity(capacity, n + 1, element);
      currentRuntime().allocate(newCapacity);
      const array = slice ? slice.values() : [];
      while (array.length < newCapacity) array.push(zeroValue(element));
      grown = new Slice(array, 0, n + 1, newCapacity);
    }
    val.pointer?.store(grown);
    const elementPointer = new Pointer(grown.array, grown.offset + n);
    const err = this.unmarshal(
      { type: element, value: elementPointer.load(), pointer: elementPointer, readOnly: val.readOnly },
      start
    );
    if (err !== undefined) val.pointer?.store(new Slice(grown.array, grown.offset, n, grown.capacity));
    return err;
  }

  /** The UnmarshalXML and UnmarshalText methods of a value or its address, as unmarshal tries them. */
  private unmarshalWithMethods(val: XVal, start: StartToken): Value | typeof NO_METHOD {
    if (val.readOnly) return NO_METHOD;
    const pointerType = pointerTo(val.type);
    if (implementsInterface(val.type, UNMARSHALER)) return this.unmarshalInterface(val.type, val.value, start);
    if (val.pointer && implementsInterface(pointerType, UNMARSHALER)) {
      return this.unmarshalInterface(pointerType, val.pointer, start);
    }
    if (implementsInterface(val.type, TEXT_UNMARSHALER)) return this.unmarshalText(val.type, val.value);
    if (val.pointer && implementsInterface(pointerType, TEXT_UNMARSHALER)) {
      return this.unmarshalText(pointerType, val.pointer);
    }
    return NO_METHOD;
  }

  private unmarshalInterface(type: Type, receiver: Value, start: StartToken): Value {
    this.d.pushEOF();
    const saved = this.d.inUnmarshalXML;
    this.d.inUnmarshalXML = true;
    let err: Value;
    try {
      const startValue = new GoStruct([nameToGo(start.name), attrsToGo(start.attr)]);
      err = callValueMethod(type, receiver, 'UnmarshalXML', [this.decoderPointer, startValue]) as Value;
    } finally {
      this.d.inUnmarshalXML = saved;
    }
    if (err !== undefined) {
      this.d.popEOF();
      return err;
    }
    if (!this.d.popEOF()) {
      const typeText = typeName(type) === '' ? `(${typeString(type)})` : typeString(type);
      return plainError(`xml: ${typeText}.UnmarshalXML did not consume entire <${start.name.local}> element`);
    }
    return undefined;
  }

  private unmarshalText(type: Type, receiver: Value): Value {
    let buf = '';
    let depth = 1;
    while (depth > 0) {
      const [token, err] = this.d.token();
      if (err !== undefined) return err;
      if (token?.kind === 'chardata' && depth === 1) buf += token.data;
      else if (token?.kind === 'start') depth++;
      else if (token?.kind === 'end') depth--;
    }
    return callValueMethod(type, receiver, 'UnmarshalText', [byteSlice(buf)]) as Value;
  }

  /** `unmarshalPath` for fields without parent paths: the struct field named by the element, if any. */
  private unmarshalPath(tinfo: TypeInfo, sv: XVal, start: StartToken): [boolean, Value] {
    for (const finfo of tinfo.fields) {
      if (finfo.name === start.name.local) {
        return [true, this.unmarshal(fieldValue(sv, finfo, true) as XVal, start)];
      }
    }
    return [false, undefined];
  }
}

const NO_METHOD = Symbol('no method');

function isByteKind(type: Type): boolean {
  return kindOf(type) === 'uint' && bitsOf(type) === 8;
}

/** `strings.TrimSpace` of UTF-8 bytes. */
export function trimSpace(s: string): string {
  let start = 0;
  while (start < s.length) {
    const { rune, size } = decodeRune(s, start);
    if (!isSpace(rune)) break;
    start += size;
  }
  let end = s.length;
  while (end > start) {
    let begin = end - 1;
    while (begin > start && (s.charCodeAt(begin) & 0xc0) === 0x80) begin--;
    const { rune, size } = decodeRune(s, begin);
    if (begin + size !== end || !isSpace(rune)) break;
    end = begin;
  }
  return s.slice(start, end);
}

/** `copyValue`: parses character data into a basic value or byte slice. */
// code-gauge-allow functionCognitiveComplexity 25 -- One case per kind, as Go's copyValue.
function copyValue(dst0: XVal, src: string): Value {
  let dst = dst0;
  if (kindOf(dst.type) === 'pointer') {
    let target = dst.value as Pointer | undefined;
    if (target === undefined) {
      target = newVariable(elementType(dst.type));
      dst.pointer?.store(target);
    }
    dst = { type: elementType(dst.type), value: target.load(), pointer: target, readOnly: dst.readOnly };
  }
  const set = (value: Value): Value => {
    dst.pointer?.store(value);
    return undefined;
  };
  const bits = bitsOf(dst.type);
  switch (kindOf(dst.type)) {
    case 'int': {
      if (src.length === 0) return set(0n);
      const [value, err] = parseInt(trimSpace(src), 10, bits, 'ParseInt');
      return err ?? set(value);
    }
    case 'uint': {
      if (src.length === 0) return set(0n);
      const [value, err] = parseUint(trimSpace(src), 10, bits, 'ParseUint');
      return err ?? set(value);
    }
    case 'float': {
      if (src.length === 0) return set(0);
      const [value, err] = parseFloat(trimSpace(src), bits);
      return err ?? set(value);
    }
    case 'bool': {
      if (src.length === 0) return set(false);
      const parseBool = STRCONV_PACKAGE.members.get('ParseBool') as unknown as { direct: (args: Value[]) => Value[] };
      const [value, err] = parseBool.direct([trimSpace(src)]);
      return err ?? set(value);
    }
    case 'string': {
      return set(src);
    }
    case 'slice': {
      return set(byteSlice(src));
    }
    default: {
      return plainError(`cannot unmarshal into ${typeString(dst0.type)}`);
    }
  }
}
