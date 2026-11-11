// The `numbers` module. Its ABCs are classes every run shares, since Fraction, which this grader writes natively,
// derives from Rational; their namespaces, methods included, are the ones CPython's `Lib/numbers.py` gives them, from
// one run of that code, and each run registers the builtin types with them when it imports the module, as that code
// does.
import { sharedPythonClasses } from '../annotations';
import { registerModule } from '../modules';
import type { Runtime } from '../runtime';
import { sharedNamespaceModules } from '../sharedNamespaces';
import { runModuleSource } from '../sourceModules';
import { complexClass, floatClass, intClass, objectClass } from '../types';
import { PyClass, type PyValue } from '../values';
import { abcMetaClass, abcRegister, adoptNamespace, noteSubclass, registerVirtual, sharedAbcValue } from './abc';
import { NUMBERS_SOURCE } from './abcSource';

export { abcMetaClass, registerVirtual };

function abstractClass(name: string, base: PyClass): PyClass {
  const cls = new PyClass(name, [base], abcMetaClass);
  cls.mro = [cls, ...base.mro];
  cls.module = 'numbers';
  cls.isBaseType = true;
  sharedPythonClasses.add(cls);
  return cls;
}

export const numberClass = abstractClass('Number', objectClass);
export const complexAbstractClass = abstractClass('Complex', numberClass);
export const realClass = abstractClass('Real', complexAbstractClass);
export const rationalClass = abstractClass('Rational', realClass);
export const integralClass = abstractClass('Integral', rationalClass);

const CLASSES = [numberClass, complexAbstractClass, realClass, rationalClass, integralClass];

// Native code asks these without a run, as CPython's registrations make them hold.
registerVirtual(complexAbstractClass, complexClass);
registerVirtual(realClass, floatClass);
registerVirtual(integralClass, intClass);

/** The namespace where numbers.py ran for the methods of the ABCs, whose frames, as a library's, stay out of traces. */
const sharedNamespace = new Map<string, PyValue>([['__name__', 'numbers']]);
sharedNamespaceModules.set(sharedNamespace, 'numbers');
let shared = false;

function shareClasses(runtime: Runtime): void {
  runtime.addLibraryNamespace(sharedNamespace);
  if (shared) return;
  shared = true;
  runModuleSource(runtime, sharedNamespace, NUMBERS_SOURCE);
  for (const cls of CLASSES) {
    adoptNamespace(cls, sharedNamespace.get(cls.name) as PyClass);
    sharedNamespace.set(cls.name, cls);
  }
  // The decorator of the run that ran the code gives way to the shared one, which no run owns.
  sharedNamespace.set('abstractmethod', sharedAbcValue('abstractmethod'));
}

registerModule('numbers', (runtime) => {
  shareClasses(runtime);
  // As numbers.py creates the ABCs and registers the builtin types, each with the ABCs created before it.
  noteSubclass(runtime, objectClass, numberClass);
  noteSubclass(runtime, numberClass, complexAbstractClass);
  abcRegister(complexAbstractClass, complexClass, true);
  noteSubclass(runtime, complexAbstractClass, realClass);
  abcRegister(realClass, floatClass, true);
  noteSubclass(runtime, realClass, rationalClass);
  noteSubclass(runtime, rationalClass, integralClass);
  abcRegister(integralClass, intClass, true);
  const abc = runtime.importModule('abc');
  return new Map<string, PyValue>([
    ['__doc__', sharedNamespace.get('__doc__') as PyValue],
    ['ABCMeta', abcMetaClass],
    ['abstractmethod', abc.dict.get('abstractmethod') as PyValue],
    ['__all__', runtime.listOf(CLASSES.map((cls) => cls.name))],
    ...CLASSES.map((cls): [string, PyValue] => [cls.name, cls]),
  ]);
});
