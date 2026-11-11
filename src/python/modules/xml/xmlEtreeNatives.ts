import { builtin } from '../../define';
import { defineNew } from '../../instances';
import { importModule, isRegisteredModule, registerModule, setBuiltinFunctionModule } from '../../modules';
import { callValue, getAttribute } from '../../objects';
import { currentRuntime } from '../../runtimeContext';
import { defineMethod, nativeFunction, None, staticmethodClass } from '../../types';
import { type PyClass, PyDescriptor, PyFunction, PyInstance, type PyModule, type PyValue } from '../../values';

/**
 * The helpers that make the Element type, written in Python here, the C type of CPython's `_elementtree`: builtin
 * methods and functions in place of Python functions, fields outside the instance, and no class body attributes.
 */
export function elementTreeNatives(): Map<string, PyValue> {
  return new Map<string, PyValue>([
    ['_c_type', builtin('_c_type', 'one', 1, 1, ([cls]) => makeCType(cls as PyClass))],
    [
      '_allocate',
      // The instance a C type's tp_alloc creates, which object.__new__ refuses for a builtin type.
      builtin('_allocate', 'one', 1, 1, ([cls]) => {
        currentRuntime().allocate(1);
        return new PyInstance(cls as PyClass);
      }),
    ],
    ['_get_slot', builtin('_get_slot', 'expected', 2, 2, ([self, index]) => fieldsOf(self)[Number(index)] ?? None)],
    [
      '_put_slot',
      builtin('_put_slot', 'expected', 3, 3, ([self, index, value]) => {
        fieldsOf(self)[Number(index)] = value;
        return None;
      }),
    ],
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

function makeCType(cls: PyClass): PyValue {
  for (const [name, attribute] of new Map(cls.dict)) {
    if (attribute instanceof PyFunction) {
      defineMethod(cls, name, (self, args, kwargs) => callValue(attribute, [self, ...args], kwargs));
    } else if (name === '__new__' && attribute instanceof PyDescriptor && attribute.cls === staticmethodClass) {
      defineNew(cls, (subclass, args, kwargs) => callValue(attribute.fn, [subclass, ...args], kwargs));
    }
  }
  // As C's tp_getattro, which CPython's Element defines.
  defineMethod(cls, '__getattribute__', (self, [name]) => getAttribute(self, name as string));
  for (const name of ['__firstlineno__', '__static_attributes__', '__slots__']) cls.dict.delete(name);
  cls.qualifiedName = cls.name;
  cls.isBuiltin = true;
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

/** The fields of each Element, its tag, attrib, text, tail, and children, which C keeps in the object's struct. */
const fields = new WeakMap<object, PyValue[]>();

function fieldsOf(element: PyValue): PyValue[] {
  let found = fields.get(element as object);
  if (!found) fields.set(element as object, (found = []));
  return found;
}
