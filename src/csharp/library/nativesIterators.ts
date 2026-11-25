import type { IteratorState } from '../iterators';
import { defineNatives } from '../natives';
import { CsObject } from '../values';
import { evaluatorOf, fail } from './support';

function stateOf(receiver: unknown): IteratorState {
  return (receiver as CsObject).native as IteratorState;
}

defineNatives({
  // An enumerable hands itself out the first time, as the compiler's iterators do on their own thread, and a fresh
  // run of the method's body after that.
  'System.Linq.Internal.YieldIterator`1.GetEnumerator': (_call, receiver) => {
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
  },
  'System.Linq.Internal.YieldIterator`1.MoveNext': (call, receiver) =>
    evaluatorOf(call).moveIterator(stateOf(receiver)),
  'System.Linq.Internal.YieldIterator`1.get_Current': (_call, receiver) => stateOf(receiver).current,
  'System.Linq.Internal.YieldIterator`1.Reset': () =>
    fail('System.NotSupportedException', 'Specified method is not supported.'),
  'System.Linq.Internal.YieldIterator`1.Dispose': (call, receiver) => {
    evaluatorOf(call).disposeIterator(stateOf(receiver));
  },
});
