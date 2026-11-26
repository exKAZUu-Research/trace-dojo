import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

// Library functions at the boundary of their arguments raise what GHC 9.14.1 and its libraries raise.
test.each([
  [
    'Seq.chunksOf 0',
    'print (Seq.chunksOf 0 (Seq.fromList [1, 2 :: Int]))',
    'chunksOf: A non-empty sequence can only be broken up into positively-sized chunks.',
  ],
  ['Seq.chunksOf on an empty sequence', 'print (Seq.chunksOf 0 (Seq.empty :: Seq.Seq Int))', undefined],
  ['Seq.replicate', 'print (Seq.replicate (-1) (1 :: Int))', 'replicate takes a nonnegative integer argument'],
  [
    'Seq.replicateA',
    'print (Seq.replicateA (-1) (Just (1 :: Int)))',
    'replicateA takes a nonnegative integer argument',
  ],
  ['Seq.iterateN', 'print (Seq.iterateN (-2) (+ 1) (0 :: Int))', 'iterateN takes a nonnegative integer argument'],
  ['Seq.fromFunction', 'print (Seq.fromFunction (-1) id)', 'Data.Sequence.fromFunction called with negative len'],
  ['Int8 div', 'print ((minBound :: Int8) `div` (-1))', 'arithmetic overflow'],
  ['Int16 quot', 'print ((minBound :: Int16) `quot` (-1))', 'arithmetic overflow'],
  ['Int32 rem', 'print ((minBound :: Int32) `rem` (-1))', undefined],
  ['Ratio zero denominator', 'print (1 % (0 :: Integer))', 'Ratio has zero denominator'],
  ['assert False', 'assert False (putStrLn "reached")', 'Assertion failed'],
  ['assert True', 'assert True (putStrLn "reached")', undefined],
])('%s', (_, body, exception) => {
  const source = `import qualified Data.Sequence as Seq\nimport Data.Int\nimport Data.Ratio\nimport Control.Exception\nmain :: IO ()\nmain = ${body}\n`;
  const result = executeProgram('haskell', source);
  expect(result.kind).toBe('executed');
  if (result.kind === 'executed') expect(result.uncaughtException).toBe(exception);
});

test('an arithmetic failure is caught as the ArithException it is', () => {
  const source = `import Control.Exception
import Data.Int
import Data.Ratio
main :: IO ()
main = do
  a <- try (evaluate ((minBound :: Int8) \`div\` (-1))) :: IO (Either ArithException Int8)
  b <- try (evaluate (1 % (0 :: Integer))) :: IO (Either ArithException Rational)
  c <- try (evaluate (1 \`div\` (0 :: Int))) :: IO (Either ArithException Int)
  print (a, b, c)
`;
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    stdout: '(Left arithmetic overflow,Left Ratio has zero denominator,Left divide by zero)\n',
  });
});
