// oxlint-disable unicorn/prefer-code-point -- Each code unit is one PHP byte.
import { detectionCodePoint, mobileDetectionTable } from './detectionDecodeTables';
import { decodeEucCn, decodeGb18030 } from './gb18030Detection';
import { readExtendedJisEncoding, readJisEncoding } from './jisDetectionReader';
import { legacyDetectionCodePoint } from './legacyDetectionTables';
import { rt } from './runtime';

const BAD = -1;
const TABLE_REPLACEMENT = 0xff_fd;
const PLANE_WIDTH = 94;
const PLANE_SIZE = PLANE_WIDTH * PLANE_WIDTH;
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const IMAP_BASE64 = BASE64.slice(0, -1) + ',';
const MOBILE_CARRIERS = ['DOCOMO', 'KDDI-A', 'KDDI-B', 'SOFTBANK'];
type Decode = (bytes: string) => number[];

const FIXED_READERS = new Map<string, Decode>([
  ['GB18030', (bytes) => decodeGb18030(bytes, false, BAD)],
  ['GB18030-2022', (bytes) => decodeGb18030(bytes, true, BAD)],
  ['EUC-CN', (bytes) => decodeEucCn(bytes, BAD)],
  ['JIS', readJisCodes],
  ['ISO-2022-JP', readJisCodes],
  ['CP50220', readCp5022x],
  ['CP50221', readCp5022x],
  ['CP50222', readCp5022x],
  ['ISO-2022-JP-MS', (bytes) => readExtendedJisEncoding(bytes, 'ms')],
  ['ISO-2022-JP-2004', (bytes) => readExtendedJisEncoding(bytes, '2004')],
  ['EUC-KR', (bytes) => decodeMappedPairs(bytes, false)],
  ['CP950', (bytes) => decodeMappedPairs(bytes, true)],
  ['EUC-TW', decodeEucTw],
]);

export function encodingValidator(name: string, utf16: Decode): ((bytes: string) => boolean) | undefined {
  if (name === 'UTF-7' || name === 'UTF7-IMAP') {
    return (bytes) => !decodeShiftedUtf16(bytes, name === 'UTF7-IMAP', utf16, true).includes(BAD);
  }
  if (name === 'JIS' || name === 'ISO-2022-JP') return (bytes) => readJisEncoding(bytes, name === 'ISO-2022-JP').valid;
}

export function extraEncodingReader(name: string, utf8: Decode, utf16: Decode): Decode | undefined {
  const reader = FIXED_READERS.get(name);
  if (reader) return reader;
  if (name.startsWith('UTF-8-Mobile#')) return mobileReader(name, utf8);
  if (name.startsWith('UCS-')) {
    const size = name[4] === '2' ? 2 : 4;
    return (bytes) => decodeFixedWidth(bytes, size, name.endsWith('LE'), name.length === 5);
  }
  switch (name) {
    case 'ArmSCII-8':
    case 'CP850': {
      const offset = name === 'CP850' ? 256 : 0;
      return (bytes) => {
        rt().spend(Math.ceil(bytes.length / 64));
        return Array.from(bytes, (byte) => tableCode(offset + byte.charCodeAt(0)));
      };
    }
    case 'SJIS':
    case 'CP932': {
      const offset = 512 + 3 * PLANE_SIZE + (name === 'CP932' ? 256 + 60 * 189 : 0);
      return (bytes) => decodeShiftJis(bytes, offset, name === 'CP932');
    }
    case 'UTF-7':
    case 'UTF7-IMAP': {
      return (bytes) => decodeShiftedUtf16(bytes, name === 'UTF7-IMAP', utf16);
    }
    case 'HZ':
    case 'ISO-2022-KR': {
      const hz = name === 'HZ';
      const decoder = new TextDecoder(hz ? 'gbk' : 'euc-kr');
      return (bytes) => decodeShiftedPairs(bytes, hz, decoder);
    }
  }
  return undefined;
}

function readJisCodes(bytes: string): number[] {
  return readJisEncoding(bytes).codes;
}

function readCp5022x(bytes: string): number[] {
  return readExtendedJisEncoding(bytes, 'cp5022x');
}

function decodeMappedPairs(bytes: string, cp950: boolean): number[] {
  const result: number[] = [];
  const validLead = cp950 ? (lead: number) => lead >= 0x81 && lead <= 0xfe : isEucKrLead;
  const table = cp950 ? 'cp950' : 'eucKr';
  const width = cp950 ? 157 : PLANE_WIDTH;
  const firstLead = cp950 ? 0x81 : 0xa1;
  rt().spend(Math.ceil(bytes.length / 64));
  for (let at = 0; at < bytes.length;) {
    const lead = bytes.charCodeAt(at++);
    if (lead < 0x80) {
      result.push(lead);
      continue;
    }
    if (!validLead(lead) || at === bytes.length) {
      result.push(BAD);
      continue;
    }
    const trail = bytes.charCodeAt(at++);
    const column = mappedPairColumn(trail, cp950);
    const code = column < 0 ? TABLE_REPLACEMENT : legacyDetectionCodePoint(table, (lead - firstLead) * width + column);
    result.push(code === TABLE_REPLACEMENT ? BAD : code);
  }
  return result;
}

function isEucKrLead(lead: number): boolean {
  return (lead >= 0xa1 && lead <= 0xac) || (lead >= 0xb0 && lead <= 0xfd && lead !== 0xc9);
}

function mappedPairColumn(trail: number, cp950: boolean): number {
  if (cp950 && trail >= 0x40 && trail <= 0x7e) return trail - 0x40;
  if (trail >= 0xa1 && trail <= 0xfe) return trail - 0xa1 + (cp950 ? 63 : 0);
  return -1;
}

function mobileReader(name: string, utf8: Decode): Decode {
  const table = mobileDetectionTable(MOBILE_CARRIERS.indexOf(name.slice('UTF-8-Mobile#'.length)));
  return (bytes) => utf8(bytes).flatMap((code) => table.get(code) ?? code);
}

function decodeFixedWidth(bytes: string, size: 2 | 4, little: boolean, useBom: boolean): number[] {
  const buffer = Buffer.from(bytes, 'latin1');
  let index = 0;
  if (useBom && bytes.length >= size) {
    const bom = buffer.readUIntBE(0, size);
    if (bom === 0xfe_ff || bom === (size === 2 ? 0xff_fe : 0xff_fe_00_00)) {
      index = size;
      little = bom !== 0xfe_ff;
    }
  }
  const values: number[] = [];
  rt().spend(Math.ceil(bytes.length / 64));
  for (; index + size <= bytes.length; index += size) {
    const code = little ? buffer.readUIntLE(index, size) : buffer.readUIntBE(index, size);
    values.push(code === 0xff_ff_ff_ff ? BAD : code);
  }
  if (index !== bytes.length) values.push(BAD);
  return values;
}

function tableCode(index: number): number {
  const code = detectionCodePoint(index);
  return code === TABLE_REPLACEMENT ? BAD : code;
}

function decodeEucTw(bytes: string): number[] {
  const result: number[] = [];
  rt().spend(Math.ceil(bytes.length / 64));
  for (let at = 0; at < bytes.length;) {
    let lead = bytes.charCodeAt(at++);
    if (lead < 0x80) {
      result.push(lead);
      continue;
    }
    let plane = 0;
    if (lead === 0x8e) {
      const selector = bytes.charCodeAt(at++);
      plane = [0xa1, 0xa2, 0xae].indexOf(selector);
      if (plane !== -1) lead = bytes.charCodeAt(at++);
    }
    if (!taiwaneseLead(lead, plane)) {
      result.push(BAD);
      continue;
    }
    const trail = bytes.charCodeAt(at++);
    result.push(
      trail >= 0xa1 && trail <= 0xfe
        ? tableCode(512 + plane * PLANE_SIZE + (lead - 0xa1) * PLANE_WIDTH + trail - 0xa1)
        : BAD
    );
  }
  return result;
}

function taiwaneseLead(lead: number, plane: number): boolean {
  if (plane === 0) return (lead >= 0xa1 && lead <= 0xa6) || (lead >= 0xc2 && lead <= 0xfd && lead !== 0xc3);
  if (plane === 1) return lead >= 0xa1 && lead <= 0xf2;
  return plane === 2 && lead >= 0xa1 && lead <= 0xe7;
}

function decodeShiftJis(bytes: string, offset: number, extended: boolean): number[] {
  const values: number[] = [];
  rt().spend(Math.ceil(bytes.length / 64));
  for (let index = 0; index < bytes.length;) {
    const lead = bytes.charCodeAt(index++);
    const double = (lead >= 0x81 && lead <= 0x9f) || (lead >= 0xe0 && lead <= (extended ? 0xfc : 0xef));
    if (!double) {
      values.push(tableCode(offset + lead));
      continue;
    }
    const trail = bytes.charCodeAt(index++);
    const row = lead < 0xe0 ? lead - 0x81 : 31 + lead - 0xe0;
    values.push(trail >= 0x40 && trail <= 0xfc ? tableCode(offset + 256 + row * 189 + trail - 0x40) : BAD);
  }
  return values;
}

function decodeShiftedUtf16(bytes: string, imap: boolean, utf16: Decode, validating = false): number[] {
  rt().spend(Math.ceil(bytes.length / 64));
  const shift = imap ? '&' : '+';
  const values: number[] = [];
  for (let index = 0; index < bytes.length;) {
    const char = bytes[index++];
    if (char !== shift) {
      values.push(directUtf7Code(char, imap, validating));
    } else if (bytes[index] === '-') {
      values.push(shift.charCodeAt(0));
      index++;
    } else {
      const section = shiftedUtf16Section(bytes, index, imap, utf16, validating);
      for (const code of section.values) values.push(code);
      index = section.end;
    }
  }
  return values;
}

function directUtf7Code(char: string, imap: boolean, validating: boolean): number {
  const code = char.charCodeAt(0);
  if (imap) return code >= 0x20 && code < 0x7f ? code : BAD;
  if (!validating) return code < 0x80 ? code : BAD;
  return code === 0 || (/[\t\r\n -\u007D]/.test(char) && char !== '\\') ? code : BAD;
}

// code-gauge-allow functionCognitiveComplexity 21 -- The ending byte determines both the section validity and the next byte to decode.
function shiftedUtf16Section(
  bytes: string,
  start: number,
  imap: boolean,
  utf16: Decode,
  validating: boolean
): { end: number; values: number[] } {
  const alphabet = imap ? IMAP_BASE64 : BASE64;
  let index = start;
  while (index < bytes.length && alphabet.includes(bytes[index])) index++;
  const section = bytes.slice(start, index);
  const terminator = bytes[index];
  const closing = terminator === '-';
  const invalidTerminator =
    terminator !== undefined && !closing && directUtf7Code(terminator, imap, validating) === BAD;
  const consume = closing || (terminator !== undefined && (imap || terminator.charCodeAt(0) >= 0x80));
  const end = index + Number(consume);
  const encoded = imap ? section.replaceAll(',', '/') : section;
  const decoded = Buffer.from(encoded, 'base64');
  const values = utf16(decoded.subarray(0, decoded.length & ~1).toString('latin1'));
  const padding = (section.length * 6) % 16;
  const incomplete = padding >= 6 || (alphabet.indexOf(section.at(-1) ?? '') & ((1 << padding) - 1)) !== 0;
  if (incomplete) values.push(BAD);
  if (imap && !closing) values.push(BAD);
  if (!imap && (invalidTerminator || (validating && section === '' && terminator !== undefined))) values.push(BAD);
  return {
    end,
    values: imap ? values.map((code) => (code >= 0x20 && code < 0x7f && code !== 0x26 ? BAD : code)) : values,
  };
}

// code-gauge-allow functionCognitiveComplexity 27 -- Maintains the escape and shifted-byte state of the two transport encodings.
function decodeShiftedPairs(bytes: string, hz: boolean, decoder: TextDecoder): number[] {
  const result: number[] = [];
  let shifted = false;
  rt().spend(Math.ceil(bytes.length / 64));
  for (let index = 0; index < bytes.length;) {
    const lead = bytes.charCodeAt(index++);
    if (hz && lead === 0x7e) {
      if (index === bytes.length) break;
      shifted = hzEscape(bytes[index++], shifted, result);
    } else if (!hz && lead === 0x1b) {
      if (bytes.startsWith('$)C', index)) {
        index += 3;
        shifted = false;
      } else {
        index += invalidKoreanEscapeWidth(bytes, index);
        result.push(BAD);
      }
    } else if (!hz && (lead === 0x0e || lead === 0x0f)) {
      shifted = lead === 0x0e;
    } else if (shifted && validShiftedLead(lead, hz) && index < bytes.length) {
      const trail = bytes.charCodeAt(index++);
      result.push(trail >= 0x21 && trail <= 0x7e ? decodePair(decoder, lead, trail, hz) : BAD);
    } else {
      result.push(!shifted && lead < 0x80 ? lead : BAD);
    }
  }
  return result;
}

function hzEscape(escape: string, shifted: boolean, result: number[]): boolean {
  if (escape === '{' && !shifted) return true;
  if (escape === '}' && shifted) return false;
  if (escape === '~' && !shifted) result.push(0x7e);
  else if (escape !== '\n') result.push(BAD);
  return shifted;
}

function invalidKoreanEscapeWidth(bytes: string, index: number): number {
  if (bytes[index] !== '$') return 1;
  return bytes[index + 1] === ')' ? 3 : 2;
}

function validShiftedLead(lead: number, hz: boolean): boolean {
  return hz ? (lead >= 0x21 && lead <= 0x29) || (lead >= 0x30 && lead <= 0x77) : lead >= 0x21 && lead <= 0x7e;
}

function decodePair(decoder: TextDecoder, lead: number, trail: number, hz: boolean): number {
  if (hz && lead === 0x21) {
    if (trail === 0x24) return 0x30_fb;
    if (trail === 0x2a) return 0x20_15;
  }
  const value = decoder.decode(Uint8Array.of(lead + 0x80, trail + 0x80));
  const code = value.codePointAt(0);
  return code !== undefined && code !== TABLE_REPLACEMENT ? code : BAD;
}
