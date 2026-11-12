import type { Entity } from '../entities';
import { newError } from '../errorValues';
import { FORMATTER, GO_STRINGER, Printer, STATE } from '../fmt';
import { addMethod, definePackage, fn, namedType, nativeFunction, typeEntity } from '../native';
import { ERROR_TYPE, pointerTo, sliceOf, type Type } from '../types';
import { Cell, GoStruct, Iface, Pointer, Slice, type Value } from '../values';
import { IO_WRITER } from './io';
import { sscan, sscanf } from './scan';
import { ANY_SLICE, byteSlice, callMethod, INT, sliceValues, STRING, writeStdout } from './support';

const ERROR_RESULTS: Type[] = [INT, ERROR_TYPE];

/** `fmt.Stringer`. */
const STRINGER = namedType('fmt', 'Stringer', {
  kind: 'interface',
  methods: [{ name: 'String', type: fn([], [STRING]) }],
});

/** The error `Errorf` returns for one %w: its message and the error it wraps. */
const WRAP_ERROR = namedType('fmt', 'wrapError', {
  kind: 'struct',
  fields: [
    { name: 'msg', type: STRING, embedded: false },
    { name: 'err', type: ERROR_TYPE, embedded: false },
  ],
});
addMethod(WRAP_ERROR, 'Error', fn([], [STRING]), (receiver) => structOf(receiver).fields[0], true);
addMethod(WRAP_ERROR, 'Unwrap', fn([], [ERROR_TYPE]), (receiver) => structOf(receiver).fields[1], true);

const WRAP_ERRORS = namedType('fmt', 'wrapErrors', {
  kind: 'struct',
  fields: [
    { name: 'msg', type: STRING, embedded: false },
    { name: 'errs', type: sliceOf(ERROR_TYPE), embedded: false },
  ],
});
addMethod(WRAP_ERRORS, 'Error', fn([], [STRING]), (receiver) => structOf(receiver).fields[0], true);
addMethod(WRAP_ERRORS, 'Unwrap', fn([], [sliceOf(ERROR_TYPE)]), (receiver) => structOf(receiver).fields[1], true);

function structOf(receiver: Value): GoStruct {
  return (receiver as Pointer).load() as GoStruct;
}

/** `Errorf`: formats as Sprintf does, and wraps the errors that %w verbs refer to. */
function errorf(format: string, args: Value[]): Value {
  const printer = new Printer(true);
  const message = printer.printf(format, args);
  const { wrapped } = printer;
  if (wrapped.length === 0) return newError(message);
  if (wrapped.length === 1) {
    return new Iface(pointerTo(WRAP_ERROR), new Pointer(new Cell(new GoStruct([message, wrapped[0]])), 'v'));
  }
  const list = new Slice(wrapped, 0, wrapped.length, wrapped.length);
  return new Iface(pointerTo(WRAP_ERRORS), new Pointer(new Cell(new GoStruct([message, list])), 'v'));
}

/** Writes to an io.Writer through its Write method, as Fprint does. */
export function writeTo(writer: Value, bytes: string): Value[] {
  const result = callMethod(writer, 'Write', [byteSlice(bytes)]) as Value[];
  return result;
}

function printTo(bytes: string): Value[] {
  writeStdout(bytes);
  return [BigInt(bytes.length), undefined];
}

const members: Record<string, Entity> = {
  Println: nativeFunction('Println', fn([ANY_SLICE], ERROR_RESULTS, true), ([args]) =>
    printTo(new Printer().println(sliceValues(args)))
  ),
  Print: nativeFunction('Print', fn([ANY_SLICE], ERROR_RESULTS, true), ([args]) =>
    printTo(new Printer().print(sliceValues(args)))
  ),
  Printf: nativeFunction('Printf', fn([STRING, ANY_SLICE], ERROR_RESULTS, true), ([format, args]) =>
    printTo(new Printer().printf(format as string, sliceValues(args)))
  ),
  Sprintln: nativeFunction('Sprintln', fn([ANY_SLICE], [STRING], true), ([args]) =>
    new Printer().println(sliceValues(args))
  ),
  Sprint: nativeFunction('Sprint', fn([ANY_SLICE], [STRING], true), ([args]) => new Printer().print(sliceValues(args))),
  Sprintf: nativeFunction('Sprintf', fn([STRING, ANY_SLICE], [STRING], true), ([format, args]) =>
    new Printer().printf(format as string, sliceValues(args))
  ),
  Errorf: nativeFunction('Errorf', fn([STRING, ANY_SLICE], [ERROR_TYPE], true), ([format, args]) =>
    errorf(format as string, sliceValues(args))
  ),
  Fprintln: nativeFunction('Fprintln', fn([IO_WRITER, ANY_SLICE], ERROR_RESULTS, true), ([writer, args]) =>
    writeTo(writer, new Printer().println(sliceValues(args)))
  ),
  Fprint: nativeFunction('Fprint', fn([IO_WRITER, ANY_SLICE], ERROR_RESULTS, true), ([writer, args]) =>
    writeTo(writer, new Printer().print(sliceValues(args)))
  ),
  Fprintf: nativeFunction(
    'Fprintf',
    fn([IO_WRITER, STRING, ANY_SLICE], ERROR_RESULTS, true),
    ([writer, format, args]) => writeTo(writer, new Printer().printf(format as string, sliceValues(args)))
  ),
  Stringer: typeEntity(STRINGER),
  State: typeEntity(STATE),
  Formatter: typeEntity(FORMATTER),
  GoStringer: typeEntity(GO_STRINGER),
  Sscan: nativeFunction('Sscan', fn([STRING, ANY_SLICE], [INT, ERROR_TYPE], true), ([input, args]) =>
    sscan(input as string, sliceValues(args), false)
  ),
  Sscanln: nativeFunction('Sscanln', fn([STRING, ANY_SLICE], [INT, ERROR_TYPE], true), ([input, args]) =>
    sscan(input as string, sliceValues(args), true)
  ),
  Sscanf: nativeFunction('Sscanf', fn([STRING, STRING, ANY_SLICE], [INT, ERROR_TYPE], true), ([input, format, args]) =>
    sscanf(input as string, format as string, sliceValues(args))
  ),
};

export const FMT_PACKAGE = definePackage('fmt', members, [
  'Scan',
  'Scanln',
  'Scanf',
  'Fscan',
  'Fscanln',
  'Fscanf',
  'Append',
  'Appendf',
  'Appendln',
  'FormatString',
]);
