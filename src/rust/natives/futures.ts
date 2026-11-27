import type { BuiltinAdt, FnDef } from '../types';
import { CellPlace, EnumValue, FutureValue, PENDING, StructValue, UNIT_VALUE, type Value } from '../values';
import { call, define, deref, type NativeContext, panic, placeOf } from './support';

const identity = ([value]: Value[]): Value => value;

define({
  'AsyncFuture<_>::poll': pollFuture,
  'Ready<_>::poll': pollFuture,
  'Pending<_>::poll': pollFuture,
  'PollFn<_, _>::poll': pollFuture,
  // A `Box<F>` (or a `Pin<Box<F>>`) is the future it holds, which a pinned reference to it refers to.
  'Box<_>::poll': ([pinned, context], ctx) => pollInner(ctx, pinned, context),
  'Pin<Box<_>>::poll': ([pinned, context], ctx) => pollInner(ctx, pinned, context),
  '&mut Future::poll': ([pinned, context], ctx) => pollInner(ctx, placeOf(pinned).get(), context),
  'Pin<&mut _>::poll': ([pinned, context], ctx) => pollInner(ctx, placeOf(pinned).get(), context),
  'std::future::ready': ([value], ctx) => {
    let taken = false;
    return new FutureValue(() => {
      if (taken) panic(ctx, '`Ready` polled after completion');
      taken = true;
      return value;
    });
  },
  'std::future::pending': () => new FutureValue(() => PENDING),
  'std::future::poll_fn': ([f], ctx) =>
    new FutureValue(
      (context) => {
        const result = deref(call(ctx, f, [context])) as EnumValue;
        return result.variant === 0 ? result.fields[0] : PENDING;
      },
      [f]
    ),
  'Poll<_>::is_ready': ([value]) => (deref(value) as EnumValue).variant === 0,
  'Poll<_>::is_pending': ([value]) => (deref(value) as EnumValue).variant === 1,
  'Poll<_>::map': ([value, f], ctx) => {
    const result = deref(value) as EnumValue;
    return result.variant === 0 ? poll(ctx, call(ctx, f, [result.fields[0]])) : result;
  },
  'Context::from_waker': (_args, ctx) => unitStruct(ctx, 'Context'),
  'Context::waker': (_args, ctx) => new CellPlace(unitStruct(ctx, 'Waker')),
  'Waker::noop': (_args, ctx) => new CellPlace(unitStruct(ctx, 'Waker')),
  'Waker::wake': () => UNIT_VALUE,
  'Waker::wake_by_ref': () => UNIT_VALUE,
  'Waker::will_wake': () => true,
  'Waker::clone': (_args, ctx) => unitStruct(ctx, 'Waker'),
  'Future::into_future': identity,
  'Pin<&mut _>::new': identity,
  'Pin<_>::new_unchecked': identity,
  'Pin<_>::into_inner': identity,
  'Pin<&mut _>::as_mut': ([pinned]) => placeOf(pinned).get(),
  'Pin<&mut _>::get_mut': identity,
  'Pin<&mut _>::set': ([pinned, value]) => {
    placeOf(placeOf(pinned).get()).set(value);
    return UNIT_VALUE;
  },
  'Pin<Box<_>>::as_mut': ([pinned]) => pinned,
  'Box<_>::pin': identity,
  'Box<_>::into_pin': identity,
  'std::pin::pin_value': ([value]) => new CellPlace(value),
});

/** Polls a future the library makes: an `async` block's, or `ready`'s, `pending`'s, or `poll_fn`'s. */
function pollFuture([pinned, context]: Value[], ctx: NativeContext): Value {
  return poll(ctx, (deref(pinned) as FutureValue).poll(context));
}

/** Polls the future of type `F` (the impl's parameter) that `pinned` refers to. */
function pollInner(ctx: NativeContext, pinned: Value, context: Value): Value {
  const pollFn = ctx.interp.program.traitDef('Future').methods.get('poll') as FnDef;
  return ctx.interp.callFn(pollFn, [ctx.typeArgs[0]], [pinned, context], undefined, ctx.span, ctx.frame);
}

function poll(ctx: NativeContext, result: Value | typeof PENDING): Value {
  const def = ctx.interp.program.adtDef('Poll');
  return result === PENDING ? new EnumValue(def, 1, []) : new EnumValue(def, 0, [result]);
}

function unitStruct(ctx: NativeContext, type: BuiltinAdt): StructValue {
  return new StructValue(ctx.interp.program.adtDef(type), [UNIT_VALUE]);
}
