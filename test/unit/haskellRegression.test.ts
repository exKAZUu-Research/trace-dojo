import { expect, test } from 'vitest';

import { executeProgram, traceProgram } from '../../src/interpreter/program';

test.each([
  ['Data.Map', String.raw`M.foldr' (\x _ -> if x == 1 then 0 else error "bad") 0 (M.fromList [(1,1),(2,2)])`],
  ['Data.Map', String.raw`M.foldrWithKey' (\k _ _ -> if k == 1 then 0 else error "bad") 0 (M.fromList [(1,1),(2,2)])`],
  ['Data.Set', String.raw`M.foldr' (\x _ -> if x == 1 then 0 else error "bad") 0 (M.fromList [1,2])`],
])('strict right folds evaluate every intermediate result: %s %s', (module, expression) => {
  expect(executeProgram('haskell', `import qualified ${module} as M\nmain = print (${expression})`)).toMatchObject({
    kind: 'executed',
    stdout: '',
    uncaughtException: 'bad',
  });
});

test('record updates can change updated parameters and retain unchanged fields', () => {
  const source = `data Box a b = Box { value :: a, keep :: b } deriving Show
change b = b { value = "hello" }
main = print ((Box 1 'x') { value = True }, change (Box True (2 :: Int)))`;
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: '(Box {value = True, keep = \'x\'},Box {value = "hello", keep = 2})\n',
  });
  expect(
    executeProgram(
      'haskell',
      'data Pair a = Pair { first :: a, second :: a }\nmain = print (first ((Pair 1 2) { first = True }))'
    ).kind
  ).toBe('compileError');
});

test('strict map merges preserve carried values and force computed values', () => {
  const imports = 'import qualified Data.Map as L\nimport qualified Data.Map.Strict as S\n';
  const maps = 'a = L.singleton 1 (error "carried" :: Int)\nb = L.singleton 2 (3 :: Int)\n';
  const source = `${imports}${maps}main = print (S.size (S.unionWith (+) a b), S.size (S.unionWithKey (\\_ -> (+)) b a), S.size (S.unionsWith (+) [a,b]), S.size (S.differenceWith (\\x _ -> Just x) a b))`;
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: '(2,2,2,1)\n',
  });
  for (const expression of [
    String.raw`S.unionWith (\_ _ -> error "computed") b b`,
    String.raw`S.differenceWith (\_ _ -> Just (error "computed")) b b`,
  ]) {
    expect(executeProgram('haskell', `${imports}${maps}main = print (S.size (${expression}))`)).toMatchObject({
      kind: 'executed',
      stdout: '',
      uncaughtException: 'computed',
    });
  }
});

test('printf consumes dynamic dimensions before each value', () => {
  const source = `import Text.Printf
main = do
  printf "[%*.*f][%*d][%0*d][%.*s][%.*f]\\n" (8 :: Int) (2 :: Int) (1.25 :: Double) (4 :: Int) (2 :: Int) (-5 :: Int) (2 :: Int) (-2 :: Int) "hello" (-2 :: Int) (1.25 :: Double)
  printf "%*d|%d\\n" (3 :: Integer) (2 :: Int) (7 :: Int)`;
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: '[    1.25][   2][2    ][][1]\n  2|7\n',
  });
});

test.each([
  'x :: Bool\n(x,y) = (1,2)\nmain = print x',
  'main = do\n  let x :: Bool\n      (x,y) = (1,2)\n  print x',
  'f :: a -> a\n(f,x) = (const True,1)\nmain = print (f False)',
  'x :: Num a => a\n(x,y) = (1,2)\nmain = print (x :: Int)',
])('pattern signatures reject invalid definitions: %s', (source) => {
  expect(executeProgram('haskell', source).kind).toBe('compileError');
});

test('pattern signatures constrain arithmetic and preserve polymorphism', () => {
  const source = `x :: Int
(x,y) = (9223372036854775807 + 1,2)
f :: a -> a
(f,z) = (id,3)
main = do
  let a :: Int
      (a,b) = (9223372036854775807 + 1,2)
  print (x, a, f True, f 'x')`;
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: "(-9223372036854775808,-9223372036854775808,True,'x')\n",
  });
});

test.each(['sum [1 .. 30000 :: Int]', 'length [1 ..]'])(
  'display attempts do not consume the program budget: %s',
  (value) => {
    const source = `import Control.Monad
main = do
  let total = ${value}
  forM_ [1 .. 60 :: Int] $ \\i -> print i
  ${value.startsWith('sum') ? 'print total' : 'return ()'}`;
    const execution = executeProgram('haskell', source);
    expect(execution.kind).toBe('executed');
    const recording = traceProgram('haskell', source, source);
    expect(recording.stdout).toBe(execution.kind === 'executed' ? execution.stdout : undefined);
    expect(recording.uncaughtException).toBeUndefined();
    expect(recording.traceItems.length).toBeGreaterThan(60);
  }
);
