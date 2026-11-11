// code-gauge-allow-file fileNcss 445 -- Reads and writes every type code of the marshal format, as marshal.c does.
// CPython's marshal module. Loading reads every format exactly. Dumping with versions 3 to 5 marks the objects CPython
// finds shared by their reference counts, which this interpreter does not keep: it treats the object passed, the
// immutable values a program writes as literals, and what the data reaches more than once as shared, and str values
// made of identifier characters as interned, as they are when they come from literals.
import { bytesLikeData, newBytes, PyBytes } from '../bytesValues';
import { decodeBytes, encodeString } from '../codecs';
import { pyRepr } from '../conversions';
import { DictStore } from '../dictStore';
import { registerModule } from '../modules';
import { parseFloatText } from '../numbers';
import { callValue, getAttribute } from '../objects';
import { currentRuntime } from '../runtimeContext';
import { SetTable } from '../setTable';
import {
  bytearrayClass,
  bytesClass,
  classOf,
  complexClass,
  dictClass,
  Ellipsis,
  exceptionClassNamed,
  floatClass,
  frozensetClass,
  intClass,
  listClass,
  newList,
  newTuple,
  None,
  pyError,
  setClass,
  sliceClass,
  strClass,
  tupleClass,
  typeError,
  typeName,
} from '../types';
import { UnsupportedFeatureError } from '../unsupported';
import { PyComplex, PyDict, PyList, PyObject, PySet, PySlice, PyTuple, type PyValue } from '../values';
import { cInt, clinicFunction, type ClinicSpec } from './clinicArgs';

const VERSION = 5;
const FLAG_REF = 0x80;
const MAX_DEPTH = 2000;

// Writing ---------------------------------------------------------------------------------------------------------

class Writer {
  readonly out: number[] = [];
  private readonly refs = new Map<unknown, number>();
  private depth = 0;

  constructor(
    readonly version: number,
    /** How many times the data reaches each object, which stands for CPython's reference counts. */
    private readonly uses: Map<unknown, number>
  ) {}

  byte(value: number): void {
    this.out.push(value & 0xff);
  }

  long(value: number): void {
    for (let shift = 0; shift < 32; shift += 8) this.byte(value >> shift);
  }

  bytes(data: Uint8Array | readonly number[]): void {
    for (const byte of data) this.out.push(byte);
  }

  pstring(data: Uint8Array): void {
    this.long(data.length);
    this.bytes(data);
  }

  object(value: PyValue, top = false): void {
    this.depth++;
    if (this.depth > MAX_DEPTH) throw pyError('ValueError', 'object too deeply nested to marshal');
    currentRuntime().spend();
    try {
      if (!this.singleton(value)) this.referenced(value, top);
    } finally {
      this.depth--;
    }
  }

  private singleton(value: PyValue): boolean {
    const code = singletonCodes().get(value);
    if (code === undefined) return false;
    this.byte(code.codePointAt(0) as number);
    return true;
  }

  private referenced(value: PyValue, top: boolean): void {
    let flag = 0;
    if (this.version >= 3 && this.isShared(value, top)) {
      const key = identityKey(value);
      const index = this.refs.get(key);
      if (index !== undefined) {
        this.byte(0x72);
        this.long(index);
        return;
      }
      this.refs.set(key, this.refs.size);
      flag = FLAG_REF;
    }
    this.complexObject(value, flag);
  }

  private isShared(value: PyValue, top: boolean): boolean {
    if (top || (this.uses.get(identityKey(value)) ?? 0) > 1) return true;
    const cls = classOf(value);
    return !(cls === listClass || cls === dictClass || cls === setClass || cls === bytearrayClass);
  }

  private type(code: string, flag: number): void {
    this.byte((code.codePointAt(0) as number) | flag);
  }

  private complexObject(value: PyValue, flag: number): void {
    const cls = classOf(value);
    if (cls === intClass) return this.integer(value as bigint, flag);
    if (cls === floatClass) return this.float(value as number, flag);
    if (cls === complexClass) return this.complex(value as PyComplex, flag);
    if (cls === strClass) return this.string(value as string, flag);
    if (cls === tupleClass) return this.sequence(value as PyTuple, flag, true);
    if (cls === listClass) return this.sequence(value as PyList, flag, false);
    if (cls === dictClass) return this.dict(value as PyDict, flag);
    if (cls === setClass || cls === frozensetClass) return this.set(value as PySet, flag, cls === frozensetClass);
    if (cls === sliceClass && this.version >= 5) return this.slice(value as PySlice, flag);
    if (value instanceof PyBytes && (cls === bytesClass || cls === bytearrayClass)) {
      this.type('s', flag);
      return this.pstring(bytesLikeData(value) as Uint8Array);
    }
    const data = bytesLikeData(value);
    if (data !== undefined) {
      this.type('s', flag);
      return this.pstring(data);
    }
    throw pyError('ValueError', 'unmarshallable object');
  }

  private integer(value: bigint, flag: number): void {
    if (value >= -2_147_483_648n && value <= 2_147_483_647n) {
      this.type('i', flag);
      this.long(Number(value));
      return;
    }
    this.type('l', flag);
    let magnitude = value < 0n ? -value : value;
    const digits: number[] = [];
    while (magnitude > 0n) {
      digits.push(Number(magnitude & 0x7f_ffn));
      magnitude >>= 15n;
    }
    this.long(value < 0n ? -digits.length : digits.length);
    for (const digit of digits) this.bytes([digit & 0xff, digit >> 8]);
  }

  private float(value: number, flag: number): void {
    if (this.version > 1) {
      this.type('g', flag);
      this.binaryDouble(value);
    } else {
      this.type('f', flag);
      this.floatText(value);
    }
  }

  private complex(value: PyComplex, flag: number): void {
    if (this.version > 1) {
      this.type('y', flag);
      this.binaryDouble(value.real);
      this.binaryDouble(value.imag);
    } else {
      this.type('x', flag);
      this.floatText(value.real);
      this.floatText(value.imag);
    }
  }

  private binaryDouble(value: number): void {
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value, true);
    this.bytes(new Uint8Array(view.buffer));
  }

  /** `PyOS_double_to_string(value, 'g', 17, 0)`: 17 significant digits, without the trailing zeros. */
  private floatText(value: number): void {
    const text = gFormat17(value);
    this.byte(text.length);
    this.bytes(Array.from(text, (char) => char.codePointAt(0) as number));
  }

  private string(value: string, flag: number): void {
    // oxlint-disable-next-line eslint/no-control-regex -- ASCII includes the control characters.
    const ascii = /^[\u0000-\u007F]*$/.test(value);
    const interned = isInterned(value);
    if (this.version >= 4 && ascii) {
      const data = Array.from(value, (char) => char.codePointAt(0) as number);
      if (data.length < 256) {
        this.type(interned ? 'Z' : 'z', flag);
        this.byte(data.length);
      } else {
        this.type(interned ? 'A' : 'a', flag);
        this.long(data.length);
      }
      this.bytes(data);
      return;
    }
    this.type(this.version >= 3 && interned ? 't' : 'u', flag);
    this.pstring(encodeString(value, 'utf8', 'surrogatepass'));
  }

  private sequence(value: PyTuple | PyList, flag: number, tuple: boolean): void {
    const { items } = value;
    if (tuple && this.version >= 4 && items.length < 256) {
      this.type(')', flag);
      this.byte(items.length);
    } else {
      this.type(tuple ? '(' : '[', flag);
      this.long(items.length);
    }
    for (const item of items) this.object(item);
  }

  private dict(value: PyDict, flag: number): void {
    this.type('{', flag);
    for (const entry of value.store.ordered()) {
      this.object(entry.key);
      this.object(entry.value);
    }
    this.byte(0x30);
  }

  private set(value: PySet, flag: number, frozen: boolean): void {
    this.type(frozen ? '>' : '<', flag);
    let items = value.table.keys();
    this.long(items.length);
    if (frozen) items = this.sortedByDump(items);
    for (const item of items) this.object(item);
  }

  /** Orders a frozenset's items by their own marshal data, as CPython does to make its output deterministic. */
  private sortedByDump(items: PyValue[]): PyValue[] {
    const keyed = items.map((item) => {
      const writer = new Writer(this.version, this.uses);
      writer.object(item, true);
      return { item, key: writer.out };
    });
    keyed.sort((a, b) => compareBytes(a.key, b.key));
    return keyed.map(({ item }) => item);
  }

  private slice(value: PySlice, flag: number): void {
    this.type(':', flag);
    this.object(value.start);
    this.object(value.stop);
    this.object(value.step);
  }
}

let singletons: Map<PyValue, string> | undefined;

/** The type codes of the objects marshal writes as one byte. */
function singletonCodes(): Map<PyValue, string> {
  singletons ??= new Map<PyValue, string>([
    [None, 'N'],
    [Ellipsis, '.'],
    [false, 'F'],
    [true, 'T'],
    [exceptionClassNamed('StopIteration'), 'S'],
  ]);
  return singletons;
}

function compareBytes(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

/** Equal immutable values stand for one object, as the constants of a program are; containers have their identity. */
function identityKey(value: PyValue): unknown {
  if (value instanceof PyObject && classOf(value) !== tupleClass) return value;
  if (typeof value === 'object') return `${typeName(value)}:${pyRepr(value)}`;
  return `${typeof value}:${String(value)}`;
}

/** Whether CPython interns a str a program writes as a literal: one of identifier characters, or of one latin-1 char. */
function isInterned(value: string): boolean {
  return /^[\w]*$/.test(value) || (value.length === 1 && (value.codePointAt(0) as number) < 0x1_00);
}

const trimZeros = (text: string): string => (text.includes('.') ? text.replace(/\.?0+$/, '') : text);

function gFormat17(value: number): string {
  if (Number.isNaN(value)) return 'nan';
  if (!Number.isFinite(value)) return value > 0 ? 'inf' : '-inf';
  if (value === 0) return Object.is(value, -0) ? '-0' : '0';
  const [mantissa, power] = value.toExponential(16).split('e');
  const exponent = Number(power);
  if (exponent < -4 || exponent >= 17) {
    return `${trimZeros(mantissa)}e${exponent < 0 ? '-' : '+'}${String(Math.abs(exponent)).padStart(2, '0')}`;
  }
  return trimZeros(value.toFixed(16 - exponent));
}

/** Counts how many times the data reaches each object, to tell which CPython would find shared. */
function countUses(value: PyValue, uses: Map<unknown, number>): void {
  const key = identityKey(value);
  const count = (uses.get(key) ?? 0) + 1;
  uses.set(key, count);
  if (count > 1) return;
  if (value instanceof PyTuple || value instanceof PyList) for (const item of value.items) countUses(item, uses);
  else if (value instanceof PyDict) {
    for (const entry of value.store.ordered()) {
      countUses(entry.key, uses);
      countUses(entry.value, uses);
    }
  } else if (value instanceof PySet) for (const item of value.table.keys()) countUses(item, uses);
}

export function marshalDumps(value: PyValue, version: number): Uint8Array {
  const uses = new Map<unknown, number>();
  if (version >= 3) countUses(value, uses);
  const writer = new Writer(version, uses);
  writer.object(value, true);
  return Uint8Array.from(writer.out);
}

// Reading ---------------------------------------------------------------------------------------------------------

class Reader {
  private position = 0;
  private readonly refs: (PyValue | undefined)[] = [];
  private depth = 0;

  constructor(private readonly data: Uint8Array) {}

  get consumed(): number {
    return this.position;
  }

  take(count: number): Uint8Array {
    if (this.position + count > this.data.length) throw pyError('EOFError', 'marshal data too short');
    const result = this.data.subarray(this.position, this.position + count);
    this.position += count;
    return result;
  }

  long(): number {
    const bytes = this.take(4);
    return bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24);
  }

  object(context?: string): PyValue {
    if (this.position >= this.data.length) throw pyError('EOFError', 'EOF read where object expected');
    this.depth++;
    if (this.depth > MAX_DEPTH) throw pyError('ValueError', 'recursion limit exceeded');
    currentRuntime().spend();
    try {
      const code = this.data[this.position++];
      const value = this.typed(code & ~FLAG_REF, (code & FLAG_REF) !== 0);
      if (value === undefined) throw typeError(`NULL object in marshal data for ${context ?? 'object'}`);
      return value;
    } finally {
      this.depth--;
    }
  }

  /** Reads an object that may be the NULL that ends a dict. */
  private optionalObject(): PyValue | undefined {
    if (this.position >= this.data.length) throw pyError('EOFError', 'EOF read where object expected');
    const code = this.data[this.position++];
    return this.typed(code & ~FLAG_REF, (code & FLAG_REF) !== 0);
  }

  private remember<T extends PyValue>(value: T, flagged: boolean): T {
    if (flagged) this.refs.push(value);
    return value;
  }

  // code-gauge-allow functionNcss 57 -- One case per type code, as r_object has.
  private typed(code: number, flagged: boolean): PyValue | undefined {
    switch (String.fromCodePoint(code)) {
      case '0': {
        return undefined;
      }
      case 'N': {
        return None;
      }
      case 'S': {
        return exceptionClassNamed('StopIteration');
      }
      case '.': {
        return Ellipsis;
      }
      case 'F': {
        return false;
      }
      case 'T': {
        return true;
      }
      case 'i': {
        return this.remember(BigInt(this.long()), flagged);
      }
      case 'l': {
        return this.remember(this.bigInteger(), flagged);
      }
      case 'f': {
        return this.remember(this.floatText(), flagged);
      }
      case 'g': {
        return this.remember(this.binaryDouble(), flagged);
      }
      case 'x': {
        return this.remember(new PyComplex(complexClass, this.floatText(), this.floatText()), flagged);
      }
      case 'y': {
        return this.remember(new PyComplex(complexClass, this.binaryDouble(), this.binaryDouble()), flagged);
      }
      case 's': {
        return this.remember(newBytes(Uint8Array.from(this.take(this.size()))), flagged);
      }
      case 'u':
      case 't': {
        return this.remember(decodeBytes(this.take(this.size()), 'utf8', 'surrogatepass'), flagged);
      }
      case 'a':
      case 'A': {
        return this.remember(this.ascii(this.size()), flagged);
      }
      case 'z':
      case 'Z': {
        return this.remember(this.ascii(this.take(1)[0]), flagged);
      }
      case '(': {
        return this.tuple(this.size('tuple'), flagged);
      }
      case ')': {
        return this.tuple(this.take(1)[0], flagged);
      }
      case '[': {
        return this.list(flagged);
      }
      case '{': {
        return this.dict(flagged);
      }
      case '<':
      case '>': {
        return this.set(code === 0x3e, flagged);
      }
      case ':': {
        return this.slice(flagged);
      }
      case 'r': {
        return this.reference();
      }
      case 'c': {
        // A code object starts with its argument counts, which truncated data runs out before.
        this.take(4);
        throw new UnsupportedFeatureError('marshal で読み込むコードオブジェクト');
      }
      default: {
        throw pyError('ValueError', 'bad marshal data (unknown type code)');
      }
    }
  }

  private size(kind = 'size'): number {
    const n = this.long();
    if (n < 0) throw pyError('ValueError', `bad marshal data (${kind} size out of range)`);
    return n;
  }

  private bigInteger(): bigint {
    const n = this.long();
    let result = 0n;
    const count = Math.abs(n);
    for (let index = 0; index < count; index++) {
      const bytes = this.take(2);
      const digit = bytes[0] | (bytes[1] << 8);
      if (digit > 0x7f_ff) throw pyError('ValueError', 'bad marshal data (digit out of range in long)');
      if (digit === 0 && index === count - 1) throw pyError('ValueError', 'bad marshal data (unnormalized long data)');
      result |= BigInt(digit) << BigInt(15 * index);
    }
    return n < 0 ? -result : result;
  }

  private floatText(): number {
    const text = String.fromCodePoint(...this.take(this.take(1)[0]));
    const value = parseFloatText(text);
    if (value === undefined) throw pyError('ValueError', `could not convert string to float: '${text}'`);
    return value;
  }

  private binaryDouble(): number {
    return new DataView(Uint8Array.from(this.take(8)).buffer).getFloat64(0, true);
  }

  private ascii(length: number): string {
    return String.fromCodePoint(...this.take(length));
  }

  private tuple(length: number, flagged: boolean): PyValue {
    const slot = this.refs.length;
    if (flagged) this.refs.push(undefined);
    const items: PyValue[] = [];
    for (let index = 0; index < length; index++) items.push(this.object('tuple'));
    const tuple = newTuple(items);
    if (flagged) this.refs[slot] = tuple;
    return tuple;
  }

  private list(flagged: boolean): PyValue {
    const length = this.size('list');
    const list = this.remember(newList([]), flagged);
    for (let index = 0; index < length; index++) list.items.push(this.object('list'));
    return list;
  }

  private dict(flagged: boolean): PyValue {
    const dict = this.remember(new PyDict(dictClass, new DictStore()), flagged);
    for (;;) {
      const key = this.optionalObject();
      if (key === undefined) break;
      const value = this.optionalObject();
      if (value === undefined) break;
      setItem(dict, key, value);
    }
    return dict;
  }

  private set(frozen: boolean, flagged: boolean): PyValue {
    const length = this.size('set');
    const slot = this.refs.length;
    const set = new PySet(frozen ? frozensetClass : setClass, new SetTable());
    if (flagged) this.refs.push(frozen ? undefined : set);
    for (let index = 0; index < length; index++) addItem(set, this.object('set'));
    if (flagged) this.refs[slot] = set;
    return set;
  }

  private slice(flagged: boolean): PyValue {
    const slot = this.refs.length;
    if (flagged) this.refs.push(undefined);
    const slice = new PySlice(sliceClass, this.object('slice'), this.object('slice'), this.object('slice'));
    if (flagged) this.refs[slot] = slice;
    return slice;
  }

  private reference(): PyValue {
    const index = this.long();
    const value = this.refs[index];
    if (index < 0 || value === undefined) throw pyError('ValueError', 'bad marshal data (invalid reference)');
    return value;
  }
}

function setItem(dict: PyDict, key: PyValue, value: PyValue): void {
  checkHashable(key, 'a dict key');
  dict.store.set(key, value);
}

function addItem(set: PySet, item: PyValue): void {
  checkHashable(item, 'a set element');
  set.table.add(item);
}

function checkHashable(value: PyValue, role: string): void {
  const cls = classOf(value);
  if (cls === listClass || cls === dictClass || cls === setClass || cls === bytearrayClass) {
    throw typeError(`cannot use '${cls.name}' as ${role} (unhashable type: '${cls.name}')`);
  }
}

// The module ------------------------------------------------------------------------------------------------------

const DUMPS: ClinicSpec = {
  name: 'dumps',
  params: ['value', 'version'],
  positionalOnly: 2,
  required: 1,
  keywordOnly: ['allow_code'],
};
const LOADS: ClinicSpec = {
  name: 'loads',
  params: ['bytes'],
  positionalOnly: 1,
  required: 1,
  keywordOnly: ['allow_code'],
};

registerModule(
  'marshal',
  () =>
    new Map<string, PyValue>([
      ['version', BigInt(VERSION)],
      [
        'dumps',
        clinicFunction(DUMPS, ([value, version]) => newBytes(marshalDumps(value as PyValue, cInt(version, VERSION)))),
      ],
      [
        'dump',
        clinicFunction(
          {
            name: 'dump',
            params: ['value', 'file', 'version'],
            positionalOnly: 3,
            required: 2,
            keywordOnly: ['allow_code'],
          },
          ([value, file, version]) => {
            const data = marshalDumps(value as PyValue, cInt(version, VERSION));
            callValue(getAttribute(file as PyValue, 'write'), [newBytes(data)]);
            return None;
          }
        ),
      ],
      [
        'load',
        clinicFunction(
          { name: 'load', params: ['file'], positionalOnly: 1, required: 1, keywordOnly: ['allow_code'] },
          ([file]) => loadFromFile(file as PyValue)
        ),
      ],
      [
        'loads',
        clinicFunction(LOADS, ([bytes]) => {
          const data = bytesLikeData(bytes as PyValue);
          if (data === undefined) {
            throw typeError(`a bytes-like object is required, not '${typeName(bytes as PyValue)}'`);
          }
          return new Reader(data).object();
        }),
      ],
    ])
);

/** `marshal.load`: reads one object from a binary file such as BytesIO, leaving the file just after it. */
function loadFromFile(file: PyValue): PyValue {
  const data = bytesLikeData(callValue(getAttribute(file, 'read'), []));
  if (data === undefined) throw typeError('file.read() returned not bytes');
  const reader = new Reader(data);
  const value = reader.object();
  const unread = data.length - reader.consumed;
  if (unread > 0) callValue(getAttribute(file, 'seek'), [BigInt(-unread), 1n]);
  return value;
}
