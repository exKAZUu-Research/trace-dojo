import { BUILTIN_DOC } from './attributes';
import { registerUnsupportedClassAttributes } from './unsupportedAttributes';

// The attributes of builtin and library classes that CPython has and this grader does not support, which raise the
// unsupported error instead of AttributeError. Each feature says why.

const of = (feature: string, names: string[]): Record<string, string> =>
  Object.fromEntries(names.map((name) => [name, `${feature}（${name}）`]));

/** CPython's own memory, which no program here can see. */
const MEMORY = 'CPython のメモリ上の配置';
const BUFFER = 'CPython のバッファのメモリ';
/** Classes CPython writes in Python and this grader writes natively, whose internal attributes differ. */
const PYTHON_CLASS = 'CPython が Python で書いたクラスの内部の属性';
const ITERATOR_PICKLE = 'イテレータの pickle';
const FINALIZER = 'オブジェクトの後始末（__del__）を直接呼ぶこと';
const WEAKREF_LIST = '組み込みのクラスのオブジェクトの弱参照の一覧';
const INTERNAL = 'CPython の内部の関数';

for (const iterator of [
  'str_ascii_iterator',
  'tuple_iterator',
  'list_iterator',
  'range_iterator',
  'list_reverseiterator',
  'map',
  'zip',
]) {
  registerUnsupportedClassAttributes(`builtins.${iterator}`, of(ITERATOR_PICKLE, ['__setstate__']));
}
registerUnsupportedClassAttributes('builtins.generator', of(FINALIZER, ['__del__']));
registerUnsupportedClassAttributes('builtins.type', {
  ...of(MEMORY, ['__basicsize__', '__dictoffset__', '__itemsize__', '__weakrefoffset__']),
  __text_signature__: '組み込み関数の __text_signature__（シグネチャのデータ）',
});
registerUnsupportedClassAttributes('builtins.bytearray', of(BUFFER, ['__alloc__', '__release_buffer__']));
registerUnsupportedClassAttributes('builtins.memoryview', of(BUFFER, ['__release_buffer__', '_from_flags']));
registerUnsupportedClassAttributes('array.array', of(BUFFER, ['__release_buffer__']));
registerUnsupportedClassAttributes('builtins.ExceptionGroup', of(WEAKREF_LIST, ['__weakref__']));
registerUnsupportedClassAttributes('builtins.super', { __doc__: BUILTIN_DOC });
registerUnsupportedClassAttributes('functools.partial', of(MEMORY, ['__vectorcalloffset__']));
registerUnsupportedClassAttributes('operator.itemgetter', {
  ...of(MEMORY, ['__vectorcalloffset__']),
  __text_signature__: '組み込み関数の __text_signature__（シグネチャのデータ）',
});
registerUnsupportedClassAttributes('collections.ChainMap', {
  ...of(WEAKREF_LIST, ['__weakref__']),
  ...of(PYTHON_CLASS, ['_abc_impl']),
});
registerUnsupportedClassAttributes('collections.Counter', {
  ...of(WEAKREF_LIST, ['__weakref__']),
  ...of(PYTHON_CLASS, ['__dict__', '__firstlineno__', '__static_attributes__', '_keep_positive']),
});
registerUnsupportedClassAttributes('collections.OrderedDict', of(PYTHON_CLASS, ['__dict__']));
registerUnsupportedClassAttributes(
  'fractions.Fraction',
  of(PYTHON_CLASS, [
    '__abstractmethods__',
    '__firstlineno__',
    '__slots__',
    '__static_attributes__',
    '_abc_impl',
    '_add',
    '_div',
    '_divmod',
    '_floordiv',
    '_format_float_style',
    '_format_general',
    '_from_coprime_ints',
    '_mod',
    '_mul',
    '_operator_fallbacks',
    '_richcmp',
    '_sub',
  ])
);
registerUnsupportedClassAttributes(
  'statistics.NormalDist',
  of(PYTHON_CLASS, ['__firstlineno__', '__setstate__', '__slots__', '__static_attributes__'])
);
for (const stream of ['StringIO', 'BytesIO']) {
  registerUnsupportedClassAttributes(`_io.${stream}`, {
    ...of(FINALIZER, ['__del__']),
    ...of(PYTHON_CLASS, ['__dict__']),
    ...of('ストリームの pickle', ['__setstate__']),
    ...of(INTERNAL, ['_checkClosed', '_checkReadable', '_checkSeekable', '_checkWritable']),
  });
}
for (const lock of ['_thread.lock', '_thread.RLock', 'threading.Condition', 'threading.Event']) {
  registerUnsupportedClassAttributes(lock, of('プロセスの fork', ['_at_fork_reinit']));
}
registerUnsupportedClassAttributes('_thread.RLock', of(INTERNAL, ['_recursion_count']));
registerUnsupportedClassAttributes(
  'threading.Thread',
  of(INTERNAL, [
    '_after_fork',
    '_bootstrap_inner',
    '_context',
    '_delete',
    '_invoke_excepthook',
    '_os_thread_handle',
    '_set_ident',
    '_set_native_id',
    '_set_os_name',
    '_stderr',
  ])
);
registerUnsupportedClassAttributes('typing.TypeVar', {
  ...of(INTERNAL, ['__typing_prepare_subst__', '__typing_subst__']),
  ...of('型引数の遅延評価の関数', ['evaluate_bound', 'evaluate_constraints', 'evaluate_default']),
});
registerUnsupportedClassAttributes(
  'enum.EnumType',
  of('Enum のクラスの特殊メソッドを直接呼ぶこと（len() と [] は使える）', ['__getitem__', '__len__'])
);
registerUnsupportedClassAttributes('typing.Any', {
  ...of(PYTHON_CLASS, ['__firstlineno__', '__static_attributes__']),
  ...of(WEAKREF_LIST, ['__weakref__']),
});
