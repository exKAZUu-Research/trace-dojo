import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

// GHC 9.14.1 (runghc) prints the expected output: lazy lists, derived Show with negative fields and records, Map's key
// order, Integer and Int arithmetic, GHC's float formatting, printf's padding, and a derived Read.
test('a program prints what GHC prints', () => {
  const program = String.raw`import qualified Data.Map as M
import Text.Printf

data Shape = Circle Double | Rect { w :: Double, h :: Double } deriving (Show, Eq, Ord)

fibs :: [Integer]
fibs = 0 : 1 : zipWith (+) fibs (tail fibs)

main :: IO ()
main = do
  print (take 8 fibs, fibs !! 90, fst (1, undefined))
  print [Circle (-1.5), Rect { w = 2, h = 0.1 }]
  print (M.toList (M.fromListWith (+) [(c, 1 :: Int) | c <- "mississippi"]))
  print (2 ^ 64, maxBound :: Int, 7 ${'`'}div${'`'} (-2), 7 ${'`'}quot${'`'} (-2), 1.0e-2, 12345678.9 :: Double, 1 / 3 :: Float)
  printf "%5.2f|%-4d|%s\n" (3.14159 :: Double) (42 :: Int) "ok"
  print (read "[(1,\"a\")]" :: [(Int, String)])
`;
  expect(executeProgram('haskell', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: [
      '([0,1,1,2,3,5,8,13],2880067194370816120,1)',
      '[Circle (-1.5),Rect {w = 2.0, h = 0.1}]',
      "[('i',4),('m',1),('p',2),('s',4)]",
      '(18446744073709551616,9223372036854775807,-4,-3,1.0e-2,1.23456789e7,0.33333334)',
      ' 3.14|42  |ok',
      '[(1,"a")]',
      '',
    ].join('\n'),
  });
});

// GHC 9.14.1 writes what precedes the failing pattern match, and reports the clauses' span in the file.
test('a failed pattern match stops the program with GHC message', () => {
  const program = `classify :: Int -> String
classify 0 = "zero"
classify 1 = "one"

main :: IO ()
main = do
  putStrLn (classify 0)
  putStr "partial "
  putStrLn (classify 2)
`;
  expect(executeProgram('haskell', program)).toMatchObject({
    kind: 'executed',
    stdout: 'zero\npartial ',
    uncaughtException: 'Main.hs:(2,1)-(3,18): Non-exhaustive patterns in function classify',
  });
});

test.each([
  ['a type error', 'main = putStrLn (1 + 2)'],
  ['a name out of scope', 'main = print (foo 3)'],
  ['an ambiguous type', 'main = print (read "3")'],
  ['a missing instance', String.raw`main = print (\x -> x)`],
  ['a rigid type variable', 'f :: a -> a\nf x = x + 1\nmain = print (f 1)'],
  ['a name defined by the program and the Prelude', 'lookup x = x\nmain = print (lookup 3)'],
  ['a misplaced line', 'main = do\n    print 1\n  print 2'],
])('%s is a compile error, as in GHC', (_name, program) => {
  expect(executeProgram('haskell', program).kind).toBe('compileError');
});

test.each([
  ['standard input', 'main = getLine >>= putStrLn'],
  ['a file', 'main = readFile "a.txt" >>= putStrLn'],
  ['a syntax of an extension', 'f = \\case\n  _ -> 1\nmain = print (f ())'],
  ['a module outside base and containers', 'import Data.IORef\nmain = print 1'],
])('%s is rejected as unsupported', (_name, program) => {
  const execution = executeProgram('haskell', program);
  expect(execution.kind).toBe('compileError');
  if (execution.kind === 'compileError')
    expect(execution.diagnostics[0].message).toContain('この採点環境では使えません');
});

test('turtles move, and the program own definitions hide the Turtle API names', () => {
  const program = `import Control.Monad

forward :: Int
forward = 2

main :: IO ()
main = do
  keep <- newTurtleAt 1 1
  forM_ [1 .. forward] $ \\_ -> 前に進む keep
  turnRight keep
  temporary <- newTurtleWithColor 4 4 "Y"
  前に進む temporary
  hPutStrLn' "not shown"
  where hPutStrLn' _ = return ()
`;
  expect(executeProgram('haskell', program)).toMatchObject({
    kind: 'executed',
    finalBoard: ['.......', '.#.....', '.#.....', '.#.....', '....Y..', '....Y..', '.......'].join('\n'),
    finalTurtles: [
      { x: 1, y: 3, color: '#', dir: 'E' },
      { x: 4, y: 5, color: 'Y', dir: 'N' },
    ],
  });
});

test('standard error is accepted but not shown', () => {
  const program = `import System.IO
main :: IO ()
main = do
  hPutStrLn stderr "warning"
  putStrLn "out"
`;
  expect(executeProgram('haskell', program)).toMatchObject({ kind: 'executed', stdout: 'out\n', stderr: 'warning\n' });
});

test('an endless loop stops at the operation limit', () => {
  expect(executeProgram('haskell', 'main = print (length [1 ..])')).toEqual({
    kind: 'limitExceeded',
    limit: 'operations',
  });
});
