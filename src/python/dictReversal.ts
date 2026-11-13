import type { DictEntry } from './dictStore';
import { reduction, withState } from './iteratorStates';
import { checkDictUnchanged, withRemaining } from './objects';
import { iteratorClass, newList, newTuple, pyError } from './types';
import { DONE, type PyDict, PyIterator, type PyValue } from './values';

type DictView = 'keys' | 'values' | 'items';

const ITERATOR_NAMES = { keys: 'key', values: 'value', items: 'item' } as const;

/** `reversed()` of a dict or its view, which reads the entries lazily as CPython's dictreviter does. */
export function reversedDictIterator(dict: PyDict, view: DictView): PyIterator {
  const { store } = dict;
  const { size, version } = store;
  const entries = store.reversedLiveEntries();
  let last: DictEntry | undefined;
  let left = size;
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
      return viewItem(step.value, view);
    },
    () => (state === 'running' && store.size === size ? left : 0)
  );
  withState(next, {
    reduce: () => {
      const items: PyValue[] = [];
      for (let entry = store.previous(last); entry && state === 'running'; entry = store.previous(entry)) {
        items.push(viewItem(entry, view));
      }
      return reduction('iter', [newList(items.slice(0, left))]);
    },
  });
  return new PyIterator(
    iteratorClass(dict.cls.flags.isOrderedDict ? 'odict_iterator' : `dict_reverse${ITERATOR_NAMES[view]}iterator`),
    next,
    () => [dict]
  );
}

function viewItem(entry: DictEntry, view: DictView): PyValue {
  if (view === 'keys') return entry.key;
  if (view === 'values') return entry.value;
  return newTuple([entry.key, entry.value]);
}
