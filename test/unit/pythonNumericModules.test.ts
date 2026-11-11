import { expect, test } from 'vitest';

import { executeProgram, traceProgram } from '../../src/interpreter/program';

// The expected values are what CPython 3.14.10 prints for the same expressions.
test('fractions, decimal, cmath, and statistics compute what CPython computes', () => {
  const program = `from fractions import Fraction
from decimal import Decimal, getcontext, localcontext, ROUND_FLOOR
import cmath, math, statistics, operator
getcontext().prec = 16
with localcontext(rounding=ROUND_FLOOR):
    floor_power = Decimal(100) ** Decimal('0.5')
actual = [repr(Fraction('3.1415926').limit_denominator(100) + 1), format(Fraction(2, 3), '.5f'), str(1 / Fraction(3) == Fraction(1, 3)),
          str(hash(Fraction(1, 2)) == hash(0.5)), str(Decimal(1) / 7), str(floor_power), format(Decimal('1234.5'), ',.2f'),
          repr(cmath.acos(complex(-1, -3.75))), repr(cmath.sqrt(complex(0.0, -0.0))), repr(math.hypot(1.3, 2.7)),
          repr(statistics.stdev([1.5, 2.5, 2.5, 2.75, 3.25, 4.75])), repr(statistics.NormalDist(100, 15).inv_cdf(0.9)),
          repr(statistics.variance([Fraction(1, 3), Fraction(1, 2), 2])), repr(operator.itemgetter(1, 0)('ab'))]
expected = ['Fraction(410, 99)', '0.66667', 'True', 'True', '0.1428571428571429', '9.999999999999999', '1,234.50',
            '(1.8234765819369754+2.0634370688955603j)', '-0j', '2.9966648127543394', '1.0810874155219827',
            '119.22327348316901', 'Fraction(91, 108)', "('b', 'a')"]
for a, e in zip(actual, expected):
    if a != e:
        raise ValueError(a + ' != ' + e)`;
  expect(executeProgram('python', program)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
});

test.each([
  [
    'a trapped decimal signal',
    'from decimal import Decimal\nDecimal(1) / 0',
    "decimal.DivisionByZero: [<class 'decimal.DivisionByZero'>]",
  ],
  [
    'a decimal operation meeting two trapped conditions',
    'from decimal import Decimal\ndivmod(Decimal(7), 0)',
    "decimal.InvalidOperation: [<class 'decimal.InvalidOperation'>, <class 'decimal.DivisionByZero'>]",
  ],
  [
    'a decimal mixed with a float',
    'from decimal import Decimal\nDecimal(1) + 1.5',
    "TypeError: unsupported operand type(s) for +: 'decimal.Decimal' and 'float'",
  ],
  [
    'a fraction with a zero denominator',
    'from fractions import Fraction\nFraction(3, 0)',
    'ZeroDivisionError: Fraction(3, 0)',
  ],
])('%s ends as CPython reports it', (_name, program, uncaughtException) => {
  expect(executeProgram('python', program)).toMatchObject({ kind: 'executed', uncaughtException });
});

test('traces show fractions and decimals as their reprs', () => {
  const program =
    "from fractions import Fraction\nfrom decimal import Decimal\nf = Fraction(1, 2)\nd = Decimal('0.10')\ndone = True";
  const trace = traceProgram('python', program, program);
  expect(trace.traceItems.at(-1)?.referenceVars).toMatchObject({
    f: { kind: 'value', value: 'Fraction(1, 2)' },
    d: { kind: 'value', value: "Decimal('0.10')" },
  });
});
