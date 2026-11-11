import { makeCType } from '../../cTypes';
import { builtin } from '../../define';
import { importModule, isRegisteredModule, registerModule, setBuiltinFunctionModule } from '../../modules';
import { callValue, getAttribute } from '../../objects';
import { currentRuntime } from '../../runtimeContext';
import { defineMethod, nativeFunction, None } from '../../types';
import type { PyClass, PyFunction, PyModule, PyValue } from '../../values';

/**
 * The helpers that make the Element type and functions, written in Python here, those of CPython's C accelerator
 * `_elementtree`.
 */
export function elementTreeNatives(): Map<string, PyValue> {
  return new Map<string, PyValue>([
    ['_c_type', builtin('_c_type', 'one', 1, 1, ([cls]) => makeElementType(cls as PyClass))],
    [
      '_c_function',
      builtin('_c_function', 'one', 1, 1, ([fn]) => {
        const name = (fn as PyFunction).name;
        const native = nativeFunction(name, (args, kwargs) => callValue(fn, args, kwargs));
        setBuiltinFunctionModule(native, '_elementtree');
        acceleratorModule().dict.set(name, native);
        return native;
      }),
    ],
  ]);
}

function makeElementType(cls: PyClass): PyValue {
  makeCType(cls);
  // As C's tp_getattro, which CPython's Element defines.
  defineMethod(cls, '__getattribute__', (self, [name]) => getAttribute(self, name as string));
  acceleratorModule().dict.set(cls.name, cls);
  return None;
}

/**
 * CPython's `_elementtree`, which holds the objects the module written in Python here makes as its C ones, and
 * fails for the others.
 */
function acceleratorModule(): PyModule {
  if (!isRegisteredModule('_elementtree')) registerModule('_elementtree', () => new Map());
  const module = importModule(currentRuntime(), '_elementtree');
  module.partialFeature = 'モジュール _elementtree のほかの名前';
  return module;
}
