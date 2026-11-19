import { legacyDetectionCodePoint } from './legacyDetectionTables';
import { rt } from './runtime';

const decoder = new TextDecoder('gb18030', { ignoreBOM: true });
const legacyMappings = new Map<number, number>([
  [0xa3_a0, 58_853],
  [0xa6_d9, 59_277],
  [0xa6_da, 59_278],
  [0xa6_db, 59_279],
  [0xa6_dc, 59_280],
  [0xa6_dd, 59_281],
  [0xa6_de, 59_282],
  [0xa6_df, 59_283],
  [0xa6_ec, 59_284],
  [0xa6_ed, 59_285],
  [0xa6_f3, 59_286],
  [0xa8_bc, 59_335],
  [0xfe_59, 59_422],
  [0xfe_61, 59_430],
  [0xfe_66, 59_435],
  [0xfe_67, 59_436],
  [0xfe_6d, 59_442],
  [0xfe_7e, 59_459],
  [0xfe_90, 59_476],
  [0xfe_a0, 59_492],
  [0x81_35_f4_37, 7743],
]);
const revisedMappings = new Map<number, number>([
  [0xa3_a0, 58_853],
  [0x82_35_90_37, 59_422],
  [0x82_35_90_38, 59_430],
  [0x82_35_90_39, 59_435],
  [0x82_35_91_30, 59_436],
  [0x82_35_91_31, 59_442],
  [0x82_35_91_32, 59_459],
  [0x82_35_91_33, 59_476],
  [0x82_35_91_34, 59_492],
  [0x84_31_82_36, 59_277],
  [0x84_31_82_37, 59_279],
  [0x84_31_82_38, 59_278],
  [0x84_31_82_39, 59_280],
  [0x84_31_83_30, 59_281],
  [0x84_31_83_31, 59_282],
  [0x84_31_83_32, 59_283],
  [0x84_31_83_33, 59_284],
  [0x84_31_83_34, 59_285],
  [0x84_31_83_35, 59_286],
]);
export function decodeEucCn(bytes: string, bad: number): number[] {
  const input = Buffer.from(bytes, 'latin1');
  const result: number[] = [];
  rt().spend(Math.ceil(bytes.length / 64));
  for (let index = 0; index < input.length;) {
    const lead = input[index++];
    if (lead < 0x80) result.push(lead);
    else if (eucCnLead(lead) && index < input.length) {
      const trail = input[index++];
      result.push(trail >= 0xa1 && trail <= 0xfe ? gb2312CodePoint(lead, trail, bad) : bad);
    } else result.push(bad);
  }
  return result;
}

function eucCnLead(lead: number): boolean {
  return (lead >= 0xa1 && lead <= 0xa9) || (lead >= 0xb0 && lead <= 0xf7);
}

export function gb2312CodePoint(lead: number, trail: number, bad: number, hz = false): number {
  const index = (lead - 0xa1) * 94 + trail - 0xa1;
  const shifted = hz ? legacyDetectionCodePoint('hz', index) : 0;
  const code = shifted || legacyDetectionCodePoint('eucCn', index);
  return code === 0xff_fd ? bad : code;
}

export function decodeCp936(bytes: string, bad: number): number[] {
  const input = Buffer.from(bytes, 'latin1');
  const result: number[] = [];
  rt().spend(Math.ceil(bytes.length / 64));
  for (let index = 0; index < input.length;) {
    const start = index;
    const lead = input[index++];
    if (lead < 0x80) result.push(lead);
    else if (lead === 0x80) result.push(0x20_ac);
    else if (lead === 0xff) result.push(0xf8_f5);
    else if (index === input.length) result.push(bad);
    else {
      const trail = input[index++];
      result.push(
        trail >= 0x40 && trail <= 0xfe && trail !== 0x7f
          ? cp936CodePoint(input.subarray(start, index), lead, trail, bad)
          : bad
      );
    }
  }
  return result;
}

function cp936CodePoint(bytes: Uint8Array, lead: number, trail: number, bad: number): number {
  const column = trail - (trail < 0x7f ? 0x40 : 0x41);
  const delta = legacyDetectionCodePoint('cp936', (lead - 0x81) * 190 + column);
  // A stored offset of one lets a CP936 mapping to NUL differ from the host table.
  const code = delta ? delta - 1 : decoder.decode(bytes).codePointAt(0);
  return code === undefined || code === 0xff_fd ? bad : code;
}

// code-gauge-allow functionCognitiveComplexity 19 -- Reads sequences in mbfl's order, including which bytes a malformed unit consumes.
export function decodeGb18030(bytes: string, revised: boolean, bad: number): number[] {
  const input = Buffer.from(bytes, 'latin1');
  const mappings = revised ? revisedMappings : legacyMappings;
  const result: number[] = [];
  rt().spend(Math.ceil(bytes.length / 64));
  for (let index = 0; index < input.length;) {
    const start = index;
    const lead = input[index++];
    if (lead < 0x80) {
      result.push(lead);
      continue;
    }
    if (lead === 0x80 || lead === 0xff || index === input.length) {
      result.push(bad);
      continue;
    }
    const trail = input[index++];
    if (digit(trail) && (lead <= 0x84 || (lead >= 0x90 && lead <= 0xe3))) {
      const third = input[index++];
      result.push(
        third >= 0x81 && third <= 0xfe && index < input.length ? fourBytes(input, start, ++index, mappings, bad) : bad
      );
    } else if (trail >= 0x40 && trail <= 0xfe && trail !== 0x7f) {
      result.push(
        mappings.get(lead * 256 + trail) ?? decoder.decode(input.subarray(start, index)).codePointAt(0) ?? bad
      );
    } else result.push(bad);
  }
  return result;
}

function fourBytes(input: Buffer, start: number, end: number, mappings: Map<number, number>, bad: number): number {
  const lead = input[start];
  const last = input[end - 1];
  if (!digit(last)) return bad;
  const pointer =
    (((lead - (lead >= 0x90 ? 0x90 : 0x81)) * 10 + input[start + 1] - 0x30) * 126 + input[start + 2] - 0x81) * 10 +
    last -
    0x30;
  if (lead >= 0x90) return pointer <= 0xf_ff_ff ? pointer + 0x1_00_00 : bad;
  if (pointer > 39_419) return bad;
  return mappings.get(input.readUInt32BE(start)) ?? decoder.decode(input.subarray(start, end)).codePointAt(0) ?? bad;
}

function digit(byte: number): boolean {
  return byte >= 0x30 && byte <= 0x39;
}
