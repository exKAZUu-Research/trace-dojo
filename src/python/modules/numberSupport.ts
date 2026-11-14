import { builtinClass, propertyClass, typeError } from '../types';
import {
  type Kwargs,
  type NativeBinding,
  PyBuiltinFunction,
  type PyClass,
  PyDescriptor,
  type PyValue,
} from '../values';

/**
 * The class of the methods defined here. Unlike `method_descriptor`, whose `__hash__` and `__format__` the
 * interpreter replaces with its native implementations, the hashing and formatting of values call these methods.
 */
const slotMethodClass = builtinClass('wrapper_descriptor');
const getterClass = builtinClass('getter');

/** The parameters of a method written in Python, whose argument errors name `qualified`. */
export interface PythonSignature {
  qualified: string;
  /** The parameter names after `self`. */
  params: readonly string[];
  /** How many of `params` have no default. */
  required: number;
  /** Whether the parameters can only be passed by position. */
  positionalOnly?: boolean;
  /** Whether this is a function rather than a method, whose counts in messages include no `self`. */
  isFunction?: boolean;
}

/** Defines a method that checks its arguments as a Python function with `signature` does. */
export function pythonMethod(
  cls: PyClass,
  signature: Omit<PythonSignature, 'qualified'>,
  name: string,
  run: (self: PyValue, args: (PyValue | undefined)[]) => PyValue,
  binding: NativeBinding = 'method'
): void {
  const full = { ...signature, qualified: `${cls.name}.${name}` };
  defineSlot(cls, name, (self, args, kwargs) => run(self, bindArguments(full, args, kwargs)), binding);
}

/** Defines a method whose arguments the caller checks, which hashing and formatting call. */
export function defineSlot(
  cls: PyClass,
  name: string,
  run: (self: PyValue, args: PyValue[], kwargs: Kwargs) => PyValue,
  binding: NativeBinding = 'method'
): void {
  cls.dict.set(
    name,
    new PyBuiltinFunction(
      slotMethodClass,
      name,
      (args, kwargs) => run(args[0], args.slice(1), kwargs),
      undefined,
      binding,
      cls.name
    )
  );
}

/** Defines a read-only property. */
export function defineProperty(cls: PyClass, name: string, get: (self: PyValue) => PyValue): void {
  cls.dict.set(name, new PyDescriptor(propertyClass, new PyBuiltinFunction(getterClass, name, ([self]) => get(self))));
}

/** Matches arguments to parameters as a call of a Python function does, raising its TypeErrors. */
// code-gauge-allow functionCognitiveComplexity 16 -- Follows how CPython binds arguments to the parameters of a Python function.
export function bindArguments(signature: PythonSignature, args: PyValue[], kwargs: Kwargs): (PyValue | undefined)[] {
  const { qualified, params, required } = signature;
  if (args.length > params.length) throw tooManyPositional(signature, args.length);
  const bound: (PyValue | undefined)[] = [...args];
  for (const [key, value] of kwargs ?? []) {
    const index = signature.positionalOnly ? -1 : params.indexOf(key);
    if (index === -1) throw typeError(`${qualified}() got an unexpected keyword argument '${key}'`);
    if (index < args.length) throw typeError(`${qualified}() got multiple values for argument '${key}'`);
    bound[index] = value;
  }
  const missing = params.slice(0, required).filter((_, index) => bound[index] === undefined);
  if (missing.length > 0) {
    const names = missing.map((name) => `'${name}'`);
    const listed =
      names.length === 1
        ? names[0]
        : names.length === 2
          ? names.join(' and ')
          : `${names.slice(0, -1).join(', ')}, and ${names.at(-1)}`;
    throw typeError(
      `${qualified}() missing ${missing.length} required positional argument${missing.length === 1 ? '' : 's'}: ${listed}`
    );
  }
  return bound;
}

function tooManyPositional({ qualified, params, required, isFunction }: PythonSignature, given: number): Error {
  const self = isFunction ? 0 : 1;
  const most = params.length + self;
  const least = required + self;
  const takes = least === most ? `${most}` : `from ${least} to ${most}`;
  const plural = least === most && most === 1 ? 'argument' : 'arguments';
  const count = given + self;
  return typeError(
    `${qualified}() takes ${takes} positional ${plural} but ${count} ${count === 1 ? 'was' : 'were'} given`
  );
}
