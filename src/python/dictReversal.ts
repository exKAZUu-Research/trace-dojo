import { DictItemTuple, dictItemValue } from './dictItemTuple';
import type { DictEntry } from './dictStore';
import { reduction, withState } from './iteratorStates';
import { checkDictUnchanged, nativeIterator, withRemaining } from './objects';
import { iteratorClass, newList, pyError } from './types';
import { DONE, type PyDict, type PyIterator, type PyValue } from './values';

type DictView = 'keys' | 'values' | 'items';

const ITERATOR_NAMES = { keys: 'key', values: 'value', items: 'item' } as const;

/** `reversed()` of a dict or its view, which reads the entries lazily as CPython's dictreviter does. */
// code-gauge-allow functionCognitiveComplexity 21 -- Reverse traversal, reduction and cached tuple ownership share one state machine.
// code-gauge-allow functionNcss 31 -- Reverse traversal, reduction and cached tuple ownership share one state machine.
export function reversedDictIterator(dict: PyDict, view: DictView): PyIterator {
  const { store } = dict;
  const { size, version } = store;
  const entries = store.reversedLiveEntries();
  let last: DictEntry | undefined;
  let left = size;
  const cached = view === 'items' ? new DictItemTuple() : undefined;
  let state: 'running' | 'failed' | 'done' = 'running';
  const next = withRemaining(
    () => {
      if (state === 'done') return DONE;
      if (state === 'failed') {
        checkDictUnchanged(dict, size, version);
        throw pyError('RuntimeError', 'dictionary changed size during iteration');
      }
      try {
        checkDictUnchanged(dict, size, version);
      } catch (error) {
        state = 'failed';
        throw error;
      }
      const step = entries.next();
      if (step.done) {
        state = 'done';
        return DONE;
      }
      last = step.value;
      left--;
      return cached ? cached.item(step.value) : dictItemValue(step.value, view);
    },
    () => (state === 'running' && store.size === size ? left : 0)
  );
  withState(next, {
    holds: () => [...(state === 'done' ? [] : [dict]), ...(cached?.holds() ?? [])],
    reduce: () => {
      const items: PyValue[] = [];
      for (let entry = store.previous(last); entry && state === 'running'; entry = store.previous(entry)) {
        items.push(dictItemValue(entry, view));
      }
      return reduction('iter', [newList(items.slice(0, left))]);
    },
  });
  return nativeIterator(
    iteratorClass(dict.cls.flags.isOrderedDict ? 'odict_iterator' : `dict_reverse${ITERATOR_NAMES[view]}iterator`),
    next,
    () => [dict]
  );
}
