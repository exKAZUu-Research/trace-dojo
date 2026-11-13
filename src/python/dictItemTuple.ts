import type { DictEntry } from './dictStore';
import { currentRuntime } from './runtimeContext';
import { newTuple, None } from './types';
import type { PyTuple, PyValue } from './values';

export class DictItemTuple {
  private readonly tuple = newTuple([None, None]);
  private checking = false;

  constructor() {
    currentRuntime().finalizer.locals.born(this.tuple);
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
        runtime.heldByNative().includes(this.tuple) ||
        (locals.isLocal(this.tuple)
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
