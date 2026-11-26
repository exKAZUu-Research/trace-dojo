import type { IteratorState } from '../iterators';
import { defineNatives, type NativeCall } from '../natives';
import { taskObject, type TaskState } from '../tasks';
import type { Type } from '../types';
import { CsObject, CsStruct, type Value } from '../values';
import { passEnumeratorToken } from './nativesAsyncStreams';
import { evaluatorOf, fail, libraryType } from './support';

function stateOf(receiver: unknown): IteratorState {
  return (receiver as CsObject).native as IteratorState;
}

/**
 * The enumerator of an iterator's enumerable: the enumerable itself the first time, as the compiler's iterators hand
 * themselves out on their own thread, and a fresh run of the method's body after that.
 */
function enumeratorOf(receiver: unknown): CsObject {
  const state = stateOf(receiver);
  if (!state.isTaken && state.status === 'before') {
    state.isTaken = true;
    return receiver as CsObject;
  }
  const fresh = new CsObject((receiver as CsObject).type, []);
  const run = (state.restart as () => IteratorState)();
  run.isTaken = true;
  fresh.native = run;
  return fresh;
}

defineNatives({
  'System.Linq.Internal.YieldIterator`1.GetEnumerator': (_call, receiver) => enumeratorOf(receiver),
  'System.Linq.Internal.YieldIterator`1.MoveNext': (call, receiver) =>
    evaluatorOf(call).moveIterator(stateOf(receiver)),
  'System.Linq.Internal.YieldIterator`1.get_Current': (_call, receiver) => stateOf(receiver).current,
  'System.Linq.Internal.YieldIterator`1.Reset': () =>
    fail('System.NotSupportedException', 'Specified method is not supported.'),
  'System.Linq.Internal.YieldIterator`1.Dispose': (call, receiver) => {
    evaluatorOf(call).disposeIterator(stateOf(receiver));
  },
});

function valueTaskOf(call: NativeCall, state: TaskState, resultType?: Type): CsStruct {
  const taskType = resultType
    ? libraryType(call, 'System.Threading.Tasks.Task', [resultType])
    : libraryType(call, 'System.Threading.Tasks.Task');
  const valueTaskType = resultType
    ? libraryType(call, 'System.Threading.Tasks.ValueTask', [resultType])
    : libraryType(call, 'System.Threading.Tasks.ValueTask');
  return new CsStruct(valueTaskType, [taskObject(taskType, state)]);
}

defineNatives({
  'System.Linq.Internal.YieldAsyncIterator`1.GetAsyncEnumerator': (call, receiver, [token]) => {
    const enumerator = enumeratorOf(receiver);
    passEnumeratorToken(call, stateOf(enumerator), token as Value);
    return enumerator;
  },
  'System.Linq.Internal.YieldAsyncIterator`1.get_Current': (_call, receiver) => stateOf(receiver).current,
  'System.Linq.Internal.YieldAsyncIterator`1.MoveNextAsync': (call, receiver) =>
    valueTaskOf(call, evaluatorOf(call).moveNextAsync(stateOf(receiver)), libraryType(call, 'System.Boolean')),
  'System.Linq.Internal.YieldAsyncIterator`1.DisposeAsync': (call, receiver) =>
    valueTaskOf(call, evaluatorOf(call).disposeAsyncIterator(stateOf(receiver))),
});
