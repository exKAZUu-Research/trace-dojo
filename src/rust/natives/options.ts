import { DEFAULT_SPEC } from '../fmt';
import { cloneValue, copyValue } from '../ops';
import type { Type } from '../types';
import { ElementPlace, type EnumValue, type Value } from '../values';
import { defaultValue } from './core';
import { arrayIter } from './iterators';
import { call, define, deref, err, type NativeContext, none, ok, panic, placeOf, some } from './support';

function opt(value: Value): EnumValue {
  return deref(value) as EnumValue;
}

function isSome(value: Value): boolean {
  return opt(value).variant === 1;
}

function isOk(value: Value): boolean {
  return opt(value).variant === 0;
}

function debugText(ctx: NativeContext, value: Value, type: Type): string {
  return ctx.interp.formatter.debug(value, type, DEFAULT_SPEC, undefined);
}

const optionNatives: Record<string, (args: Value[], ctx: NativeContext) => Value> = {
  is_some: ([self]) => isSome(self),
  is_none: ([self]) => !isSome(self),
  is_some_and: ([self, f], ctx) => isSome(self) && (deref(call(ctx, f, [opt(self).fields[0]])) as boolean),
  is_none_or: ([self, f], ctx) => !isSome(self) || (deref(call(ctx, f, [opt(self).fields[0]])) as boolean),
  unwrap: ([self], ctx) => {
    if (!isSome(self)) panic(ctx, 'called `Option::unwrap()` on a `None` value');
    return opt(self).fields[0];
  },
  expect: ([self, msg], ctx) => {
    if (!isSome(self)) panic(ctx, deref(msg) as string);
    return opt(self).fields[0];
  },
  unwrap_or: ([self, fallback]) => (isSome(self) ? opt(self).fields[0] : fallback),
  unwrap_or_else: ([self, f], ctx) => (isSome(self) ? opt(self).fields[0] : call(ctx, f, [])),
  unwrap_or_default: ([self], ctx) => (isSome(self) ? opt(self).fields[0] : defaultValue(ctx, ctx.typeArgs[0])),
  map: ([self, f], ctx) => (isSome(self) ? some(ctx, call(ctx, f, [opt(self).fields[0]])) : none(ctx)),
  map_or: ([self, fallback, f], ctx) => (isSome(self) ? call(ctx, f, [opt(self).fields[0]]) : fallback),
  map_or_else: ([self, fallback, f], ctx) =>
    isSome(self) ? call(ctx, f, [opt(self).fields[0]]) : call(ctx, fallback, []),
  inspect: ([self, f], ctx) => {
    if (isSome(self)) call(ctx, f, [opt(self).fields[0]]);
    return self;
  },
  and_then: ([self, f], ctx) => (isSome(self) ? call(ctx, f, [opt(self).fields[0]]) : none(ctx)),
  and: ([self, other], ctx) => (isSome(self) ? other : none(ctx)),
  or: ([self, other]) => (isSome(self) ? self : other),
  or_else: ([self, f], ctx) => (isSome(self) ? self : call(ctx, f, [])),
  xor: ([self, other], ctx) => {
    if (isSome(self) && !isSome(other)) return self;
    if (!isSome(self) && isSome(other)) return other;
    return none(ctx);
  },
  filter: ([self, f], ctx) =>
    isSome(self) && (deref(call(ctx, f, [opt(self).fields[0]])) as boolean) ? self : none(ctx),
  ok_or: ([self, error], ctx) => (isSome(self) ? ok(ctx, opt(self).fields[0]) : err(ctx, error)),
  ok_or_else: ([self, f], ctx) => (isSome(self) ? ok(ctx, opt(self).fields[0]) : err(ctx, call(ctx, f, []))),
  take: ([self], ctx) => {
    const place = placeOf(self);
    const value = place.get();
    place.set(none(ctx));
    return value;
  },
  replace: ([self, value], ctx) => {
    const place = placeOf(self);
    const old = place.get();
    place.set(some(ctx, value));
    return old;
  },
  insert: ([self, value], ctx) => {
    const place = placeOf(self);
    const created = some(ctx, value) as EnumValue;
    place.set(created);
    return new ElementPlace(created.fields, 0);
  },
  get_or_insert: ([self, value], ctx) => {
    const place = placeOf(self);
    if (!isSome(place.get())) place.set(some(ctx, value));
    return new ElementPlace((place.get() as EnumValue).fields, 0);
  },
  get_or_insert_with: ([self, f], ctx) => {
    const place = placeOf(self);
    if (!isSome(place.get())) place.set(some(ctx, call(ctx, f, [])));
    return new ElementPlace((place.get() as EnumValue).fields, 0);
  },
  as_ref: ([self], ctx) => (isSome(self) ? some(ctx, opt(self).fields[0]) : none(ctx)),
  as_mut: ([self], ctx) => (isSome(self) ? some(ctx, new ElementPlace(opt(self).fields, 0)) : none(ctx)),
  iter: ([self]) => arrayIter(isSome(self) ? [opt(self).fields[0]] : []),
  into_iter: ([self]) => arrayIter(isSome(self) ? [opt(self).fields[0]] : []),
  zip: ([self, other], ctx) =>
    isSome(self) && isSome(other) ? some(ctx, [opt(self).fields[0], opt(other).fields[0]]) : none(ctx),
};

const resultNatives: Record<string, (args: Value[], ctx: NativeContext) => Value> = {
  is_ok: ([self]) => isOk(self),
  is_err: ([self]) => !isOk(self),
  is_ok_and: ([self, f], ctx) => isOk(self) && (deref(call(ctx, f, [opt(self).fields[0]])) as boolean),
  is_err_and: ([self, f], ctx) => !isOk(self) && (deref(call(ctx, f, [opt(self).fields[0]])) as boolean),
  unwrap: ([self], ctx) => {
    if (!isOk(self)) {
      panic(
        ctx,
        `called \`Result::unwrap()\` on an \`Err\` value: ${debugText(ctx, opt(self).fields[0], ctx.typeArgs[1])}`
      );
    }
    return opt(self).fields[0];
  },
  expect: ([self, msg], ctx) => {
    if (!isOk(self)) panic(ctx, `${deref(msg) as string}: ${debugText(ctx, opt(self).fields[0], ctx.typeArgs[1])}`);
    return opt(self).fields[0];
  },
  unwrap_err: ([self], ctx) => {
    if (isOk(self)) {
      panic(
        ctx,
        `called \`Result::unwrap_err()\` on an \`Ok\` value: ${debugText(ctx, opt(self).fields[0], ctx.typeArgs[0])}`
      );
    }
    return opt(self).fields[0];
  },
  expect_err: ([self, msg], ctx) => {
    if (isOk(self)) panic(ctx, `${deref(msg) as string}: ${debugText(ctx, opt(self).fields[0], ctx.typeArgs[0])}`);
    return opt(self).fields[0];
  },
  unwrap_or: ([self, fallback]) => (isOk(self) ? opt(self).fields[0] : fallback),
  unwrap_or_else: ([self, f], ctx) => (isOk(self) ? opt(self).fields[0] : call(ctx, f, [opt(self).fields[0]])),
  unwrap_or_default: ([self], ctx) => (isOk(self) ? opt(self).fields[0] : defaultValue(ctx, ctx.typeArgs[0])),
  map: ([self, f], ctx) => (isOk(self) ? ok(ctx, call(ctx, f, [opt(self).fields[0]])) : self),
  map_or: ([self, fallback, f], ctx) => (isOk(self) ? call(ctx, f, [opt(self).fields[0]]) : fallback),
  map_err: ([self, f], ctx) => (isOk(self) ? self : err(ctx, call(ctx, f, [opt(self).fields[0]]))),
  inspect: ([self, f], ctx) => {
    if (isOk(self)) call(ctx, f, [opt(self).fields[0]]);
    return self;
  },
  and_then: ([self, f], ctx) => (isOk(self) ? call(ctx, f, [opt(self).fields[0]]) : self),
  and: ([self, other]) => (isOk(self) ? other : self),
  or: ([self, other]) => (isOk(self) ? self : other),
  or_else: ([self, f], ctx) => (isOk(self) ? self : call(ctx, f, [opt(self).fields[0]])),
  ok: ([self], ctx) => (isOk(self) ? some(ctx, opt(self).fields[0]) : none(ctx)),
  err: ([self], ctx) => (isOk(self) ? none(ctx) : some(ctx, opt(self).fields[0])),
  as_ref: ([self], ctx) => (isOk(self) ? ok(ctx, opt(self).fields[0]) : err(ctx, opt(self).fields[0])),
  as_mut: ([self], ctx) => {
    const place = new ElementPlace(opt(self).fields, 0);
    return isOk(self) ? ok(ctx, place) : err(ctx, place);
  },
  iter: ([self]) => arrayIter(isOk(self) ? [opt(self).fields[0]] : []),
  into_iter: ([self]) => arrayIter(isOk(self) ? [opt(self).fields[0]] : []),
};

const natives: Record<string, (args: Value[], ctx: NativeContext) => Value> = {};
for (const [name, native] of Object.entries(optionNatives)) natives[`Option<_>::${name}`] = native;
for (const [name, native] of Object.entries(resultNatives)) natives[`Result<_, _>::${name}`] = native;
for (const prefix of ['Option<&_>', 'Option<&mut _>']) {
  natives[`${prefix}::copied`] = ([self], ctx) =>
    isSome(self) ? some(ctx, copyValue(deref(opt(self).fields[0]))) : none(ctx);
  natives[`${prefix}::cloned`] = ([self], ctx) =>
    isSome(self) ? some(ctx, cloneValue(ctx.typeArgs[0], deref(opt(self).fields[0]))) : none(ctx);
}
natives['Result<&_, _>::copied'] = ([self], ctx) =>
  isOk(self) ? ok(ctx, copyValue(deref(opt(self).fields[0]))) : self;
natives['Result<&_, _>::cloned'] = ([self], ctx) =>
  isOk(self) ? ok(ctx, cloneValue(ctx.typeArgs[0], deref(opt(self).fields[0]))) : self;
natives['Option<Option<_>>::flatten'] = ([self], ctx) => (isSome(self) ? opt(self).fields[0] : none(ctx));
natives['Option<Result<_, _>>::transpose'] = ([self], ctx) => {
  if (!isSome(self)) return ok(ctx, none(ctx));
  const inner = opt(opt(self).fields[0]);
  return inner.variant === 0 ? ok(ctx, some(ctx, inner.fields[0])) : err(ctx, inner.fields[0]);
};
natives['Result<Option<_>, _>::transpose'] = ([self], ctx) => {
  if (!isOk(self)) return some(ctx, err(ctx, opt(self).fields[0]));
  const inner = opt(opt(self).fields[0]);
  return inner.variant === 1 ? some(ctx, ok(ctx, inner.fields[0])) : none(ctx);
};
define(natives);
