import { defineSlot } from './modules/numberSupport';
import type { PyClass, PyValue } from './values';

/** Defines `__hash__` from the instance's value, as a slot that `pyHash` calls instead of hashing by identity. */
export function defineValueHash(cls: PyClass, hash: (self: PyValue) => bigint): void {
  defineSlot(cls, '__hash__', (self) => hash(self));
}
