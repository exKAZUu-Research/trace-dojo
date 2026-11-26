import type { NativeCall } from '../natives';
import { displayType, type MethodSymbol } from '../types';
import type { CsObject, Value, VariableReference } from '../values';
import { callImplementation, evaluatorOf } from './support';

/** The writers and the reader that `Console.SetOut`, `SetError`, and `SetIn` put in place of the console's. */
export interface ConsoleRedirection {
  out?: CsObject;
  error?: CsObject;
  in?: CsObject;
}

const redirections = new WeakMap<object, ConsoleRedirection>();

export function redirectionOf(call: NativeCall): ConsoleRedirection {
  const runtime = call.frame.runtime;
  let redirection = redirections.get(runtime);
  if (!redirection) {
    redirection = {};
    redirections.set(runtime, redirection);
  }
  return redirection;
}

/**
 * Calls the member of a redirected TextWriter or TextReader that a Console method stands for, the one of the same
 * name and parameters, as .NET's Console forwards `WriteLine(x)` to `Out.WriteLine(x)`, so a program's own writer
 * receives the call.
 */
export function forwardTo(
  call: NativeCall,
  target: CsObject,
  typeName: string,
  args: (Value | VariableReference)[]
): Value {
  const wanted = signature(call.method);
  const method = evaluatorOf(call)
    .runtime.library.typeNamed(typeName)
    .methods.find((candidate) => candidate.name === call.method.name && signature(candidate) === wanted);
  if (!method) throw new Error(`${typeName} lacks ${call.method.name}(${wanted})`);
  return callImplementation(call, method, target, args);
}

function signature(method: MethodSymbol): string {
  return method.parameters.map((parameter) => displayType(parameter.type).replaceAll('?', '')).join(', ');
}
