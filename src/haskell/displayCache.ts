import type { DisplayNode } from '../problems/trace';
import type { Runtime } from './runtime';
import type { Type } from './types';
import type { Slot, Value } from './values';

export interface CachedDisplay {
  node: DisplayNode;
  slots: readonly Slot[];
  dependencies: readonly CachedDisplay[];
  pending: boolean;
}

type TypedDisplays = WeakMap<Type, Map<string, CachedDisplay>>;
const caches = new WeakMap<Runtime, DisplayCache>();
const negativeZero = Symbol();

export function displayCacheFor(runtime: Runtime): DisplayCache {
  let cache = caches.get(runtime);
  if (!cache) {
    cache = new DisplayCache();
    caches.set(runtime, cache);
  }
  return cache;
}

class DisplayCache {
  private readonly objects = new WeakMap<object, TypedDisplays>();
  private readonly primitives = new Map<Value | symbol, TypedDisplays>();

  get(value: Value, type: Type, key: string): CachedDisplay | undefined {
    return this.typesFor(value, false)?.get(type)?.get(key);
  }

  set(value: Value, type: Type, key: string, display: CachedDisplay): void {
    const types = this.typesFor(value, true)!;
    let views = types.get(type);
    if (!views) {
      views = new Map();
      types.set(type, views);
    }
    views.set(key, display);
  }

  private typesFor(value: Value, create: boolean): TypedDisplays | undefined {
    const key = Object.is(value, -0) ? negativeZero : value;
    let types = typeof key === 'object' ? this.objects.get(key) : this.primitives.get(key);
    if (!types && create) {
      types = new WeakMap();
      if (typeof key === 'object') this.objects.set(key, types);
      else this.primitives.set(key, types);
    }
    return types;
  }
}
