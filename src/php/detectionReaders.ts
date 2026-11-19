// oxlint-disable unicorn/prefer-code-point -- Each code unit is one PHP byte.
import { detectionCodePoint, mobileDetectionTable } from './detectionDecodeTables';
import { decodeEucCn, decodeGb18030, gb2312CodePoint } from './gb18030Detection';
import { readEucJp, readExtendedJisEncoding, readJisEncoding, readSjis2004 } from './jisDetectionReader';
import { appendLegacyMapping, legacyDetectionCodePoint } from './legacyDetectionTables';
import { rt } from './runtime';

const BAD = -1;
const TABLE_REPLACEMENT = 0xff_fd;
const PLANE_WIDTH = 94;
const PLANE_SIZE = PLANE_WIDTH * PLANE_WIDTH;
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const SJIS_TABLE = 512 + 3 * PLANE_SIZE;
const CP932_TABLE = SJIS_TABLE + 256 + 60 * 189;
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
  ['ISO-2022-JP-MOBILE#KDDI', (bytes) => readExtendedJisEncoding(bytes, 'kddi')],
  ['ISO-2022-JP-2004', (bytes) => readExtendedJisEncoding(bytes, '2004')],
  ['EUC-JP', (bytes) => readEucJp(bytes, 'plain')],
  ['eucJP-win', (bytes) => readEucJp(bytes, 'windows')],
  ['EUC-JP-2004', (bytes) => readEucJp(bytes, '2004')],
  ['CP51932', (bytes) => readEucJp(bytes, 'cp51932')],
  ['SJIS', (bytes) => decodeShiftJis(bytes, SJIS_TABLE, false)],
  ['CP932', readCp932],
  ['SJIS-win', readCp932],
  ['SJIS-2004', readSjis2004],
  ['SJIS-mac', (bytes) => readSjisVariant(bytes, 'sjisMac')],
  ['SJIS-Mobile#DOCOMO', (bytes) => readSjisVariant(bytes, 'sjisDocomo')],
  ['SJIS-Mobile#KDDI', (bytes) => readSjisVariant(bytes, 'sjisKddi')],
  ['SJIS-Mobile#SOFTBANK', (bytes) => readSjisVariant(bytes, 'sjisSoftbank')],
  ['EUC-KR', (bytes) => decodeMappedPairs(bytes, 'eucKr')],
  ['CP950', (bytes) => decodeMappedPairs(bytes, 'cp950')],
  ['BIG-5', (bytes) => decodeMappedPairs(bytes, 'big5')],
  ['EUC-TW', decodeEucTw],
  ['HZ', (bytes) => decodeShiftedPairs(bytes, true)],
  ['ISO-2022-KR', (bytes) => decodeShiftedPairs(bytes, false)],
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
    case 'UTF-7':
    case 'UTF7-IMAP': {
      return (bytes) => decodeShiftedUtf16(bytes, name === 'UTF7-IMAP', utf16);
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

const PAIR_LEAD_RANGES = {
  big5: [0xa1, 0xf9],
  cp950: [0x81, 0xfe],
  eucKr: [0xa1, 0xfd],
} as const;
type PairEncoding = keyof typeof PAIR_LEAD_RANGES;

// code-gauge-allow functionCognitiveComplexity 16 -- The lead, trail and BIG-5 retry share one input cursor.
function decodeMappedPairs(bytes: string, encoding: PairEncoding): number[] {
  const result: number[] = [];
  const traditionalChinese = encoding !== 'eucKr';
  const [firstLead, lastLead] = PAIR_LEAD_RANGES[encoding];
  const width = traditionalChinese ? 157 : PLANE_WIDTH;
  const validLead = traditionalChinese ? (lead: number) => lead >= firstLead && lead <= lastLead : isEucKrLead;
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
    const column = mappedPairColumn(trail, traditionalChinese);
    const code = column < 0 ? TABLE_REPLACEMENT : mappedPairCode(encoding, lead, column, (lead - firstLead) * width);
    if (encoding === 'big5' && lead === 0xc8 && column >= 0 && code === TABLE_REPLACEMENT) at--;
    result.push(code === TABLE_REPLACEMENT ? BAD : code);
  }
  return result;
}

function mappedPairCode(encoding: PairEncoding, lead: number, column: number, rowStart: number): number {
  const code = legacyDetectionCodePoint(encoding, rowStart + column);
  return encoding === 'big5' && code === 0 ? legacyDetectionCodePoint('cp950', (lead - 0x81) * 157 + column) : code;
}

function isEucKrLead(lead: number): boolean {
  return (lead >= 0xa1 && lead <= 0xac) || (lead >= 0xb0 && lead <= 0xfd && lead !== 0xc9);
}

function mappedPairColumn(trail: number, traditionalChinese: boolean): number {
  if (traditionalChinese && trail >= 0x40 && trail <= 0x7e) return trail - 0x40;
  if (trail >= 0xa1 && trail <= 0xfe) return trail - 0xa1 + (traditionalChinese ? 63 : 0);
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

function readCp932(bytes: string): number[] {
  return decodeShiftJis(bytes, CP932_TABLE, true);
}

function decodeShiftJis(bytes: string, offset: number, extended: boolean): number[] {
  const values: number[] = [];
  rt().spend(Math.ceil(bytes.length / 64));
  for (let index = 0; index < bytes.length;) {
    const lead = bytes.charCodeAt(index++);
    const row = sjisLeadRow(lead, extended ? 0xfc : 0xef);
    if (row < 0) {
      values.push(tableCode(offset + lead));
      continue;
    }
    const trail = bytes.charCodeAt(index++);
    values.push(trail >= 0x40 && trail <= 0xfc ? tableCode(offset + 256 + row * 189 + trail - 0x40) : BAD);
  }
  return values;
}

type SjisVariant = 'sjisMac' | 'sjisDocomo' | 'sjisKddi' | 'sjisSoftbank';

function readSjisVariant(bytes: string, encoding: SjisVariant): number[] {
  const values: number[] = [];
  const mac = encoding === 'sjisMac';
  rt().spend(Math.ceil(bytes.length / 64));
  for (let index = 0; index < bytes.length;) {
    const lead = bytes.charCodeAt(index++);
    if (encoding === 'sjisSoftbank' && lead === 0x1b) {
      index = readSoftbankEscape(bytes, index, values);
      continue;
    }
    const row = sjisLeadRow(lead, mac ? 0xed : 0xfc);
    if (row < 0) {
      pushSjisSingle(values, lead, mac);
      continue;
    }
    const trail = bytes.charCodeAt(index++);
    if (!(trail >= 0x40 && trail <= 0xfc)) {
      values.push(BAD);
      continue;
    }
    const offset = row * 189 + trail - 0x40;
    const code = legacyDetectionCodePoint(encoding, offset) || detectionCodePoint(CP932_TABLE + 256 + offset);
    appendLegacyMapping(values, code, BAD);
  }
  return values;
}

function sjisLeadRow(lead: number, last: number): number {
  if (lead >= 0x81 && lead <= 0x9f) return lead - 0x81;
  return lead >= 0xe0 && lead <= last ? lead - 0xe0 + 31 : -1;
}

const MAC_SINGLE = new Map<number, number>([
  [0x5c, 0xa5],
  [0x80, 0x5c],
  [0xa0, 0xa0],
  [0xfd, 0xa9],
  [0xfe, 0x21_22],
]);

function pushSjisSingle(values: number[], byte: number, mac: boolean): void {
  if (mac && byte === 0xff) values.push(0x20_26, 0xf8_7f);
  else if (mac && MAC_SINGLE.has(byte)) values.push(MAC_SINGLE.get(byte)!);
  else if (byte < 0x80) values.push(byte);
  else values.push(byte >= 0xa1 && byte <= 0xdf ? 0xfe_c0 + byte : BAD);
}

function readSoftbankEscape(bytes: string, index: number, values: number[]): number {
  if (bytes[index++] !== '$' || index >= bytes.length) {
    values.push(BAD);
    return index;
  }
  const bank = 'EFGOPQ'.indexOf(bytes[index++]);
  if (bank === -1) {
    values.push(BAD);
    return index;
  }
  while (index < bytes.length) {
    const next = bytes.charCodeAt(index++);
    if (next === 0x0f) break;
    const code =
      next >= 0x21 && next <= 0x7a
        ? legacyDetectionCodePoint('softbankEscape', bank * 90 + next - 0x21)
        : TABLE_REPLACEMENT;
    appendLegacyMapping(values, code, BAD);
    if (code === TABLE_REPLACEMENT) break;
  }
  return index;
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
function decodeShiftedPairs(bytes: string, hz: boolean): number[] {
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
      result.push(trail >= 0x21 && trail <= 0x7e ? shiftedPairCode(lead, trail, hz) : BAD);
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
  const available = bytes.length - index;
  const dollar = bytes[index] === '$';
  if (available < 3) return Math.min(available, dollar ? 2 : 1);
  if (bytes[index + 1] === ')') return 3;
  return dollar ? 2 : 1;
}

function validShiftedLead(lead: number, hz: boolean): boolean {
  return hz ? (lead >= 0x21 && lead <= 0x29) || (lead >= 0x30 && lead <= 0x77) : lead >= 0x21 && lead <= 0x7e;
}

function shiftedPairCode(lead: number, trail: number, hz: boolean): number {
  if (hz) return gb2312CodePoint(lead + 0x80, trail + 0x80, BAD, true);
  const index = (lead - 0x21) * PLANE_WIDTH + trail - 0x21;
  const shifted = legacyDetectionCodePoint('koreanShift', index);
  const code = shifted || (lead < 0x7e ? legacyDetectionCodePoint('eucKr', index) : TABLE_REPLACEMENT);
  return code === TABLE_REPLACEMENT ? BAD : code;
}
