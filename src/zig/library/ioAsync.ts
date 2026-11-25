import type { Expression, Span } from '../ast';
import { runtime, type SemaApi, type TExpr } from '../semaBase';
import { errorSetOf, errorUnionOf, pointerTo, type StructType, type Type, typeName, USIZE, VOID } from '../types';
import { type Pointer, ZStruct } from '../values';
import { IO_TYPE, receiverMethod } from './files';
import { addMembers, compileArgs, expectArgs, fnMember, type Member, nativeStruct, receiverAddress } from './native';

// Asynchronous calls --------------------------------------------------------------------------------------------------

const futures = new Map<Type, StructType>();

/** `std.Io.Future(T)`, which holds the result of a call that `io.async` ran to its end when it started. */
export function futureType(result: Type): StructType {
  let future = futures.get(result);
  if (future) return future;
  future = nativeStruct(`Io.Future(${typeName(result)})`, {}, [{ name: 'result', type: result, hasDefault: false }]);
  const self = future;
  const take = (name: string): (() => Member) =>
    receiverMethod(
      `Future.${name}`,
      pointerTo(self, false),
      (sema, call) => receiverAddress(sema, call, self),
      () => [IO_TYPE()],
      result,
      (_, target) => ((target as Pointer).load() as ZStruct).slots[0]
    );
  addMembers(future, { await: take('await'), cancel: take('cancel') });
  futures.set(result, future);
  return future;
}

/**
 * The call `@call(.auto, function, args)`, which `io.async` and the like run to its end when they start, so that
 * what runs asynchronously runs in the order it starts.
 */
export function startedCall(sema: SemaApi, functionArg: Expression, argsArg: Expression, span: Span): TExpr {
  const at = { row: span.row, col: span.col, endRow: span.endRow };
  return sema.compile({
    kind: 'builtinCall',
    ...at,
    name: '@call',
    args: [{ kind: 'enumLiteral', ...at, name: 'auto' }, functionArg, argsArg],
  });
}

/** `io.async(function, args)` and `io.concurrent(function, args)`. */
export function asyncMember(name: 'async' | 'concurrent'): () => Member {
  return fnMember(`Io.${name}`, (sema, call) => {
    const [functionArg, argsArg] = expectArgs(sema, call, 2, name);
    const result = startedCall(sema, functionArg, argsArg, call.span);
    const future = futureType(result.type);
    const receiver = call.receiver;
    const evaluateIo = receiver?.eval;
    const evaluate = result.eval;
    const type = name === 'async' ? future : errorUnionOf(errorSetOf(['ConcurrencyUnavailable']), future);
    return runtime(
      type,
      (frame) => {
        evaluateIo?.(frame);
        return new ZStruct([evaluate(frame)]);
      },
      call.span
    );
  });
}

/** `std.Io.Group`, whose tasks `async` runs to their end when they start. */
export const GROUP: StructType = nativeStruct('Io.Group', {}, [{ name: 'state', type: USIZE, hasDefault: false }]);

addMembers(GROUP, {
  init: () => ({ type: GROUP, value: new ZStruct([0n]) }),
  async: groupStart('async'),
  concurrent: groupStart('concurrent'),
  await: groupFinish('await', errorUnionOf(errorSetOf(['Canceled']), VOID)),
  cancel: groupFinish('cancel', VOID),
});

function groupStart(name: 'async' | 'concurrent'): () => Member {
  return fnMember(`Group.${name}`, (sema, call) => {
    const pointer = receiverAddress(sema, call, GROUP);
    const [ioArg, functionArg, argsArg] = expectArgs(sema, call, 3, name);
    const [io] = compileArgs(sema, [ioArg], [IO_TYPE()]);
    const result = startedCall(sema, functionArg, argsArg, call.span);
    const evaluators = [pointer, io, result].map((arg) => arg.eval);
    const type = name === 'async' ? VOID : errorUnionOf(errorSetOf(['ConcurrencyUnavailable']), VOID);
    // A group's task may return only `error.Canceled`, which the group drops.
    if (result.type.kind !== 'void' && !(result.type.kind === 'error_union' && result.type.payload.kind === 'void'))
      sema.error(call.span, `Group.${name} の関数は、void か error{Canceled}!void を返してください。`);
    return runtime(
      type,
      (frame) => {
        for (const evaluate of evaluators) evaluate(frame);
        return;
      },
      call.span
    );
  });
}

function groupFinish(name: string, result: Type): () => Member {
  return receiverMethod(
    `Group.${name}`,
    pointerTo(GROUP, false),
    (sema, call) => receiverAddress(sema, call, GROUP),
    () => [IO_TYPE()],
    result,
    () => {}
  );
}
