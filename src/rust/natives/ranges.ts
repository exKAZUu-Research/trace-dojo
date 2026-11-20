import type { RangeValue, Value } from '../values';
import { deref, libraryPanic, type NativeContext } from './support';

export function checkedRangeBounds(ctx: NativeContext, range: Value, length: number): [number, number] {
  const bounds = deref(range) as RangeValue | undefined;
  const size = BigInt(length);
  const last = bounds?.end as bigint | undefined;
  const inclusive = bounds?.inclusive === true;
  const end = last === undefined ? size : last + (inclusive ? 1n : 0n);
  if (end > size) {
    libraryPanic(
      ctx,
      `range end index ${last} out of range for slice of length ${length}`,
      `core/src/slice/index.rs:${inclusive ? '1005:52' : '1009:51'}`
    );
  }
  const start = inclusive && bounds?.exhausted ? end : ((bounds?.start as bigint | undefined) ?? 0n);
  if (start > size) {
    libraryPanic(
      ctx,
      `range start index ${start} out of range for slice of length ${length}`,
      'core/src/slice/index.rs:1020:55'
    );
  }
  if (start > end) {
    libraryPanic(ctx, `slice index starts at ${start} but ends at ${end}`, 'core/src/slice/index.rs:1020:55');
  }
  return [Number(start), Number(end)];
}
