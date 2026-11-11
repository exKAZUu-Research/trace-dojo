import { bytesLikeData, latin1Text } from '../bytesValues';
import { UNIDATA_VERSION } from '../data/unicodeData';
import { builtin, method } from '../define';
import { registerModule } from '../modules';
import { currentRuntime } from '../runtimeContext';
import { strLength } from '../strings';
import { builtinClass, typeError, typeName, unbox, valueError } from '../types';
import {
  isOldUnassigned,
  oldDecomposition,
  oldNormalizationDecomposition,
  oldNumericValue,
  oldProperties,
} from '../unicode320';
import {
  characterName,
  type CharacterProperties,
  decompositionOf,
  lookupName,
  type NormalizationForm,
  normalize,
  numericValueOf,
  propertiesOf,
} from '../unicodeDatabase';
import { PyOpaque, type PyValue } from '../values';

/** A version of the Unicode database: the current one, or the Unicode 3.2.0 one of `ucd_3_2_0`. */
interface Database {
  properties: (point: number) => CharacterProperties;
  numeric: (point: number, kind: 'decimal' | 'digit' | 'numeric') => number | undefined;
  decomposition: (point: number) => { tag: string; points: number[] } | undefined;
  name: (point: number) => string | undefined;
  lookup: (name: string) => number | number[] | undefined;
  normalize: (form: NormalizationForm, text: string) => string;
}

const KINDS = { decimal: 'd', digit: 'dg', numeric: 'dgn' } as const;

const CURRENT: Database = {
  properties: propertiesOf,
  numeric: (point, kind) => {
    const entry = numericValueOf(point);
    return entry && KINDS[kind].includes(entry.kind) ? entry.value : undefined;
  },
  decomposition: decompositionOf,
  name: (point) => characterName(point),
  lookup: (name) => lookupName(name, true),
  normalize: (form, text) => normalize(form, text),
};

/** Unicode 3.2.0, which has no name aliases or named sequences and no names for the characters it lacks. */
const UNICODE_3_2_0: Database = {
  properties: oldProperties,
  numeric: oldNumericValue,
  decomposition: oldDecomposition,
  name: (point) => (isOldUnassigned(point) ? undefined : characterName(point)),
  lookup: (name) => lookupName(name, false, (point) => !isOldUnassigned(point)),
  normalize: (form, text) => normalize(form, text, oldNormalizationDecomposition),
};

/** The code point of a one-character argument, or CPython's TypeError for any other value. */
function characterArgument(argumentValue: PyValue, functionName: string, label: string): number {
  const value = unbox(argumentValue);
  if (typeof value !== 'string') {
    throw typeError(`${functionName}() ${label} must be a unicode character, not ${typeName(value)}`);
  }
  const length = strLength(value);
  if (length !== 1) {
    throw typeError(`${functionName}(): ${label} must be a unicode character, not a string of length ${length}`);
  }
  return value.codePointAt(0) as number;
}

const NAME_MAX_LENGTH = 256;

function lookup(database: Database, argumentValue: PyValue): PyValue {
  const value = unbox(argumentValue);
  let name: string;
  if (typeof value === 'string') name = value;
  else {
    const data = bytesLikeData(value);
    if (data === undefined) throw typeError(`a bytes-like object is required, not '${typeName(value)}'`);
    name = latin1Text(data);
  }
  if (name.length > NAME_MAX_LENGTH) throw currentRuntime().keyError('name too long');
  const found = database.lookup(name);
  if (found === undefined) throw currentRuntime().keyError(`undefined character name '${name}'`);
  return typeof found === 'number' ? String.fromCodePoint(found) : String.fromCodePoint(...found);
}

function normalizationForm(formValue: PyValue, name: string): NormalizationForm {
  const value = unbox(formValue);
  if (typeof value !== 'string') throw typeError(`${name}() argument 1 must be str, not ${typeName(value)}`);
  if (value !== 'NFC' && value !== 'NFD' && value !== 'NFKC' && value !== 'NFKD') {
    throw valueError('invalid normalization form');
  }
  return value;
}

function normalized(database: Database, name: string, args: PyValue[]): string {
  const form = normalizationForm(args[0], name);
  const text = unbox(args[1]);
  if (typeof text !== 'string') throw typeError(`${name}() argument 2 must be str, not ${typeName(text)}`);
  currentRuntime().scan(text.length * 4);
  return database.normalize(form, text);
}

function decomposition(database: Database, value: PyValue): PyValue {
  const entry = database.decomposition(characterArgument(value, 'decomposition', 'argument'));
  if (!entry) return '';
  const points = entry.points.map((point) => point.toString(16).toUpperCase().padStart(4, '0'));
  return [...(entry.tag === '' ? [] : [`<${entry.tag}>`]), ...points].join(' ');
}

const PROPERTIES: [string, keyof CharacterProperties][] = [
  ['category', 'category'],
  ['bidirectional', 'bidirectional'],
  ['combining', 'combining'],
  ['east_asian_width', 'eastAsianWidth'],
  ['mirrored', 'mirrored'],
];

const NUMERIC_MESSAGES = {
  decimal: 'not a decimal',
  digit: 'not a digit',
  numeric: 'not a numeric character',
} as const;

/** The functions of a database: `name(args)`, by name, with its range of positional arguments. */
function functionsOf(database: Database): [string, number, number, (args: PyValue[]) => PyValue][] {
  return [
    ['lookup', 1, 1, ([name]) => lookup(database, name)],
    [
      'name',
      1,
      2,
      ([value, fallback]) => {
        const name = database.name(characterArgument(value, 'name', 'argument 1'));
        if (name !== undefined) return name;
        if (fallback !== undefined) return fallback;
        throw valueError('no such name');
      },
    ],
    ...(['decimal', 'digit', 'numeric'] as const).map(
      (kind): [string, number, number, (args: PyValue[]) => PyValue] => [
        kind,
        1,
        2,
        ([value, fallback]) => {
          const found = database.numeric(characterArgument(value, kind, 'argument 1'), kind);
          if (found !== undefined) return kind === 'numeric' ? found : BigInt(found);
          if (fallback !== undefined) return fallback;
          throw valueError(NUMERIC_MESSAGES[kind]);
        },
      ]
    ),
    ...PROPERTIES.map(([name, key]): [string, number, number, (args: PyValue[]) => PyValue] => [
      name,
      1,
      1,
      ([value]) => {
        const result = database.properties(characterArgument(value, name, 'argument'))[key];
        return typeof result === 'number' ? BigInt(result) : result;
      },
    ]),
    ['decomposition', 1, 1, ([value]) => decomposition(database, value)],
    ['normalize', 2, 2, (args) => normalized(database, 'normalize', args)],
    ['is_normalized', 2, 2, (args) => normalized(database, 'is_normalized', args) === args[1]],
  ];
}

/** The argument style of a function, whose messages differ for one argument. */
const styleOf = (min: number, max: number): 'one' | 'expected' => (min === 1 && max === 1 ? 'one' : 'expected');

/** `unicodedata.UCD`, the class of `ucd_3_2_0`, whose methods are the module's functions for Unicode 3.2.0. */
const ucdClass = builtinClass('UCD');
ucdClass.module = 'unicodedata';
ucdClass.construct = () => {
  throw typeError("cannot create 'unicodedata.UCD' instances");
};
for (const [name, min, max, run] of functionsOf(UNICODE_3_2_0)) {
  method(ucdClass, name, styleOf(min, max), min, max, (_self, args) => run(args));
}
ucdClass.dict.set('unidata_version', '3.2.0');

registerModule('unicodedata', () => {
  return new Map<string, PyValue>([
    ...functionsOf(CURRENT).map(([name, min, max, run]): [string, PyValue] => [
      name,
      builtin(name, styleOf(min, max), min, max, run),
    ]),
    ['unidata_version', UNIDATA_VERSION],
    ['UCD', ucdClass],
    ['ucd_3_2_0', new PyOpaque(ucdClass, '')],
  ]);
});
