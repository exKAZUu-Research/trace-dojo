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
    uncaughtException: 'carried',
    stdout: '(2,',
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

test('integer printf flags combine precision, prefixes and padding', () => {
  const source = `import Text.Printf
main = printf "%#x|%#o|%#.0x|%.0d|%08.3d|%#.3o\\n" (0::Int) (0::Int) (0::Int) (0::Int) (12::Int) (8::Int)`;
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: '0|0|||     012|010\n',
  });
});

test('right scans produce lazy prefixes and finite suffix sums', () => {
  const source =
    'main = print (take 3 (scanr const 0 [1..]), take 3 (scanr1 const [1..]), scanr (+) 0 [1,2,3], scanr1 (+) [1,2,3])';
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: '([1,2,3],[1,2,3],[6,5,3,0],[6,5,3])\n',
  });
});

test('Read round-trips every ASCII control character and string', () => {
  const source = String.raw`import Data.Char
main = print (all (\c -> (read (show c) :: Char) == c && (read (show [c]) :: String) == [c]) (map chr [0..127]))`;
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: 'True\n',
  });
});

test('Read decodes numeric escapes and rejects out-of-range code points', () => {
  const source = String.raw`main = do
  print (read "'\\x41'" :: Char, read "\"\\o101\\x42\\67\"" :: String)
  print (reads "'\\x110000'" :: [(Char,String)], reads "'\\o4200000'" :: [(Char,String)])`;
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: '(\'A\',"ABC")\n([],[])\n',
  });
});

test.each(['1e999999999999999999999', '1e-999999999999999999999'])(
  'fractional expansion is bounded before BigInt allocation: %s',
  (literal) => {
    expect(executeProgram('haskell', `x :: Fractional a => a\nx = ${literal}\nmain = print (x :: Double)`)).toEqual({
      kind: 'limitExceeded',
      limit: 'operations',
    });
  }
);

test.each(['instance C [a] => C [a] where c _ = True', 'instance C (a,a) => C [a] where c _ = True'])(
  'non-decreasing instance contexts are compile errors: %s',
  (instance) => {
    expect(
      executeProgram('haskell', `class C a where c :: a -> Bool\n${instance}\nmain = print (c [1 :: Int])`).kind
    ).toBe('compileError');
  }
);

test('handle output actions remain lazy until executed', () => {
  const source =
    'import System.IO\nmain = hPutStr undefined "x" `seq` hPutStrLn undefined "y" `seq` hPrint undefined (1 :: Int) `seq` putStrLn "ok"';
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: 'ok\n',
  });
  expect(executeProgram('haskell', 'import System.IO\nmain = hPutStr undefined "x"')).toMatchObject({
    kind: 'executed',
    uncaughtException: 'Prelude.undefined',
    stdout: '',
  });
});

test('encodeFloat handles extreme scaling and GHC Float conversion', () => {
  const source = `main = do
  print (encodeFloat 1 9223372036854775807 :: Double, encodeFloat 1 (-9223372036854775807) :: Double, encodeFloat (-1) (-9223372036854775807) :: Double)
  print (encodeFloat 0 9223372036854775807 :: Float, encodeFloat 18014399583223809 0 :: Float, encodeFloat 1 (-149) :: Float)`;
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: '(Infinity,0.0,-0.0)\n(0.0,1.8014399e16,1.0e-45)\n',
  });
});

test('local IO calls retain caller turtles like top-level calls', () => {
  const header = `main = do
  t1 <- newTurtleAt 1 1
  t2 <- newTurtleAt 3 3
  walk t2
  print 1
`;
  const local = `${header}  where walk t = 前に進む t`;
  const top = `${header}\nwalk t = 前に進む t`;
  const actual = traceProgram('haskell', local, local);
  const expected = traceProgram('haskell', top, top);
  expect(actual.finalTurtles).toEqual(expected.finalTurtles);
  expect(actual.finalTurtles).toHaveLength(2);
  expect(actual.traceItems.map((item) => item.turtles)).toEqual(expected.traceItems.map((item) => item.turtles));
});

test('abstract collections display ordered contents and ratios display their value', () => {
  const source = `import qualified Data.Map as M
import qualified Data.Set as S
import Data.Ratio
main = do
  let m = M.fromList [("banana",5 :: Int),("apple",3)]
      s = S.fromList "ih"
      r = 6 % 8 :: Rational
  print (m,s,r)`;
  const last = traceProgram('haskell', source, source).traceItems.at(-1);
  expect(last?.vars.r).toBe('3 % 4');
  expect(last?.referenceVars).toMatchObject({
    m: {
      kind: 'array',
      entries: {
        0: { kind: 'array', entries: { 0: { kind: 'value', value: 'apple' }, 1: { kind: 'value', value: 3 } } },
        1: { kind: 'array', entries: { 0: { kind: 'value', value: 'banana' }, 1: { kind: 'value', value: 5 } } },
      },
    },
    s: { kind: 'array', entries: { 0: { kind: 'value', value: 'h' }, 1: { kind: 'value', value: 'i' } } },
  });
});
