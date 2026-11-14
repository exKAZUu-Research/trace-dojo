import type { SpecialCall } from '../expressionCompiler';
import type { NativeFunction } from '../runtime';
import { VOID } from '../types';

/** `va_start(ap, last)`: points `ap` at the extra arguments of the variadic function running it. */
export const vaStartCall: SpecialCall = (compiler, call) => {
  const { row, args } = call;
  if (args.length !== 2) compiler.error(row, 'va_start には、va_list の変数と、最後の名前付きの引数を書いてください。');
  const fn = compiler.currentFunction;
  if (!fn?.type.variadic) return compiler.error(row, 'va_start は、可変長引数の関数（...）の中でしか使えません。');
  const last = args[1];
  const lastParam = fn.params.at(-1);
  if (last.kind !== 'identifier' || last.name !== lastParam?.name) {
    compiler.error(row, 'va_start の2つ目には、関数の最後の名前付きの引数を書いてください。');
  }
  const list = compiler.vaList(args[0], row, 'va_start');
  return {
    type: VOID,
    value: (frame) => {
      list.resolve(frame).store(frame.varargs);
      return 0;
    },
    isCall: true,
  };
};

export type { NativeFunction };
