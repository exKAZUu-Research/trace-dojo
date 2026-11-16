import { rEquals, toInt } from './conversions';
import { coreMethod } from './define';
import { argumentError, typeError } from './errors';
import { callMethod, type Gen, invoke } from './interp';
import { isRational } from './libRational';
import { NIL, RArray, type Value } from './objects';
import { rt } from './runtime';
import { arr } from './values';

export function* rationalSequenceSize(start: Value, end: Value, step: Value, exclusive: boolean): Gen<bigint> {
  const distance = yield* integerOperation(end, '-', start);
  const index = yield* numericOperation(distance, 'div', step);
  const lastIndex = yield* toInt(index);
  if (lastIndex < 0n) return 0n;
  const last = yield* integerOperation(start, '+', yield* integerOperation(step, '*', lastIndex));
  return exclusive && (yield* rEquals(last, end)) ? lastIndex : lastIndex + 1n;
}

export function* rationalSequenceLast(start: Value, end: Value, step: Value, exclusive: boolean, args: Value[]): Gen {
  const distance = yield* numericOperation(end, '-', start);
  const index = yield* toInt(yield* numericOperation(distance, 'div', step));
  if (index < 0n) return args.length === 0 ? NIL : arr([]);
  let last = yield* numericOperation(start, '+', yield* numericOperation(step, '*', index));
  const adjusted = exclusive && (yield* rEquals(last, end));
  if (adjusted) last = yield* numericOperation(last, '-', step);
  if (args.length === 0) return last;
  const requested = yield* toInt(args[0]);
  const length = adjusted ? index : index + 1n;
  const count = requested < length ? requested : length;
  if (count < 0n) throw argumentError('negative array size');
  let value = yield* integerOperation(last, '-', yield* integerOperation(step, '*', count));
  const values: Value[] = [];
  rt().heldArrays.push(values);
  try {
    for (let position = 0n; position < count; position++) {
      rt().spend();
      value = yield* integerOperation(value, '+', step);
      values.push(value);
    }
    return arr(values);
  } finally {
    rt().heldArrays.pop();
  }
}

function* numericOperation(left: Value, op: string, right: Value): Gen<Value> {
  const owner = typeof left === 'bigint' ? rt().c.Integer : isRational(left) ? rt().c.Rational : rt().c.Float;
  return yield* invoke(coreMethod(owner, op), left, [right], undefined, undefined, true);
}

function* integerOperation(left: Value, op: string, right: Value): Gen<Value> {
  if (typeof left === 'bigint') return yield* numericOperation(left, op, right);
  const pair = yield* callMethod(right, 'coerce', [left]);
  if (!(pair instanceof RArray) || pair.items.length !== 2) throw typeError('coerce must return [x, y]');
  return yield* callMethod(pair.items[0], op, [pair.items[1]]);
}
