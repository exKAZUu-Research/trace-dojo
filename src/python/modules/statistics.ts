import { pythonFunction } from '../define';
import { type DictEntry, DictStore } from '../dictStore';
import { pyHash } from '../hashing';
import { registerModule } from '../modules';
import { exactBinary, intToFloat, scaleToFloat } from '../numbers';
import { toArray } from '../objects';
import { binaryOp, lessThan } from '../operators';
import { exceptionClassNamed, newException, typeError, typeName } from '../types';
import { PyError, type PyValue } from '../values';
import { builtinClassWithBase } from './moduleClasses';

const statisticsErrorClass = builtinClassWithBase('StatisticsError', exceptionClassNamed('ValueError'), 'statistics');

function statisticsError(message: string): PyError {
  return new PyError(newException(statisticsErrorClass, [message]));
}

interface Fraction {
  numerator: bigint;
  denominator: bigint;
}

function toFraction(value: PyValue): Fraction {
  if (typeof value === 'bigint' || typeof value === 'boolean') return { numerator: BigInt(value), denominator: 1n };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw typeError('cannot convert infinity or NaN to a fraction');
    const { mantissa, exponent } = exactBinary(value);
    return exponent >= 0
      ? { numerator: mantissa << BigInt(exponent), denominator: 1n }
      : { numerator: mantissa, denominator: 1n << BigInt(-exponent) };
  }
  throw typeError(`can't convert type '${typeName(value)}' to numerator/denominator`);
}

/** The exact quotient of two fractions as the nearest float. */
function fractionToFloat({ numerator, denominator }: Fraction): number {
  if (numerator === 0n) return 0;
  const negative = numerator < 0n;
  const magnitude = negative ? -numerator : numerator;
  const shift = BigInt(denominator.toString(2).length - magnitude.toString(2).length + 60);
  const scaled = shift > 0n ? magnitude << shift : magnitude >> -shift;
  let quotient = scaled / denominator;
  if (scaled % denominator !== 0n) quotient |= 1n;
  const result = scaleToFloat(quotient, -Number(shift));
  return negative ? -result : result;
}

/** `statistics.mean`, computed exactly and converted to the type of the data, as CPython does. */
function mean([data]: PyValue[]): PyValue {
  const items = toArray(data);
  if (items.length === 0) throw statisticsError('mean requires at least one data point');
  // Summing per denominator keeps the integers small: the floats of a data set share few denominators.
  const numerators = new Map<bigint, bigint>();
  let isFloat = false;
  for (const item of items) {
    if (typeof item === 'number') isFloat = true;
    const fraction = toFraction(item);
    numerators.set(fraction.denominator, (numerators.get(fraction.denominator) ?? 0n) + fraction.numerator);
  }
  let numerator = 0n;
  let denominator = 1n;
  for (const [each, sum] of numerators) {
    numerator = numerator * each + sum * denominator;
    denominator *= each;
  }
  denominator *= BigInt(items.length);
  if (!isFloat && numerator % denominator === 0n) return numerator / denominator;
  return fractionToFloat({ numerator, denominator });
}

function median([data]: PyValue[]): PyValue {
  const items = toArray(data).toSorted((a, b) => (lessThan(a, b) ? -1 : lessThan(b, a) ? 1 : 0));
  const n = items.length;
  if (n === 0) throw statisticsError('no median for empty data');
  if (n % 2 === 1) return items[(n - 1) / 2];
  const middle = n / 2;
  return binaryOp('/', binaryOp('+', items[middle - 1], items[middle]), 2n);
}

function mode([data]: PyValue[]): PyValue {
  const items = toArray(data);
  if (items.length === 0) throw statisticsError('no mode for empty data');
  const counts = new DictStore();
  for (const item of items) {
    const hash = pyHash(item);
    counts.set(item, ((counts.lookup(item, hash)?.value as bigint | undefined) ?? 0n) + 1n, hash);
  }
  let best = counts.first() as DictEntry;
  for (const entry of counts.ordered()) if ((entry.value as bigint) > (best.value as bigint)) best = entry;
  return best.key;
}

registerModule(
  'statistics',
  () =>
    new Map<string, PyValue>([
      ['mean', pythonFunction('mean', 'data', mean)],
      ['median', pythonFunction('median', 'data', median)],
      ['mode', pythonFunction('mode', 'data', mode)],
      ['StatisticsError', statisticsErrorClass],
    ])
);

export { intToFloat };
