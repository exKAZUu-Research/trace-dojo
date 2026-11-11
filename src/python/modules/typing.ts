import { abcMetaClass, initAbstractClass } from '../abstractClasses';
import { pyRepr } from '../conversions';
import { builtin, method } from '../define';
import { runLibrarySource } from '../librarySource';
import { importModule, registerModule, registerUnsupportedAttributes } from '../modules';
import { getAttribute, getAttributeOrUndefined, isTruthy } from '../objects';
import type { Runtime } from '../runtime';
import { currentRuntime } from '../runtimeContext';
import {
  annotatedGetItem,
  anyType,
  concatenateGetItem,
  forwardRefClass,
  genericAliasClass,
  literalGetItem,
  newSpecialAlias,
  newSpecialForm,
  optionalGetItem,
  singleTypeForm,
  typingArgs,
  typingOrigin,
  unionClass,
  unionOf,
} from '../typeHints';
import {
  builtinClass,
  dictClass,
  frozensetClass,
  functionClass,
  listClass,
  methodClass,
  newDict,
  newSet,
  None,
  noneClass,
  pyError,
  setClass,
  strClass,
  tupleClass,
  typeClass,
  typeError,
} from '../types';
import { UnsupportedFeatureError } from '../unsupported';
import { type Kwargs, PyClass, PyDict, PyFunction, PyModule, PyOpaque, type PyTuple, type PyValue } from '../values';
import { counterClass, defaultdictClass, dequeClass, orderedDictClass } from './collections';
import { TYPING_SOURCE } from './typingSource';

/** The names of typing that need generic classes, metaclasses, or other features this grader does not support. */
const UNSUPPORTED_NAMES: Record<string, string> = {
  Generic: 'typing.Generic（ジェネリッククラス）',
  Protocol: 'typing.Protocol（プロトコルクラス）',
  runtime_checkable: 'typing.runtime_checkable（プロトコルクラス）',
  TypeVar: 'typing.TypeVar（型変数）',
  TypeVarTuple: 'typing.TypeVarTuple（型変数）',
  ParamSpec: 'typing.ParamSpec（型変数）',
  ParamSpecArgs: 'typing.ParamSpecArgs（型変数）',
  ParamSpecKwargs: 'typing.ParamSpecKwargs（型変数）',
  AnyStr: 'typing.AnyStr（型変数）',
  T: 'typing.T（型変数）',
  KT: 'typing.KT（型変数）',
  VT: 'typing.VT（型変数）',
  T_co: 'typing.T_co（型変数）',
  V_co: 'typing.V_co（型変数）',
  VT_co: 'typing.VT_co（型変数）',
  T_contra: 'typing.T_contra（型変数）',
  CT_co: 'typing.CT_co（型変数）',
  TypeAliasType: 'typing.TypeAliasType（type 文の型の別名）',
  NewType: 'typing.NewType',
  NamedTuple: 'typing.NamedTuple（メタクラスで作るクラス）',
  NamedTupleMeta: 'typing.NamedTupleMeta（メタクラス）',
  TypedDict: 'typing.TypedDict（メタクラスで作るクラス）',
  ABCMeta: 'typing.ABCMeta（メタクラス）',
  abstractmethod: 'typing.abstractmethod（abc モジュール）',
  IO: 'typing.IO（ファイルの読み書き）',
  TextIO: 'typing.TextIO（ファイルの読み書き）',
  BinaryIO: 'typing.BinaryIO（ファイルの読み書き）',
  ByteString: 'typing.ByteString（bytes 型）',
  Pattern: 'typing.Pattern（re モジュール）',
  Match: 'typing.Match（re モジュール）',
  evaluate_forward_ref: 'typing.evaluate_forward_ref（文字列の型ヒントの評価）',
  copyreg: 'モジュール copyreg',
  operator: 'モジュール operator',
  types: 'モジュール types',
};

/** `typing.EXCLUDED_ATTRIBUTES`, the attributes a protocol's members leave out. */
const EXCLUDED_ATTRIBUTES = [
  '__parameters__',
  '__orig_bases__',
  '__orig_class__',
  '_is_protocol',
  '_is_runtime_protocol',
  '__protocol_attrs__',
  '__non_callable_proto_members__',
  '__type_params__',
  '__abstractmethods__',
  '__annotations__',
  '__dict__',
  '__doc__',
  '__init__',
  '__module__',
  '__new__',
  '__slots__',
  '__subclasshook__',
  '__weakref__',
  '__class_getitem__',
  '__match_args__',
  '__static_attributes__',
  '__firstlineno__',
  '__annotate__',
  '__annotate_func__',
  '__annotations_cache__',
  '_MutableMapping__marker',
];

registerUnsupportedAttributes('typing', UNSUPPORTED_NAMES);

registerModule('typing', (runtime) => {
  const abc = importModule(runtime, 'collections.abc');
  const collections = importModule(runtime, 'collections');
  const namespace = new Map<string, PyValue>([...specialForms(), ...aliases(abc, collections), ...natives(runtime)]);
  return runLibrarySource('typing', TYPING_SOURCE, namespace);
});

function specialForms(): [string, PyValue][] {
  const single = singleTypeForm(false);
  return [
    ['Any', anyType],
    ['ClassVar', newSpecialForm('ClassVar', singleTypeForm(true))],
    ['Final', newSpecialForm('Final', singleTypeForm(true))],
    ['Optional', newSpecialForm('Optional', optionalGetItem)],
    ['Union', unionClass],
    ['Literal', newSpecialForm('Literal', literalGetItem, true)],
    ['Annotated', newSpecialForm('Annotated', annotatedGetItem, true)],
    ['Concatenate', newSpecialForm('Concatenate', concatenateGetItem)],
    ...['TypeGuard', 'TypeIs', 'Required', 'NotRequired', 'ReadOnly', 'Unpack'].map((name): [string, PyValue] => [
      name,
      newSpecialForm(name, single),
    ]),
    ...['Never', 'NoReturn', 'Self', 'LiteralString', 'TypeAlias'].map((name): [string, PyValue] => [
      name,
      newSpecialForm(name),
    ]),
  ];
}

function aliases(abc: PyModule, collections: PyModule): [string, PyValue][] {
  const abcClass = (name: string): PyValue => abc.attribute(name) as PyValue;
  const abcAliases: [string, string, number][] = [
    ['Hashable', 'Hashable', 0],
    ['Awaitable', 'Awaitable', 1],
    ['Coroutine', 'Coroutine', 3],
    ['AsyncIterable', 'AsyncIterable', 1],
    ['AsyncIterator', 'AsyncIterator', 1],
    ['Iterable', 'Iterable', 1],
    ['Iterator', 'Iterator', 1],
    ['Reversible', 'Reversible', 1],
    ['Sized', 'Sized', 0],
    ['Container', 'Container', 1],
    ['Collection', 'Collection', 1],
    ['AbstractSet', 'Set', 1],
    ['MutableSet', 'MutableSet', 1],
    ['Mapping', 'Mapping', 2],
    ['MutableMapping', 'MutableMapping', 2],
    ['Sequence', 'Sequence', 1],
    ['MutableSequence', 'MutableSequence', 1],
    ['MappingView', 'MappingView', 1],
    ['KeysView', 'KeysView', 1],
    ['ItemsView', 'ItemsView', 2],
    ['ValuesView', 'ValuesView', 1],
  ];
  return [
    ['List', newSpecialAlias(listClass, 1, { name: 'List', inst: false })],
    ['Dict', newSpecialAlias(dictClass, 2, { name: 'Dict', inst: false })],
    ['Set', newSpecialAlias(setClass, 1, { name: 'Set', inst: false })],
    ['FrozenSet', newSpecialAlias(frozensetClass, 1, { name: 'FrozenSet', inst: false })],
    ['Tuple', newSpecialAlias(tupleClass, -1, { name: 'Tuple', inst: false })],
    ['Type', newSpecialAlias(typeClass, 1, { name: 'Type', inst: false })],
    ['Callable', newSpecialAlias(abcClass('Callable'), -1, { name: 'Callable' })],
    ['Deque', newSpecialAlias(dequeClass, 1, { name: 'Deque' })],
    ['DefaultDict', newSpecialAlias(defaultdictClass, 2, { name: 'DefaultDict' })],
    ['OrderedDict', newSpecialAlias(orderedDictClass, 2, { name: 'OrderedDict' })],
    ['Counter', newSpecialAlias(counterClass, 1, { name: 'Counter' })],
    ['ChainMap', newSpecialAlias(collections.attribute('ChainMap') as PyValue, 2, { name: 'ChainMap' })],
    ['Generator', newSpecialAlias(abcClass('Generator'), 3, { defaults: [noneClass, noneClass] })],
    ['AsyncGenerator', newSpecialAlias(abcClass('AsyncGenerator'), 2, { defaults: [noneClass] })],
    ...abcAliases.map(([name, origin, nparams]): [string, PyValue] => [
      name,
      newSpecialAlias(abcClass(origin), nparams, { name }),
    ]),
    ['Text', strClass],
    ['GenericAlias', genericAliasClass],
    ['ForwardRef', forwardRefClass],
    ['defaultdict', defaultdictClass],
    ['collections', collections],
    ['NoDefault', new PyOpaque(noDefaultClass, 'NoDefault')],
  ];
}

const protocolMetaClass = builtinClass('_ProtocolMeta', abcMetaClass);
protocolMetaClass.module = 'typing';

const noDefaultClass = builtinClass('NoDefaultType');
method(noDefaultClass, '__repr__', 'none', 0, 0, () => 'typing.NoDefault');

function natives(runtime: Runtime): [string, PyValue][] {
  return [
    ['TYPE_CHECKING', false],
    ['EXCLUDED_ATTRIBUTES', newSet(EXCLUDED_ATTRIBUTES, true)],
    ['functools', importModule(runtime, 'functools')],
    ['sys', importModule(runtime, 'sys')],
    ['get_origin', builtin('get_origin', 'one', 1, 1, ([tp]) => getOrigin(tp))],
    ['get_args', builtin('get_args', 'one', 1, 1, ([tp]) => typingArgs(tp))],
    [
      'get_type_hints',
      builtin('get_type_hints', 'expected', 1, 4, (args, kwargs) => getTypeHints(args, kwargs), {
        keywords: ['obj', 'globalns', 'localns', 'include_extras', 'format'],
      }),
    ],
    [
      '_write_stderr',
      builtin('_write_stderr', 'one', 1, 1, ([text]) => {
        currentRuntime().errorOutput += text as string;
        return None;
      }),
    ],
    [
      '_firstlineno',
      builtin('_firstlineno', 'one', 1, 1, ([fn]) => {
        if (!(fn instanceof PyFunction)) throw getAttributeError(fn);
        return BigInt(fn.def.row + 1);
      }),
    ],
    ['_FunctionType', functionClass],
    ['_MethodType', methodClass],
    [
      '_abc_init',
      builtin('_abc_init', 'one', 1, 1, ([cls]) => {
        initAbstractClass(cls as PyClass, protocolMetaClass);
        return None;
      }),
    ],
  ];
}

function getAttributeError(value: PyValue): Error {
  try {
    getAttribute(value, '__code__');
  } catch (error) {
    return error as Error;
  }
  return typeError('not a function');
}

function getOrigin(tp: PyValue): PyValue {
  const module = currentRuntime().modules.get('typing') as PyModule;
  return typingOrigin(tp, module.dict.get('Annotated') as PyValue);
}

/**
 * `typing.get_type_hints`: the annotations of a class (with its bases') or of a function or module, with None as
 * NoneType and forward references resolved by name.
 */
function getTypeHints(args: PyValue[], kwargs: Kwargs): PyValue {
  const [obj] = args;
  const includeExtras = isTruthy(kwargs?.get('include_extras') ?? args[3] ?? false);
  const globalns = kwargs?.get('globalns') ?? args[1];
  const localns = kwargs?.get('localns') ?? args[2];
  if ((globalns !== undefined && globalns !== None) || (localns !== undefined && localns !== None)) {
    throw new UnsupportedFeatureError('get_type_hints() の globalns・localns');
  }
  const noTypeCheck = typeof obj === 'object' ? getAttributeOrUndefined(obj, '__no_type_check__') : undefined;
  if (noTypeCheck !== undefined && isTruthy(noTypeCheck)) return newDict();
  const runtime = currentRuntime();
  const hints = new Map<string, PyValue>();
  if (obj instanceof PyClass) {
    for (const base of obj.mro.toReversed()) {
      for (const [name, value] of runtime.classAnnotations(base)) {
        hints.set(name as string, resolveHint(value, base.dict, globalsOf(base.module)));
      }
    }
  } else {
    const annotations = typeof obj === 'object' ? getAttributeOrUndefined(obj, '__annotations__') : undefined;
    if (!(annotations instanceof PyDict)) throw typeError(`${pyRepr(obj)} is not a module, class, or callable.`);
    const globals = obj instanceof PyFunction ? obj.globals : obj instanceof PyModule ? obj.dict : new Map();
    for (const entry of annotations.store.ordered()) {
      hints.set(entry.key as string, resolveHint(entry.value, new Map(), globals));
    }
  }
  return newDict([...hints].map(([name, value]) => [name, includeExtras ? value : stripAnnotations(value)]));
}

function globalsOf(module: string): Map<string, PyValue> {
  const runtime = currentRuntime();
  if (module === '__main__') return runtime.frames[0].globals;
  return runtime.modules.get(module)?.dict ?? new Map();
}

/** Resolves a type hint: None is NoneType, and a string or forward reference is looked up as a dotted name. */
function resolveHint(value: PyValue, locals: Map<string, PyValue>, globals: Map<string, PyValue>): PyValue {
  if (value === None) return noneClass;
  if (typeof value === 'string') return resolveName(value, locals, globals);
  if (value instanceof PyOpaque && value.cls === forwardRefClass) return resolveName(value.text, locals, globals);
  return value;
}

function resolveName(text: string, locals: Map<string, PyValue>, globals: Map<string, PyValue>): PyValue {
  const parts = text.trim().split('.');
  if (!parts.every((part) => /^[\p{L}_][\p{L}\p{N}_]*$/u.test(part))) {
    throw new UnsupportedFeatureError(`名前でない文字列の型ヒントの評価（${text}）`);
  }
  const runtime = currentRuntime();
  let value = locals.get(parts[0]) ?? globals.get(parts[0]) ?? runtime.builtins.get(parts[0]);
  if (value === undefined) throw pyError('NameError', `name '${parts[0]}' is not defined`);
  for (const part of parts.slice(1)) value = getAttribute(value, part);
  return value === None ? noneClass : value;
}

/** `typing._strip_annotations`: Annotated and Required, NotRequired, and ReadOnly give the type they wrap. */
function stripAnnotations(value: PyValue): PyValue {
  if (!(value instanceof PyOpaque)) return value;
  const origin = getAttributeOrUndefined(value, '__origin__');
  const args =
    getAttributeOrUndefined(value, '__metadata__') === undefined ? undefined : getAttribute(value, '__args__');
  if (args !== undefined && origin !== undefined) return stripAnnotations(origin);
  if (origin instanceof PyOpaque && ['Required', 'NotRequired', 'ReadOnly'].includes(formName(origin))) {
    const [inner] = (getAttribute(value, '__args__') as PyTuple).items;
    return stripAnnotations(inner);
  }
  if (value.cls === unionClass) return unionOf((value.data as PyValue[]).map(stripAnnotations));
  return value;
}

function formName(value: PyOpaque): string {
  const name = getAttributeOrUndefined(value, '_name');
  return typeof name === 'string' ? name : '';
}
