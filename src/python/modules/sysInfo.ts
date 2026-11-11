import { PyBytes } from '../bytesValues';
import { pyRepr } from '../conversions';
import { builtin, method } from '../define';
import type { Frame } from '../frame';
import { isSupportedModule } from '../moduleNames';
import { trackModules } from '../modules';
import { namespaceDict } from '../namespaces';
import { toIndex } from '../numbers';
import type { Runtime } from '../runtime';
import { currentRuntime } from '../runtimeContext';
import {
  builtinClass,
  classOf,
  Ellipsis,
  moduleClass,
  newTuple,
  None,
  NotImplemented,
  objectClass,
  pyError,
  tupleClass,
  typeError,
  typeName,
  valueError,
} from '../types';
import { unavailableValue } from '../unavailableValues';
import { UnsupportedFeatureError } from '../unsupported';
import { PyComplex, PyInstance, PyModule, PyObject, PyRange, PyTuple, type PyValue } from '../values';
import { defineProperty } from './numberSupport';

/** What the reference CPython, 3.14.10 built for macOS, reports about itself. */
const VERSION = '3.14.10 (main, Oct 26 2026, 13:59:48) [Clang 23.1.3 ]';
const HEXVERSION = 0x03_0e_0a_f0n;
// oxlint-disable-next-line unicorn/text-encoding-identifier-case -- CPython names the encoding utf-8.
const ENCODING = 'utf-8';

/** The attributes of `sys` that describe the interpreter, in addition to its I/O and exit. */
export function sysInformation(runtime: Runtime): [string, PyValue][] {
  const versionInfo = structSeq('version_info', [
    ['major', 3n],
    ['minor', 14n],
    ['micro', 10n],
    ['releaselevel', 'final'],
    ['serial', 0n],
  ]);
  return [
    ['version', VERSION],
    ['version_info', versionInfo],
    ['hexversion', HEXVERSION],
    ['api_version', 1013n],
    ['implementation', implementation(versionInfo)],
    ['platform', 'darwin'],
    ['byteorder', 'little'],
    ['maxunicode', 0x10_ff_ffn],
    ['float_repr_style', 'short'],
    ['float_info', FLOAT_INFO],
    ['int_info', INT_INFO],
    ['hash_info', HASH_INFO],
    ['flags', FLAGS],
    ['getrecursionlimit', builtin('getrecursionlimit', 'none', 0, 0, () => BigInt(runtime.recursionLimit))],
    ['setrecursionlimit', builtin('setrecursionlimit', 'one', 1, 1, ([limit]) => setRecursionLimit(runtime, limit))],
    ['getsizeof', builtin('getsizeof', 'takes', 1, 2, ([value]) => sizeOf(value), { keywords: ['object', 'default'] })],
    ['getdefaultencoding', builtin('getdefaultencoding', 'none', 0, 0, () => ENCODING)],
    ['getfilesystemencoding', builtin('getfilesystemencoding', 'none', 0, 0, () => ENCODING)],
    ['get_int_max_str_digits', builtin('get_int_max_str_digits', 'none', 0, 0, () => 4300n)],
    ['intern', builtin('intern', 'one', 1, 1, ([value]) => intern(value))],
    ['exc_info', builtin('exc_info', 'none', 0, 0, () => excInfo(runtime))],
    // A program can add no audit hook, so raising an audit event does nothing, as in CPython without hooks.
    [
      'audit',
      builtin('audit', 'expected', 1, Number.POSITIVE_INFINITY, ([event]) => {
        if (typeof event !== 'string') throw typeError(`audit() argument 1 must be str, not ${typeName(event)}`);
        return None;
      }),
    ],
    ['exception', builtin('exception', 'none', 0, 0, () => runtime.evaluator.handledExceptions.at(-1) ?? None)],
  ];
}

// Modules -----------------------------------------------------------------------------------------------------------

/** The modules CPython has imported when a script starts, in the order of `sys.modules`. */
const STARTUP_MODULES = [
  'sys',
  'builtins',
  '_frozen_importlib',
  '_imp',
  '_thread',
  '_warnings',
  '_weakref',
  '_io',
  'marshal',
  'posix',
  '_frozen_importlib_external',
  'time',
  'zipimport',
  '_codecs',
  'codecs',
  'encodings.aliases',
  'encodings',
  'encodings.utf_8',
  '_signal',
  '__main__',
  '_abc',
  'abc',
  '_stat',
  'stat',
  '_collections_abc',
  'errno',
  'genericpath',
  'posixpath',
  'os.path',
  'os',
  '_sitebuiltins',
  'site',
];

/**
 * `sys.modules`: the startup modules, then those the program imports, which this grader implements or names only. The
 * startup modules written in Python, such as `codecs`, read `sys` as they load, so `sys` must have its other attributes
 * first.
 */
export function sysModules(runtime: Runtime): PyValue {
  return namespaceDict(moduleTable(runtime));
}

function moduleTable(runtime: Runtime): Map<string, PyValue> {
  const table = new Map<string, PyValue>();
  for (const name of STARTUP_MODULES) {
    const loaded = runtime.modules.get(name) ?? (isSupportedModule(name) ? runtime.importModule(name) : undefined);
    table.set(name, loaded ?? (name === '__main__' ? mainModule(runtime) : unavailableValue(`モジュール ${name}`)));
  }
  for (const [name, module] of runtime.modules) table.set(name, module);
  trackModules(runtime, table);
  return table;
}

/** The `__main__` module, whose repr names the script's file. */
const mainModuleClass = builtinClass('module', moduleClass);
method(mainModuleClass, '__repr__', 'none', 0, 0, () => {
  throw new UnsupportedFeatureError('__main__ モジュールの repr（スクリプトのファイルのパスを含む）');
});

function mainModule(runtime: Runtime): PyModule {
  return new PyModule(mainModuleClass, '__main__', (runtime.frames[0] as Frame).globals);
}

// Struct sequences --------------------------------------------------------------------------------------------------

/** A named tuple of `sys`, such as `sys.version_info`, which compares and indexes as a tuple. */
function structSeq(name: string, fields: [string, PyValue][]): PyTuple {
  const cls = builtinClass(name, tupleClass);
  cls.module = 'sys';
  for (const [index, [field]] of fields.entries()) {
    defineProperty(cls, field, (self) => (self as PyTuple).items[index]);
  }
  cls.dict.set('n_fields', BigInt(fields.length));
  cls.dict.set('n_sequence_fields', BigInt(fields.length));
  method(cls, '__repr__', 'none', 0, 0, (self) => {
    const { items } = self as PyTuple;
    return `sys.${name}(${fields.map(([field], index) => `${field}=${pyRepr(items[index])}`).join(', ')})`;
  });
  return new PyTuple(
    cls,
    fields.map(([, value]) => value)
  );
}

const FLOAT_INFO = structSeq('float_info', [
  ['max', Number.MAX_VALUE],
  ['max_exp', 1024n],
  ['max_10_exp', 308n],
  ['min', 2.2250738585072014e-308],
  ['min_exp', -1021n],
  ['min_10_exp', -307n],
  ['dig', 15n],
  ['mant_dig', 53n],
  ['epsilon', Number.EPSILON],
  ['radix', 2n],
  ['rounds', 1n],
]);

const INT_INFO = structSeq('int_info', [
  ['bits_per_digit', 30n],
  ['sizeof_digit', 4n],
  ['default_max_str_digits', 4300n],
  ['str_digits_check_threshold', 640n],
]);

const HASH_INFO = structSeq('hash_info', [
  ['width', 64n],
  ['modulus', (1n << 61n) - 1n],
  ['inf', 314_159n],
  ['nan', 0n],
  ['imag', 1_000_003n],
  ['algorithm', 'siphash13'],
  ['hash_bits', 64n],
  ['seed_bits', 128n],
  ['cutoff', 0n],
]);

/** The flags the reference CPython runs programs with, `dont_write_bytecode` and `utf8_mode` among them. */
const FLAGS = structSeq('flags', [
  ['debug', 0n],
  ['inspect', 0n],
  ['interactive', 0n],
  ['optimize', 0n],
  ['dont_write_bytecode', 1n],
  ['no_user_site', 0n],
  ['no_site', 0n],
  ['ignore_environment', 0n],
  ['verbose', 0n],
  ['bytes_warning', 0n],
  ['quiet', 0n],
  ['hash_randomization', 1n],
  ['isolated', 0n],
  ['dev_mode', false],
  ['utf8_mode', 1n],
  ['warn_default_encoding', 0n],
  ['safe_path', false],
  ['int_max_str_digits', 4300n],
]);

/** `sys.implementation`, a `types.SimpleNamespace`. */
const simpleNamespaceClass = builtinClass('SimpleNamespace');
simpleNamespaceClass.module = 'types';
method(simpleNamespaceClass, '__repr__', 'none', 0, 0, (self) => {
  const entries = [...(self as PyInstance).dict].map(([key, value]) => `${key}=${pyRepr(value)}`);
  return `namespace(${entries.join(', ')})`;
});

function implementation(versionInfo: PyTuple): PyInstance {
  const namespace = new PyInstance(simpleNamespaceClass);
  for (const [key, value] of [
    ['name', 'cpython'],
    ['cache_tag', 'cpython-314'],
    ['version', versionInfo],
    ['hexversion', HEXVERSION],
    ['_multiarch', 'darwin'],
    ['supports_isolated_interpreters', true],
  ] as const) {
    namespace.dict.set(key, value);
  }
  return namespace;
}

// Functions ---------------------------------------------------------------------------------------------------------

function setRecursionLimit(runtime: Runtime, value: PyValue): PyValue {
  const limit = toIndex(value);
  if (limit < 1n) throw valueError('recursion limit must be greater or equal than 1');
  const depth = runtime.frames.length;
  if (limit <= BigInt(depth)) {
    throw pyError(
      'RecursionError',
      `cannot set the recursion limit to ${limit} at the recursion depth ${depth}: the limit is too low`
    );
  }
  runtime.recursionLimit = Number(limit > 1_000_000_000n ? 1_000_000_000n : limit);
  return None;
}

/** `sys.getsizeof` of the objects whose size in CPython does not depend on how they grew. */
function sizeOf(value: PyValue): PyValue {
  const size = fixedSize(value);
  if (size === undefined)
    throw new UnsupportedFeatureError(`sys.getsizeof() での ${typeName(value)} オブジェクトの大きさ`);
  return BigInt(size);
}

// code-gauge-allow functionCognitiveComplexity 16 -- One case per kind of object of a fixed layout.
function fixedSize(value: PyValue): number | undefined {
  if (typeof value === 'bigint' || typeof value === 'boolean') return intSize(BigInt(value));
  if (typeof value === 'number') return 24;
  if (typeof value === 'string') return isAscii(value) ? 41 + value.length : undefined;
  if (value === None || value === Ellipsis || value === NotImplemented) return 16;
  if (value instanceof PyComplex) return 32;
  if (value instanceof PyBytes && !value.isMutable && value.cls.isBuiltin) return 33 + value.length;
  if (value instanceof PyTuple && value.cls === tupleClass) return 48 + 8 * value.items.length;
  if (value instanceof PyRange) return 48;
  return value instanceof PyObject && classOf(value) === objectClass ? 16 : undefined;
}

/** The size of an int, whose 30-bit digits take 4 bytes each, with at least one digit. */
function intSize(value: bigint): number {
  const magnitude = value < 0n ? -value : value;
  return 24 + 4 * Math.max(1, Math.ceil(magnitude.toString(2).length / 30));
}

/** Whether a string is ASCII, whose size depends only on its length, unlike others, which may cache their UTF-8. */
function isAscii(text: string): boolean {
  for (let index = 0; index < text.length; index++) if ((text.codePointAt(index) ?? 0) > 0x7f) return false;
  return true;
}

function intern(value: PyValue): PyValue {
  if (typeof value !== 'string') throw typeError(`intern() argument must be str, not ${typeName(value)}`);
  return value;
}

function excInfo(runtime: Runtime): PyValue {
  const exception = runtime.evaluator.handledExceptions.at(-1);
  if (!exception) return newTuple([None, None, None]);
  return currentRuntime().tuple([exception.cls, exception, unavailableValue('トレースバックオブジェクト')]);
}
