import { builtinFunctionModule, registerModuleAlias, setBuiltinFunctionModule } from '../modules';
import { callValue, toArray } from '../objects';
import type { Runtime } from '../runtime';
import { registerSourceModule } from '../sourceModules';
import { nativeFunction, newTuple, None } from '../types';
import { PyBuiltinFunction, PyClass, type PyValue } from '../values';
import { cInt, clinicArgs } from './clinicArgs';
import { defaultdictClass, dequeClass } from './collections';
import { COMPAT_PICKLE_SOURCE } from './compatPickleSource';
import { decimalClass } from './decimal';
import { fractionClass } from './fractions';
import { partialClass } from './functools';
import { PICKLE_SOURCE } from './pickleSource';

registerSourceModule('_compat_pickle', COMPAT_PICKLE_SOURCE);
// The C module whose functions and classes `pickle` exports, which pickles of them name.
registerModuleAlias('_pickle', 'pickle');

const strings = (value: PyValue): string[] => toArray(value) as string[];

/** The C types CPython creates from specs, whose `__module__` each type holds as a str object of its own. */
const HEAP_C_TYPES: ReadonlySet<PyClass> = new Set([dequeClass, defaultdictClass, decimalClass, partialClass]);
/** The classes this interpreter writes natively but CPython in Python, whose names are interned str objects. */
const PYTHON_CLASSES: ReadonlySet<PyClass> = new Set([fractionClass]);
let freshNames = 0n;
const fresh = (): PyValue => newTuple(['fresh', freshNames++]);

/**
 * Which str objects CPython's pickler saves for a global's module and name, as keys of the pickler's memo: None for the
 * interned str, which this interpreter's equal str values stand for. The qualified name of a C type or builtin function
 * is a new str each time; the module name of the builtins module's functions, and of a heap C type, is a str of its own.
 */
function globalKeys(runtime: Runtime, obj: PyValue): PyValue[] {
  if (obj instanceof PyBuiltinFunction) {
    return [builtinFunctionModule(runtime, obj) === 'builtins' ? newTuple(['builtin functions']) : None, fresh()];
  }
  if (obj instanceof PyClass && obj.isBuiltin && !PYTHON_CLASSES.has(obj)) {
    return [HEAP_C_TYPES.has(obj) ? newTuple(['type module', runtime.idOf(obj)]) : None, fresh()];
  }
  return [None, None];
}

registerSourceModule('pickle', PICKLE_SOURCE, (runtime) => {
  return new Map<string, PyValue>([
    [
      // Wraps a function written in Python in the argument parsing of the C function it stands for.
      '_clinic',
      nativeFunction('_clinic', ([name, params, positionalOnly, required, keywordOnly, fn]) => {
        const spec = {
          name: name as string,
          params: strings(params),
          positionalOnly: cInt(positionalOnly, 0),
          required: cInt(required, 0),
          keywordOnly: strings(keywordOnly),
        };
        const wrapper = nativeFunction(spec.name, (args, kwargs) => {
          const bound = clinicArgs(spec, args, kwargs);
          const names = [...spec.params, ...spec.keywordOnly];
          const keywords = new Map<string, PyValue>();
          for (const [index, value] of bound.entries()) {
            if (value !== undefined && index >= spec.positionalOnly) keywords.set(names[index], value);
          }
          return callValue(fn, bound.slice(0, spec.positionalOnly) as PyValue[], keywords);
        });
        setBuiltinFunctionModule(wrapper, '_pickle');
        return wrapper;
      }),
    ],
    ['_global_keys', nativeFunction('_global_keys', ([obj]) => newTuple(globalKeys(runtime, obj)))],
  ]);
});
