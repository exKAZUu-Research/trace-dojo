import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

test.each([
  ['isAlpha', '2560\n'],
  ['isUpper', '800\n'],
])('%s processes introductory text within the operation budget', (predicate, stdout) => {
  const source = `import Data.Char
main=print(length(filter ${predicate}(concat(replicate 160 "Hello, World 123 abc XYZ!\\n"))))`;
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    stdout,
    uncaughtException: undefined,
  });
});

test.each([
  ['toEnum(k `mod` 100)', '99000\n'],
  ['succ(toEnum(k `mod` 99))', '99210\n'],
  ['pred(toEnum(1+k `mod` 99))', '97210\n'],
  ['head([K99 ..])', '198000\n'],
  ['head([K99,K98 ..])', '198000\n'],
])('derived Enum lookup has bounded cost across a large type: %s', (value, stdout) => {
  const constructors = Array.from({ length: 100 }, (_, index) => `K${index}`).join('|');
  const source = `data C=${constructors} deriving Enum
main=print(sum[fromEnum(${value}::C)|k<-[0..1999::Int]])`;
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    stdout,
    uncaughtException: undefined,
  });
});

test('derived enumeration ranges preserve bounds, direction and zero-step laziness', () => {
  const source = `data C=A|B|C|D deriving(Enum,Show)
main=do
 print([A .. D])
 print([B ..])
 print([D,C ..])
 print([D,B .. A])
 print(take 4[B,B ..])
 print(take 0[error "unused"..]::[C])`;
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    stdout: '[A,B,C,D]\n[B,C,D]\n[D,C,B,A]\n[D,B]\n[B,B,B,B]\n[]\n',
    uncaughtException: undefined,
  });
});
