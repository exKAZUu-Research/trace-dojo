import { CppRuntimeError } from './errors';
import type { Frame } from './runtime';
import { CHAR, sizeOf, type Type, typeName } from './types';
import { ArrayStore, Ptr, type Value } from './values';

/** An argument of the `...` of a C variadic function, with its type after the default argument promotions. */
export interface VariadicArgument {
  value: Value;
  type: Type;
}

/** The `va_list` that `va_start` makes in a variadic function's frame: a pointer to its first variadic argument. */
export function startVariadicArguments(frame: Frame): Ptr {
  const args = (frame.variadicArguments ?? []) as unknown as Value[];
  return new Ptr(new ArrayStore([...args], CHAR), 0);
}

/** The variadic arguments a `va_list` has left, for `vprintf` and the functions like it. */
export function remainingArguments(list: Ptr): unknown[] {
  const store = list.store;
  if (!(store instanceof ArrayStore)) throw new CppRuntimeError('custom', 'va_start していない va_list を使いました。');
  return store.values.slice(list.index);
}

/**
 * `va_arg(ap, T)`: the next variadic argument, which must have been passed as a `T` (or as an integer type of the same
 * size, a pointer, or a `double`), and the `va_list` moved past it.
 */
export function nextVariadicArgument(list: Ptr, type: Type): { value: Value; next: Ptr } {
  const store = list.store;
  if (!(store instanceof ArrayStore)) throw new CppRuntimeError('custom', 'va_start していない va_list を使いました。');
  const argument = store.values[list.index] as unknown as VariadicArgument | undefined;
  if (!argument) throw new CppRuntimeError('custom', 'va_arg で、渡された数より多くの可変長引数を取り出しました。');
  if (!passesAs(argument.type, type))
    throw new CppRuntimeError(
      'custom',
      `va_arg で取り出す型（${typeName(type)}）が、可変長引数として渡した値の型（${typeName(argument.type)}）と合いません。`
    );
  return { value: argument.value, next: list.offset(1) };
}

function passesAs(passed: Type, read: Type): boolean {
  if (passed.kind === 'int' && read.kind === 'int') return sizeOf(passed) === sizeOf(read);
  if (passed.kind === 'float' && read.kind === 'float') return passed.name === read.name;
  return (passed.kind === 'pointer' || passed.kind === 'nullptr') && read.kind === 'pointer';
}
