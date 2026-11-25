import { FUNCTION_TYPE, IO_TYPE } from './builtinTypes';
import type { CoercionSpec } from './entities';
import { TailCall } from './machine';
import { newtypeBox } from './newtypes';
import { define, type Primitive } from './primitives';
import type { Runtime } from './runtime';
import { prune, splitApp, type Type } from './types';
import { ConValue, IOBind, IOReturn, PrimFn, type Slot, Thunk, type Value } from './values';

/**
 * The function that a `Coercible` constraint's evidence is at run time: it takes the evidence of the given
 * constraints it uses, a direction (0 converts forward, 1 back), and the value to convert. A newtype's value holds
 * its field, so converting a value rebuilds the newtypes inside it, lazily, as the program looks into it.
 */
export function coercionPrimitive(spec: CoercionSpec, leafCount: number): Primitive {
  return {
    name: 'coerce',
    arity: leafCount + 2,
    strict: [leafCount],
    fn: (args, runtime) => {
      const leaves = args.slice(0, leafCount);
      const forward = runtime.machine.force(args[leafCount]) === 0n;
      return convert(spec, args[leafCount + 1], forward, leaves, runtime);
    },
  };
}

// `coerce`, which applies the evidence of `Coercible a b` forward to a value.
define(
  'coerceApply',
  2,
  [0],
  ([evidence, value], runtime) => new TailCall(runtime.machine.force(evidence), [0n, value])
);

function lazily(compute: () => Slot | TailCall): Thunk {
  return new Thunk(undefined, undefined, compute);
}

function oneArgument(name: string, fn: (arg: Slot) => Slot | TailCall): PrimFn {
  return new PrimFn({ name, arity: 1, strict: [], fn: ([arg]) => fn(arg) });
}

function convert(spec: CoercionSpec, value: Slot, forward: boolean, leaves: Slot[], runtime: Runtime): Slot {
  const force = (slot: Slot): Value => runtime.machine.force(slot);
  switch (spec.k) {
    case 'refl': {
      return value;
    }
    case 'leaf': {
      const direction = forward === spec.flipped ? 1n : 0n;
      return lazily(() => new TailCall(force(leaves[spec.index]), [direction, value]));
    }
    case 'unwrap':
    case 'wrap': {
      // Unwrapping forward and wrapping back take the newtype's field out; the others put the field in.
      if ((spec.k === 'unwrap') === forward) {
        return lazily(() => convert(spec.inner, (force(value) as ConValue).fields[0], forward, leaves, runtime));
      }
      return lazily(() => newtypeBox(spec.con, convert(spec.inner, value, forward, leaves, runtime), force));
    }
    case 'fun': {
      return lazily(() => {
        const fn = force(value);
        return oneArgument('coerce', (arg) =>
          convert(
            spec.res,
            lazily(() => new TailCall(fn, [convert(spec.arg, arg, !forward, leaves, runtime)])),
            forward,
            leaves,
            runtime
          )
        );
      });
    }
    case 'io': {
      const next = oneArgument('coerce', (result) => new IOReturn(convert(spec.res, result, forward, leaves, runtime)));
      return lazily(() => {
        force(value);
        return new IOBind(value, next);
      });
    }
    case 'data': {
      return lazily(() => {
        const original = force(value) as ConValue;
        const fields = original.fields.map((field, index) => {
          const fieldSpec = specOfField(original.con.fieldTypes[index], spec.params);
          return convert(fieldSpec, field, forward, leaves, runtime);
        });
        return new ConValue(original.con, fields, original.dicts);
      });
    }
  }
}

/** How a field converts, given how the data type's parameters do. */
function specOfField(type: Type, params: CoercionSpec[]): CoercionSpec {
  const current = prune(type);
  if (current.tag === 'tgen') return params[current.index] ?? { k: 'refl' };
  if (current.tag === 'forall') {
    // A polymorphic field takes its constraints' dictionaries first, which pass through unchanged.
    let spec = specOfField(current.body, params);
    if (spec.k === 'refl') return spec;
    for (let index = 0; index < current.preds.length; index++) spec = { k: 'fun', arg: { k: 'refl' }, res: spec };
    return spec;
  }
  if (current.tag !== 'tap') return { k: 'refl' };
  const { head, args } = splitApp(current);
  if (head.tag !== 'tcon') return { k: 'refl' };
  const argSpecs = args.map((arg) => specOfField(arg, params));
  if (argSpecs.every((arg) => arg.k === 'refl')) return { k: 'refl' };
  if (head.entity === FUNCTION_TYPE) return { k: 'fun', arg: argSpecs[0], res: argSpecs[1] };
  if (head.entity === IO_TYPE) return { k: 'io', res: argSpecs[0] };
  return { k: 'data', params: argSpecs };
}
