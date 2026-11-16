import { expect, test } from 'vitest';

import { executeProgram, traceProgram } from '../../src/interpreter/program';

test.each([
  [
    'expression dictionaries',
    'main = print (((+) :: Num a => a -> a -> a) 1 2, (show :: Show a => a -> String) True)',
    '(3,"True")\n',
  ],
  ['pattern entry point', '(main,x) = (putStrLn "ok",1)', 'ok\n'],
  ['constructor entry point', 'Just main = Just (putStrLn "ok")', 'ok\n'],
  [
    'method constraints',
    'class C a where f :: Eq a => a -> a -> Bool\ninstance C Int where f = (==)\nmain = print (f (1::Int) 2)',
    'False\n',
  ],
  [
    'higher-kinded synonyms',
    'type Id a = a\ntype App f a = Id f a\nmain = print (Just 1 :: App Maybe Int)',
    'Just 1\n',
  ],
  ['given constraints', 'f :: Eq [a] => [a] -> Bool\nf xs = xs == xs\nmain = print (f [True])', 'True\n'],
  [
    'disjoint instance heads',
    'class C a where c :: a -> Int\ninstance C (Either a a) where c _ = 1\ninstance C (Either Int Bool) where c _ = 2\nmain = print (c (Left 1 :: Either Int Bool))',
    '2\n',
  ],
  ['readIO', 'main = do\n  x <- readIO "42" :: IO Int\n  y <- readIO "True" :: IO Bool\n  print (x,y)', '(42,True)\n'],
])('%s executes with its inferred dictionaries and types', (_name, source, stdout) => {
  expect(executeProgram('haskell', source)).toMatchObject({ kind: 'executed', uncaughtException: undefined, stdout });
});

test.each([
  'f :: Show a => Int\nf = 1\nmain = print 2',
  'main = do\n  let f :: Eq a => Bool\n      f = True\n  print 2',
  'main = print (f 1 2)\n  where\n    infixl 4 `f`\n    infixr 5 `f`\n    f x y = x + y',
  'module Main (main, Maybe(Nothing)) where\nimport Prelude hiding (Maybe(..))\nimport Data.Maybe (Maybe(Just))\nmain = print 1',
  'class C a where c :: a -> Int\ninstance C (Either a a) where c _ = 1\ninstance C (Either Int Int) where c _ = 2\nmain = print 1',
])('invalid declarations produce compile diagnostics: %s', (source) => {
  expect(executeProgram('haskell', source).kind).toBe('compileError');
});

test('ambiguous imported functions name public modules in the diagnostic', () => {
  const result = executeProgram('haskell', 'import Data.Map\nmain = print (filter even [1,2])');
  expect(result.kind).toBe('compileError');
  if (result.kind === 'compileError') {
    expect(result.diagnostics[0].message).toContain('Prelude.filter');
    expect(result.diagnostics[0].message).toContain('Data.Map.filter');
    expect(result.diagnostics[0].message).not.toContain('Internal');
  }
});

test.each([
  ['[x]', '([] :: [Int])', '[x]'],
  ['(x:xs)', '([] :: [Int])', 'x : xs'],
])('pattern failures preserve %s syntax', (pattern, value, rendered) => {
  const result = executeProgram('haskell', `main = print (let ${pattern} = ${value} in x)`);
  expect(result).toMatchObject({
    kind: 'executed',
    stdout: '',
    uncaughtException: expect.stringContaining(`Non-exhaustive patterns in ${rendered}`),
  });
});

test('single-action nested IO blocks retain their statement trace', () => {
  const source = 'main = do\n  (do\n    print 1) >> print 2\n  print 3';
  const recording = traceProgram('haskell', source, source);
  expect(recording.stdout).toBe('1\n2\n3\n');
  expect(recording.traceItems.map((item) => item.line)).toEqual([0, 3, 4]);
});

test('sum-type traces retain their constructors', () => {
  const source =
    'data Shape = Circle Double | Square Double\nmain = do\n  let a = Circle 2.0\n      b = Square 2.0\n      e = Left 3 :: Either Int Int\n  print 1';
  const refs = traceProgram('haskell', source, source).traceItems.at(-1)?.referenceVars;
  expect(refs?.a).toMatchObject({ kind: 'object', entries: { '<constructor>': { kind: 'value', value: 'Circle' } } });
  expect(refs?.b).toMatchObject({ kind: 'object', entries: { '<constructor>': { kind: 'value', value: 'Square' } } });
  expect(refs?.e).toMatchObject({ kind: 'object', entries: { '<constructor>': { kind: 'value', value: 'Left' } } });
});

test('strict map transformations evaluate their root before children', () => {
  const source =
    'import qualified Data.Map.Strict as M\nmain = print (M.size (M.mapWithKey (\\k _ -> error (show k)) (M.fromList [(1,1),(2,2),(3,3)])))';
  expect(executeProgram('haskell', source)).toMatchObject({ kind: 'executed', stdout: '', uncaughtException: '2' });
});

test('ascending sets keep the last equal representative', () => {
  const source =
    'import qualified Data.Set as S\ndata K = K Int Int deriving Show\ninstance Eq K where K a _ == K b _ = a == b\ninstance Ord K where compare (K a _) (K b _) = compare a b\nmain = print (S.fromAscList [K 1 10,K 1 20,K 1 30,K 2 40])';
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: 'fromList [K 1 30,K 2 40]\n',
  });
});

test('negative Integer bit counts use signed magnitude', () => {
  expect(
    executeProgram('haskell', 'import Data.Bits\nmain = print (map popCount [-1,-2,-3,-7,0,1,7 :: Integer])')
  ).toMatchObject({ kind: 'executed', uncaughtException: undefined, stdout: '[-1,-1,-2,-3,0,1,3]\n' });
});

test('unit comparisons force their left operand before their right operand', () => {
  expect(executeProgram('haskell', 'main = print ((error "left" :: ()) == error "right")')).toMatchObject({
    kind: 'executed',
    uncaughtException: 'left',
    stdout: '',
  });
});

test('introductory library combinators compose with collections', () => {
  const source = `import Data.List
import Control.Monad
import Control.Applicative
import Data.Function
import Data.Bits
import qualified Data.Map as M
import qualified Data.Set as S
main = do
  print (deleteFirstsBy (==) [1,2,3,2] [2], applyWhen True reverse [1,2])
  print (mfilter even (Just 2), optional (Nothing :: Maybe Int), Just 2 <**> Just (+3), liftM3 (\\a b c -> (a,b,c)) (Just 1) (Just True) (Just 'x'))
  print (rotateL (1 :: Int) 3, rotateR (1 :: Int) 1, finiteBitSize (0 :: Int), countLeadingZeros (1 :: Int), countTrailingZeros (8 :: Int))
  print (S.powerSet (S.fromList [1,2]), S.cartesianProduct (S.fromList [1,2]) (S.fromList "ab"))
  print (M.mapAccum (\\s x -> (s+x,s)) (0 :: Int) (M.fromList [(1,2),(2,3)]))`;
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout:
      "([1,3,2],[2,1])\n(Just 2,Just Nothing,Just 5,Just (1,True,'x'))\n(8,-9223372036854775808,64,63,3)\n(fromList [fromList [],fromList [1],fromList [1,2],fromList [2]],fromList [(1,'a'),(1,'b'),(2,'a'),(2,'b')])\n(5,fromList [(1,0),(2,2)])\n",
  });
});

test.each([
  ['data Either a b = L a | R b\nf :: Either Int Int -> Int\nf _ = 1\nmain = print 1', 'Prelude.Either', 'Main.Either'],
  [
    'class Show a where sh :: a -> String\ninstance Show Int where sh = const ""\nmain = putStrLn (sh (1::Int))',
    'Prelude.Show',
    'Main.Show',
  ],
  ['import Data.Map\ndata Map = Map\nf :: Map -> Int\nf _ = 1\nmain = print 1', 'Data.Map.Map', 'Main.Map'],
])('type/class ambiguity diagnostics retain public origins: %s', (source, imported, own) => {
  const result = executeProgram('haskell', source);
  expect(result.kind).toBe('compileError');
  if (result.kind === 'compileError') {
    expect(result.diagnostics[0].message).toContain(imported);
    expect(result.diagnostics[0].message).toContain(own);
    expect(result.diagnostics[0].message).not.toContain('Base.');
    expect(result.diagnostics[0].message).not.toContain('Internal.');
  }
});

test.each([
  ['data T = A | B\ninstance Show T where\n  show A = "A"\nmain = putStrLn (show B)', 'show'],
  ['data T = A | B\ninstance Eq T where\n  A == A = True\nmain = print (A == B)', '=='],
  ['class C a where\n  f :: Bool -> a\n  f True = undefined\ninstance C Int\nmain = print (f False :: Int)', 'f'],
])('partial instance/default methods report their source name: %s', (source, name) => {
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    stdout: '',
    uncaughtException: expect.stringMatching(new RegExp(`Non-exhaustive patterns in function ${name}$`)),
  });
});
