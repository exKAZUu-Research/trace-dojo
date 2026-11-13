import type { Entity } from '../entities';
import { addMethod, currentRuntime, fn, namedType, nativeFunction, perRun, typeEntity } from '../native';
import { divideByZeroPanic, nilPointerPanic } from '../runtimeErrors';
import { BASIC, type NamedType, pointerTo, RUNE, sliceOf, type Type } from '../types';
import { Cell, GoArray, GoMap, GoStruct, Pointer, type Slice, type Value } from '../values';
import { libraryVariable } from './io';
import { BOOL, INT, sliceOfValues, sliceValues, STRING } from './support';
import { CASE_RANGES, UPPER_LOWER } from './unicodeCaseTables';
import { toLower, toTitle, toUpper } from './unicodeSupport';
import {
  CATEGORY_TABLES,
  FOLD_CATEGORY_TABLES,
  FOLD_SCRIPT_TABLES,
  PROPERTY_TABLES,
  SCRIPT_TABLES,
} from './unicodeTables';

const UINT16 = BASIC.uint16;
const UINT32 = BASIC.uint32;
const MAX_RUNE = 0x10_ff_ff;
const LINEAR_MAX = 18;
const UPPER_CASE = 0;
const MAX_CASE = 3;

function struct(name: string, fields: [string, Type][]): NamedType {
  return namedType('unicode', name, {
    kind: 'struct',
    fields: fields.map(([fieldName, type]) => ({ name: fieldName, type, embedded: false })),
  });
}

const RANGE16 = struct('Range16', [
  ['Lo', UINT16],
  ['Hi', UINT16],
  ['Stride', UINT16],
]);
const RANGE32 = struct('Range32', [
  ['Lo', UINT32],
  ['Hi', UINT32],
  ['Stride', UINT32],
]);
const RANGE_TABLE = struct('RangeTable', [
  ['R16', sliceOf(RANGE16)],
  ['R32', sliceOf(RANGE32)],
  ['LatinOffset', INT],
]);
export const RANGE_TABLE_POINTER = pointerTo(RANGE_TABLE);
const DELTAS = namedType('unicode', 'd', { kind: 'array', element: RUNE, length: MAX_CASE });
const CASE_RANGE = struct('CaseRange', [
  ['Lo', UINT32],
  ['Hi', UINT32],
  ['Delta', DELTAS],
]);
export const SPECIAL_CASE = namedType('unicode', 'SpecialCase', sliceOf(CASE_RANGE));

// Range tables ------------------------------------------------------------------------------------------------------

interface TableData {
  r16: number[][];
  r32: number[][];
  latinOffset: number;
}

function parseRanges(part: string): number[][] {
  if (part === '') return [];
  return part.split(' ').map((range) => {
    const [lo, span, stride] = range.split('.').map((digits) => Number.parseInt(digits, 36));
    return [lo, lo + span, stride];
  });
}

function parseGroup(text: string): Map<string, TableData> {
  return new Map(
    text.split('\n').map((line) => {
      const [name, data] = line.split(' ', 2) as [string, string];
      const rest = line.slice(name.length + 1) || data;
      const [r16, r32, latinOffset] = rest.split('|');
      return [name, { r16: parseRanges(r16), r32: parseRanges(r32), latinOffset: Number(latinOffset) }];
    })
  );
}

let groups: Record<string, Map<string, TableData>> | undefined;

function tableGroups(): Record<string, Map<string, TableData>> {
  groups ??= {
    Categories: parseGroup(CATEGORY_TABLES),
    Scripts: parseGroup(SCRIPT_TABLES),
    Properties: parseGroup(PROPERTY_TABLES),
    FoldCategory: parseGroup(FOLD_CATEGORY_TABLES),
    FoldScript: parseGroup(FOLD_SCRIPT_TABLES),
  };
  return groups;
}

/** The exported variables that name another table, as Go's `Letter = _L`. */
const ALIASES: Record<string, string> = {
  Digit: 'Nd',
  Letter: 'L',
  Lower: 'Ll',
  Mark: 'M',
  Number: 'N',
  Other: 'C',
  Punct: 'P',
  Space: 'Z',
  Symbol: 'S',
  Title: 'Lt',
  Upper: 'Lu',
  STerm: 'Sentence_Terminal',
};

/** The tables a run has built, keyed by group and name, so that each Go variable is one pointer. */
const runCache = perRun(() => new Map<string, Value>());

function cached(key: string, build: () => Value): Value {
  const cache = runCache();
  if (!cache.has(key)) cache.set(key, build());
  return cache.get(key);
}

function rangeSlice(ranges: number[][]): Slice | undefined {
  if (ranges.length === 0) return undefined;
  return sliceOfValues(ranges.map((range) => new GoStruct(range.map(BigInt))));
}

function tablePointer(group: string, name: string): Value {
  return cached(`${group}.${name}`, () => {
    const data = tableGroups()[group].get(name) as TableData;
    currentRuntime().allocate(data.r16.length + data.r32.length);
    const table = new GoStruct([rangeSlice(data.r16), rangeSlice(data.r32), BigInt(data.latinOffset)]);
    return new Pointer(new Cell(table), 'v');
  });
}

function rangeAt(ranges: Slice, index: number): [number, number, number] {
  return (ranges.get(index) as GoStruct).fields.map(Number) as [number, number, number];
}

/** `is16` and `is32`: a linear search through short tables and Latin-1, a binary search otherwise. */
function inRanges(ranges: Slice, r: number, linear: boolean): boolean {
  const contains = ([lo, , stride]: [number, number, number]): boolean => {
    if (stride === 1) return true;
    if (stride === 0) divideByZeroPanic();
    return (r - lo) % stride === 0;
  };
  if (linear) {
    for (let index = 0; index < ranges.length; index++) {
      const range = rangeAt(ranges, index);
      if (r < range[0]) return false;
      if (r <= range[1]) return contains(range);
    }
    return false;
  }
  let lo = 0;
  let hi = ranges.length;
  while (lo < hi) {
    const middle = (lo + hi) >>> 1;
    const range = rangeAt(ranges, middle);
    if (range[0] <= r && r <= range[1]) return contains(range);
    if (r < range[0]) hi = middle;
    else lo = middle + 1;
  }
  return false;
}

/** `unicode.Is`. */
export function isInTable(table: Value, rune: number): boolean {
  if (!(table instanceof Pointer)) nilPointerPanic();
  const [r16, r32] = (table.load() as GoStruct).fields as [Slice | undefined, Slice | undefined];
  const unsigned = rune >>> 0;
  if (r16 && r16.length > 0 && unsigned <= rangeAt(r16, r16.length - 1)[1]) {
    const short = unsigned & 0xff_ff;
    return inRanges(r16, short, r16.length <= LINEAR_MAX || short <= 0xff);
  }
  if (r32 && r32.length > 0 && rune >= rangeAt(r32, 0)[0]) return inRanges(r32, unsigned, r32.length <= LINEAR_MAX);
  return false;
}

function tableMap(group: string): Value {
  return cached(`map.${group}`, () => {
    const map = new GoMap((key) => key);
    for (const name of tableGroups()[group].keys()) {
      map.entries.set(name, { key: name, value: tablePointer(group, name) });
    }
    return map;
  });
}

// Case mapping ------------------------------------------------------------------------------------------------------

function caseRangeValues(rows: readonly number[]): Slice | undefined {
  const values: Value[] = [];
  for (let at = 0; at < rows.length; at += 5) {
    values.push(
      new GoStruct([BigInt(rows[at]), BigInt(rows[at + 1]), new GoArray(rows.slice(at + 2, at + 5).map(BigInt))])
    );
  }
  return sliceOfValues(values);
}

const TURKISH_CASE = [
  0x49,
  0x49,
  0,
  0x1_31 - 0x49,
  0,
  0x69,
  0x69,
  0x1_30 - 0x69,
  0,
  0x1_30 - 0x69,
  0x1_30,
  0x1_30,
  0,
  0x69 - 0x1_30,
  0,
  0x1_31,
  0x1_31,
  0x49 - 0x1_31,
  0,
  0x49 - 0x1_31,
];

/** `unicode.to`: the rune mapped by the case range containing it, and whether one does. */
function caseOf(kind: number, rune: number, caseRanges: Value): [number, boolean] {
  if (kind < 0 || kind >= MAX_CASE) return [0xff_fd, false];
  const ranges = caseRanges as Slice | undefined;
  let lo = 0;
  let hi = ranges?.length ?? 0;
  while (lo < hi) {
    const middle = (lo + hi) >>> 1;
    const [rangeLo, rangeHi, deltas] = ((ranges as Slice).get(middle) as GoStruct).fields;
    const start = Number(rangeLo as bigint);
    if (start <= rune && rune <= Number(rangeHi as bigint)) {
      const delta = Number((deltas as GoArray).elements[kind] as bigint);
      if (delta > MAX_RUNE) return [start + (((rune - start) & ~1) | (kind & 1)), true];
      return [Math.trunc(rune + delta), true];
    }
    if (rune < start) hi = middle;
    else lo = middle + 1;
  }
  return [rune, false];
}

const CASE_FALLBACKS = [toUpper, toLower, toTitle];

/** A method of SpecialCase: its own mapping, and the standard one for runes it does not map. */
export function specialCaseMapper(special: Value, kind: number): (rune: number) => number {
  return (rune) => {
    const [mapped, found] = caseOf(kind, rune, special);
    return mapped === rune && !found ? CASE_FALLBACKS[kind](rune) : mapped;
  };
}

for (const [index, name] of ['ToUpper', 'ToLower', 'ToTitle'].entries()) {
  addMethod(SPECIAL_CASE, name, fn([RUNE], [RUNE]), (receiver, [rune]) =>
    BigInt(specialCaseMapper(receiver, index)(Number(rune as bigint)))
  );
}

// Members -----------------------------------------------------------------------------------------------------------

function intConstant(name: string, value: number, type: Type = BASIC.untypedInt): Entity {
  return {
    kind: 'const',
    name,
    type,
    value: { kind: 'int', value: BigInt(value) },
    span: { row: 0, column: 0 },
    used: true,
  };
}

function tableVariables(): Record<string, Entity> {
  const entries: [string, Entity][] = [];
  for (const group of ['Categories', 'Scripts', 'Properties']) {
    for (const name of tableGroups()[group].keys()) {
      entries.push([name, libraryVariable(name, RANGE_TABLE_POINTER, () => tablePointer(group, name))]);
    }
  }
  for (const [alias, target] of Object.entries(ALIASES)) {
    const group = target.length <= 2 ? 'Categories' : 'Properties';
    entries.push([alias, libraryVariable(alias, RANGE_TABLE_POINTER, () => tablePointer(group, target))]);
  }
  return Object.fromEntries(entries);
}

const CATEGORY_ALIASES: Record<string, string> = {
  Cased_Letter: 'LC',
  Close_Punctuation: 'Pe',
  Combining_Mark: 'M',
  Connector_Punctuation: 'Pc',
  Control: 'Cc',
  Currency_Symbol: 'Sc',
  Dash_Punctuation: 'Pd',
  Decimal_Number: 'Nd',
  Enclosing_Mark: 'Me',
  Final_Punctuation: 'Pf',
  Format: 'Cf',
  Initial_Punctuation: 'Pi',
  Letter: 'L',
  Letter_Number: 'Nl',
  Line_Separator: 'Zl',
  Lowercase_Letter: 'Ll',
  Mark: 'M',
  Math_Symbol: 'Sm',
  Modifier_Letter: 'Lm',
  Modifier_Symbol: 'Sk',
  Nonspacing_Mark: 'Mn',
  Number: 'N',
  Open_Punctuation: 'Ps',
  Other: 'C',
  Other_Letter: 'Lo',
  Other_Number: 'No',
  Other_Punctuation: 'Po',
  Other_Symbol: 'So',
  Paragraph_Separator: 'Zp',
  Private_Use: 'Co',
  Punctuation: 'P',
  Separator: 'Z',
  Space_Separator: 'Zs',
  Spacing_Mark: 'Mc',
  Surrogate: 'Cs',
  Symbol: 'S',
  Titlecase_Letter: 'Lt',
  Unassigned: 'Cn',
  Uppercase_Letter: 'Lu',
  cntrl: 'Cc',
  digit: 'Nd',
  punct: 'P',
};

const TABLE_MAP = { kind: 'map' as const, key: STRING, value: RANGE_TABLE_POINTER };
const TABLE_LIST = sliceOf(RANGE_TABLE_POINTER);
const tableList = (names: string[]): Slice => sliceOfValues(names.map((name) => tablePointer('Categories', name)));

export const UNICODE_RANGE_MEMBERS: Record<string, Entity> = {
  RangeTable: typeEntity(RANGE_TABLE),
  Range16: typeEntity(RANGE16),
  Range32: typeEntity(RANGE32),
  CaseRange: typeEntity(CASE_RANGE),
  SpecialCase: typeEntity(SPECIAL_CASE),
  ...tableVariables(),
  Categories: libraryVariable('Categories', TABLE_MAP, () => tableMap('Categories')),
  Scripts: libraryVariable('Scripts', TABLE_MAP, () => tableMap('Scripts')),
  Properties: libraryVariable('Properties', TABLE_MAP, () => tableMap('Properties')),
  FoldCategory: libraryVariable('FoldCategory', TABLE_MAP, () => tableMap('FoldCategory')),
  FoldScript: libraryVariable('FoldScript', TABLE_MAP, () => tableMap('FoldScript')),
  CategoryAliases: libraryVariable('CategoryAliases', { kind: 'map', key: STRING, value: STRING }, () =>
    cached('CategoryAliases', () => {
      const map = new GoMap((key) => key);
      for (const [key, value] of Object.entries(CATEGORY_ALIASES)) map.entries.set(key, { key, value });
      return map;
    })
  ),
  GraphicRanges: libraryVariable('GraphicRanges', TABLE_LIST, () =>
    cached('GraphicRanges', () => tableList(['L', 'M', 'N', 'P', 'S', 'Zs']))
  ),
  PrintRanges: libraryVariable('PrintRanges', TABLE_LIST, () =>
    cached('PrintRanges', () => tableList(['L', 'M', 'N', 'P', 'S']))
  ),
  CaseRanges: libraryVariable('CaseRanges', sliceOf(CASE_RANGE), () =>
    cached('CaseRanges', () => caseRangeValues(CASE_RANGES))
  ),
  TurkishCase: libraryVariable('TurkishCase', SPECIAL_CASE, () =>
    cached('TurkishCase', () => caseRangeValues(TURKISH_CASE))
  ),
  AzeriCase: libraryVariable('AzeriCase', SPECIAL_CASE, () =>
    cached('TurkishCase', () => caseRangeValues(TURKISH_CASE))
  ),
  UpperCase: intConstant('UpperCase', UPPER_CASE),
  LowerCase: intConstant('LowerCase', 1),
  TitleCase: intConstant('TitleCase', 2),
  MaxCase: intConstant('MaxCase', MAX_CASE),
  UpperLower: intConstant('UpperLower', UPPER_LOWER, BASIC.untypedRune),
  Version: {
    kind: 'const',
    name: 'Version',
    type: BASIC.untypedString,
    value: { kind: 'string', value: '17.0.0' },
    span: { row: 0, column: 0 },
    used: true,
  },
  Is: nativeFunction('Is', fn([RANGE_TABLE_POINTER, RUNE], [BOOL]), ([table, rune]) =>
    isInTable(table, Number(rune as bigint))
  ),
  In: nativeFunction('In', fn([RUNE, TABLE_LIST], [BOOL], true), ([rune, tables]) =>
    sliceValues(tables).some((table) => isInTable(table, Number(rune as bigint)))
  ),
  IsOneOf: nativeFunction('IsOneOf', fn([TABLE_LIST, RUNE], [BOOL]), ([tables, rune]) =>
    sliceValues(tables).some((table) => isInTable(table, Number(rune as bigint)))
  ),
  To: nativeFunction('To', fn([INT, RUNE], [RUNE]), ([kind, rune]) =>
    BigInt(
      caseOf(
        Number(kind as bigint),
        Number(rune as bigint),
        cached('CaseRanges', () => caseRangeValues(CASE_RANGES))
      )[0]
    )
  ),
};
