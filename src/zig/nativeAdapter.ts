import assert from 'node:assert/strict';

import type { SourceFile, Span } from './ast';
import type { FunctionInstance } from './functions';
import { parseZig } from './parse';
import { NATIVE_FN_TYPE, NativeFn, type SemaApi } from './semaBase';
import type { Value } from './values';

const files = new WeakMap<NativeFn, { file: SourceFile; implementation: NativeFn }>();

export function callableNative(sema: SemaApi, fn: NativeFn, span: Span): FunctionInstance {
  const signature = fn.signature;
  assert.ok(signature);
  let adapter = files.get(fn);
  if (!adapter) {
    const names = signature.type.params.map((_, index) => `a${index}`);
    const params = names.map((name) => `${name}:anytype`).join(',');
    const source = `fn invoke(${params}) T {return implementation(${names.join(',')});}`;
    const implementation = new NativeFn(fn.name, (sema, call) => {
      const receiver = signature.receiver ? sema.compile(call.args[0]) : undefined;
      return fn.compileCall(sema, { ...call, receiver, args: signature.receiver ? call.args.slice(1) : call.args });
    });
    adapter = { file: parseZig(source), implementation };
    files.set(fn, adapter);
  }
  return sema.libraryFunction(adapter.file, signature.type.returnType, 'invoke', signature.type.params, span, {
    namespaceName: 'std.native',
    members: { implementation: { type: NATIVE_FN_TYPE, value: adapter.implementation as unknown as Value } },
  });
}
