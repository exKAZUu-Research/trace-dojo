import { formatJava, type FormatValues } from '../interpreter/javaFormatter';
import { javaHash } from './builtinCollections';
import { stringify } from './builtins';
import { type Frame, throwBuiltin } from './runtime';
import { JavaObject, type Value } from './values';

/** Formats as `String.format` does for the conversions learners use: d, s, f, e, g, x, o, c, b, h, n, and %. */
export function formatText(frame: Frame, pattern: string, args: Value[]): string {
  return formatJava(pattern, args, javaValues(frame));
}

function javaValues(frame: Frame): FormatValues<Value> {
  return {
    isNull: (value) => value === undefined,
    stringify: (value) => stringify(frame, value, { kind: 'null' }),
    hash: (value) => javaHash(frame, value),
    booleanOf: (value) =>
      value instanceof JavaObject && typeof value.boxed === 'boolean' ? value.boxed : value !== undefined,
    numberOf: (value) => {
      const kind = value instanceof JavaObject ? value.cls.unboxedType?.kind : undefined;
      return kind ? { kind, value: (value as JavaObject).boxed as number | bigint } : undefined;
    },
    typeName: (value) =>
      value instanceof JavaObject
        ? (frame.runtime.builtins.qualifiedNames.get(value.cls) ?? value.cls.name)
        : 'java.lang.String',
    fail: (name, message) => throwBuiltin(frame, name, message),
    scan: (length) => frame.runtime.scanString(length),
  };
}
