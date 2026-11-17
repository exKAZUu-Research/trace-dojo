import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

test.each(['Int', 'Integer', 'Word'])(
  '%s alternate radix forms use the original numeric value before precision and padding',
  (type) => {
    const source = `import Text.Printf
main=do
 printf "%#.3x|%#.2b|%#6.3X|%#.1x|%#.0o|%#.3o\\n" ${Array.from({ length: 6 }, () => `(0::${type})`).join(' ')}
 printf "%#06.3x|%#-6.3X|%#.2o|%+v|% v\\n" ${[1, 1, 8, 1, 1].map((n) => `(${n}::${type})`).join(' ')}`;
    expect(executeProgram('haskell', source)).toMatchObject({
      kind: 'executed',
      stdout: `000|00|   000|0||000\n 0x001|0X001 |010|${type === 'Word' ? '1|1' : '+1| 1'}\n`,
      uncaughtException: undefined,
    });
  }
);

test.each(['Int', 'Integer'])(
  'negative %s values converted to unsigned zero retain nonzero-source prefixes',
  (type) => {
    const source = `import Text.Printf
main=printf "%#hhx|%#.0hhx|%#.3hhx|%#.0hho|%#hhb\\n" ${Array.from({ length: 5 }, () => `(-256::${type})`).join(' ')}`;
    expect(executeProgram('haskell', source)).toMatchObject({
      kind: 'executed',
      stdout: '0x0|0x|0x000|0|0b0\n',
      uncaughtException: undefined,
    });
  }
);

test.each(['%.0c', '%.1c', '%-12.3c', '%hc', '%llc'])(
  'character conversion validates precision and modifiers consistently: %s',
  (format) => {
    for (const value of ["'a'", '(97::Int)', '(97::Integer)', '(97::Word)']) {
      const source = `import Text.Printf\nmain=printf "head|${format}|tail" ${value}`;
      expect(executeProgram('haskell', source)).toMatchObject({
        kind: 'executed',
        stdout: 'head|',
        uncaughtException: 'printf: illegal char conversion',
      });
    }
  }
);

test.each(['(-1::Integer)', '(1114112::Integer)', '(18446744073709551713::Integer)'])(
  'character conversion checks the raw integer before narrowing: %s',
  (value) => {
    expect(executeProgram('haskell', `import Text.Printf\nmain=printf "head|%c|tail" ${value}`)).toMatchObject({
      kind: 'executed',
      stdout: 'head|',
      uncaughtException: 'printf: illegal char conversion',
    });
  }
);

test('valid character conversion keeps field padding and Unicode range boundaries', () => {
  const source = "import Text.Printf\nmain=printf \"[%05c][%-5c][%c][%v]\" (97::Int) 'a' (1114111::Integer) 'a'";
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    stdout: `[0000a][a    ][${String.fromCodePoint(1_114_111)}][a]`,
    uncaughtException: undefined,
  });
});

test.each([
  ['%.1v', "'a'", 'printf: illegal char conversion'],
  ['%.*c', "(-1::Int) 'a'", 'printf: illegal char conversion'],
  ['%.1c', '(error "argument"::Int)', 'argument'],
  ['%.1c', '(error "argument"::Char)', 'argument'],
  ['%.*c', '(error "precision"::Int) \'a\'', 'printf: illegal char conversion'],
  ['%*.1c', '(error "width"::Int) \'a\'', 'width'],
  ['%*d', '(error "width"::Int) (error "argument"::Int)', 'argument'],
  ['%*.1d', '(error "width"::Int) (error "argument"::Int)', 'width'],
  ['%*s', '(error "width"::Int) (error "argument"::String)', 'width'],
  ['%#x', '(-1::Integer)', 'printf: bad argument'],
])('conversion validation preserves demand and partial output: %s', (format, args, uncaughtException) => {
  const source = `import Text.Printf\nmain=printf "head|${format}|tail" ${args}`;
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    stdout: format === '%#x' ? 'head|0x' : 'head|',
    uncaughtException,
  });
});

test.each([
  ['Float', '0.14285715', '71.42857'],
  ['Double', '0.14285714285714285', '71.42857142857143'],
])('printing a table of %s ratios stays within the execution budget', (type, first, last) => {
  const source = `import Control.Monad\nmain=forM_ [1..500::Int] $ \\i->print(fromIntegral i/7::${type})`;
  const result = executeProgram('haskell', source);
  expect(result.kind).toBe('executed');
  if (result.kind !== 'executed') return;
  expect(result.uncaughtException).toBeUndefined();
  const lines = result.stdout.trimEnd().split('\n');
  expect(lines).toHaveLength(500);
  expect(lines[0]).toBe(first);
  expect(lines.at(-1)).toBe(last);
});

test.each(['Float', 'Double'])('formatting a table of %s ratios stays within the execution budget', (type) => {
  const source = `import Control.Monad\nimport Text.Printf\nmain=forM_ [1..250::Int] $ \\i->printf "%6.2f\\n" (fromIntegral i/7::${type})`;
  const result = executeProgram('haskell', source);
  expect(result.kind).toBe('executed');
  if (result.kind !== 'executed') return;
  expect(result.uncaughtException).toBeUndefined();
  const lines = result.stdout.trimEnd().split('\n');
  expect(lines).toHaveLength(250);
  expect(lines[0]).toBe('  0.14');
  expect(lines.at(-1)).toBe(' 35.71');
});

test('generic RealFloat formatting retains nonstrict user methods', () => {
  const source = `import Numeric

data N=N
instance Eq N where _==_=False
instance Ord N where compare _ _=GT
instance Num N where
 fromInteger _=N
 (+) _ _=N
 (*) _ _=N
 negate _=N
 abs _=N
 signum _=N
instance Real N where toRational _=0
instance Fractional N where fromRational _=N
instance RealFrac N where properFraction _=(0,N)
instance Floating N
instance RealFloat N where
 floatRadix _=2
 floatDigits _=53
 floatRange _=(-1021,1024)
 decodeFloat _=(4503599627370496,-52)
 encodeFloat _ _=N
 isNaN _=False
 isInfinite _=False
 isDenormalized _=False
 isNegativeZero _=False
 isIEEE _=True
main=putStrLn(showGFloat Nothing (undefined::N) "")
`;
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    stdout: '-1.0\n',
    uncaughtException: undefined,
  });
});

test.each([
  [500, '%6.2f', 'fromIntegral i/7::Double', '  0.14', ' 71.43'],
  [700, '%5d', 'i', '    1', '  700'],
  [700, '%-10s', 'show i', '1         ', '700       '],
  [500, '%08.3f', 'fromIntegral i/7::Float', '0000.143', '0071.429'],
])('printf table dimensions stay within the execution budget: %i %s', (count, format, value, first, last) => {
  const source = `import Control.Monad\nimport Text.Printf\nmain=forM_ [1..${count}::Int] $ \\i->printf "${format}\\n" (${value})`;
  const result = executeProgram('haskell', source);
  expect(result.kind).toBe('executed');
  if (result.kind !== 'executed') return;
  expect(result.uncaughtException).toBeUndefined();
  const lines = result.stdout.split('\n');
  expect(lines.pop()).toBe('');
  expect(lines).toHaveLength(count);
  expect(lines[0]).toBe(first);
  expect(lines.at(-1)).toBe(last);
});

test('printf literal dimensions retain Int overflow behavior', () => {
  const source =
    'import Text.Printf\nmain=printf "%18446744073709551616d|%18446744073709551617d|%.18446744073709551616d|%.18446744073709551617d" (0::Int) (0::Int) (0::Int) (0::Int)';
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    stdout: '0|0||0',
    uncaughtException: undefined,
  });
});
