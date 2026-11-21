import type { TypeRef } from './ast';
import type { Frame } from './runtime';
import type { ClassSymbol, FunctionSymbol, PropertySymbol } from './symbols';
import type { Value } from './values';

/**
 * A function of the standard library implemented in TypeScript. Its receiver and arguments come as the function
 * declares them, unboxed where it declares a primitive type. A function with reified type parameters also gets their
 * types, after its arguments.
 */
export type NativeFunction = (frame: Frame, receiver: Value, args: Value[]) => Value;

export interface NativeProperty {
  get: (frame: Frame, receiver: Value) => Value;
  set?: (frame: Frame, receiver: Value, value: Value) => void;
}

/** What a native needs from the declarations it implements. */
export interface NativeBinding {
  function?: FunctionSymbol;
  property?: PropertySymbol;
  cls?: ClassSymbol;
}

/** Writes a type as the prelude's source writes it, which names the natives that take it. */
export function typeRefText(ref: TypeRef): string {
  if (ref.kind === 'function') {
    const receiver = ref.receiver ? `${typeRefText(ref.receiver)}.` : '';
    const text = `${receiver}(${ref.params.map(typeRefText).join(', ')}) -> ${typeRefText(ref.returnType)}`;
    return ref.nullable ? `(${text})?` : text;
  }
  const parts = ref.parts.map((part) => {
    if (part.args.length === 0) return part.name;
    const args = part.args.map((argument) => {
      if (argument.star) return '*';
      return `${argument.variance ? `${argument.variance} ` : ''}${typeRefText(argument.type)}`;
    });
    return `${part.name}<${args.join(', ')}>`;
  });
  return `${parts.join('.')}${ref.nullable ? '?' : ''}`;
}
