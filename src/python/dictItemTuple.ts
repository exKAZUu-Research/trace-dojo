import type { DictEntry } from './dictStore';
import { referencesOf } from './garbageCollection';
import { currentRuntime } from './runtimeContext';
import { newTuple, None } from './types';
import { PyDict, PyList, PyObject, PyTuple, type PyValue } from './values';

export class DictItemTuple {
  private readonly tuple = newTuple([None, None]);
  private checking = false;

  constructor() {
    currentRuntime().finalizer.locals.bornItemTuple(this.tuple);
  }

  holds(): PyTuple[] {
    return this.checking ? [] : [this.tuple];
  }

  item(entry: DictEntry): PyTuple {
    const runtime = currentRuntime();
    let shared: boolean;
    this.checking = true;
    try {
      const locals = runtime.finalizer.locals;
      shared =
        runtime.heldByNative().some((root) => directlyHolds(root, this.tuple)) ||
        (locals.canLocateItemTuple(this.tuple)
          ? locals.aliveAmong([this.tuple], runtime.heldByNative()).has(this.tuple)
          : runtime.reachableObjects([], new Set([this.tuple])).has(this.tuple));
    } finally {
      this.checking = false;
    }
    if (shared) return newTuple([entry.key, entry.value]);
    // CPython mutates the iterator's cached tuple only while no Python reference reaches it.
    const items = this.tuple.items as PyValue[];
    const dropped = [...items];
    items[0] = entry.key;
    items[1] = entry.value;
    this.tuple.hash = undefined;
    runtime.finalizer.locals.own(entry.key, this.tuple);
    runtime.finalizer.locals.own(entry.value, this.tuple);
    runtime.finalizer.release(dropped, [this.tuple]);
    return this.tuple;
  }
}

export function dictItemValue(entry: DictEntry, view: 'keys' | 'values' | 'items'): PyValue {
  if (view === 'keys') return entry.key;
  if (view === 'values') return entry.value;
  return newTuple([entry.key, entry.value]);
}

function directlyHolds(root: unknown, tuple: PyTuple): boolean {
  if (root === tuple) return true;
  if (Array.isArray(root)) return root.includes(tuple);
  if (root instanceof PyList || root instanceof PyTuple) return root.items.includes(tuple);
  if (root instanceof PyDict)
    return root.store.liveEntries().some((entry) => entry.key === tuple || entry.value === tuple);
  return root instanceof PyObject && referencesOf(root).includes(tuple);
}
