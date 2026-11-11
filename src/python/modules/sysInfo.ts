import { pyRepr } from '../conversions';
import { SYS_BUILTIN_MODULE_NAMES, SYS_STDLIB_MODULE_NAMES } from '../data/sysModuleNames';
import { builtin, method } from '../define';
import type { Frame } from '../frame';
import { SUPPORTED_MODULES } from '../moduleNames';
import { registerMainModule, trackModules } from '../modules';
import { namespaceDict } from '../namespaces';
import { toIndex } from '../numbers';
import { sizeOf } from '../objectSizes';
import type { Runtime } from '../runtime';
import { currentRuntime } from '../runtimeContext';
import { hideSubclass } from '../subclasses';
import { stackFrame } from '../tracebacks';
import {
  builtinClass,
  defineMethod,
  moduleClass,
  newDict,
  newSet,
  newTuple,
  None,
  pyError,
  tupleClass,
  typeError,
  typeName,
  valueError,
} from '../types';
import { unavailableValue } from '../unavailableValues';
import { UnsupportedFeatureError } from '../unsupported';
import { type Kwargs, PyInstance, PyModule, PyTuple, type PyValue } from '../values';
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
    // A program here runs with no -W or -X option.
    ['warnoptions', runtime.listOf([])],
    ['_xoptions', newDict()],
    ['getrecursionlimit', builtin('getrecursionlimit', 'none', 0, 0, () => BigInt(runtime.recursionLimit))],
    ['setrecursionlimit', builtin('setrecursionlimit', 'one', 1, 1, ([limit]) => setRecursionLimit(runtime, limit))],
    [
      'getsizeof',
      builtin('getsizeof', 'takes', 1, 2, ([value]) => BigInt(sizeOf(value)), { keywords: ['object', 'default'] }),
    ],
    ['getdefaultencoding', builtin('getdefaultencoding', 'none', 0, 0, () => ENCODING)],
    ['getfilesystemencoding', builtin('getfilesystemencoding', 'none', 0, 0, () => ENCODING)],
    ['get_int_max_str_digits', builtin('get_int_max_str_digits', 'none', 0, 0, () => 4300n)],
    ['intern', builtin('intern', 'one', 1, 1, ([value]) => intern(value))],
    // With no way to add an audit hook, raising an audit event does nothing.
    [
      'audit',
      builtin('audit', 'expected', 1, Number.POSITIVE_INFINITY, ([event]) => {
        if (typeof event !== 'string') throw typeError(`audit() argument 1 must be str, not ${typeName(event)}`);
        return None;
      }),
    ],
    ['exc_info', builtin('exc_info', 'none', 0, 0, () => excInfo(runtime))],
    ['_getframe', builtin('_getframe', 'expected', 0, 1, getFrame)],
    ['stdlib_module_names', newSet(SYS_STDLIB_MODULE_NAMES, true)],
    ['builtin_module_names', newTuple([...SYS_BUILTIN_MODULE_NAMES])],
    ['audit', builtin('audit', 'expected', 1, Number.POSITIVE_INFINITY, audit)],
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
 * first. The codec modules, such as `encodings.utf_8`, read `codecs` as they load, which may be loading itself, so they
 * join only when imported.
 */
export function sysModules(runtime: Runtime): PyValue {
  return namespaceDict(moduleTable(runtime));
}

function moduleTable(runtime: Runtime): Map<string, PyValue> {
  const table = new Map<string, PyValue>();
  for (const name of STARTUP_MODULES) {
    const loaded = runtime.modules.get(name) ?? (SUPPORTED_MODULES.has(name) ? runtime.importModule(name) : undefined);
    table.set(name, loaded ?? unavailableValue(`モジュール ${name}`));
  }
  for (const [name, module] of runtime.modules) table.set(name, module);
  trackModules(runtime, table);
  return table;
}

/** The `__main__` module, whose repr names the script's file. */
const mainModuleClass = builtinClass('module', moduleClass);
hideSubclass(mainModuleClass);
method(mainModuleClass, '__repr__', 'none', 0, 0, () => {
  throw new UnsupportedFeatureError('__main__ モジュールの repr（スクリプトのファイルのパスを含む）');
});

registerMainModule((runtime) => new PyModule(mainModuleClass, '__main__', (runtime.frames[0] as Frame).globals));

// Struct sequences --------------------------------------------------------------------------------------------------

/**
 * A named tuple of `sys`, such as `sys.version_info`, which compares and indexes as a tuple. `hidden` are the fields
 * that only its attributes show, as `sys.flags.gil`.
 */
export function structSeq(
  name: string,
  fields: [string, PyValue][],
  { module = 'sys', hidden = [] }: { module?: string; hidden?: [string, PyValue][] } = {}
): PyTuple {
  const cls = builtinClass(name, tupleClass);
  cls.module = module;
  const all = [...fields, ...hidden];
  const extra = new WeakMap<PyTuple, PyValue[]>();
  for (const [index, [field]] of fields.entries()) {
    defineProperty(cls, field, (self) => (self as PyTuple).items[index]);
  }
  for (const [index, [field]] of hidden.entries()) {
    defineProperty(cls, field, (self) => extra.get(self as PyTuple)?.[index] ?? None);
  }
  cls.dict.set('n_fields', BigInt(all.length));
  cls.dict.set('n_sequence_fields', BigInt(fields.length));
  cls.dict.set('n_unnamed_fields', 0n);
  cls.dict.set('__match_args__', newTuple(fields.map(([field]) => field)));
  const create = (values: PyValue[]): PyTuple => {
    const tuple = new PyTuple(cls, values.slice(0, fields.length));
    extra.set(tuple, values.slice(fields.length));
    return tuple;
  };
  const prefix = module === 'sys' ? 'sys.' : '';
  method(cls, '__repr__', 'none', 0, 0, (self) => {
    const { items } = self as PyTuple;
    return `${prefix}${name}(${fields.map(([field], index) => `${field}=${pyRepr(items[index])}`).join(', ')})`;
  });
  defineMethod(cls, '__replace__', (self, args, kwargs) => {
    const values = [...(self as PyTuple).items, ...(extra.get(self as PyTuple) ?? [])];
    return create(
      replacedFields(
        all.map(([field]) => field),
        values,
        args,
        kwargs
      )
    );
  });
  return create(all.map(([, value]) => value));
}

/** The values of a struct sequence's `__replace__(**changes)`: its values, with the changed fields replaced. */
function replacedFields(fields: string[], values: PyValue[], args: PyValue[], kwargs: Kwargs): PyValue[] {
  if (args.length > 0) throw typeError('__replace__() takes no positional arguments');
  const unexpected = [...(kwargs?.keys() ?? [])].filter((key) => !fields.includes(key));
  if (unexpected.length > 0) {
    throw typeError(`Got unexpected field name(s): [${unexpected.map((key) => pyRepr(key)).join(', ')}]`);
  }
  return values.map((value, index) => kwargs?.get(fields[index]) ?? value);
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
const FLAGS = structSeq(
  'flags',
  [
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
  ],
  {
    hidden: [
      ['gil', 1n],
      ['context_aware_warnings', 0n],
      ['thread_inherit_context', 0n],
    ],
  }
);

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

function intern(value: PyValue): PyValue {
  if (typeof value !== 'string') throw typeError(`intern() argument must be str, not ${typeName(value)}`);
  return value;
}

function excInfo(runtime: Runtime): PyValue {
  const exception = runtime.evaluator.handledExceptions.at(-1);
  if (!exception) return newTuple([None, None, None]);
  return currentRuntime().tuple([exception.cls, exception, exception.exception?.traceback ?? None]);
}

/** `sys.audit(event, *args)`, which calls no hooks, as no program can add one here. */
function audit([event]: PyValue[]): PyValue {
  if (typeof event !== 'string') throw typeError(`audit() argument 1 must be str, not ${typeName(event)}`);
  return None;
}

/** `sys._getframe(depth=0)`: the frame object `depth` calls below the caller's. */
function getFrame(args: PyValue[]): PyValue {
  const depth = args.length === 0 ? 0n : toIndex(args[0]);
  const frame = depth < 0n ? undefined : stackFrame(Number(depth));
  if (frame === undefined) throw valueError('call stack is not deep enough');
  return frame;
}
