import { type ArgStyle, checkArgs } from './nativeArgs';
import { defineMethod, nativeFunction } from './types';
import type { Kwargs, NativeBinding, PyBuiltinFunction, PyClass, PyValue } from './values';

interface Options {
  keywords?: readonly string[];
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
  const spec = { qualified: name, short: options.short ?? name, min, max, style, keywords: options.keywords };
  return nativeFunction(
    name,
    (args, kwargs) => {
      checkArgs(spec, args, kwargs);
      return run(args, kwargs);
    },
    options.owner
  );
}
