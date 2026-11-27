import { normalize } from '../infer';
import { cloneValue, copyValue } from '../ops';
import { shallow, type Type } from '../types';
import { BorrowGuard, CellBox, CellPlace, type Place, SharedBox, UNIT_VALUE, type Value, WeakRef } from '../values';
import { defaultValue } from './core';
import { call, define, deref, err, type NativeContext, none, ok, panic, placeOf, some } from './support';

/** `Rc` and `Weak`, `RefCell` and its guards, and `Cell`, whose values share or guard what they hold. */

function shared(value: Value): SharedBox {
  return deref(value) as SharedBox;
}

function cell(value: Value): CellBox {
  return deref(value) as CellBox;
}

function elemType(ctx: NativeContext): Type {
  return ctx.typeArgs[0];
}

/** A new guard of a `RefCell`'s value, which goes at the end of the statement unless a variable keeps it. */
function borrowCell(ctx: NativeContext, target: CellBox, mutable: boolean): BorrowGuard {
  if (mutable ? target.borrows !== 0 : target.borrows < 0) {
    panic(ctx, mutable ? 'RefCell already borrowed' : 'RefCell already mutably borrowed');
  }
  target.borrows = mutable ? -1 : target.borrows + 1;
  const guard = new BorrowGuard(target, mutable);
  ctx.runtime.liveGuards.push(guard);
  return guard;
}

function requireUnborrowed(ctx: NativeContext, target: CellBox): void {
  if (target.borrows !== 0) panic(ctx, 'RefCell already borrowed');
}

function dropValue(ctx: NativeContext, value: Value, type: Type): void {
  ctx.interp.dropper.drop(value, type);
}

define({
  'Rc<_>::new': ([value], ctx) => {
    ctx.interp.dropper.activate();
    return new SharedBox(value);
  },
  'Rc<_>::strong_count': ([rc]) => BigInt(shared(rc).strong),
  'Rc<_>::weak_count': ([rc]) => BigInt(shared(rc).weak),
  'Rc<_>::downgrade': ([rc]) => {
    const box = shared(rc);
    box.weak++;
    return new WeakRef(box);
  },
  'Rc<_>::ptr_eq': ([a, b]) => shared(a) === shared(b),
  'Rc<_>::as_ref': ([rc]) => shared(rc).value,
  'Rc<_>::try_unwrap': ([rc], ctx) => {
    const box = shared(rc);
    if (box.strong !== 1) return err(ctx, box);
    box.strong = 0;
    return ok(ctx, box.value);
  },
  'Rc<_>::into_inner': ([rc], ctx) => {
    const box = shared(rc);
    box.strong--;
    return box.strong === 0 ? some(ctx, box.value) : none(ctx);
  },
  'Rc<_>::unwrap_or_clone': ([rc], ctx) => {
    const box = shared(rc);
    if (box.strong === 1) {
      box.strong = 0;
      return box.value;
    }
    box.strong--;
    return cloneValue(elemType(ctx), box.value);
  },
  'Rc<_>::get_mut': ([rc], ctx) => {
    const box = shared(rc);
    return box.strong === 1 && box.weak === 0 ? some(ctx, valuePlace(box)) : none(ctx);
  },
  'Rc<_>::make_mut': ([rc], ctx) => {
    const place = placeOf(rc);
    let box = shared(place);
    if (box.strong !== 1) {
      box.strong--;
      box = new SharedBox(cloneValue(elemType(ctx), box.value));
      place.set(box);
    } else if (box.weak > 0) {
      // The only `Rc` with `Weak`s left moves the value to an allocation of its own, which the `Weak`s lose.
      box.strong = 0;
      box = new SharedBox(box.value);
      place.set(box);
    }
    return valuePlace(box);
  },
  'Weak<_>::new': () => new WeakRef(undefined),
  'Weak<_>::upgrade': ([weak], ctx) => {
    const { box } = deref(weak) as WeakRef;
    if (!box || box.strong === 0) return none(ctx);
    box.strong++;
    return some(ctx, box);
  },
  'Weak<_>::strong_count': ([weak]) => BigInt((deref(weak) as WeakRef).box?.strong ?? 0),
  'Weak<_>::weak_count': ([weak]) => {
    const { box } = deref(weak) as WeakRef;
    return BigInt(box && box.strong > 0 ? box.weak : 0);
  },
  'Weak<_>::ptr_eq': ([a, b]) => (deref(a) as WeakRef).box === (deref(b) as WeakRef).box,
  'RefCell<_>::new': ([value], ctx) => {
    ctx.interp.dropper.activate();
    return new CellBox(value);
  },
  'RefCell<_>::borrow': ([self], ctx) => borrowCell(ctx, cell(self), false),
  'RefCell<_>::borrow_mut': ([self], ctx) => borrowCell(ctx, cell(self), true),
  'RefCell<_>::replace': ([self, value], ctx) => {
    const target = cell(self);
    requireUnborrowed(ctx, target);
    const old = target.value;
    target.value = value;
    return old;
  },
  'RefCell<_>::replace_with': ([self, f], ctx) => {
    const target = cell(self);
    requireUnborrowed(ctx, target);
    target.borrows = -1;
    let replacement: Value;
    try {
      replacement = call(ctx, f, [new CellPlace(target.value)]);
    } finally {
      target.borrows = 0;
    }
    const old = target.value;
    target.value = replacement;
    return old;
  },
  'RefCell<_>::take': ([self], ctx) => {
    const target = cell(self);
    requireUnborrowed(ctx, target);
    const old = target.value;
    target.value = defaultValue(ctx, elemType(ctx));
    return old;
  },
  'RefCell<_>::into_inner': ([self]) => cell(self).value,
  'RefCell<_>::get_mut': ([self]) => cellPlace(cell(self)),
  'RefCell<_>::swap': ([self, other], ctx) => {
    const a = cell(self);
    const b = cell(other);
    requireUnborrowed(ctx, a);
    requireUnborrowed(ctx, b);
    [a.value, b.value] = [b.value, a.value];
    return UNIT_VALUE;
  },
  'Ref<_>::clone': ([guard], ctx) => borrowCell(ctx, (deref(guard) as BorrowGuard).cell, false),
  'Cell<_>::new': ([value]) => new CellBox(value),
  'Cell<_>::get': ([self]) => copyValue(cell(self).value),
  'Cell<_>::set': ([self, value], ctx) => {
    const target = cell(self);
    const old = target.value;
    target.value = value;
    dropValue(ctx, old, elemType(ctx));
    return UNIT_VALUE;
  },
  'Cell<_>::replace': ([self, value]) => {
    const target = cell(self);
    const old = target.value;
    target.value = value;
    return old;
  },
  'Cell<_>::take': ([self], ctx) => {
    const target = cell(self);
    const old = target.value;
    target.value = defaultValue(ctx, elemType(ctx));
    return old;
  },
  'Cell<_>::into_inner': ([self]) => cell(self).value,
  'Cell<_>::get_mut': ([self]) => cellPlace(cell(self)),
  'Cell<_>::swap': ([self, other]) => {
    const a = cell(self);
    const b = cell(other);
    [a.value, b.value] = [b.value, a.value];
    return UNIT_VALUE;
  },
  'Cell<_>::update': ([self, f], ctx) => {
    const target = cell(self);
    target.value = call(ctx, f, [copyValue(target.value)]);
    return UNIT_VALUE;
  },
  // `*` and autoderef of `Rc` and of `RefCell`'s guards, which reach what they point to.
  'Deref::deref': ([self], ctx) => {
    const target = deref(self);
    if (target instanceof SharedBox) return target.value;
    if (target instanceof BorrowGuard) return target.cell.value;
    return panic(ctx, `${describe(ctx.typeArgs[0])} は * でたどれません。`);
  },
  'DerefMut::deref_mut': ([self], ctx) => {
    const target = deref(self);
    if (target instanceof BorrowGuard && target.mutable) return target.place();
    return panic(ctx, `${describe(ctx.typeArgs[0])} は * で書き換えられません。`);
  },
});

function valuePlace(box: SharedBox): Place {
  return {
    isPlace: true,
    get: () => box.value,
    set: (value) => {
      box.value = value;
    },
  };
}

function cellPlace(target: CellBox): Place {
  return {
    isPlace: true,
    get: () => target.value,
    set: (value) => {
      target.value = value;
    },
  };
}

function describe(type: Type): string {
  const t = normalize(shallow(type));
  return t.kind === 'adt' ? t.def.name : t.kind;
}
