import { DEFAULT_SPEC } from '../fmt';
import { described, fieldsPart, optionPart } from '../iterDebug';
import { cloneValue, copyValue } from '../ops';
import type { Type } from '../types';
import { ElementPlace, type EnumValue, type IterValue, textOf, type Value } from '../values';
import { defaultValue } from './core';
import { arrayIter, ownedIter } from './iterators';
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

function inspectVariant(variant: number): (args: Value[], ctx: NativeContext) => Value {
  return ([self, f], ctx) => {
    const value = opt(self);
    if (value.variant === variant) call(ctx, f, [value.fields[0]]);
    return self;
  };
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
    if (!isSome(self)) panic(ctx, textOf(msg));
    return opt(self).fields[0];
  },
  unwrap_or: ([self, fallback]) => (isSome(self) ? opt(self).fields[0] : fallback),
  unwrap_or_else: ([self, f], ctx) => (isSome(self) ? opt(self).fields[0] : call(ctx, f, [])),
  unwrap_or_default: ([self], ctx) => (isSome(self) ? opt(self).fields[0] : defaultValue(ctx, ctx.typeArgs[0])),
  map: ([self, f], ctx) => (isSome(self) ? some(ctx, call(ctx, f, [opt(self).fields[0]])) : none(ctx)),
  map_or: ([self, fallback, f], ctx) => (isSome(self) ? call(ctx, f, [opt(self).fields[0]]) : fallback),
  map_or_else: ([self, fallback, f], ctx) =>
    isSome(self) ? call(ctx, f, [opt(self).fields[0]]) : call(ctx, fallback, []),
  inspect: inspectVariant(1),
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
  take_if: ([self, predicate], ctx) => {
    const current = opt(self);
    if (current.variant !== 1 || !deref(call(ctx, predicate, [new ElementPlace(current.fields, 0)]))) return none(ctx);
    return optionNatives.take([self], ctx);
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
  iter: ([self]) => outcomeIter(opt(self), 'ref'),
  iter_mut: ([self]) => outcomeIter(opt(self), 'mut'),
  into_iter: ([self], ctx) => outcomeIter(opt(self), 'value', ctx.typeArgs[0]),
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
    if (!isOk(self)) panic(ctx, `${textOf(msg)}: ${debugText(ctx, opt(self).fields[0], ctx.typeArgs[1])}`);
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
    if (isOk(self)) panic(ctx, `${textOf(msg)}: ${debugText(ctx, opt(self).fields[0], ctx.typeArgs[0])}`);
    return opt(self).fields[0];
  },
  unwrap_or: ([self, fallback]) => (isOk(self) ? opt(self).fields[0] : fallback),
  unwrap_or_else: ([self, f], ctx) => (isOk(self) ? opt(self).fields[0] : call(ctx, f, [opt(self).fields[0]])),
  unwrap_or_default: ([self], ctx) => (isOk(self) ? opt(self).fields[0] : defaultValue(ctx, ctx.typeArgs[0])),
  map: ([self, f], ctx) => (isOk(self) ? ok(ctx, call(ctx, f, [opt(self).fields[0]])) : self),
  map_or: ([self, fallback, f], ctx) => (isOk(self) ? call(ctx, f, [opt(self).fields[0]]) : fallback),
  map_or_else: ([self, fallback, f], ctx) => call(ctx, isOk(self) ? f : fallback, [opt(self).fields[0]]),
  map_err: ([self, f], ctx) => (isOk(self) ? self : err(ctx, call(ctx, f, [opt(self).fields[0]]))),
  inspect: inspectVariant(0),
  inspect_err: inspectVariant(1),
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
  iter: ([self]) => outcomeIter(opt(self), 'ref'),
  iter_mut: ([self]) => outcomeIter(opt(self), 'mut'),
  into_iter: ([self], ctx) => outcomeIter(opt(self), 'value', ctx.typeArgs[0]),
};

const natives: Record<string, (args: Value[], ctx: NativeContext) => Value> = {};
for (const [name, native] of Object.entries(optionNatives)) natives[`Option<_>::${name}`] = native;
for (const target of ['String', 'Vec<_>', 'Box<_>']) {
  natives[`Option<${target}>::as_deref`] = optionNatives.as_ref;
  natives[`Option<${target}>::as_deref_mut`] = optionNatives.as_mut;
}
natives['Option<(_, _)>::unzip'] = ([self], ctx) => {
  const value = opt(self);
  if (value.variant === 0) return [none(ctx), none(ctx)];
  const [first, second] = value.fields[0] as Value[];
  return [some(ctx, first), some(ctx, second)];
};
for (const [name, native] of Object.entries(resultNatives)) natives[`Result<_, _>::${name}`] = native;
for (const [container, methods] of [
  ['Option<_>', optionNatives],
  ['Result<_, _>', resultNatives],
] as const) {
  natives[`&${container}::into_iter`] = methods.iter;
  natives[`&mut ${container}::into_iter`] = methods.iter_mut;
}
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

export function outcomeIter(value: EnumValue, mode: 'value' | 'ref' | 'mut', owned?: Type): IterValue {
  const isOption = value.def.builtin === 'Option';
  const present = value.variant === (isOption ? 1 : 0);
  const items = present ? [mode === 'mut' ? new ElementPlace(value.fields, 0) : value.fields[0]] : [];
  const iter = owned && mode === 'value' ? ownedIter(items, owned) : arrayIter(items);
  const name = { value: 'IntoIter', ref: 'Iter', mut: 'IterMut' }[mode];
  return described(iter, (show, item, target) => {
    const [value] = target.rest?.() ?? [];
    const inner = optionPart(value === undefined ? undefined : (indent, sink) => show(value, item, indent, sink));
    return fieldsPart(name, [['inner', isOption ? fieldsPart('Item', [['opt', inner]]) : inner]]);
  });
}
