import type { DictEntry } from './dictStore';
import { currentRuntime } from './runtimeContext';
import { iteratorClass, pyError } from './types';
import { DONE, type PyDict, PyIterator, type PyValue } from './values';

type DictView = 'keys' | 'values' | 'items';

const ITERATOR_NAMES = { keys: 'key', values: 'value', items: 'item' } as const;

/** `reversed()` of a dict or its view, which reads the entries lazily as CPython's dictreviter does. */
export function reversedDictIterator(dict: PyDict, view: DictView): PyIterator {
  const { store } = dict;
  const size = store.size;
  const entries = store.reversedLiveEntries();
  let left = size;
  let isExhausted = false;
  const iterator = new PyIterator(
    iteratorClass(dict.cls.flags.isOrderedDict ? 'odict_iterator' : `dict_reverse${ITERATOR_NAMES[view]}iterator`),
    () => {
      if (isExhausted) return DONE;
      if (store.size !== size) throw pyError('RuntimeError', 'dictionary changed size during iteration');
      const next = entries.next();
      if (next.done) {
        isExhausted = true;
        return DONE;
      }
      left--;
      return viewItem(next.value, view);
    },
    () => [dict]
  );
  iterator.lengthHint = () => (isExhausted || store.size !== size ? 0 : left);
  return iterator;
}

function viewItem(entry: DictEntry, view: DictView): PyValue {
  if (view === 'keys') return entry.key;
  if (view === 'values') return entry.value;
  return currentRuntime().tuple([entry.key, entry.value]);
}
