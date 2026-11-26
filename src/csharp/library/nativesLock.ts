import { defineNatives, type NativeCall } from '../natives';
import { CsObject, CsStruct, type Value } from '../values';
import { fail, failOutOfRange, libraryType, nullReference } from './support';

/**
 * `System.Threading.Lock`, which the program's one thread always takes at once; it counts how many times the thread
 * holds it, as the lock is reentrant, so that `IsHeldByCurrentThread` and `Exit` see the count.
 */

const LOCK = 'System.Threading.Lock';

interface LockState {
  heldCount: number;
  references(): Value[];
}

function lockStateOf(receiver: Value): LockState {
  if (receiver === undefined) nullReference();
  const object = receiver as CsObject;
  object.native ??= { heldCount: 0, references: () => [] } satisfies LockState;
  return object.native as LockState;
}

function enter(receiver: Value): boolean {
  lockStateOf(receiver).heldCount++;
  return true;
}

function exit(receiver: Value): void {
  const state = lockStateOf(receiver);
  if (state.heldCount === 0)
    fail('System.Threading.SynchronizationLockException', 'The calling thread does not hold the lock.');
  state.heldCount--;
}

function checkTimeout(call: NativeCall, milliseconds: number, paramName: string): void {
  if (milliseconds < -1)
    failOutOfRange(
      call,
      paramName,
      `${paramName} ('${milliseconds}') must be greater than or equal to '-1'.`,
      String(milliseconds)
    );
}

defineNatives({
  [`${LOCK}..ctor`]: (_call, receiver) => {
    lockStateOf(receiver);
  },
  [`${LOCK}.get_IsHeldByCurrentThread`]: (_call, receiver) => lockStateOf(receiver).heldCount > 0,
  [`${LOCK}.Enter`]: (_call, receiver) => {
    enter(receiver);
  },
  [`${LOCK}.TryEnter()`]: (_call, receiver) => enter(receiver),
  [`${LOCK}.TryEnter(int)`]: (call, receiver, [milliseconds]) => {
    checkTimeout(call, milliseconds as number, 'millisecondsTimeout');
    return enter(receiver);
  },
  [`${LOCK}.TryEnter(TimeSpan)`]: (call, receiver, [timeout]) => {
    const ticks = (timeout as CsStruct).fields[0] as bigint;
    const milliseconds = ticks / 10_000n;
    if (milliseconds < -1n || milliseconds > 2_147_483_647n)
      failOutOfRange(
        call,
        'timeout',
        'The value needs to translate in milliseconds to -1 (signifying an infinite timeout), 0, or a positive integer less than or equal to the maximum allowed timer duration.'
      );
    return enter(receiver);
  },
  [`${LOCK}.Exit`]: (_call, receiver) => {
    exit(receiver);
  },
  [`${LOCK}.EnterScope`]: (call, receiver) => {
    enter(receiver);
    return new CsStruct(libraryType(call, `${LOCK}+Scope`), [receiver]);
  },
  [`${LOCK}+Scope.Dispose`]: (_call, receiver) => {
    const fields = (receiver as CsStruct).fields;
    // .NET's Scope forgets its lock once disposed, so a second Dispose does nothing.
    const held = fields[0];
    if (held instanceof CsObject) {
      fields[0] = undefined;
      exit(held);
    }
  },
});
