import { toFloat } from './conversions';
import { coreMethod } from './define';
import { typeError } from './errors';
import { callBlock, callMethod, type Gen, invoke } from './interp';
import { addRationals, isRational, rationalToFloat } from './libRational';
import { isRubyFloat, isRubyNumber, NIL, type RArray, type RObject, type RProc, RString, type Value } from './objects';
import { rt } from './runtime';

const IMMEDIATE_INTEGER_LIMIT = 1n << 62n;

export function* arraySum(self: RArray, args: Value[], block: RProc | undefined): Gen {
  const accumulator = new NumericSum(args[0] ?? 0n, 'array', args.length > 0);
  try {
    for (let index = 0; index < self.items.length;) {
      rt().spend();
      const item = block ? yield* callBlock(block, [self.items[index]]) : self.items[index];
      if ((yield* accumulator.add(item)) === 'advance') index++;
    }
    return yield* accumulator.finish();
  } finally {
    accumulator.release();
  }
}

export class NumericSum {
  private total: Value;
  private readonly initialFloat: number | undefined;
  private readonly exactActive: boolean;
  private readonly mark: number;
  private integers = 0n;
  private rationals: RObject | undefined;
  private floating: CompensatedSum | undefined;
  private sawValue = false;
  private generic = false;

  constructor(
    private readonly initial: Value,
    private readonly mode: 'array' | 'enumerable',
    private readonly explicit: boolean
  ) {
    this.total = initial;
    this.initialFloat = isRubyFloat(initial) ? Number(initial) : undefined;
    this.exactActive = isSumNumber(initial);
    if (this.initialFloat !== undefined) {
      if (mode === 'array') this.total = 0n;
      else this.floating = new CompensatedSum(this.initialFloat);
    }
    this.mark = rt().held.length;
    rt().held.push(initial, NIL);
  }

  *add(item: Value): Gen<'advance' | 'repeat'> {
    const hadValues = this.sawValue;
    this.sawValue = true;
    const exactActive = this.mode === 'array' ? this.exactActive && !this.generic : isSumNumber(this.total);
    if (this.floating === undefined && exactActive) {
      if (typeof item === 'bigint' || isRational(item)) {
        yield* this.addExact(item);
        return 'advance';
      }
      yield* this.normalize(this.mode !== 'array' || hadValues);
      if (this.mode === 'array' && this.initialFloat !== undefined) {
        this.floating = new CompensatedSum(yield* sumFloat(this.total));
        this.floating.add(this.initialFloat);
        return 'repeat';
      }
      if (isRubyFloat(item)) this.floating = new CompensatedSum(yield* sumFloat(this.total));
    }
    if (this.floating !== undefined && this.addFloating(item, this.floating)) return 'advance';
    this.generic = true;
    this.total = yield* callMethod(this.total, '+', [item]);
    rt().held[this.mark] = this.total;
    return 'advance';
  }

  *finish(): Gen {
    if (!this.sawValue) return this.initial;
    if (this.floating) return this.floating.result;
    if (this.mode === 'array' && this.generic) return this.total;
    const exact = yield* this.normalize(this.mode === 'array' && this.explicit);
    return this.mode === 'array' && this.initialFloat !== undefined
      ? yield* invoke(coreMethod(rt().c.Float, '+'), this.initialFloat, [exact], undefined, undefined, true)
      : exact;
  }

  release(): void {
    rt().held.length = this.mark;
  }

  private addFloating(item: Value, floating: CompensatedSum): boolean {
    if (isRubyNumber(item) || isRational(item)) {
      floating.add(isRational(item) ? rationalToFloat(item) : Number(item));
      return true;
    }
    this.total = floating.value;
    rt().held[this.mark] = this.total;
    this.floating = undefined;
    return false;
  }

  private *addExact(item: bigint | RObject): Gen<void> {
    if (typeof item === 'bigint') {
      if (fixable(item)) {
        this.integers += item;
        if (!fixable(this.integers)) {
          yield* this.addInteger(this.integers);
          this.integers = 0n;
        }
      } else yield* this.addInteger(item);
    } else {
      this.rationals = this.rationals ? addRationals(this.rationals, item) : item;
      rt().held[this.mark + 1] = this.rationals;
    }
  }

  private *normalize(includeZero: boolean): Gen<Value> {
    if (this.integers !== 0n || (includeZero && (this.mode !== 'array' || this.rationals === undefined)))
      yield* this.addInteger(this.integers);
    this.integers = 0n;
    if (this.rationals) {
      this.total = isRubyFloat(this.total)
        ? rationalToFloat(this.rationals) + Number(this.total)
        : typeof this.total === 'bigint' || isRational(this.total)
          ? addRationals(this.rationals, this.total)
          : yield* invoke(coreMethod(rt().c.Rational, '+'), this.rationals, [this.total], undefined, undefined, true);
      this.rationals = undefined;
      rt().held[this.mark + 1] = NIL;
    }
    rt().held[this.mark] = this.total;
    return this.total;
  }

  private *addInteger(value: bigint): Gen<void> {
    this.total = yield* invoke(coreMethod(rt().c.Integer, '+'), value, [this.total], undefined, undefined, true);
    rt().held[this.mark] = this.total;
  }
}

class CompensatedSum {
  private compensation = 0;

  constructor(public value: number) {}

  add(x: number): void {
    const previous = this.value;
    if (Number.isNaN(previous)) return;
    if (Number.isNaN(x)) this.value = x;
    else if (!Number.isFinite(x))
      this.value = !Number.isFinite(previous) && Math.sign(x) !== Math.sign(previous) ? Number.NaN : x;
    else if (Number.isFinite(previous)) {
      const next = previous + x;
      this.compensation += Math.abs(previous) >= Math.abs(x) ? previous - next + x : x - next + previous;
      this.value = next;
    }
  }

  get result(): number {
    return this.value + this.compensation;
  }
}

function isSumNumber(value: Value): boolean {
  return isRubyNumber(value) || isRational(value);
}

function fixable(value: bigint): boolean {
  return value >= -IMMEDIATE_INTEGER_LIMIT && value < IMMEDIATE_INTEGER_LIMIT;
}

function* sumFloat(value: Value): Gen<number> {
  if (value instanceof RString) throw typeError('no implicit conversion to float from string');
  return isRational(value) ? rationalToFloat(value) : yield* toFloat(value);
}
