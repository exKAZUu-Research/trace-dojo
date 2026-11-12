import { abcInvalidationCount, abcMetaClass, initAbstractClass, updateAbstractMethods } from '../abstractClasses';
import { setAttribute } from '../attributes';
import { createDynamicClass } from '../classes';
import { builtin, pythonFunction } from '../define';
import { registerModule, registerModuleValues, registerUnsupportedAttributes } from '../modules';
import { classmethodClass, None, propertyClass, staticmethodClass } from '../types';
import { PyClass, PyDescriptor, PyFunction, type PyValue } from '../values';

registerModule('abc', () => {
  const abcClass = createDynamicClass('ABC', [], new Map(), 'abc');
  initAbstractClass(abcClass, abcMetaClass);
  return new Map<string, PyValue>([
    ['ABC', abcClass],
    ['ABCMeta', abcMetaClass],
    ['abstractmethod', pythonFunction('abstractmethod', 'funcobj', ([fn]) => markAbstract(fn))],
    [
      'abstractclassmethod',
      builtin('abstractclassmethod', 'one', 1, 1, ([fn]) => new PyDescriptor(classmethodClass, markAbstract(fn))),
    ],
    [
      'abstractstaticmethod',
      builtin('abstractstaticmethod', 'one', 1, 1, ([fn]) => new PyDescriptor(staticmethodClass, markAbstract(fn))),
    ],
    [
      'abstractproperty',
      pythonFunction('abstractproperty', 'fget=None, fset=None, fdel=None, doc=None', abstractProperty),
    ],
    [
      'update_abstractmethods',
      pythonFunction('update_abstractmethods', 'cls', ([cls]) => {
        if (cls instanceof PyClass) updateAbstractMethods(cls);
        return cls;
      }),
    ],
    ['get_cache_token', builtin('get_cache_token', 'none', 0, 0, () => BigInt(abcInvalidationCount()))],
  ]);
});
registerModuleValues('abc', '', undefined);
registerUnsupportedAttributes('abc', {
  __builtins__: 'モジュールの __builtins__（組み込みの名前空間そのもの）',
  __cached__: 'モジュールの __cached__（ファイルのパス）',
  __doc__: 'モジュールの説明文（__doc__）',
  __file__: 'モジュールの __file__（ファイルのパス）',
  __loader__: 'モジュールの __loader__（import の仕組み）',
  __spec__: 'モジュールの __spec__（import の仕組み）',
});

function markAbstract(fn: PyValue): PyValue {
  setAttribute(fn, '__isabstractmethod__', true);
  return fn;
}

/** A property whose getter is marked abstract, which makes the property abstract as `abc.abstractproperty` is. */
function abstractProperty([fget, fset, fdel, doc]: PyValue[]): PyValue {
  if (fget instanceof PyFunction) markAbstract(fget);
  return new PyDescriptor(propertyClass, fget ?? None, fset ?? None, fdel ?? None, doc ?? None);
}
