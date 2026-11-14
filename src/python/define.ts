import { type ArgStyle, bindPythonArgs, checkArgs, pythonSignature } from './nativeArgs';
import { defineMethod, nativeFunction, staticmethodClass, typeClass } from './types';
import { UnsupportedFeatureError } from './unsupported';
import { type Kwargs, type NativeBinding, PyBuiltinFunction, PyClass, PyDescriptor, type PyValue } from './values';

interface Options {
  keywords?: readonly string[];
  /** How many of the first `keywords` name the positional parameters in order. */
  named?: number;
  /** The name in `expected` and `takes` messages, when it differs from the method's name. */
  short?: string;
  binding?: NativeBinding;
  /** The name receiver errors give the declaring class, when CPython declares the method on a C base of it. */
  ownerName?: string;
}

interface BuiltinOptions extends Options {
  owner?: string;
  /** The C module whose name qualifies the function in `one`, `none`, and no-keyword messages. */
  module?: string;
}

const OPERATORS = 'add sub mul matmul truediv floordiv mod divmod pow lshift rshift and xor or';
const SLOT_METHODS = new Set(
  [
    ...OPERATORS.split(' ').flatMap((name) => [`__${name}__`, `__r${name}__`, `__i${name}__`]),
    ...'getattribute getattr setattr delattr repr hash str lt le eq ne gt ge iter next get set delete'.split(' '),
    ...'neg pos abs bool invert int float index len getitem setitem delitem contains'.split(' '),
  ].map((name) => (name.startsWith('__') ? name : `__${name}__`))
);
const VARIADIC_SLOTS = new Set(['__init__', '__call__', '__del__']);
// CPython defines these as methods besides the slot, for speed.
const SLOT_AND_METHOD = new Set([
  'list.__getitem__',
  'dict.__getitem__',
  'dict.__contains__',
  'set.__contains__',
  'frozenset.__contains__',
]);

/** Whether CPython reaches the method through a slot wrapper, which words a wrong call in its own way. */
function isSlotWrapper(qualified: string, name: string, style: ArgStyle, min: number, max: number): boolean {
  const isFixed = min === max || name.endsWith('pow__');
  return style !== 'takes' && isFixed && SLOT_METHODS.has(name) && !SLOT_AND_METHOD.has(qualified);
}

/** Whether the method is a slot wrapper as far as its receiver goes, whatever arguments the slot takes. */
function hasSlot(qualified: string, name: string): boolean {
  return (SLOT_METHODS.has(name) || VARIADIC_SLOTS.has(name)) && !SLOT_AND_METHOD.has(qualified);
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
  const qualified = `${cls.name}.${name}`;
  const spec = {
    qualified,
    short: options.short ?? name,
    min,
    max,
    style: isSlotWrapper(qualified, name, style, min, max) ? ('wrapper' as const) : style,
    keywords: options.keywords,
    named: options.named,
  };
  defineMethod(
    cls,
    name,
    (self, args, kwargs, boundTo) => {
      // A static method receives no instance, so what arrives as `self` is its first argument.
      const all = options.binding !== 'static' ? args : self === undefined ? [] : [self, ...args];
      // A metaclass method read from a class is named after that class, as a builtin bound to a type is in CPython;
      // whether `cls` is a metaclass is asked here, since `type` is still being set up when its methods are defined.
      const named =
        boundTo instanceof PyClass && cls.isSubclassOf(typeClass)
          ? { ...spec, qualified: `${boundTo.qualifiedName}.${name}` }
          : spec;
      checkArgs(named, all, kwargs);
      return run(self, all, kwargs);
    },
    {
      binding: options.binding,
      receiver: hasSlot(qualified, name) ? 'wrapper' : 'method',
      ownerName: options.ownerName,
    }
  );
  // As in CPython, a builtin type's static method is a staticmethod wrapping the function in the type's dictionary.
  const fn = cls.dict.get(name);
  if (options.binding === 'static' && fn) cls.dict.set(name, new PyDescriptor(staticmethodClass, fn));
}

/**
 * Declares on `cls` methods that it inherits from `base` here but declares itself in CPython: each runs as the base's
 * does, but rejects receivers that are not instances of `cls` and names `cls` in that error.
 */
export function redeclareMethods(cls: PyClass, base: PyClass, names: readonly string[]): void {
  for (const name of names) {
    const inherited = base.dict.get(name);
    if (!(inherited instanceof PyBuiltinFunction)) throw new Error(`${base.name}.${name} is not a builtin method`);
    defineMethod(cls, name, (self, args, kwargs) => inherited.run([self, ...args], kwargs), {
      receiver: hasSlot(`${cls.name}.${name}`, name) ? 'wrapper' : 'method',
    });
  }
}

/** Creates a builtin function that checks its argument count as CPython's parser for `style` does. */
export function builtin(
  name: string,
  style: ArgStyle,
  min: number,
  max: number,
  run: (args: PyValue[], kwargs: Kwargs) => PyValue,
  options: BuiltinOptions = {}
): PyBuiltinFunction {
  const spec = {
    qualified: options.module === undefined ? name : `${options.module}.${name}`,
    short: options.short ?? name,
    min,
    max,
    style,
    keywords: options.keywords,
    named: options.named,
  };
  const fn = nativeFunction(
    name,
    (args, kwargs) => {
      checkArgs(spec, args, kwargs);
      return run(args, kwargs);
    },
    options.owner
  );
  fn.module = options.module;
  return fn;
}

/**
 * The `builtin` of the functions of a C module, which CPython's messages qualify with the name the module has in C,
 * such as `math` or `_heapq`.
 */
export function moduleBuiltin(module: string): typeof builtin {
  return (name, style, min, max, run, options) => builtin(name, style, min, max, run, { ...options, module });
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
    { binding, receiver: 'unchecked' }
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

/** Defines a method without arguments that raises the unsupported error for `feature`. */
export function unsupportedMethod(cls: PyClass, name: string, feature: string): void {
  method(cls, name, 'none', 0, 0, () => {
    throw new UnsupportedFeatureError(feature);
  });
}

/** CPython's finalizer, which only its garbage collector should call. */
export const FINALIZER_FEATURE = 'オブジェクトの後始末（__del__）を直接呼ぶこと（__del__）';

/** Defines `__sizeof__` of a type whose objects' sizes CPython counts by fields this grader's objects lack. */
export function unsupportedSizeof(cls: PyClass): void {
  unsupportedMethod(cls, '__sizeof__', `${cls.name} オブジェクトの大きさ（__sizeof__）`);
}
