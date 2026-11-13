import type { Entity } from '../entities';
import { newError } from '../errorValues';
import { Printer } from '../fmt';
import { encodeRune } from '../literals';
import { addMethod, definePackage, fn, namedType, nativeFunction, opaqueType, typeEntity } from '../native';
import { ERROR_TYPE, type InterfaceType, missingMethod, pointerTo, RUNE, sliceOf, type Type } from '../types';
import { Cell, GoStruct, Iface, Pointer, Slice, type Value } from '../values';
import { fscan, fscanf, SCAN_STATE, SCANNER, sscan, sscanf } from './fmtScan';
import { IO_READER, IO_WRITER } from './io';
import {
  ANY_SLICE,
  appendBytes,
  BOOL,
  BYTES,
  byteSlice,
  bytesOf,
  callMethod,
  INT,
  receiverStruct,
  sliceValues,
  STRING,
  writeStdout,
} from './support';

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
  return receiverStruct(receiver);
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

// Formatter ---------------------------------------------------------------------------------------------------------

const STATE = namedType('fmt', 'State', {
  kind: 'interface',
  methods: [
    { name: 'Flag', type: fn([INT], [BOOL]) },
    { name: 'Precision', type: fn([], [INT, BOOL]) },
    { name: 'Width', type: fn([], [INT, BOOL]) },
    { name: 'Write', type: fn([BYTES], [INT, ERROR_TYPE]) },
  ],
});
const FORMATTER = namedType('fmt', 'Formatter', {
  kind: 'interface',
  methods: [{ name: 'Format', type: fn([STATE, RUNE], []) }],
});
const GO_STRINGER = namedType('fmt', 'GoStringer', {
  kind: 'interface',
  methods: [{ name: 'GoString', type: fn([], [STRING]) }],
});

/** `*fmt.pp`, the printer that a Format method receives as its fmt.State. */
const PP = opaqueType(namedType('fmt', 'pp', { kind: 'struct', fields: [] }));
const printerOf = (receiver: Value): Printer => receiverStruct(receiver).native?.printer as Printer;
const optional = (value: number | undefined): Value[] => [BigInt(value ?? 0), value !== undefined];
addMethod(PP, 'Flag', fn([INT], [BOOL]), (receiver, [char]) => printerOf(receiver).flag(Number(char as bigint)), true);
addMethod(PP, 'Width', fn([], [INT, BOOL]), (receiver) => optional(printerOf(receiver).width()), true);
addMethod(PP, 'Precision', fn([], [INT, BOOL]), (receiver) => optional(printerOf(receiver).precision()), true);
for (const name of ['Write', 'WriteString']) {
  addMethod(
    PP,
    name,
    fn([name === 'Write' ? BYTES : STRING], [INT, ERROR_TYPE]),
    (receiver, [data]) => {
      const bytes = name === 'Write' ? bytesOf(data) : (data as string);
      printerOf(receiver).write(bytes);
      return [BigInt(bytes.length), undefined];
    },
    true
  );
}

Printer.formatter = (printer, iface, verb) => {
  if (missingMethod(iface.type, FORMATTER.underlying as InterfaceType)) return false;
  const state = new Iface(pointerTo(PP), new Pointer(new Cell(new GoStruct([], { printer })), 'v'));
  callMethod(iface, 'Format', [state, BigInt(verb.codePointAt(0) as number)]);
  return true;
};

/** `fmt.FormatString`: the directive, with its flags, width and precision, that a State was formatting. */
function formatString(state: Value, verb: number): string {
  let directive = '%';
  for (const char of ' +-#0') {
    if (callMethod(state, 'Flag', [BigInt(char.codePointAt(0) as number)]) === true) directive += char;
  }
  const [width, hasWidth] = callMethod(state, 'Width') as [bigint, boolean];
  if (hasWidth) directive += String(width);
  const [precision, hasPrecision] = callMethod(state, 'Precision') as [bigint, boolean];
  if (hasPrecision) directive += `.${precision}`;
  return directive + encodeRune(verb);
}

const members: Record<string, Entity> = {
  State: typeEntity(STATE),
  Scanner: typeEntity(SCANNER),
  ScanState: typeEntity(SCAN_STATE),
  Formatter: typeEntity(FORMATTER),
  GoStringer: typeEntity(GO_STRINGER),
  FormatString: nativeFunction('FormatString', fn([STATE, RUNE], [STRING]), ([state, verb]) =>
    formatString(state, Number(verb as bigint))
  ),
  Append: nativeFunction('Append', fn([BYTES, ANY_SLICE], [BYTES], true), ([b, args]) =>
    appendBytes(b, new Printer().print(sliceValues(args)))
  ),
  Appendln: nativeFunction('Appendln', fn([BYTES, ANY_SLICE], [BYTES], true), ([b, args]) =>
    appendBytes(b, new Printer().println(sliceValues(args)))
  ),
  Appendf: nativeFunction('Appendf', fn([BYTES, STRING, ANY_SLICE], [BYTES], true), ([b, format, args]) =>
    appendBytes(b, new Printer().printf(format as string, sliceValues(args)))
  ),
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
  Sscan: nativeFunction('Sscan', fn([STRING, ANY_SLICE], ERROR_RESULTS, true), ([text, args]) =>
    sscan(text as string, sliceValues(args), 'scan')
  ),
  Sscanln: nativeFunction('Sscanln', fn([STRING, ANY_SLICE], ERROR_RESULTS, true), ([text, args]) =>
    sscan(text as string, sliceValues(args), 'scanln')
  ),
  Sscanf: nativeFunction('Sscanf', fn([STRING, STRING, ANY_SLICE], ERROR_RESULTS, true), ([text, format, args]) =>
    sscanf(text as string, format as string, sliceValues(args))
  ),
  Fscan: nativeFunction('Fscan', fn([IO_READER, ANY_SLICE], ERROR_RESULTS, true), ([reader, args]) =>
    fscan(reader, sliceValues(args), 'scan')
  ),
  Fscanln: nativeFunction('Fscanln', fn([IO_READER, ANY_SLICE], ERROR_RESULTS, true), ([reader, args]) =>
    fscan(reader, sliceValues(args), 'scanln')
  ),
  Fscanf: nativeFunction('Fscanf', fn([IO_READER, STRING, ANY_SLICE], ERROR_RESULTS, true), ([reader, format, args]) =>
    fscanf(reader, format as string, sliceValues(args))
  ),
};

export const FMT_PACKAGE = definePackage('fmt', members, ['Scan', 'Scanln', 'Scanf']);
