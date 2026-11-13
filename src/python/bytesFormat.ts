import { bytesLikeData, latin1Bytes, latin1Text, newBytes, PyBytes } from './bytesValues';
import { pyAscii } from './conversions';
import { bindValue, callValue, lookupSpecial } from './objects';
import { renderPercent, TemplateReader } from './percentFormat';
import { repeatText } from './stringBuilder';
import { pyError, typeError, typeName, valueError } from './types';
import { PyTuple, type PyValue } from './values';

/** The `%` operator on bytes or a bytearray, which formats numbers as str's `%` does and inserts bytes for `%s`. */
export function formatBytesPercent(template: Uint8Array, argument: PyValue): Uint8Array {
  const isMapping =
    !(argument instanceof PyTuple) &&
    !(argument instanceof PyBytes) &&
    typeof argument === 'object' &&
    lookupSpecial(argument, '__getitem__') !== undefined;
  const reader = new BytesTemplateReader(latin1Text(template).split(''), argument, isMapping);
  return latin1Bytes(renderPercent(reader, 'bytes'));
}

/** Reads a `%` template whose characters each stand for one byte. */
class BytesTemplateReader extends TemplateReader {
  protected override convertSpecifier(
    type: string,
    value: PyValue,
    flags: string,
    width: string,
    precision: number | undefined,
    position: number
  ): string {
    if ('diuoxXeEfFgG'.includes(type)) return super.convertSpecifier(type, value, flags, width, precision, position);
    const body = textOf(type, value, position);
    const shown = precision === undefined || type === 'c' ? body : body.slice(0, precision);
    const padding = repeatText(' ', Number(width || '0') - shown.length);
    return flags.includes('-') ? shown + padding : padding + shown;
  }

  protected override mappingKey(key: string): PyValue {
    return newBytes(latin1Bytes(key));
  }
}

/** The bytes, as one character per byte, that the conversion `type` makes of a value. */
function textOf(type: string, value: PyValue, position: number): string {
  if (type === 's' || type === 'b') return latin1Text(bytesOf(value));
  if (type === 'r' || type === 'a') return pyAscii(value);
  if (type === 'c') return byteOf(value);
  throw valueError(
    `unsupported format character '${type}' (0x${(type.codePointAt(0) as number).toString(16)}) at index ${position}`
  );
}

function bytesOf(value: PyValue): Uint8Array {
  const data = bytesLikeData(value);
  if (data !== undefined) return data;
  const special = lookupSpecial(value, '__bytes__');
  if (special !== undefined) {
    const result = callValue(bindValue(special, value), []);
    if (!(result instanceof PyBytes) || result.isMutable) {
      throw typeError(`__bytes__ returned non-bytes (type ${typeName(result)})`);
    }
    return result.data;
  }
  throw typeError(`%b requires a bytes-like object, or an object that implements __bytes__, not '${typeName(value)}'`);
}

function byteOf(value: PyValue): string {
  if (typeof value === 'bigint' || typeof value === 'boolean') {
    const code = BigInt(value);
    if (code < 0n || code > 255n) throw pyError('OverflowError', '%c arg not in range(256)');
    return String.fromCodePoint(Number(code));
  }
  const data = bytesLikeData(value);
  if (data?.length === 1) return String.fromCodePoint(data[0]);
  const described = data === undefined ? typeName(value) : `a bytes object of length ${data.length}`;
  throw typeError(`%c requires an integer in range(256) or a single byte, not ${described}`);
}
