export class WeakValueMap<K, V extends object> {
  private readonly entries = new Map<K, WeakRef<V>>();
  private readonly cleanup = new FinalizationRegistry<{ key: K; ref: WeakRef<V> }>(({ key, ref }) => {
    if (this.entries.get(key) === ref) this.entries.delete(key);
  });

  get(key: K): V | undefined {
    return this.entries.get(key)?.deref();
  }

  set(key: K, value: V): void {
    const previous = this.entries.get(key);
    if (previous) this.cleanup.unregister(previous);
    const ref = new WeakRef(value);
    this.entries.set(key, ref);
    this.cleanup.register(value, { key, ref }, ref);
  }
}
