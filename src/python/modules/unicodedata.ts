import { bytesLikeData, latin1Text } from '../bytesValues';
import { UNIDATA_VERSION } from '../data/unicodeData';
import { builtin } from '../define';
import { registerModule } from '../modules';
import { currentRuntime } from '../runtimeContext';
import { strLength } from '../strings';
import { typeError, typeName, unbox, valueError } from '../types';
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
import type { PyValue } from '../values';

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

function property<K extends keyof CharacterProperties>(name: string, key: K): PyValue {
  return builtin(name, 'one', 1, 1, ([value]) => {
    const result = propertiesOf(characterArgument(value, name, 'argument'))[key];
    return typeof result === 'number' ? BigInt(result) : result;
  });
}

/** `decimal()`, `digit()`, or `numeric()`, which accept the characters whose value is of `kinds`. */
function numericFunction(name: string, kinds: string, message: string, toValue: (value: number) => PyValue): PyValue {
  return builtin(name, 'expected', 1, 2, ([value, fallback]) => {
    const entry = numericValueOf(characterArgument(value, name, 'argument 1'));
    if (entry && kinds.includes(entry.kind)) return toValue(entry.value);
    if (fallback !== undefined) return fallback;
    throw valueError(message);
  });
}

const NAME_MAX_LENGTH = 256;

function lookup([argumentValue]: PyValue[]): PyValue {
  const value = unbox(argumentValue);
  let name: string;
  if (typeof value === 'string') name = value;
  else {
    const data = bytesLikeData(value);
    if (data === undefined) throw typeError(`a bytes-like object is required, not '${typeName(value)}'`);
    name = latin1Text(data);
  }
  if (name.length > NAME_MAX_LENGTH) throw currentRuntime().keyError('name too long');
  const found = lookupName(name, true);
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

function normalized(name: string, args: PyValue[]): string {
  const form = normalizationForm(args[0], name);
  const text = unbox(args[1]);
  if (typeof text !== 'string') throw typeError(`${name}() argument 2 must be str, not ${typeName(text)}`);
  currentRuntime().scan(text.length * 4);
  return normalize(form, text);
}

function decomposition([value]: PyValue[]): PyValue {
  const entry = decompositionOf(characterArgument(value, 'decomposition', 'argument'));
  if (!entry) return '';
  const points = entry.points.map((point) => point.toString(16).toUpperCase().padStart(4, '0'));
  return [...(entry.tag === '' ? [] : [`<${entry.tag}>`]), ...points].join(' ');
}

registerModule(
  'unicodedata',
  () =>
    new Map<string, PyValue>([
      ['lookup', builtin('lookup', 'one', 1, 1, lookup)],
      [
        'name',
        builtin('name', 'expected', 1, 2, ([value, fallback]) => {
          const name = characterName(characterArgument(value, 'name', 'argument 1'));
          if (name !== undefined) return name;
          if (fallback !== undefined) return fallback;
          throw valueError('no such name');
        }),
      ],
      ['decimal', numericFunction('decimal', 'd', 'not a decimal', BigInt)],
      ['digit', numericFunction('digit', 'dg', 'not a digit', BigInt)],
      ['numeric', numericFunction('numeric', 'dgn', 'not a numeric character', (value) => value)],
      ['category', property('category', 'category')],
      ['bidirectional', property('bidirectional', 'bidirectional')],
      ['combining', property('combining', 'combining')],
      ['east_asian_width', property('east_asian_width', 'eastAsianWidth')],
      ['mirrored', property('mirrored', 'mirrored')],
      ['decomposition', builtin('decomposition', 'one', 1, 1, decomposition)],
      ['normalize', builtin('normalize', 'expected', 2, 2, (args) => normalized('normalize', args))],
      [
        'is_normalized',
        builtin('is_normalized', 'expected', 2, 2, (args) => normalized('is_normalized', args) === args[1]),
      ],
      ['unidata_version', UNIDATA_VERSION],
    ]),
  { ucd_3_2_0: 'unicodedata.ucd_3_2_0（Unicode 3.2.0 のデータ）', UCD: 'unicodedata.UCD' }
);
