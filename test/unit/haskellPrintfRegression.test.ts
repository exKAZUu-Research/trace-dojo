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
