import { ExecutionLimitError, LIMITS } from '../interpreter/limits';
import { stringEncodingName } from './conversions';
import { rubyError } from './errors';
import type { RString } from './objects';
import { rt } from './runtime';
import { stringBytes, stringFromBytes } from './values';

export function joinEncodedStrings(parts: RString[], limit = LIMITS.maxStringLength): RString {
  const builder = new EncodedStringBuilder(limit);
  for (const part of parts) builder.append(part);
  return builder.finish();
}

export class EncodedStringBuilder {
  length = 0;
  private readonly buffers: Uint8Array[] = [];
  private encoding?: RString;
  private ascii = true;

  constructor(
    private readonly limit = LIMITS.maxStringLength,
    initial?: RString
  ) {
    if (initial) this.encoding = stringFromBytes(new Uint8Array(), initial.binary, initial.usAscii);
  }

  append(part: RString): void {
    const bytes = stringBytes(part);
    if (this.length + bytes.length > this.limit) throw new ExecutionLimitError('storage');
    const partAscii = bytes.every((byte) => byte < 0x80);
    if (this.encoding) checkStringEncodingCompatibility(this.encoding, this.ascii, part, partAscii);
    if (!this.encoding || (this.ascii && !partAscii))
      this.encoding = stringFromBytes(new Uint8Array(), part.binary, part.usAscii);
    this.ascii &&= partAscii;
    this.length += bytes.length;
    rt().spend(Math.ceil(bytes.length / 256));
    this.buffers.push(Uint8Array.from(bytes));
  }

  finish(): RString {
    const bytes = new Uint8Array(this.length);
    let offset = 0;
    for (const buffer of this.buffers) {
      bytes.set(buffer, offset);
      offset += buffer.length;
    }
    return stringFromBytes(bytes, this.encoding?.binary ?? false, this.encoding?.usAscii ?? false);
  }
}

export function checkStringEncodingCompatibility(
  left: RString,
  leftAscii: boolean,
  right: RString,
  rightAscii: boolean
): void {
  if (!leftAscii && !rightAscii && stringEncodingName(left) !== stringEncodingName(right))
    throwIncompatibleStringEncodings(left, right);
}

export function requireCompatibleStringEncoding(left: RString, right: RString): RString {
  const encoding = compatibleStringEncoding(left, right);
  if (encoding === undefined) throwIncompatibleStringEncodings(left, right);
  return encoding;
}

export function compatibleStringEncoding(left: RString, right: RString): RString | undefined {
  if (stringEncodingName(left) === stringEncodingName(right)) return left;
  const rightAscii = stringBytes(right).every((byte) => byte < 0x80);
  if (rightAscii) return left;
  return stringBytes(left).every((byte) => byte < 0x80) ? right : undefined;
}

function throwIncompatibleStringEncodings(left: RString, right: RString): never {
  throw rubyError(
    rt().c['Encoding::CompatibilityError'],
    `incompatible character encodings: ${stringEncodingName(left)} and ${stringEncodingName(right)}`
  );
}
