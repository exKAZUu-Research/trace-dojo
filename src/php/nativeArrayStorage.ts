import type { ArrayStorage } from './libArrayObject';

export let nativeArrayStorage: (value: unknown) => value is ArrayStorage = (_value): _value is ArrayStorage => false;

export function setNativeArrayStorage(check: typeof nativeArrayStorage): void {
  nativeArrayStorage = check;
}
