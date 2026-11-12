import { getItem, setItem } from '../items';
import { callValue, getAttributeOrUndefined, iterate } from '../objects';
import { currentRuntime } from '../runtimeContext';
import { dictClass, newList, typeError, valueError } from '../types';
import { DONE, type Kwargs, PyDict, type PyValue } from '../values';

/** OrderedDict's update, transcribing odictobject.c's mutablemapping_update, which sets each item through `self[key]`. */
export function updateOrderedDict(self: PyValue, args: readonly PyValue[], kwargs: Kwargs | undefined): void {
  if (args.length > 1) throw typeError(`update() takes at most 1 positional argument (${args.length} given)`);
  if (args.length > 0) updateFrom(self, args[0]);
  if (kwargs && kwargs.size > 0)
    addPairs(self, newList([...kwargs].map(([key, value]) => currentRuntime().tuple([key, value]))));
}

function updateFrom(self: PyValue, other: PyValue): void {
  if (other instanceof PyDict && other.cls === dictClass) {
    addPairs(self, newList(other.store.ordered().map((entry) => currentRuntime().tuple([entry.key, entry.value]))));
    return;
  }
  const keys = getAttributeOrUndefined(other, 'keys');
  if (keys !== undefined) {
    const next = iterate(callValue(keys, []));
    for (let key = next(); key !== DONE; key = next()) setItem(self, key, getItem(other, key));
    return;
  }
  const items = getAttributeOrUndefined(other, 'items');
  addPairs(self, items === undefined ? other : callValue(items, []));
}

/** mutablemapping_add_pairs: each pair is unpacked into a key and a value with its own messages. */
function addPairs(self: PyValue, pairs: PyValue): void {
  const next = iterate(pairs);
  for (let pair = next(); pair !== DONE; pair = next()) {
    const nextItem = iterate(pair);
    const key = nextItem();
    if (key === DONE) throw valueError('need more than 0 values to unpack');
    const value = nextItem();
    if (value === DONE) throw valueError('need more than 1 value to unpack');
    if (nextItem() !== DONE) throw valueError('too many values to unpack (expected 2)');
    setItem(self, key, value);
  }
}
