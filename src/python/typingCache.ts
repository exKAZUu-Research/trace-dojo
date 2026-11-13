import { DictStore } from './dictStore';
import { pyHash } from './hashing';
import { registerRootSource } from './hostRoots';
import type { Runtime } from './runtime';
import { currentRuntime } from './runtimeContext';
import { classOf, newTuple } from './types';
import { PyError, type PyValue } from './values';

const caches = new WeakMap<Runtime, Map<string, DictStore>>();
registerRootSource((runtime) =>
  [...(caches.get(runtime)?.values() ?? [])].flatMap((store) =>
    [...store.liveEntries()].flatMap(({ key, value }) => [key, value])
  )
);

export function cachedTyping(
  group: string,
  owner: PyValue,
  key: PyValue,
  create: () => PyValue,
  typed = false
): PyValue {
  const cacheKey = newTuple(typed ? [owner, key, classOf(key)] : [owner, key]);
  let hash: bigint;
  try {
    hash = pyHash(cacheKey);
  } catch (error) {
    if (!(error instanceof PyError) || error.exception.cls.name !== 'TypeError') throw error;
    return create();
  }
  const runtime = currentRuntime();
  let groups = caches.get(runtime);
  if (!groups) caches.set(runtime, (groups = new Map()));
  let store = groups.get(group);
  if (!store) groups.set(group, (store = new DictStore(true)));
  const found = store.lookup(cacheKey, hash);
  if (found) {
    store.moveToEnd(found, true);
    return found.value;
  }
  const value = create();
  store.set(cacheKey, value, hash);
  if (store.size > 128) {
    const oldest = store.first();
    if (oldest) {
      store.remove(oldest);
      runtime.finalizer.release([oldest.key, oldest.value], [value]);
    }
  }
  return value;
}
