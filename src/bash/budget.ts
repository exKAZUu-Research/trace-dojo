import { ExecutionLimitError, LIMITS } from '../interpreter/limits';
import type { OutputTarget } from './runtime';

export type StepMeter = () => void;
export type CostMeter = (cost?: number) => void;

/** Appends `addition` to `current` after charging operations and enforcing `LIMITS.maxStringLength`. */
export function appendMetered(current: string, addition: string, spend: CostMeter): string {
  if (addition.length === 0) return current;
  spend(Math.ceil(addition.length / 256));
  if (current.length + addition.length > LIMITS.maxStringLength) throw new ExecutionLimitError('storage');
  return current + addition;
}

/** Joins `items` with `separator` through `appendMetered`. */
export function joinMetered(items: readonly string[], separator: string, spend: CostMeter): string {
  let text = '';
  for (const [index, item] of items.entries()) {
    if (index > 0) text = appendMetered(text, separator, spend);
    text = appendMetered(text, item, spend);
  }
  return text;
}

/** Appends one item to an in-memory word or operand list while enforcing `LIMITS.maxSlots`. */
export function pushMeteredItem<T>(items: T[], item: T, spend: StepMeter, maxItems = LIMITS.maxSlots): void {
  spend();
  items.push(item);
  if (items.length > maxItems) throw new ExecutionLimitError('storage');
}

/** Charges string storage cost and enforces `LIMITS.maxStringLength` before a store cell write commits. */
export function chargeStoreString(value: string, spend: CostMeter): void {
  spend(Math.max(1, Math.ceil(value.length / 256)));
  if (value.length > LIMITS.maxStringLength) throw new ExecutionLimitError('storage');
}

/** Advances allocated store slots and enforces `LIMITS.maxSlots`. */
export function chargeStoreSlots(currentSlots: number, added: number): number {
  const next = currentSlots + added;
  if (next > LIMITS.maxSlots) throw new ExecutionLimitError('storage');
  return next;
}

/** Charges operations and slot budget when eagerly copying `entryCount` slots into a child subshell store. */
export function chargeStoreCopy(entryCount: number, spend: CostMeter, allocateSlots: (count: number) => void): void {
  const count = Math.max(1, entryCount);
  spend(count);
  allocateSlots(entryCount);
}

/** Creates a metered output sink for `$(...)` and `` `...` `` command substitutions. */
export function createCaptureBuffer(spend: CostMeter): { readonly target: OutputTarget; readonly read: () => string } {
  let text = '';
  return {
    target: {
      write: (chunk) => {
        text = appendMetered(text, chunk, spend);
      },
    },
    read: () => text,
  };
}
