// code-gauge-allow-file fileNcss -- Follows std::fmt's formatting rules case by case.
import type { FormatPiece, FormatSpec } from './ast';
import { type DebugPart, emit, list, rangeText, structText, tupleText, type WriteChunk } from './debugText';
import { debugEscapesUnicode } from './debugUnicode';
import { floatNumber } from './floatBits';
import { debugFloat, displayFloat, expFloat, fixedFloat } from './floatFormat';
import { normalize } from './infer';
import { iteratorDebug } from './iterDebug';
import { ioErrorDebug, ioErrorDisplay, ioErrorKindDisplay, ioErrorPads } from './natives/io';
import { durationDebug } from './natives/threads';
import { wrap } from './ops';
import { FmtFailure } from './runtime';
import { ERROR_TYPES } from './traits';
import { type AdtDef, type IntName, shallow, type Type } from './types';
import {
  type BorrowGuard,
  type CellBox,
  type DynValue,
  type EntryValue,
  EnumValue,
  type IoStream,
  isPlace,
  type IterValue,
  type MapValue,
  type RangeValue,
  type SetValue,
  type SharedBox,
  sliceItems,
  StructValue,
  textOf,
  type Value,
} from './values';

/** std's I/O handles, whose `Debug` shows nothing they hold (`Stdin { .. }`) or what this environment does not keep. */
const IO_HANDLES = new Set([
  'Stdin',
  'StdinLock',
  'Stdout',
  'StdoutLock',
  'Stderr',
  'StderrLock',
  'BufReader',
  'BufWriter',
  'OpenOptions',
]);

export interface Spec {
  fill: string;
  align: '<' | '>' | '^' | undefined;
  sign: '+' | '-' | undefined;
  alternate: boolean;
  zero: boolean;
  width: number | undefined;
  precision: number | undefined;
  debugHex?: 'x' | 'X';
}

export const DEFAULT_SPEC: Spec = {
  fill: ' ',
  align: undefined,
  sign: undefined,
  alternate: false,
  zero: false,
  width: undefined,
  precision: undefined,
};

/** The program's own `Display` and `Debug` impls, and the formatting of runtime values only the runtime knows. */
export interface FormatHooks {
  /** Runs the program's `fmt` for a type, returning undefined when the program has no impl of the trait for it. */
  userFmt(trait: 'Display' | 'Debug', type: Type, value: Value, spec: Spec, write?: WriteChunk): string | undefined;
  fieldTypes(def: AdtDef, args: Type[], variant: number): Type[];
  /** The concrete type of a type that may mention the running function's type parameters. */
  concrete(type: Type): Type;
  /** Checks the length of a string the formatting builds, and charges for the `written` characters. */
  allocateString(length: number, written?: number): void;
  withActiveBorrows<T>(values: Value[], use: () => T): T;
}

export class Formatter {
  constructor(private readonly hooks: FormatHooks) {}

  format(pieces: FormatPiece[], values: Value[], types: Type[], write?: WriteChunk): string {
    return this.hooks.withActiveBorrows(values, () => this.formatArguments(pieces, values, types, write));
  }

  private formatArguments(pieces: FormatPiece[], values: Value[], types: Type[], write?: WriteChunk): string {
    let text = '';
    for (const piece of pieces) {
      if (typeof piece === 'string') {
        this.hooks.allocateString(text.length + piece.length, piece.length);
        text += emit(piece, write);
        continue;
      }
      const spec = this.resolveSpec(piece, values);
      try {
        const written = this.formatOne(piece.trait, values[piece.arg], types[piece.arg], spec, write);
        this.hooks.allocateString(text.length + written.length, written.length);
        text += written;
      } catch (error) {
        if (error instanceof FmtFailure) throw new FmtFailure(text + error.written);
        throw error;
      }
    }
    return text;
  }

  private resolveSpec(piece: FormatSpec, values: Value[]): Spec {
    const count = (c: FormatSpec['width']): number | undefined => {
      if (!c) return undefined;
      if (c.kind === 'literal') return c.value;
      return Number(deref(values[c.arg]) as bigint);
    };
    const width = count(piece.width);
    // Padding writes at least `width` characters.
    if (width !== undefined) this.hooks.allocateString(width, 0);
    return {
      fill: piece.fill,
      align: piece.align,
      sign: piece.sign,
      alternate: piece.alternate,
      zero: piece.zero,
      width,
      precision: count(piece.precision),
      debugHex: piece.debugHex,
    };
  }

  formatOne(trait: FormatSpec['trait'], value: Value, type: Type, spec: Spec, write?: WriteChunk): string {
    switch (trait) {
      case 'display': {
        return this.display(value, type, spec, write);
      }
      case 'debug': {
        return this.debug(value, type, spec, spec.alternate ? 0 : undefined, write);
      }
      default: {
        return this.radix(trait, value, type, spec, write);
      }
    }
  }

  // code-gauge-allow functionNcss -- Follows std::fmt's formatting rules case by case.
  display(value: Value, type: Type, spec: Spec, write?: WriteChunk): string {
    const t = this.concrete(type);
    const v = deref(value);
    switch (t.kind) {
      case 'ref': {
        return this.display(value, t.target, spec, write);
      }
      case 'int': {
        return padNumber(integerText(v as bigint, spec), spec, 0, write);
      }
      case 'float': {
        return padNumber(this.floatText(floatNumber(v), t.name === 'f32', spec), spec, 0, write);
      }
      case 'bool': {
        return padString(String(v), spec, write);
      }
      case 'char':
      case 'str': {
        return padString(textOf(v), spec, write);
      }
      case 'never': {
        return '';
      }
      case 'dyn': {
        const dynValue = v as DynValue;
        return this.display(dynValue.value, dynValue.type, spec, write);
      }
      case 'adt': {
        const user = this.hooks.userFmt('Display', t, v, spec, write);
        if (user !== undefined) return user;
        switch (t.def.builtin) {
          case 'String':
          case 'PathDisplay': {
            return padString(textOf(v), spec, write);
          }
          case 'Box':
          case 'Pin': {
            return this.display(v, t.args[0], spec, write);
          }
          case 'Rc':
          case 'Arc': {
            return this.display((v as SharedBox).value, t.args[0], spec, write);
          }
          case 'Ref':
          case 'RefMut':
          case 'MutexGuard':
          case 'RwLockReadGuard':
          case 'RwLockWriteGuard': {
            return this.display((v as BorrowGuard).cell.value, t.args[0], spec, write);
          }
          case 'CaseIter':
          case 'EscapeDefault':
          case 'EscapeUnicode': {
            // `ToUppercase` writes its chars one by one, ignoring the width.
            const text = caseIterText(v);
            if (write) for (const char of text) write(char);
            return text;
          }
          default: {
            return stdErrorText(t.def.builtin as string, v, spec, write);
          }
        }
      }
      default: {
        return '';
      }
    }
  }

  private floatText(value: number, f32: boolean, spec: Spec): string {
    // A float writes all the digits its precision asks for.
    if (spec.precision !== undefined) this.hooks.allocateString(spec.precision, 0);
    let text = spec.precision === undefined ? displayFloat(value, f32) : fixedFloat(value, spec.precision);
    if (spec.sign === '+' && !text.startsWith('-') && !Number.isNaN(value)) text = `+${text}`;
    return text;
  }

  /**
   * `{:?}` of a value; `indent` is the nesting depth of `{:#?}`, or undefined for the compact form. Containers pass the
   * placeholder's options on to the values in them, as Rust's builders do.
   */
  debug(value: Value, type: Type, spec: Spec, indent: number | undefined, write?: WriteChunk): string {
    let streamed = false;
    const chunks = write
      ? (text: string): void => {
          streamed = true;
          write(text);
        }
      : undefined;
    const text = this.debugOf(value, type, spec, indent, chunks);
    if (!streamed) write?.(text);
    this.hooks.allocateString(text.length);
    return text;
  }

  // code-gauge-allow functionNcss -- Follows std::fmt's formatting rules case by case.
  private debugOf(value: Value, type: Type, spec: Spec, indent: number | undefined, write?: WriteChunk): string {
    const t = this.concrete(type);
    const v = deref(value);
    switch (t.kind) {
      case 'ref': {
        return this.debugOf(value, t.target, spec, indent, write);
      }
      case 'int': {
        if (spec.debugHex) return this.radix(spec.debugHex === 'x' ? 'lowerHex' : 'upperHex', v, t, spec, write);
        return padNumber(integerText(v as bigint, spec), spec, 0, write);
      }
      case 'float': {
        if (spec.precision !== undefined)
          return padNumber(this.floatText(floatNumber(v), t.name === 'f32', spec), spec, 0, write);
        let text = debugFloat(floatNumber(v), t.name === 'f32');
        if (spec.sign === '+' && !text.startsWith('-') && text !== 'NaN') text = `+${text}`;
        return padNumber(text, spec, 0, write);
      }
      case 'bool': {
        return pad(String(v), spec, '<', write);
      }
      case 'char': {
        // `char`'s `Debug` writes its quoted escape directly, ignoring the width.
        return quotedDebug(v as string, true, write);
      }
      case 'str': {
        return quotedDebug(textOf(v), false, write);
      }
      case 'tuple': {
        if (t.elems.length === 0) return pad('()', spec, '<', write);
        const items = t.elems.map(
          (elem, index) => (inner: number | undefined, sink?: WriteChunk) =>
            this.debug((v as Value[])[index], elem, spec, inner, sink)
        );
        return list('(', ')', items, indent, write, t.elems.length === 1);
      }
      case 'array':
      case 'slice': {
        const items = sliceItems(v).map(
          (item) => (inner: number | undefined, sink?: WriteChunk) => this.debug(item, t.elem, spec, inner, sink)
        );
        return list('[', ']', items, indent, write);
      }
      case 'dyn': {
        // A thread's panic payload, `Box<dyn Any + Send>`, shows none of what it holds.
        if (t.trait.trait.name === 'Any') return emit('Any { .. }', write);
        const dynValue = v as DynValue;
        return this.debug(dynValue.value, dynValue.type, spec, indent, write);
      }
      case 'adt': {
        return this.debugAdt(v, t, spec, indent, write);
      }
      default: {
        return '';
      }
    }
  }

  // code-gauge-allow functionNcss -- Follows std::fmt's formatting rules case by case.
  private debugAdt(
    v: Value,
    t: Type & { kind: 'adt' },
    spec: Spec,
    indent: number | undefined,
    write?: WriteChunk
  ): string {
    const user = this.hooks.userFmt('Debug', t, v, { ...spec, alternate: indent !== undefined }, write);
    if (user !== undefined) return user;
    const { def } = t;
    switch (def.builtin) {
      case 'String': {
        return quotedDebug(textOf(v), false, write);
      }
      case 'Vec':
      case 'VecDeque':
      case 'BinaryHeap': {
        const items = (v as Value[]).map(
          (item) => (inner: number | undefined, sink?: WriteChunk) => this.debug(item, t.args[0], spec, inner, sink)
        );
        return list('[', ']', items, indent, write);
      }
      case 'Box':
      case 'Pin': {
        return this.debug(v, t.args[0], spec, indent, write);
      }
      case 'HashMap':
      case 'BTreeMap': {
        const map = v as MapValue;
        const entries = [...map.entries.values()];
        const items = entries.map(([key, item]) => (inner: number | undefined, sink?: WriteChunk) => {
          const keyText = this.debug(key, t.args[0], spec, inner, sink);
          return keyText + emit(': ', sink) + this.debug(item, t.args[1], spec, inner, sink);
        });
        return list('{', '}', items, indent, write);
      }
      case 'HashSet':
      case 'BTreeSet': {
        return this.setText(v as SetValue, t.args[0], spec, indent, write);
      }
      case 'Range':
      case 'RangeInclusive':
      case 'RangeFrom':
      case 'RangeTo':
      case 'RangeToInclusive':
      case 'RangeFull': {
        return rangeText(v as RangeValue, (value) => this.debug(value, t.args[0], spec, indent, write), write);
      }
      case 'ParseIntError':
      case 'ParseFloatError':
      case 'ParseCharError':
      case 'TryFromIntError':
      case 'TryFromSliceError':
      case 'CharTryFromError':
      case 'TryFromCharError':
      case 'FmtError': {
        return errorDebug(def.builtin, v, indent);
      }
      case 'CaseIter': {
        return caseIterDebug(v);
      }
      case 'EscapeDefault':
      case 'EscapeUnicode': {
        return charEscapeDebug(def.builtin, v, indent);
      }
      case 'Turtle': {
        return 'Turtle';
      }
      case 'IoError': {
        return emit(ioErrorDebug(v, indent), write);
      }
      case 'Iter': {
        return this.iteratorText(v as IterValue, t, spec, indent, write);
      }
      case 'Entry':
      case 'OccupiedEntry': {
        return this.entryText(v as EntryValue, t, spec, indent, write);
      }
      default: {
        return this.debugRuntimeAdt(v, t, spec, indent, write) ?? this.debugUserAdt(v, t, spec, indent, write);
      }
    }
  }

  /** The `Debug` of the types of paths, smart pointers, cells, threads, and C strings; undefined for the others. */
  // code-gauge-allow functionNcss -- One case per runtime type of the standard library.
  private debugRuntimeAdt(
    v: Value,
    t: Type & { kind: 'adt' },
    spec: Spec,
    indent: number | undefined,
    write?: WriteChunk
  ): string | undefined {
    const { def } = t;
    switch (def.builtin) {
      case 'Path':
      case 'PathBuf':
      case 'PathDisplay': {
        return quotedDebug(textOf(v), false, write);
      }
      case 'Rc':
      case 'Arc': {
        return this.debug((v as SharedBox).value, t.args[0], spec, indent, write);
      }
      case 'MutexGuard':
      case 'RwLockReadGuard':
      case 'RwLockWriteGuard': {
        return this.debug((v as BorrowGuard).cell.value, t.args[0], spec, indent, write);
      }
      case 'Mutex':
      case 'RwLock': {
        const cell = v as CellBox;
        const data: DebugPart =
          lockedText(def.builtin, cell) ?? ((inner, sink) => this.debug(cell.value, t.args[0], spec, inner, sink));
        return structText(
          def.builtin,
          [
            ['data', data],
            ['poisoned', (_inner, sink) => emit(String(cell.poisoned), sink)],
          ],
          indent,
          true,
          write
        );
      }
      case 'Duration': {
        // The precision is the number of fraction digits, which the text already has.
        return padString(durationDebug(v, spec.precision), { ...spec, precision: undefined }, write);
      }
      case 'CStr': {
        return padString(`"${(v as bigint[]).map((byte) => escapeAscii(Number(byte))).join('')}"`, spec, write);
      }
      case 'File': {
        const stream = v as IoStream;
        const { fd, path } = stream.file ?? { fd: 0, path: '' };
        return structText(
          'File',
          [
            ['fd', textPart(String(fd))],
            ['path', textPart(JSON.stringify(path))],
            ['read', textPart(String(stream.reader !== undefined))],
            ['write', textPart(String(stream.writer !== undefined))],
          ],
          indent,
          false,
          write
        );
      }
      case 'Thread': {
        const id: DebugPart = (_inner, sink) => emit(`ThreadId(${String(v)})`, sink);
        const name: DebugPart = (_inner, sink) => emit(v === 1 ? 'Some("main")' : 'None', sink);
        return structText(
          'Thread',
          [
            ['id', id],
            ['name', name],
          ],
          indent,
          true,
          write
        );
      }
      case 'TryLockError': {
        return emit((v as EnumValue).variant === 0 ? 'Poisoned(..)' : 'WouldBlock', write);
      }
      case 'Sender':
      case 'SendError':
      case 'PoisonError':
      case 'Receiver':
      case 'JoinHandle': {
        return emit(`${def.builtin} { .. }`, write);
      }
      case 'Ref':
      case 'RefMut': {
        return this.debug((v as BorrowGuard).cell.value, t.args[0], spec, indent, write);
      }
      case 'Weak': {
        return emit('(Weak)', write);
      }
      case 'RefCell':
      case 'Cell': {
        const cell = v as CellBox;
        // A `RefCell` borrowed mutably shows no value, as reading it would conflict.
        const value: DebugPart =
          def.builtin === 'RefCell' && cell.borrows < 0
            ? (_inner, sink) => emit('<borrowed>', sink)
            : (inner, sink) => this.debug(cell.value, t.args[0], spec, inner, sink);
        return structText(def.builtin, [['value', value]], indent, false, write);
      }
      default: {
        if (IO_HANDLES.has(t.def.builtin as string)) return ioHandleDebug(t.def.builtin as string, spec, write);
        return undefined;
      }
    }
  }

  private setText(set: SetValue, elem: Type, spec: Spec, indent: number | undefined, write?: WriteChunk): string {
    const values = [...set.entries.values()];
    const items = values.map(
      (item) => (inner: number | undefined, sink?: WriteChunk) => this.debug(item, elem, spec, inner, sink)
    );
    return list('{', '}', items, indent, write);
  }

  /** A map's entry, as `Entry`, `OccupiedEntry`, and `VacantEntry` debug: the key and any value it holds. */
  private entryText(
    entry: EntryValue,
    t: Type & { kind: 'adt' },
    spec: Spec,
    indent: number | undefined,
    write?: WriteChunk
  ): string {
    const held = entry.map.entries.get(entry.lookup);
    const key: DebugPart = (inner, sink) => this.debug(held ? held[0] : entry.key, t.args[0], spec, inner, sink);
    const inner: DebugPart = held
      ? (depth, sink) => {
          const value: DebugPart = (nested, stream) => this.debug(held[1], t.args[1], spec, nested, stream);
          return structText(
            'OccupiedEntry',
            [
              ['key', key],
              ['value', value],
            ],
            depth,
            !entry.map.sorted,
            sink
          );
        }
      : (depth, sink) => tupleText('VacantEntry', [key], depth, sink);
    return t.def.builtin === 'OccupiedEntry' ? inner(indent, write) : tupleText('Entry', [inner], indent, write);
  }

  private iteratorText(
    iter: IterValue,
    t: Type & { kind: 'adt' },
    spec: Spec,
    indent: number | undefined,
    write?: WriteChunk
  ): string {
    const debug = (value: Value, type: Type, inner: number | undefined, sink?: WriteChunk): string =>
      this.debug(value, type, spec, inner, sink);
    return this.hooks.withActiveBorrows([iter], () => iteratorDebug(iter, t.args[0], t.args[1], debug, indent, write));
  }

  private debugUserAdt(
    v: Value,
    t: Type & { kind: 'adt' },
    spec: Spec,
    indent: number | undefined,
    write?: WriteChunk
  ): string {
    const { def } = t;
    const variantIndex = v instanceof EnumValue ? v.variant : 0;
    const variant = def.variants[variantIndex];
    const fields = v instanceof EnumValue || v instanceof StructValue ? v.fields : [];
    const types = this.hooks.fieldTypes(def, t.args, variantIndex);
    if (variant.shape === 'unit' || (variant.shape === 'tuple' && types.length === 0)) return emit(variant.name, write);
    const parts = types.map(
      (type, index) => (inner: number | undefined, sink?: WriteChunk) =>
        this.debug(fields[index], type, spec, inner, sink)
    );
    if (variant.shape === 'tuple') return tupleText(variant.name, parts, indent, write);
    return structText(
      variant.name,
      parts.map((part, index) => [variant.fields[index].name, part]),
      indent,
      false,
      write
    );
  }

  // code-gauge-allow functionCognitiveComplexity -- Follows std::fmt's formatting rules case by case.
  private radix(trait: FormatSpec['trait'], value: Value, type: Type, spec: Spec, write?: WriteChunk): string {
    let t = this.concrete(type);
    while (t.kind === 'ref') t = this.concrete(t.target);
    const v = deref(value);
    if (trait === 'lowerExp' || trait === 'upperExp') {
      if (spec.precision !== undefined) this.hooks.allocateString(spec.precision, 0);
      const letter = trait === 'lowerExp' ? 'e' : 'E';
      if (t.kind === 'float') {
        let text = expFloat(floatNumber(v), t.name === 'f32', spec.precision, letter);
        if (spec.sign === '+' && !text.startsWith('-') && !Number.isNaN(floatNumber(v))) text = `+${text}`;
        return padNumber(text, spec, 0, write);
      }
      return padNumber(intExp(v as bigint, spec.precision, letter, spec.sign === '+'), spec, 0, write);
    }
    const base = { lowerHex: 16, upperHex: 16, octal: 8, binary: 2 }[trait as 'lowerHex'];
    const name = t.kind === 'int' ? t.name : ('i32' as IntName);
    const unsigned = BigInt.asUintN(
      name === 'isize' || name === 'usize' ? 64 : Number(name.slice(1)),
      wrap(name, v as bigint)
    );
    let digits = unsigned.toString(base);
    if (trait === 'upperHex') digits = digits.toUpperCase();
    const prefix = spec.alternate
      ? { lowerHex: '0x', upperHex: '0x', octal: '0o', binary: '0b' }[trait as 'lowerHex']
      : '';
    const sign = spec.sign === '+' ? '+' : '';
    return padNumber(sign + prefix + digits, spec, prefix.length, write);
  }

  private concrete(type: Type): Type {
    return normalize(shallow(this.hooks.concrete(type)));
  }
}

// code-gauge-allow functionCognitiveComplexity -- Follows std::fmt's formatting rules case by case.
function intExp(value: bigint, precision: number | undefined, letter: string, plus: boolean): string {
  const negative = value < 0n;
  let digits = (negative ? -value : value).toString();
  let exponent = digits.length - 1;
  if (precision === undefined) {
    digits = digits.replace(/0+$/, '') || '0';
  } else if (digits.length > precision + 1) {
    // Round half to even at the precision.
    const keep = digits.slice(0, precision + 1);
    const rest = digits.slice(precision + 1);
    let rounded = BigInt(keep);
    const half = `5${'0'.repeat(rest.length - 1)}`;
    if (rest > half || (rest === half && rounded % 2n === 1n)) rounded++;
    digits = rounded.toString();
    if (digits.length > precision + 1) {
      digits = digits.slice(0, precision + 1);
      exponent++;
    }
  } else {
    digits = digits.padEnd(precision + 1, '0');
  }
  const mantissa = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
  if (value === 0n) exponent = 0;
  return `${negative ? '-' : plus ? '+' : ''}${mantissa}${letter}${exponent}`;
}

function deref(value: Value): Value {
  let current = value;
  while (isPlace(current)) current = current.get();
  return current;
}

function caseIterText(value: Value): string {
  return ((value as IterValue).rest?.() ?? []).join('');
}

/** `{:?}` of `ToUppercase` or `ToLowercase`: the chars it has left, as std's `CaseMappingIter` holds them. */
function caseIterDebug(value: Value): string {
  const { name } = value as unknown as { name: string };
  const chars = [...caseIterText(value)].map((c) => `'${escapeDebug(c, true)}'`).join(', ');
  return `${name}(CaseMappingIter(IntoIter([${chars}])))`;
}

export function charEscapeDebug(name: string, value: Value, indent: number | undefined): string {
  return tupleText(name, [() => `EscapeIterInner('${caseIterText(value)}')`], indent);
}

function charCount(text: string): number {
  return [...text].length;
}

export function pad(text: string, spec: Spec, defaultAlign: '<' | '>', write?: WriteChunk): string {
  if (spec.width === undefined) return emit(text, write);
  const padding = spec.width - charCount(text);
  if (padding <= 0) return emit(text, write);
  const align = spec.align ?? defaultAlign;
  const left = align === '<' ? 0 : align === '>' ? padding : Math.floor(padding / 2);
  return repeatFill(spec.fill, left, write) + emit(text, write) + repeatFill(spec.fill, padding - left, write);
}

function repeatFill(fill: string, count: number, write?: WriteChunk): string {
  if (write) for (let index = 0; index < count; index++) write(fill);
  return fill.repeat(count);
}

function padString(text: string, spec: Spec, write?: WriteChunk): string {
  let shown = text;
  if (spec.precision !== undefined) shown = [...text].slice(0, spec.precision).join('');
  return pad(shown, spec, '<', write);
}

function integerText(value: bigint, spec: Spec): string {
  return (spec.sign === '+' && value >= 0n ? '+' : '') + value.toString();
}

/** Pads a number, with `0` padding after its sign and radix prefix. */
function padNumber(shown: string, spec: Spec, prefixLength = 0, write?: WriteChunk): string {
  if (spec.zero && spec.width !== undefined) {
    const signLength = shown.startsWith('-') || shown.startsWith('+') ? 1 : 0;
    const head = shown.slice(0, signLength + prefixLength);
    const body = shown.slice(signLength + prefixLength);
    const zeros = Math.max(0, spec.width - charCount(shown));
    return emit(head, write) + repeatFill('0', zeros, write) + emit(body, write);
  }
  return pad(shown, spec, '>', write);
}

function quotedDebug(text: string, isChar: boolean, write?: WriteChunk): string {
  const quote = isChar ? "'" : '"';
  return emit(quote, write) + escapeDebug(text, isChar, write) + emit(quote, write);
}

export function escapeDebug(text: string, isChar: boolean, write?: WriteChunk): string {
  let result = '';
  let start = 0;
  let end = 0;
  for (const char of text) {
    const escaped = escapeChar(char, isChar);
    if (escaped !== char) {
      result += emit(text.slice(start, end), write) + escaped;
      if (write) for (const part of escaped) write(part);
      start = end + char.length;
    }
    end += char.length;
  }
  return result + emit(text.slice(start), write);
}

function escapeChar(char: string, isChar: boolean): string {
  switch (char) {
    case '\t': {
      return String.raw`\t`;
    }
    case '\r': {
      return String.raw`\r`;
    }
    case '\n': {
      return String.raw`\n`;
    }
    case '\\': {
      return String.raw`\\`;
    }
    case '"': {
      return isChar ? '"' : String.raw`\"`;
    }
    case "'": {
      return isChar ? String.raw`\'` : "'";
    }
    case '\0': {
      return String.raw`\0`;
    }
    default: {
      const code = char.codePointAt(0)!;
      return debugEscapesUnicode(code) ? `\\u{${code.toString(16)}}` : char;
    }
  }
}

/** What a lock's `Debug` shows for its data while held where std cannot take it (quoted for `Mutex` alone). */
function lockedText(builtin: string, cell: CellBox): DebugPart | undefined {
  if (builtin === 'Mutex') return cell.borrows === 0 ? undefined : textPart('"<locked>"');
  return cell.borrows < 0 ? textPart('<locked>') : undefined;
}

function textPart(text: string): DebugPart {
  return (_inner, sink) => emit(text, sink);
}

function stdErrorDisplay(builtin: string, value: Value): string | undefined {
  switch (builtin) {
    case 'IoError': {
      return ioErrorDisplay(value);
    }
    case 'IoErrorKind': {
      const kind = value as EnumValue;
      return ioErrorKindDisplay(kind.def.variants[kind.variant].name);
    }
    case 'SendError': {
      return 'sending on a closed channel';
    }
    case 'RecvError': {
      return 'receiving on a closed channel';
    }
    case 'TryRecvError': {
      return (value as EnumValue).variant === 0 ? 'receiving on an empty channel' : 'receiving on a closed channel';
    }
    case 'PoisonError': {
      return 'poisoned lock: another task failed inside';
    }
    case 'TryLockError': {
      return (value as EnumValue).variant === 0
        ? 'poisoned lock: another task failed inside'
        : 'try_lock failed because the operation would block';
    }
    default: {
      return ERROR_TYPES.has(builtin) ? errorDisplay(builtin, value) : undefined;
    }
  }
}

export function errorDisplay(builtin: string, value: Value): string {
  const kind = (value as StructValue | undefined)?.fields?.[0] as string | undefined;
  switch (builtin) {
    case 'ParseIntError': {
      return (
        {
          Empty: 'cannot parse integer from empty string',
          InvalidDigit: 'invalid digit found in string',
          PosOverflow: 'number too large to fit in target type',
          NegOverflow: 'number too small to fit in target type',
          Zero: 'number would be zero for non-zero type',
        }[kind ?? 'InvalidDigit'] ?? ''
      );
    }
    case 'ParseFloatError': {
      return kind === 'Empty' ? 'cannot parse float from empty string' : 'invalid float literal';
    }
    case 'ParseBoolError': {
      return 'provided string was not `true` or `false`';
    }
    case 'TryFromSliceError': {
      return 'could not convert slice to array';
    }
    case 'TryFromIntError': {
      return `number too ${kind === 'NegOverflow' ? 'small' : 'large'} to fit in target type`;
    }
    case 'CharTryFromError': {
      return 'converted integer out of range for `char`';
    }
    case 'TryFromCharError': {
      return 'unicode code point out of range';
    }
    case 'FmtError': {
      return 'an error occurred when formatting an argument';
    }
    case 'FromUtf8Error': {
      return errorDisplay('Utf8Error', (value as StructValue).fields[1]);
    }
    case 'Utf8Error': {
      const [validUpTo, errorLen] = (value as StructValue).fields as [bigint, EnumValue];
      return errorLen.variant === 0
        ? `incomplete utf-8 byte sequence from index ${validUpTo}`
        : `invalid utf-8 sequence of ${errorLen.fields[0] as bigint} bytes from index ${validUpTo}`;
    }
    case 'ParseCharError': {
      return kind === 'EmptyString' ? 'cannot parse char from empty string' : 'too many characters in string';
    }
    default: {
      return '';
    }
  }
}

function errorDebug(builtin: string, value: Value, indent: number | undefined): string {
  const kind = (value as StructValue | undefined)?.fields?.[0] as string | undefined;
  const inner = (name: string, field: string, text: string): string =>
    indent === undefined
      ? `${name} { ${field}: ${text} }`
      : `${name} {\n${'    '.repeat(indent + 1)}${field}: ${text},\n${'    '.repeat(indent)}}`;
  switch (builtin) {
    case 'ParseIntError': {
      return inner('ParseIntError', 'kind', kind ?? 'InvalidDigit');
    }
    case 'ParseFloatError': {
      return inner('ParseFloatError', 'kind', kind ?? 'Invalid');
    }
    case 'TryFromIntError': {
      const text = kind ?? 'PosOverflow';
      return indent === undefined
        ? `TryFromIntError(${text})`
        : `TryFromIntError(\n${'    '.repeat(indent + 1)}${text},\n${'    '.repeat(indent)})`;
    }
    case 'FmtError': {
      return 'Error';
    }
    case 'CharTryFromError':
    case 'TryFromCharError':
    case 'TryFromSliceError': {
      return indent === undefined
        ? `${builtin}(())`
        : `${builtin}(\n${'    '.repeat(indent + 1)}(),\n${'    '.repeat(indent)})`;
    }
    case 'ParseCharError': {
      return inner('ParseCharError', 'kind', kind ?? 'TooManyChars');
    }
    default: {
      return builtin;
    }
  }
}

/** A byte as `u8::escape_ascii` writes it, which `CStr`'s `Debug` shows. */
function escapeAscii(byte: number): string {
  const escapes: Record<number, string> = {
    9: String.raw`\t`,
    10: String.raw`\n`,
    13: String.raw`\r`,
    34: String.raw`\"`,
    39: String.raw`\'`,
    92: String.raw`\\`,
  };
  if (escapes[byte]) return escapes[byte];
  if (byte >= 0x20 && byte < 0x7f) return String.fromCodePoint(byte);
  return `\\x${byte.toString(16).padStart(2, '0')}`;
}

/**
 * The `Display` of an error type of std; `ErrorKind` and an `io::Error` std made write theirs with `write_str`, which
 * ignores the width.
 */
function stdErrorText(builtin: string, v: Value, spec: Spec, write: WriteChunk | undefined): string {
  const text = stdErrorDisplay(builtin, v);
  if (text === undefined) return '';
  const unpadded = builtin === 'IoErrorKind' || (builtin === 'IoError' && !ioErrorPads(v));
  if (!unpadded) return padString(text, spec, write);
  write?.(text);
  return text;
}

/** The `Debug` of std's I/O handles: `Stdin { .. }`; the buffers and platform flags others show are not kept here. */
function ioHandleDebug(builtin: string, spec: Spec, write: WriteChunk | undefined): string {
  if (builtin === 'BufReader' || builtin === 'BufWriter' || builtin === 'OpenOptions') {
    throw new UnsupportedFormat(`${builtin} の {:?} での表示`);
  }
  return padString(`${builtin} { .. }`, spec, write);
}

/** A value whose formatting this environment does not support, which the formatting macro reports where it is. */
export class UnsupportedFormat {
  constructor(readonly what: string) {}
}
