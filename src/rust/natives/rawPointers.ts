import { pointee } from '../compilerPlaces';
import { copyValue } from '../ops';
import { ElementPlace, RawPtr, sliceLength, UNIT_VALUE } from '../values';
import { define, deref, type NativeContext, none, panic, some } from './support';

function pointer(value: unknown): RawPtr {
  return deref(value as never) as RawPtr;
}

/** A pointer `count` elements after (or before) where one points into an array. */
function moved(value: unknown, count: number, ctx: NativeContext): RawPtr {
  const { place } = pointer(value);
  if (!(place instanceof ElementPlace)) {
    if (count === 0) return pointer(value);
    return panic(ctx, '配列の要素を指さないポインタは、ずらせません。');
  }
  const index = place.index + count;
  if (index < 0 || index > place.array.length) {
    return panic(ctx, 'ポインタが配列の外を指しました（未定義の動作です）。');
  }
  return new RawPtr(new ElementPlace(place.array, index));
}

define({
  'ConstPtr<_>::add': ([p, n], ctx) => moved(p, Number(n as bigint), ctx),
  'MutPtr<_>::add': ([p, n], ctx) => moved(p, Number(n as bigint), ctx),
  'ConstPtr<_>::sub': ([p, n], ctx) => moved(p, -Number(n as bigint), ctx),
  'MutPtr<_>::sub': ([p, n], ctx) => moved(p, -Number(n as bigint), ctx),
  'ConstPtr<_>::offset': ([p, n], ctx) => moved(p, Number(n as bigint), ctx),
  'MutPtr<_>::offset': ([p, n], ctx) => moved(p, Number(n as bigint), ctx),
  'ConstPtr<[_]>::len': ([p], ctx) => BigInt(sliceLength(pointee(pointer(p), ctx.span).get())),
  'MutPtr<[_]>::len': ([p], ctx) => BigInt(sliceLength(pointee(pointer(p), ctx.span).get())),
  'ConstPtr<[_]>::is_empty': ([p], ctx) => sliceLength(pointee(pointer(p), ctx.span).get()) === 0,
  'MutPtr<[_]>::is_empty': ([p], ctx) => sliceLength(pointee(pointer(p), ctx.span).get()) === 0,
  'std::ptr::null': () => new RawPtr(undefined),
  'std::ptr::null_mut': () => new RawPtr(undefined),
  'std::ptr::eq': ([a, b]) => samePlace(pointer(a), pointer(b)),
  'ConstPtr<_>::is_null': ([p]) => !pointer(p).place,
  'MutPtr<_>::is_null': ([p]) => !pointer(p).place,
  'ConstPtr<_>::read': ([p], ctx) => copyValue(pointee(pointer(p), ctx.span).get()),
  'MutPtr<_>::read': ([p], ctx) => copyValue(pointee(pointer(p), ctx.span).get()),
  'MutPtr<_>::write': ([p, value], ctx) => {
    pointee(pointer(p), ctx.span).set(value);
    return UNIT_VALUE;
  },
  'ConstPtr<_>::as_ref': ([p], ctx) => {
    const { place } = pointer(p);
    return place ? some(ctx, place.get()) : none(ctx);
  },
  'MutPtr<_>::as_ref': ([p], ctx) => {
    const { place } = pointer(p);
    return place ? some(ctx, place.get()) : none(ctx);
  },
  'MutPtr<_>::as_mut': ([p], ctx) => {
    const { place } = pointer(p);
    return place ? some(ctx, place) : none(ctx);
  },
});

/** Whether two pointers point to the same place: the same variable, element, or field, or both nowhere. */
export function samePlace(a: RawPtr, b: RawPtr): boolean {
  if (a === b || a.place === b.place) return true;
  if (!a.place || !b.place || a.distinct || b.distinct) return false;
  const x = a.place as unknown as Record<string, unknown>;
  const y = b.place as unknown as Record<string, unknown>;
  if (x.constructor !== y.constructor) return false;
  const keys = Object.keys(x);
  return keys.length > 0 && keys.every((key) => x[key] === y[key]);
}
