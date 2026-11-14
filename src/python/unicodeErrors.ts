import { bytesLikeData, newBytes, PyBytes } from './bytesValues';
import { method } from './define';
import { toIndex } from './numbers';
import { iterStr, strLength } from './strings';
import { exceptionClassNamed, newTuple, stringValue, typeError, typeName } from './types';
import { PyInstance, type PyValue } from './values';

type UnicodeErrorName = 'UnicodeEncodeError' | 'UnicodeDecodeError' | 'UnicodeTranslateError';

const FIELDS: Record<UnicodeErrorName, string[]> = {
  UnicodeEncodeError: ['encoding', 'object', 'start', 'end', 'reason'],
  UnicodeDecodeError: ['encoding', 'object', 'start', 'end', 'reason'],
  UnicodeTranslateError: ['object', 'start', 'end', 'reason'],
};

/** A UnicodeError whose attributes hold `fields`, by default its arguments, as CPython's constructors store them. */
export function unicodeException(name: UnicodeErrorName, args: PyValue[], fields = args): PyInstance {
  const exception = new PyInstance(exceptionClassNamed(name));
  exception.exception = { args: newTuple(args), suppressContext: false };
  for (const [index, field] of FIELDS[name].entries()) exception.dict.set(field, fields[index]);
  return exception;
}

for (const name of Object.keys(FIELDS) as UnicodeErrorName[]) {
  const cls = exceptionClassNamed(name);
  cls.construct = (_cls, args, kwargs) => {
    if (kwargs && kwargs.size > 0) throw typeError(`${name}() takes no keyword arguments`);
    const fields = FIELDS[name];
    if (args.length !== fields.length) {
      throw typeError(`function takes exactly ${fields.length} arguments (${args.length} given)`);
    }
    return unicodeException(name, checkedArguments(name, args));
  };
  method(cls, '__str__', 'none', 0, 0, (self) => unicodeErrorStr(name, self as PyInstance));
}

type Check = [(value: PyValue) => PyValue | undefined, string];

const STR: Check = [(value) => (stringValue(value) !== undefined ? value : undefined), 'str'];
const INDEX: Check = [(value) => toIndex(value), 'int'];
const BYTES: Check = [
  (value) => {
    const data = bytesLikeData(value);
    if (data === undefined) return;
    return value instanceof PyBytes && !value.isMutable ? value : newBytes(new Uint8Array(data));
  },
  'a bytes-like object',
];
const CHECKS: Record<UnicodeErrorName, Check[]> = {
  UnicodeEncodeError: [STR, STR, INDEX, INDEX, STR],
  UnicodeDecodeError: [STR, BYTES, INDEX, INDEX, STR],
  UnicodeTranslateError: [STR, INDEX, INDEX, STR],
};

function checkedArguments(name: UnicodeErrorName, args: PyValue[]): PyValue[] {
  return CHECKS[name].map(([check, what], index) => {
    const value = check(args[index]);
    if (value === undefined) throw typeError(`argument ${index + 1} must be ${what}, not ${typeName(args[index])}`);
    return value;
  });
}

function unicodeErrorStr(name: UnicodeErrorName, exception: PyInstance): string {
  const field = (key: string): PyValue | undefined => exception.dict.get(key);
  const rawObject = field('object');
  const object = stringValue(rawObject) ?? rawObject;
  const start = field('start');
  const end = field('end');
  const reason = stringValue(field('reason'));
  if (typeof start !== 'bigint' || typeof end !== 'bigint' || typeof reason !== 'string') return '';
  const encoding = name === 'UnicodeTranslateError' ? '' : `'${stringValue(field('encoding')) ?? ''}' codec `;
  const verb = { UnicodeEncodeError: 'encode', UnicodeDecodeError: 'decode', UnicodeTranslateError: 'translate' }[name];
  const length = object instanceof PyBytes ? object.length : typeof object === 'string' ? strLength(object) : 0;
  if (start < BigInt(length) && end === start + 1n) {
    if (object instanceof PyBytes) {
      const byte = object.data[Number(start)].toString(16).padStart(2, '0');
      return `${encoding}can't ${verb} byte 0x${byte} in position ${start}: ${reason}`;
    }
    const point = iterStr(object as string)[Number(start)].codePointAt(0) as number;
    return `${encoding}can't ${verb} character '${escapePoint(point)}' in position ${start}: ${reason}`;
  }
  const what = object instanceof PyBytes ? 'bytes' : 'characters';
  return `${encoding}can't ${verb} ${what} in position ${start}-${end - 1n}: ${reason}`;
}

/** The backslash escape of a code point, as messages and the backslashreplace error handler write it. */
export function escapePoint(point: number): string {
  if (point < 0x1_00) return `\\x${point.toString(16).padStart(2, '0')}`;
  if (point < 0x1_00_00) return `\\u${point.toString(16).padStart(4, '0')}`;
  return `\\U${point.toString(16).padStart(8, '0')}`;
}
