import { pyRepr } from '../conversions';
import { method } from '../define';
import { registerModule } from '../modules';
import { builtinClass, newList, newTuple, None } from '../types';
import { PyInstance, type PyValue } from '../values';

const featureClass = builtinClass('_Feature');
featureClass.module = '__future__';

type Release = [number, number, number, string, number];

/** The features of CPython 3.14's `__future__`: when each became optional and mandatory, and its compiler flag. */
const FEATURES: [string, Release, Release | undefined, number][] = [
  ['nested_scopes', [2, 1, 0, 'beta', 1], [2, 2, 0, 'alpha', 0], 0x10],
  ['generators', [2, 2, 0, 'alpha', 1], [2, 3, 0, 'final', 0], 0],
  ['division', [2, 2, 0, 'alpha', 2], [3, 0, 0, 'alpha', 0], 0x2_00_00],
  ['absolute_import', [2, 5, 0, 'alpha', 1], [3, 0, 0, 'alpha', 0], 0x4_00_00],
  ['with_statement', [2, 5, 0, 'alpha', 1], [2, 6, 0, 'alpha', 0], 0x8_00_00],
  ['print_function', [2, 6, 0, 'alpha', 2], [3, 0, 0, 'alpha', 0], 0x10_00_00],
  ['unicode_literals', [2, 6, 0, 'alpha', 2], [3, 0, 0, 'alpha', 0], 0x20_00_00],
  ['barry_as_FLUFL', [3, 1, 0, 'alpha', 2], [4, 0, 0, 'alpha', 0], 0x40_00_00],
  ['generator_stop', [3, 5, 0, 'beta', 1], [3, 7, 0, 'alpha', 0], 0x80_00_00],
  ['annotations', [3, 7, 0, 'beta', 1], undefined, 0x1_00_00_00],
];

const FLAGS: [string, number][] = [
  ['CO_NESTED', 0x10],
  ['CO_GENERATOR_ALLOWED', 0],
  ['CO_FUTURE_DIVISION', 0x2_00_00],
  ['CO_FUTURE_ABSOLUTE_IMPORT', 0x4_00_00],
  ['CO_FUTURE_WITH_STATEMENT', 0x8_00_00],
  ['CO_FUTURE_PRINT_FUNCTION', 0x10_00_00],
  ['CO_FUTURE_UNICODE_LITERALS', 0x20_00_00],
  ['CO_FUTURE_BARRY_AS_BDFL', 0x40_00_00],
  ['CO_FUTURE_GENERATOR_STOP', 0x80_00_00],
  ['CO_FUTURE_ANNOTATIONS', 0x1_00_00_00],
];

method(featureClass, 'getOptionalRelease', 'none', 0, 0, (self) => (self as PyInstance).dict.get('optional') ?? None);
method(featureClass, 'getMandatoryRelease', 'none', 0, 0, (self) => (self as PyInstance).dict.get('mandatory') ?? None);
method(featureClass, '__repr__', 'none', 0, 0, (self) => {
  const { dict } = self as PyInstance;
  const field = (name: string): string => pyRepr(dict.get(name) ?? None);
  return `_Feature(${field('optional')}, ${field('mandatory')}, ${field('compiler_flag')})`;
});

function release(value: Release | undefined): PyValue {
  return value ? newTuple(value.map((part) => (typeof part === 'number' ? BigInt(part) : part))) : None;
}

registerModule('__future__', () => {
  const features = FEATURES.map(([name, optional, mandatory, flag]): [string, PyValue] => {
    const feature = new PyInstance(featureClass);
    feature.dict.set('optional', release(optional));
    feature.dict.set('mandatory', release(mandatory));
    feature.dict.set('compiler_flag', BigInt(flag));
    return [name, feature];
  });
  return new Map<string, PyValue>([
    ['all_feature_names', newList(FEATURES.map(([name]) => name))],
    ...FLAGS.map(([name, flag]): [string, PyValue] => [name, BigInt(flag)]),
    ['_Feature', featureClass],
    ...features,
  ]);
});
