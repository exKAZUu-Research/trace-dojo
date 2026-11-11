import { builtin } from '../define';
import { registerModule } from '../modules';
import { toIndex } from '../numbers';
import { currentRuntime } from '../runtimeContext';
import { newList, None } from '../types';
import { unavailableValue } from '../unavailableValues';
import type { PyValue } from '../values';
import { runWeakCallbacks } from '../weakReferences';

interface CollectorState {
  enabled: boolean;
  threshold: PyValue[];
  debug: bigint;
}

/**
 * `gc`, whose collector this grader does not have: CPython frees most objects by reference counting and this grader by
 * reachability, so only the collector's settings behave as CPython's do.
 */
registerModule(
  'gc',
  () => {
    const state: CollectorState = { enabled: true, threshold: [2000n, 10n, 10n], debug: 0n };
    return new Map<string, PyValue>([
      [
        'enable',
        builtin('enable', 'none', 0, 0, () => {
          state.enabled = true;
          return None;
        }),
      ],
      [
        'disable',
        builtin('disable', 'none', 0, 0, () => {
          state.enabled = false;
          return None;
        }),
      ],
      ['isenabled', builtin('isenabled', 'none', 0, 0, () => state.enabled)],
      [
        'collect',
        builtin(
          'collect',
          'takes',
          0,
          1,
          () => {
            // The collector frees the objects in reference cycles that nothing reaches, calling their callbacks.
            currentRuntime().finalizer.collect();
            runWeakCallbacks([], true);
            return unavailableValue('gc.collect() が返す、回収したオブジェクトの数');
          },
          { keywords: ['generation'] }
        ),
      ],
      ['get_threshold', builtin('get_threshold', 'none', 0, 0, () => currentRuntime().tuple(state.threshold))],
      [
        'set_threshold',
        builtin('set_threshold', 'expected', 1, 3, (args) => {
          state.threshold = state.threshold.map((value, index) =>
            args[index] === undefined ? value : toIndex(args[index])
          );
          return None;
        }),
      ],
      ['get_debug', builtin('get_debug', 'none', 0, 0, () => state.debug)],
      [
        'set_debug',
        builtin('set_debug', 'one', 1, 1, ([flags]) => {
          state.debug = toIndex(flags);
          return None;
        }),
      ],
      ['garbage', newList([])],
      ['callbacks', newList([])],
      ['DEBUG_STATS', 1n],
      ['DEBUG_COLLECTABLE', 2n],
      ['DEBUG_UNCOLLECTABLE', 4n],
      ['DEBUG_SAVEALL', 32n],
      ['DEBUG_LEAK', 38n],
    ]);
  },
  Object.fromEntries(
    [
      'get_count',
      'get_objects',
      'get_referrers',
      'get_referents',
      'get_stats',
      'is_tracked',
      'is_finalized',
      'freeze',
      'unfreeze',
      'get_freeze_count',
    ].map((name) => [name, `gc.${name}()（CPython のガベージコレクタの内部状態）`])
  )
);
