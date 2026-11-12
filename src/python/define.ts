import { type ArgStyle, bindPythonArgs, checkArgs, pythonSignature } from './nativeArgs';
import { defineMethod, nativeFunction } from './types';
import type { Kwargs, NativeBinding, PyBuiltinFunction, PyClass, PyValue } from './values';

interface Options {
  keywords?: readonly string[];
  /** How many of the first `keywords` name the positional parameters in order. */
  named?: number;
  /** The name in `expected` and `takes` messages, when it differs from the method's name. */
  short?: string;
  binding?: NativeBinding;
}

/** Defines a builtin method that checks its argument count as CPython's parser for `style` does. */
// code-gauge-allow functionParameterCount 7 -- Mirrors the positional parameters of builtin, adding the owner class.
export function method(
  cls: PyClass,
  name: string,
  style: ArgStyle,
  min: number,
  max: number,
  run: (self: PyValue, args: PyValue[], kwargs: Kwargs) => PyValue,
  options: Options = {}
): void {
  const spec = {
    qualified: `${cls.name}.${name}`,
    short: options.short ?? name,
    min,
    max,
    style,
    keywords: options.keywords,
    named: options.named,
  };
  defineMethod(
    cls,
    name,
    (self, args, kwargs) => {
      // A static method receives no instance, so what arrives as `self` is its first argument.
      const all = options.binding === 'static' ? [self, ...args] : args;
      checkArgs(spec, all, kwargs);
      return run(self, all, kwargs);
    },
    options.binding
  );
}

/** Creates a builtin function that checks its argument count as CPython's parser for `style` does. */
export function builtin(
  name: string,
  style: ArgStyle,
  min: number,
  max: number,
  run: (args: PyValue[], kwargs: Kwargs) => PyValue,
  options: Options & { owner?: string } = {}
): PyBuiltinFunction {
  const spec = {
    qualified: name,
    short: options.short ?? name,
    min,
    max,
    style,
    keywords: options.keywords,
    named: options.named,
  };
  return nativeFunction(
    name,
    (args, kwargs) => {
      checkArgs(spec, args, kwargs);
      return run(args, kwargs);
    },
    options.owner
  );
}

/**
 * Defines a method that CPython's library writes in Python, with the parameters after `self` as its `def` declares
 * them: it reports a wrong call as that `def` does, and `run` receives the arguments `bindPythonArgs` returns.
 */
export function pythonMethod(
  cls: PyClass,
  name: string,
  parameters: string,
  run: (self: PyValue, args: PyValue[], kwargs: Kwargs) => PyValue,
  binding?: NativeBinding
): void {
  const signature = pythonSignature(`${cls.name}.${name}`, `${binding === 'class' ? 'cls' : 'self'}, ${parameters}`);
  defineMethod(
    cls,
    name,
    // Called through the class without an instance, the method lacks `self` as the `def` would.
    (self, args, kwargs) =>
      run(self, bindPythonArgs(signature, self === undefined ? [] : [self, ...args], kwargs).slice(1), kwargs),
    binding
  );
}

/** Creates a function that CPython's library writes in Python, as `pythonMethod` defines a method. */
export function pythonFunction(
  name: string,
  parameters: string,
  run: (args: PyValue[], kwargs: Kwargs) => PyValue,
  owner?: string
): PyBuiltinFunction {
  const signature = pythonSignature(name, parameters);
  return nativeFunction(name, (args, kwargs) => run(bindPythonArgs(signature, args, kwargs), kwargs), owner);
}
