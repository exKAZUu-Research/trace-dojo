import type { FormatPiece, FormatSpec } from './ast';
import { type DebugPart, list, structText, tupleText } from './debugText';
import { debugFloat, displayFloat, expFloat, fixedFloat } from './floatFormat';
import { normalize } from './infer';
import { iteratorDebug } from './iterDebug';
import { compareValues, wrap } from './ops';
import { FmtFailure } from './runtime';
import { ERROR_TYPES } from './traits';
import { type AdtDef, type IntName, shallow, type Type } from './types';
import {
  type DynValue,
  type EntryValue,
  EnumValue,
  isPlace,
  type IterValue,
  type MapValue,
  type RangeValue,
  type SetValue,
  sliceItems,
  StructValue,
  type Value,
} from './values';

/** The options of a placeholder, with counts resolved to numbers. */
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
  userFmt(trait: 'Display' | 'Debug', type: Type, value: Value, spec: Spec): string | undefined;
  fieldTypes(def: AdtDef, args: Type[], variant: number): Type[];
  /** The concrete type of a type that may mention the running function's type parameters. */
  concrete(type: Type): Type;
}

export class Formatter {
  constructor(private readonly hooks: FormatHooks) {}

  /** Formats a format string's pieces with the values and types of its arguments. */
  format(pieces: FormatPiece[], values: Value[], types: Type[]): string {
    let text = '';
    for (const piece of pieces) {
      if (typeof piece === 'string') {
        text += piece;
        continue;
      }
      const spec = this.resolveSpec(piece, values);
      try {
        text += this.formatOne(piece.trait, values[piece.arg], types[piece.arg], spec);
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
    return {
      fill: piece.fill,
      align: piece.align,
      sign: piece.sign,
      alternate: piece.alternate,
      zero: piece.zero,
      width: count(piece.width),
      precision: count(piece.precision),
      debugHex: piece.debugHex,
    };
  }

  formatOne(trait: FormatSpec['trait'], value: Value, type: Type, spec: Spec): string {
    switch (trait) {
      case 'display': {
        return this.display(value, type, spec);
      }
      case 'debug': {
        return this.debug(value, type, spec, spec.alternate ? 0 : undefined);
      }
      default: {
        return this.radix(trait, value, type, spec);
      }
    }
  }

  // code-gauge-allow functionNcss 37 -- Follows std::fmt's formatting rules case by case.
  display(value: Value, type: Type, spec: Spec): string {
    const t = this.concrete(type);
    const v = deref(value);
    switch (t.kind) {
      case 'ref': {
        return this.display(value, t.target, spec);
      }
      case 'int': {
        return padNumber(String(v as bigint), spec);
      }
      case 'float': {
        return padNumber(this.floatText(v as number, t.name === 'f32', spec), spec);
      }
      case 'bool': {
        return padString(String(v), spec);
      }
      case 'char':
      case 'str': {
        return padString(v as string, spec);
      }
      case 'never': {
        return '';
      }
      case 'dyn': {
        const dynValue = v as DynValue;
        return this.display(dynValue.value, dynValue.type, spec);
      }
      case 'adt': {
        const user = this.hooks.userFmt('Display', t, v, spec);
        if (user !== undefined) return user;
        switch (t.def.builtin) {
          case 'String': {
            return padString(v as string, spec);
          }
          case 'Box': {
            return this.display(v, t.args[0], spec);
          }
          case 'CaseIter': {
            // `ToUppercase` writes its chars one by one, ignoring the width.
            return caseIterText(v);
          }
          default: {
            if (ERROR_TYPES.has(t.def.builtin as string))
              return padString(errorDisplay(t.def.builtin as string, v), spec);
            return '';
          }
        }
      }
      default: {
        return '';
      }
    }
  }

  private floatText(value: number, f32: boolean, spec: Spec): string {
    let text = spec.precision === undefined ? displayFloat(value, f32) : fixedFloat(value, spec.precision);
    if (spec.sign === '+' && !text.startsWith('-') && !Number.isNaN(value)) text = `+${text}`;
    return text;
  }

  /**
   * `{:?}` of a value; `indent` is the nesting depth of `{:#?}`, or undefined for the compact form. Containers pass the
   * placeholder's options on to the values in them, as Rust's builders do.
   */
  // code-gauge-allow functionCognitiveComplexity 16 -- Follows std::fmt's formatting rules case by case.
  // code-gauge-allow functionNcss 41 -- Follows std::fmt's formatting rules case by case.
  debug(value: Value, type: Type, spec: Spec, indent: number | undefined): string {
    const t = this.concrete(type);
    const v = deref(value);
    switch (t.kind) {
      case 'ref': {
        return this.debug(value, t.target, spec, indent);
      }
      case 'int': {
        if (spec.debugHex) return this.radix(spec.debugHex === 'x' ? 'lowerHex' : 'upperHex', v, t, spec);
        return padNumber(String(v as bigint), spec);
      }
      case 'float': {
        if (spec.precision !== undefined) return padNumber(this.floatText(v as number, t.name === 'f32', spec), spec);
        let text = debugFloat(v as number, t.name === 'f32');
        if (spec.sign === '+' && !text.startsWith('-') && text !== 'NaN') text = `+${text}`;
        return padNumber(text, spec);
      }
      case 'bool': {
        return pad(String(v), spec, '<');
      }
      case 'char': {
        // `char`'s `Debug` writes its quoted escape directly, ignoring the width.
        return `'${escapeDebug(v as string, true)}'`;
      }
      case 'str': {
        return `"${escapeDebug(v as string, false)}"`;
      }
      case 'tuple': {
        if (t.elems.length === 0) return pad('()', spec, '<');
        const items = t.elems.map(
          (elem, index) => (inner: number | undefined) => this.debug((v as Value[])[index], elem, spec, inner)
        );
        if (t.elems.length === 1 && indent === undefined) return `(${items[0](undefined)},)`;
        return list('(', ')', items, indent);
      }
      case 'array':
      case 'slice': {
        const items = sliceItems(v).map((item) => (inner: number | undefined) => this.debug(item, t.elem, spec, inner));
        return list('[', ']', items, indent);
      }
      case 'dyn': {
        const dynValue = v as DynValue;
        return this.debug(dynValue.value, dynValue.type, spec, indent);
      }
      case 'adt': {
        return this.debugAdt(v, t, spec, indent);
      }
      default: {
        return '';
      }
    }
  }

  // code-gauge-allow functionNcss 58 -- Follows std::fmt's formatting rules case by case.
  private debugAdt(v: Value, t: Type & { kind: 'adt' }, spec: Spec, indent: number | undefined): string {
    const user = this.hooks.userFmt('Debug', t, v, { ...spec, alternate: indent !== undefined });
    // What an impl writes on several lines nests as the containers around it do (std's `PadAdapter`).
    if (user !== undefined) return indent ? user.replaceAll('\n', `\n${'    '.repeat(indent)}`) : user;
    const { def } = t;
    switch (def.builtin) {
      case 'String': {
        return `"${escapeDebug(v as string, false)}"`;
      }
      case 'Vec':
      case 'VecDeque':
      case 'BinaryHeap': {
        const items = (v as Value[]).map(
          (item) => (inner: number | undefined) => this.debug(item, t.args[0], spec, inner)
        );
        return list('[', ']', items, indent);
      }
      case 'Box': {
        return this.debug(v, t.args[0], spec, indent);
      }
      case 'HashMap':
      case 'BTreeMap': {
        const map = v as MapValue;
        const entries = this.mapEntries(map, t.args[0]);
        const items = entries.map(([key, item]) => (inner: number | undefined) => {
          const keyText = this.debug(key, t.args[0], spec, inner);
          return `${keyText}: ${this.debug(item, t.args[1], spec, inner)}`;
        });
        return list('{', '}', items, indent);
      }
      case 'HashSet':
      case 'BTreeSet': {
        return this.setText(v as SetValue, t.args[0], spec, indent);
      }
      case 'Range':
      case 'RangeInclusive':
      case 'RangeFrom':
      case 'RangeTo':
      case 'RangeToInclusive':
      case 'RangeFull': {
        const range = v as RangeValue;
        const start = range.start === undefined ? '' : this.debug(range.start, t.args[0], spec, indent);
        const end = range.end === undefined ? '' : this.debug(range.end, t.args[0], spec, indent);
        return `${start}${range.inclusive ? '..=' : '..'}${end}`;
      }
      case 'Ordering': {
        return pad(def.variants[(v as EnumValue).variant].name, spec, '<');
      }
      case 'ParseIntError':
      case 'ParseFloatError':
      case 'ParseCharError':
      case 'TryFromIntError':
      case 'CharTryFromError':
      case 'TryFromCharError':
      case 'Utf8Error':
      case 'FmtError': {
        return errorDebug(def.builtin, v, indent);
      }
      case 'CaseIter': {
        return caseIterDebug(v);
      }
      case 'Turtle': {
        return 'Turtle';
      }
      case 'Iter': {
        return this.iteratorText(v as IterValue, t, spec, indent);
      }
      case 'Entry': {
        return this.entryText(v as EntryValue, t, spec, indent);
      }
      default: {
        return this.debugUserAdt(v, t, spec, indent);
      }
    }
  }

  private setText(set: SetValue, elem: Type, spec: Spec, indent: number | undefined): string {
    const values = [...set.entries.values()];
    if (set.sorted) values.sort((a, b) => compareValues(elem, a, b) ?? 0);
    const items = values.map((item) => (inner: number | undefined) => this.debug(item, elem, spec, inner));
    return list('{', '}', items, indent);
  }

  /** A map's entry, as `Entry`, `OccupiedEntry`, and `VacantEntry` debug: the key and any value it holds. */
  private entryText(entry: EntryValue, t: Type & { kind: 'adt' }, spec: Spec, indent: number | undefined): string {
    const held = entry.map.entries.get(entry.hash);
    const key: DebugPart = (inner) => this.debug(held ? held[0] : entry.key, t.args[0], spec, inner);
    const inner: DebugPart = held
      ? (depth) => {
          const value: DebugPart = (nested) => this.debug(held[1], t.args[1], spec, nested);
          return structText(
            'OccupiedEntry',
            [
              ['key', key],
              ['value', value],
            ],
            depth,
            true
          );
        }
      : (depth) => tupleText('VacantEntry', [key], depth);
    return tupleText('Entry', [inner], indent);
  }

  private iteratorText(iter: IterValue, t: Type & { kind: 'adt' }, spec: Spec, indent: number | undefined): string {
    const debug = (value: Value, type: Type, inner: number | undefined): string => this.debug(value, type, spec, inner);
    return iteratorDebug(iter, t.args[0], t.args[1], debug, indent);
  }

  private debugUserAdt(v: Value, t: Type & { kind: 'adt' }, spec: Spec, indent: number | undefined): string {
    const { def } = t;
    const variantIndex = v instanceof EnumValue ? v.variant : 0;
    const variant = def.variants[variantIndex];
    const fields = v instanceof EnumValue || v instanceof StructValue ? v.fields : [];
    const types = this.hooks.fieldTypes(def, t.args, variantIndex);
    if (variant.shape === 'unit') return pad(variant.name, spec, '<');
    if (variant.shape === 'tuple' && types.length === 0) return pad(variant.name, spec, '<');
    const parts = types.map(
      (type, index) => (inner: number | undefined) => this.debug(fields[index], type, spec, inner)
    );
    if (variant.shape === 'tuple') return tupleText(variant.name, parts, indent);
    return structText(
      variant.name,
      parts.map((part, index) => [variant.fields[index].name, part]),
      indent
    );
  }

  /** A map's entries in iteration order: insertion order for `HashMap`, key order for `BTreeMap`. */
  mapEntries(map: MapValue, keyType: Type): [Value, Value][] {
    const entries = [...map.entries.values()];
    if (map.sorted) entries.sort((a, b) => compareValues(keyType, a[0], b[0]) ?? 0);
    return entries;
  }

  // code-gauge-allow functionCognitiveComplexity 16 -- Follows std::fmt's formatting rules case by case.
  private radix(trait: FormatSpec['trait'], value: Value, type: Type, spec: Spec): string {
    let t = this.concrete(type);
    while (t.kind === 'ref') t = this.concrete(t.target);
    const v = deref(value);
    if (trait === 'lowerExp' || trait === 'upperExp') {
      const letter = trait === 'lowerExp' ? 'e' : 'E';
      if (t.kind === 'float') {
        let text = expFloat(v as number, t.name === 'f32', spec.precision, letter);
        if (spec.sign === '+' && !text.startsWith('-')) text = `+${text}`;
        return padNumber(text, spec);
      }
      return padNumber(intExp(v as bigint, spec.precision, letter, spec.sign === '+'), spec);
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
    return padNumber(prefix + digits, spec, prefix.length);
  }

  private concrete(type: Type): Type {
    return normalize(shallow(this.hooks.concrete(type)));
  }
}

// code-gauge-allow functionCognitiveComplexity 16 -- Follows std::fmt's formatting rules case by case.
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

/** The chars `ToUppercase` or `ToLowercase` has left, which it displays. */
function caseIterText(value: Value): string {
  return ((value as IterValue).rest?.() ?? []).join('');
}

/** `{:?}` of `ToUppercase` or `ToLowercase`: the chars it has left, as std's `CaseMappingIter` holds them. */
function caseIterDebug(value: Value): string {
  const { name } = value as unknown as { name: string };
  const chars = [...caseIterText(value)].map((c) => `'${escapeDebug(c, true)}'`).join(', ');
  return `${name}(CaseMappingIter(IntoIter([${chars}])))`;
}

function charCount(text: string): number {
  return [...text].length;
}

export function pad(text: string, spec: Spec, defaultAlign: '<' | '>'): string {
  if (spec.width === undefined) return text;
  const length = charCount(text);
  if (length >= spec.width) return text;
  const padding = spec.width - length;
  const align = spec.align ?? defaultAlign;
  if (align === '<') return text + spec.fill.repeat(padding);
  if (align === '>') return spec.fill.repeat(padding) + text;
  const left = Math.floor(padding / 2);
  return spec.fill.repeat(left) + text + spec.fill.repeat(padding - left);
}

/** Pads a string, truncating it first to the precision. */
function padString(text: string, spec: Spec): string {
  let shown = text;
  if (spec.precision !== undefined) shown = [...text].slice(0, spec.precision).join('');
  return pad(shown, spec, '<');
}

/** Pads a number, with `0` padding after its sign and radix prefix. */
export function padNumber(text: string, spec: Spec, prefixLength = 0): string {
  let shown = text;
  if (
    spec.sign === '+' &&
    !shown.startsWith('-') &&
    !shown.startsWith('+') &&
    /^[\d]/.test(shown) &&
    !/[.eE]/.test(shown)
  ) {
    shown = `+${shown}`;
  }
  if (spec.zero && spec.width !== undefined) {
    const signLength = shown.startsWith('-') || shown.startsWith('+') ? 1 : 0;
    const head = shown.slice(0, signLength + prefixLength);
    const body = shown.slice(signLength + prefixLength);
    const zeros = Math.max(0, spec.width - charCount(shown));
    return head + '0'.repeat(zeros) + body;
  }
  return pad(shown, spec, '>');
}

/** Escapes a string or char as Rust's `Debug` does. */
export function escapeDebug(text: string, isChar: boolean): string {
  let result = '';
  for (const char of text) {
    // `Debug` escapes combining marks, which would otherwise join the char before them.
    const combining = /\p{Grapheme_Extend}/u.test(char);
    const code = char.codePointAt(0)!;
    switch (char) {
      case '\t': {
        result += String.raw`\t`;
        break;
      }
      case '\r': {
        result += String.raw`\r`;
        break;
      }
      case '\n': {
        result += String.raw`\n`;
        break;
      }
      case '\\': {
        result += String.raw`\\`;
        break;
      }
      case '"': {
        result += isChar ? '"' : String.raw`\"`;
        break;
      }
      case "'": {
        result += isChar ? String.raw`\'` : "'";
        break;
      }
      case '\0': {
        result += String.raw`\0`;
        break;
      }
      default: {
        result += isPrintable(char) && !combining ? char : `\\u{${code.toString(16)}}`;
      }
    }
  }
  return result;
}

/**
 * Whether `{:?}` shows a char as it is, as std's `is_printable` decides from Unicode's categories: not control, format,
 * separator (but the space), private-use, surrogate, or unassigned.
 */
function isPrintable(char: string): boolean {
  return char === ' ' || !/[\p{Cc}\p{Cf}\p{Z}\p{Co}\p{Cs}\p{Cn}]/u.test(char);
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
    case 'Utf8Error': {
      const [, validUpTo, errorLen] = (value as StructValue).fields as [Value, number, number | undefined];
      return errorLen === undefined
        ? `incomplete utf-8 byte sequence from index ${validUpTo}`
        : `invalid utf-8 sequence of ${errorLen} bytes from index ${validUpTo}`;
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
    case 'TryFromCharError': {
      return indent === undefined
        ? `${builtin}(())`
        : `${builtin}(\n${'    '.repeat(indent + 1)}(),\n${'    '.repeat(indent)})`;
    }
    case 'ParseCharError': {
      return inner('ParseCharError', 'kind', kind ?? 'TooManyChars');
    }
    case 'Utf8Error': {
      // `String::from_utf8`'s error, which keeps the bytes it was given.
      const [bytes, validUpTo, errorLen] = (value as StructValue).fields as [bigint[], number, number | undefined];
      const error = `Utf8Error { valid_up_to: ${validUpTo}, error_len: ${errorLen === undefined ? 'None' : `Some(${errorLen})`} }`;
      return `FromUtf8Error { bytes: [${bytes.join(', ')}], error: ${error} }`;
    }
    default: {
      return builtin;
    }
  }
}
