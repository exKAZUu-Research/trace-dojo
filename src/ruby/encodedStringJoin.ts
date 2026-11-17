import { ExecutionLimitError, LIMITS } from '../interpreter/limits';
import { stringEncodingName } from './conversions';
import { rubyError } from './errors';
import type { RString } from './objects';
import { rt } from './runtime';
import { stringBytes, stringFromBytes } from './values';

export function joinEncodedStrings(parts: RString[], limit = LIMITS.maxStringLength): RString {
  const buffers = parts.map(stringBytes);
  const length = buffers.reduce((sum, bytes) => sum + bytes.length, 0);
  if (length > limit) throw new ExecutionLimitError('storage');
  let encoding = parts[0];
  let ascii = true;
  for (const [index, part] of parts.entries()) {
    const partAscii = buffers[index].every((byte) => byte < 0x80);
    if (encoding) checkStringEncodingCompatibility(encoding, ascii, part, partAscii);
    if (ascii && !partAscii) encoding = part;
    ascii &&= partAscii;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const buffer of buffers) {
    bytes.set(buffer, offset);
    offset += buffer.length;
  }
  return stringFromBytes(bytes, encoding?.binary ?? false, encoding?.usAscii ?? false);
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
