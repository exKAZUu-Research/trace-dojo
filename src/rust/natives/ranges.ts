import { intMax } from '../types';
import { EnumValue, type RangeEndpoint, RangeValue, type Value } from '../values';
import { deref, libraryPanic, type NativeContext } from './support';

export function boundsOf(range: Value): { start?: RangeEndpoint; end?: RangeEndpoint } {
  const value = deref(range);
  if (value instanceof RangeValue) {
    return {
      start: value.start === undefined ? undefined : { key: value.start, included: true },
      end: value.end === undefined ? undefined : { key: value.end, included: value.inclusive && !value.exhausted },
    };
  }
  if (!Array.isArray(value) || value.length !== 2) return {};
  return { start: boundEndpoint(value[0]), end: boundEndpoint(value[1]) };
}

export function numericBounds(range: Value, length: bigint): [bigint, bigint] {
  const value = deref(range);
  if (value instanceof RangeValue) return [value.sliceStart() ?? 0n, value.sliceEnd() ?? length];
  const { start, end } = boundsOf(value);
  return [edgeOffset(start, false, 0n), edgeOffset(end, true, length)];
}

export function checkedRangeBounds(ctx: NativeContext, range: Value, length: number): [number, number] {
  const value = deref(range);
  const bounds = value instanceof RangeValue ? value : undefined;
  const size = BigInt(length);
  const { start: beginning, end: endpoint } = boundsOf(value);
  const last = endpoint?.key;
  const inclusive = bounds?.inclusive ?? endpoint?.included ?? false;
  const [start, end] = numericBounds(value, size);
  if (start > intMax('usize')) {
    libraryPanic(
      ctx,
      `range start index ${beginning?.key} out of range for slice of length ${length}`,
      'core/src/slice/index.rs:1016:56'
    );
  }
  if (end > size) {
    libraryPanic(
      ctx,
      `range end index ${last} out of range for slice of length ${length}`,
      `core/src/slice/index.rs:${inclusive ? '1005:52' : '1009:51'}`
    );
  }
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

function boundEndpoint(value: Value): RangeEndpoint | undefined {
  const bound = deref(value);
  if (!(bound instanceof EnumValue) || bound.def.builtin !== 'Bound' || bound.variant === 2) return;
  return { key: bound.fields[0], included: bound.variant === 0 };
}

function edgeOffset(bound: RangeEndpoint | undefined, end: boolean, fallback: bigint): bigint {
  return bound ? (bound.key as bigint) + (bound.included === end ? 1n : 0n) : fallback;
}
