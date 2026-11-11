import {
  isAsyncGenerator,
  isAsyncGeneratorFunction,
  isAwaitable,
  isCoroutine,
  isCoroutineFunction,
} from '../coroutines';
import { builtin } from '../define';
import { callValue, getAttribute, getAttributeOrUndefined, isTruthy } from '../objects';
import { currentRuntime } from '../runtimeContext';
import { registerSourceModule } from '../sourceModules';
import { IS_ABSTRACT, typeFlags } from '../typeFlags';
import { builtinFunctionClass, classOf, generatorClass, None, typeError } from '../types';
import { UnsupportedFeatureError } from '../unsupported';
import { PyBoundMethod, PyBuiltinFunction, PyClass, PyFunction, PyGenerator, PyModule, type PyValue } from '../values';
import { INSPECT_SOURCE } from './inspectPython';
import { emptyClass, formatAnnotation, parameterClass, signature, signatureClass } from './inspectSignature';
import { inspectSourceNatives } from './inspectSource';

/** The predicates of inspect, which tell what kind of object a value is. */
const PREDICATES: [string, (value: PyValue) => boolean][] = [
  ['ismodule', (value) => value instanceof PyModule],
  ['isclass', (value) => value instanceof PyClass],
  ['ismethod', (value) => value instanceof PyBoundMethod],
  ['isfunction', (value) => value instanceof PyFunction],
  ['isgeneratorfunction', (value) => isGeneratorFunction(value)],
  ['isgenerator', (value) => value instanceof PyGenerator && value.cls === generatorClass],
  ['iscoroutinefunction', isCoroutineFunction],
  ['iscoroutine', isCoroutine],
  ['isasyncgenfunction', isAsyncGeneratorFunction],
  ['isasyncgen', isAsyncGenerator],
  ['isawaitable', isAwaitable],
  ['isbuiltin', (value) => isBuiltin(value)],
  ['ismethoddescriptor', (value) => isMethodDescriptor(value)],
  // ABCMeta records `__abstractmethods__` once it creates a class, which sets the class's abstract flag.
  ['isabstract', (value) => value instanceof PyClass && (typeFlags(value) & IS_ABSTRACT) !== 0],
  [
    'isroutine',
    (value) => value instanceof PyBuiltinFunction || value instanceof PyFunction || value instanceof PyBoundMethod,
  ],
];

registerSourceModule(
  'inspect',
  INSPECT_SOURCE,
  () =>
    new Map<string, PyValue>([
      ...PREDICATES.map(([name, test]): [string, PyValue] => [
        name,
        builtin(name, 'one', 1, 1, ([value]) => test(value)),
      ]),
      [
        'signature',
        builtin('signature', 'takes', 1, 1, ([value]) => signature(value), {
          keywords: ['follow_wrapped', 'globals', 'locals', 'eval_str', 'annotation_format'],
        }),
      ],
      ['Signature', signatureClass],
      ['Parameter', parameterClass],
      ['_empty', emptyClass],
      [
        'formatannotation',
        builtin('formatannotation', 'takes', 1, 2, ([value, base]) => formatAnnotation(value, base)),
      ],
      ['getmembers', builtin('getmembers', 'takes', 1, 2, ([value, predicate]) => getMembers(value, predicate))],
      ['getdoc', builtin('getdoc', 'one', 1, 1, ([value]) => getDoc(value))],
      ['cleandoc', builtin('cleandoc', 'one', 1, 1, ([doc]) => cleanDoc(doc))],
      ['getmro', builtin('getmro', 'one', 1, 1, ([cls]) => getAttribute(cls, '__mro__'))],
      ...inspectSourceNatives(),
    ]),
  {
    unsupported: {
      ...Object.fromEntries(
        [
          ['getsourcefile', 'ソースファイルのパス'],
          ['getfile', 'ソースファイルのパス'],
          ['stack', 'ソースファイルのパスを含むフレームの情報'],
          ['trace', 'ソースファイルのパスを含むフレームの情報'],
          ['getframeinfo', 'ソースファイルのパスを含むフレームの情報'],
          ['getouterframes', 'ソースファイルのパスを含むフレームの情報'],
          ['getinnerframes', 'ソースファイルのパスを含むフレームの情報'],
          ['getclosurevars', 'CPython のバイトコードから集める名前'],
          ['getabsfile', 'ソースファイルのパス'],
        ].map(([name, feature]) => [name, `inspect.${name}()（${feature}）`])
      ),
      modulesbyfile: 'inspect.modulesbyfile（ソースファイルのパス）',
      _filesbymodname: 'inspect._filesbymodname（ソースファイルのパス）',
    },
  }
);

function isGeneratorFunction(value: PyValue): boolean {
  const fn = value instanceof PyBoundMethod ? value.fn : value;
  return fn instanceof PyFunction && fn.def.scope.isGenerator && fn.def.scope.isAsync !== true;
}

/** A builtin function, or a builtin method bound to an object, which CPython makes `builtin_function_or_method`. */
function isBuiltin(value: PyValue): boolean {
  return value instanceof PyBuiltinFunction && value.cls === builtinFunctionClass;
}

function isMethodDescriptor(value: PyValue): boolean {
  return value instanceof PyBuiltinFunction && value.self === undefined && value.cls !== builtinFunctionClass;
}

/** `inspect.getmembers`: the attributes `dir()` lists, with their values, sorted by name. */
function getMembers(value: PyValue, predicate: PyValue | undefined): PyValue {
  const runtime = currentRuntime();
  const members: PyValue[] = [];
  for (const name of runtime.dirNames(value)) {
    const member = getAttributeOrUndefined(value, name);
    if (member === undefined) continue;
    if (predicate !== undefined && predicate !== None && !isTruthy(callValue(predicate, [member]))) continue;
    members.push(runtime.tuple([name, member]));
  }
  return runtime.listOf(members);
}

/**
 * `inspect.getdoc`: the cleaned docstring of an object the program defines, or of the class or base class it inherits
 * one from. The builtins' docstrings are CPython's, which this grader does not have.
 */
export function getDoc(value: PyValue): PyValue {
  if (isBuiltinObject(value))
    throw new UnsupportedFeatureError('組み込みのオブジェクトの docstring（inspect.getdoc()）');
  const doc = getAttributeOrUndefined(value, '__doc__') ?? None;
  const found = doc === None ? inheritedDoc(value) : doc;
  return typeof found === 'string' ? cleanDoc(found) : None;
}

function isBuiltinObject(value: PyValue): boolean {
  if (value instanceof PyClass) return value.isBuiltin;
  if (value instanceof PyModule || value instanceof PyBuiltinFunction) return true;
  return !(value instanceof PyFunction || value instanceof PyBoundMethod) && classOf(value).isBuiltin;
}

/** `inspect._finddoc`: the docstring of a base class, or of the method a method overrides. */
function inheritedDoc(value: PyValue): PyValue {
  if (value instanceof PyClass) return baseClassDoc(value);
  const fn = value instanceof PyBoundMethod ? value.fn : value;
  if (!(fn instanceof PyFunction)) return None;
  const owner = value instanceof PyBoundMethod ? methodOwner(value, fn) : functionOwner(fn);
  return owner ? overriddenDoc(owner, fn.name) : None;
}

function baseClassDoc(cls: PyClass): PyValue {
  for (const base of cls.mro) {
    if (base.isBuiltin) return None;
    const doc = getAttributeOrUndefined(base, '__doc__') ?? None;
    if (doc !== None) return doc;
  }
  return None;
}

function overriddenDoc(owner: PyClass, name: string): PyValue {
  for (const base of owner.mro) {
    const attribute = base.dict.get(name);
    if (attribute === undefined) continue;
    if (base.isBuiltin) throw new UnsupportedFeatureError('組み込みのメソッドの docstring（inspect.getdoc()）');
    const doc = getAttributeOrUndefined(attribute, '__doc__') ?? None;
    if (doc !== None) return doc;
  }
  return None;
}

function methodOwner(method: PyBoundMethod, fn: PyFunction): PyClass {
  const { self } = method;
  const fromClass = self instanceof PyClass && getAttributeOrUndefined(getAttribute(self, fn.name), '__func__') === fn;
  return fromClass ? self : classOf(self);
}

/** The class whose body defines a function, found by its qualified name, as `inspect._findclass` does. */
function functionOwner(fn: PyFunction): PyClass | undefined {
  const path = fn.qualifiedName.split('.').slice(0, -1);
  if (path.length === 0 || path.includes('<locals>')) return undefined;
  let owner: PyValue | undefined = fn.globals.get(path[0]);
  for (const name of path.slice(1)) owner = owner === undefined ? undefined : getAttributeOrUndefined(owner, name);
  if (!(owner instanceof PyClass) || getAttributeOrUndefined(owner, fn.name) !== fn) return undefined;
  return owner;
}

/** `inspect.cleandoc`: a docstring without the indentation of its lines after the first and its blank edges. */
export function cleanDoc(doc: PyValue): PyValue {
  if (typeof doc !== 'string') throw typeError(`'${classOf(doc).name}' object has no attribute 'expandtabs'`);
  const expanded = callValue(getAttribute(doc, 'expandtabs'), []) as string;
  const lines = expanded.split('\n');
  let margin = Number.POSITIVE_INFINITY;
  for (const line of lines.slice(1)) {
    const content = line.replace(/^ +/, '').length;
    if (content > 0) margin = Math.min(margin, line.length - content);
  }
  lines[0] = lines[0].replace(/^ +/, '');
  if (margin < Number.POSITIVE_INFINITY)
    for (let index = 1; index < lines.length; index++) lines[index] = lines[index].slice(margin);
  while (lines.length > 0 && lines.at(-1) === '') lines.pop();
  while (lines.length > 0 && lines[0] === '') lines.shift();
  return lines.join('\n');
}
