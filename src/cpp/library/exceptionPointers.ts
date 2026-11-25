import { CppException, CppRuntimeError } from '../errors';
import type { Frame } from '../runtime';
import { endException } from '../statementCompiler';
import { type FunctionInfo, pointerTo, VOID } from '../types';
import type { Ptr } from '../values';
import { NULL_PTR } from '../values';
import { native } from './support';

/** The natives of `std::exception_ptr`, which count the references to the exception objects it shares. */
export function exceptionPointerFunctions(): Map<string, FunctionInfo[]> {
  const voidPointer = pointerTo(VOID);
  return new Map([
    [
      '__builtin_current_exception',
      [
        native('__builtin_current_exception', [], voidPointer, (_, { frame }) => {
          const exception = frame.runtime.handling.at(-1);
          if (!exception) return NULL_PTR;
          const location = exception.location();
          frame.runtime.sharedExceptions.set(location.store as object, exception);
          exception.references++;
          return location;
        }),
      ],
    ],
    [
      '__builtin_exception_retain',
      [
        native('__builtin_exception_retain', [voidPointer], VOID, ([address], { frame }) => {
          const exception = sharedException(frame, address);
          if (exception) exception.references++;
        }),
      ],
    ],
    [
      '__builtin_exception_release',
      [
        native('__builtin_exception_release', [voidPointer], VOID, ([address], { frame }) => {
          const exception = sharedException(frame, address);
          if (!exception) return;
          exception.references--;
          if (exception.references === 0) {
            frame.runtime.sharedExceptions.delete((address as Ptr).store as object);
            endException(frame, exception);
          }
        }),
      ],
    ],
    [
      '__builtin_rethrow_exception',
      [
        native('__builtin_rethrow_exception', [voidPointer], VOID, ([address], { frame }) => {
          const exception = sharedException(frame, address);
          if (!exception) throw new CppRuntimeError('custom', '空の std::exception_ptr の例外は投げ直せません。');
          return frame.runtime.throwException(frame, exception);
        }),
      ],
    ],
  ]);
}

function sharedException(frame: Frame, address: unknown): CppException | undefined {
  const pointer = address as Ptr;
  if (pointer.isNull) return undefined;
  const exception = frame.runtime.sharedExceptions.get(pointer.store as object);
  return exception instanceof CppException ? exception : undefined;
}
