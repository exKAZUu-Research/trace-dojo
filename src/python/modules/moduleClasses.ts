import { typeClass } from '../types';
import { PyClass } from '../values';

/** A builtin class of a standard library module, which reprs and tracebacks name with the module. */
export function builtinClassWithBase(name: string, base: PyClass, module: string, subclassable = true): PyClass {
  const cls = new PyClass(name, [base], typeClass);
  cls.mro = [cls, ...base.mro];
  cls.module = module;
  cls.layout = { ...base.layout };
  cls.isBaseType = subclassable;
  cls.construct = base.construct;
  return cls;
}
