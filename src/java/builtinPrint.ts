import { stringify } from './builtins';
import { addMethod } from './builtinSupport';
import { type Frame, throwBuiltin } from './runtime';
import { BOOLEAN, CHAR, type ClassInfo, DOUBLE, FLOAT, INT, type JavaType, LONG, VOID } from './types';
import { charToString, JavaArray, type Value } from './values';

const CHAR_ARRAY: JavaType = { kind: 'array', element: CHAR };

/**
 * Writes text that a print method formats, where `isLine` tells the line break of `println`, or a `printf` or
 * `format` call, and `kind` the `write` overload Java's `PrintWriter` calls for the text.
 */
export type PrintWrite = (
  frame: Frame,
  receiver: Value,
  text: string,
  isLine: boolean,
  kind?: 'string' | 'chars' | 'char'
) => void;

/**
 * Defines `print` and `println` for each type of argument, which format the argument as `String.valueOf` does, where
 * `println` prints its argument, then a line break.
 */
export function definePrintMethods(
  cls: ClassInfo,
  stringType: JavaType,
  objectType: JavaType,
  write: PrintWrite
): void {
  for (const [name, suffix] of [
    ['print', ''],
    ['println', '\n'],
  ] as const) {
    for (const type of [INT, LONG, FLOAT, DOUBLE, CHAR, BOOLEAN, stringType, objectType, CHAR_ARRAY]) {
      addMethod(cls, name, [type], VOID, false, (frame, receiver, [value]) => {
        write(frame, receiver, printedText(frame, value, type), false, writeKindOf(type));
        if (suffix) write(frame, receiver, suffix, true);
      });
    }
  }
  addMethod(cls, 'println', [], VOID, false, (frame, receiver) => {
    write(frame, receiver, '\n', true);
  });
}

/** The text `print` prints for a value, where an array of chars prints its chars. */
function printedText(frame: Frame, value: Value, type: JavaType): string {
  if (type !== CHAR_ARRAY) return stringify(frame, value, type);
  if (!(value instanceof JavaArray)) return throwBuiltin(frame, 'NullPointerException');
  frame.runtime.scanString(value.values.length);
  return value.values.map((code) => charToString(code as number)).join('');
}

/** The `write` overload that `PrintWriter.print` calls for a value of a type. */
function writeKindOf(type: JavaType): 'string' | 'chars' | 'char' {
  if (type === CHAR_ARRAY) return 'chars';
  return type === CHAR ? 'char' : 'string';
}
