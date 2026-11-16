import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

test.each([
  ['import Data.Foldable\nmain = print (foldr\' (\\x _ -> if x == 1 then 0 else error "bad") 0 [1,2])', '', 'bad'],
  [
    'import qualified Data.Map.Strict as M\nmain = print (M.size (M.insert (error "key" :: Int) (error "value" :: Int) M.empty))',
    '',
    'key',
  ],
  ['import Text.Printf\nmain = printf "[%#08x][%#08X]\\n" (42::Int) (42::Int)', '[0x00002a][0X00002A]\n', undefined],
  ['import Text.Printf\nmain = printf "%u|%x\\n" (-1::Integer) (-1::Integer)', '', 'printf: bad argument'],
  ['main = print (lex "1e+", reads "1e" :: [(Double,String)])', '([("1","e+")],[(1.0,"e")])\n', undefined],
  ['import System.IO\nmain = hFlush undefined >> putStrLn "ok"', '', 'Prelude.undefined'],
  [
    'import System.IO\nmain = hSetBuffering stdout (BlockBuffering (Just (-1))) >> putStrLn "ok"',
    '',
    'hSetBuffering: invalid argument (illegal buffer size (-1))',
  ],
  [
    'import Data.Foldable\ndata Box a = Box a\ninstance Foldable Box where foldMap f (Box x) = f x\nmain = print (toList (Box 3),sum (Box 4))',
    '([3],4)\n',
    undefined,
  ],
  ['import Data.List\nmain = print (mapAccumL (\\a x -> (a+x,a*x)) 0 (Just 5))', '(5,Just 0)\n', undefined],
  [
    'import qualified Data.Map as M\nimport qualified Data.Set as S\nmain = print (S.unions (M.fromList [(1,S.fromList "a"),(2,S.fromList "b")]), M.unionsWith (+) (Just (M.singleton 1 (2::Int))))',
    '(fromList "ab",fromList [(1,2)])\n',
    undefined,
  ],
  [
    'main = print (6.2 ** 5 :: Double, 1.1 ** 10 :: Double, 1.05 ** 20 :: Double, ((-1) ** (1/0)) :: Double, (1 ** (0/0)) :: Double)',
    '(9161.32832,2.5937424601000023,2.653297705144422,1.0,1.0)\n',
    undefined,
  ],
  [
    'main = print (atan2 4.052 (5.9 :: Double),atan2 (-3) (-4) :: Float)',
    '(0.601798038975442,-2.4980917)\n',
    undefined,
  ],
  [
    'main = print (properFraction (-0.0) :: (Integer,Double),snd (properFraction (1/0) :: (Integer,Float)))',
    '((0,0.0),0.0)\n',
    undefined,
  ],
  [
    'import Data.Ord\nmain = print (read "Down (Just 1)" :: Down (Maybe Int),minBound :: Down Bool)',
    '(Down (Just 1),Down True)\n',
    undefined,
  ],
])('library results and exception ordering match GHC: %s', (source, stdout, uncaughtException) => {
  expect(executeProgram('haskell', source)).toMatchObject({ kind: 'executed', stdout, uncaughtException });
});

test('Word fromEnum rejects values outside Int bounds', () => {
  expect(executeProgram('haskell', 'main = print (fromEnum (maxBound :: Word))')).toMatchObject({
    kind: 'executed',
    stdout: '',
    uncaughtException:
      "Enum.fromEnum{Word}: value (18446744073709551615) is outside of Int's bounds (-9223372036854775808,9223372036854775807)",
  });
});

test('library fixities preserve arithmetic and membership grouping', () => {
  const source =
    'import Data.Bits\nmain = print (1 .|. 2 .&. 4 :: Int,1 .|. 3 `shiftL` 2 :: Int,3 * 2 .&. 5 :: Int,1 + 1 `elem` [2,3])';
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: '(1,13,4,True)\n',
  });
  expect(executeProgram('haskell', 'main = print (1 `elem` [1] == True)').kind).toBe('compileError');
});

test('instance bodies require visible class methods', () => {
  const source =
    'data B a = B a\ninstance Foldable B where\n  foldr f z (B a) = f a z\n  toList (B a) = [a]\nmain = print (length (B 1))';
  expect(executeProgram('haskell', source).kind).toBe('compileError');
});

test.each(['Data.Set', 'Data.Map'])('%s searches follow balanced-tree paths within the budget', (module) => {
  const collection = module === 'Data.Set' ? 'C.fromList [1..500 :: Int]' : 'C.fromList [(i,i) | i <- [1..500 :: Int]]';
  for (const operation of ['C.lookupGE i s /= Nothing', 'C.lookupIndex i s /= Nothing']) {
    const source = `import qualified ${module} as C\ns = ${collection}\nmain = print (length (filter (\\i -> ${operation}) [1..500]))`;
    expect(executeProgram('haskell', source)).toMatchObject({
      kind: 'executed',
      uncaughtException: undefined,
      stdout: '500\n',
    });
  }
});

test('Down preserves lazy newtype matching and strict payload WHNF', () => {
  const source = `import Data.Ord
main = do
  print (fmap (const 1) (undefined :: Down Int),Down (const 1) <*> (undefined :: Down Int))
  print (case undefined :: Down Int of Down _ -> (1::Int))
  print ((undefined :: Down Int) { getDown = 1 })`;
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: '(Down 1,Down 1)\n1\nDown 1\n',
  });
  expect(
    executeProgram('haskell', 'import Data.Ord\nmain = Down (error "payload" :: Int) `seq` putStrLn "ok"')
  ).toMatchObject({ kind: 'executed', stdout: '', uncaughtException: 'payload' });
});

test('readIO parses only when its action executes', () => {
  const source = 'main = (readIO undefined :: IO Int) `seq` (readIO (error "input") :: IO Bool) `seq` putStrLn "ok"';
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: 'ok\n',
  });
  expect(
    executeProgram('haskell', 'main = putStr "before " >> (readIO (error "input") :: IO Int) >>= print')
  ).toMatchObject({ kind: 'executed', stdout: 'before ', uncaughtException: 'input' });
});

test.each([
  [String.raw`M.map (\x -> if x == 2 then x else error (show x))`, 3, '3'],
  [String.raw`M.mapWithKey (\k x -> if k == 4 then x else error (show k))`, 7, '6'],
])('strict map transformations visit root/right/left: %s', (transform, size, uncaughtException) => {
  const source = `import qualified Data.Map.Strict as M\nmain = print (M.size (${transform} (M.fromList [(i,i) | i <- [1..${size} :: Int]])))`;
  expect(executeProgram('haskell', source)).toMatchObject({ kind: 'executed', stdout: '', uncaughtException });
});

test.each([
  ['main=print (let ((x:xs):ys)=([]::[[Int]]) in x)', '(x : xs) : ys'],
  [String.raw`main=print (let ['\SOH',x]="" in x)`, String.raw`['\SOH', x]`],
  [String.raw`main=print (let ['\NUL',x]="" in x)`, String.raw`['\NUL', x]`],
  [String.raw`main=print (let ["\128\&0",x]=[] in length x)`, String.raw`["\128\&0", x]`],
])('pattern diagnostics retain Haskell syntax: %s', (source, pattern) => {
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    stdout: '',
    uncaughtException: expect.stringContaining(`Non-exhaustive patterns in ${pattern}`),
  });
});

test.each(['Data.Set', 'Data.Map'])('%s ordered searches demand keys on empty trees', (module) => {
  for (const operation of ['lookupLT', 'lookupLE', 'lookupGT', 'lookupGE', 'lookupIndex', 'findIndex']) {
    const empty = module === 'Data.Map' ? '(C.empty::C.Map Int Int)' : 'C.empty';
    const source = `import qualified ${module} as C\nmain=print(C.${operation} (undefined::Int) ${empty})`;
    expect(executeProgram('haskell', source)).toMatchObject({
      kind: 'executed',
      stdout: '',
      uncaughtException: 'Prelude.undefined',
    });
  }
});

test.each([
  [String.raw`M.differenceWith (\x _ -> Just x) M.empty (error "second"::M.Map Int Int)`, 'second'],
  [
    String.raw`M.differenceWith (\x _ -> Just x) (error "first"::M.Map Int Int) (error "second"::M.Map Int Int)`,
    'second',
  ],
  [String.raw`M.unionWithKey (\k _ _ -> error(show k)) a a`, '2'],
  [String.raw`M.unionWithKey (\k x _ -> if k==2 then x else error(show k)) a a`, '3'],
  [String.raw`M.differenceWith (\x _ -> Just(error(show x))) a a`, '3'],
])('strict map merges preserve containers traversal order: %s', (operation, uncaughtException) => {
  const source = `import qualified Data.Map.Strict as M\na=M.fromList[(i,i)|i <- [1..3::Int]]\nmain=print(M.size(${operation}))`;
  expect(executeProgram('haskell', source)).toMatchObject({ kind: 'executed', stdout: '', uncaughtException });
});

test.each([
  ['import Data.List\nmain=print(take 5(snd(mapAccumL (\\s x -> (s+x,s)) 0 [1..])))', '[0,1,3,6,10]\n'],
  ['import Data.List\nmain=print(take 3(snd(mapAccumR (\\s x -> (s,x*2)) 0 [1..])))', '[2,4,6]\n'],
  [
    'import Data.Foldable\ndata Box a=Box [a]\ninstance Foldable Box where foldMap f (Box xs)=foldMap f xs\nmain=print(take 3(toList(Box [1..])))',
    '[1,2,3]\n',
  ],
  [
    'import Data.Foldable\ndata Box a=Box [a]\ninstance Foldable Box where foldMap f (Box xs)=foldMap f xs\nmain=print(head(toList(Box (1:undefined))))',
    '1\n',
  ],
  [
    'import Text.Printf\nmain=printf "[%05s][%05c][%06.2d][%05v][%05.1s]" "ab" \'x\' (7::Int) "hi" "xyz"',
    '[000ab][0000x][    07][000hi][0000x]',
  ],
  ['main=ioError undefined `seq` ioError(error "bad") `seq` putStrLn "ok"', 'ok\n'],
  ['main=print(fst(splitAt 1 (1:undefined::[Int])))', '[1]\n'],
  ['main=print(take 1(fst(unzip ((1,2):undefined::[(Int,Int)]))))', '[1]\n'],
  ['import Data.List\nmain=print(take 1(fst(partition odd (1:undefined::[Int]))))', '[1]\n'],
  [
    'import Numeric\nmain=print(fst(head(readFloat "1e100001"::[(Rational,String)]))==1e400,fst(head(readFloat "1e-100001"::[(Rational,String)]))==0)',
    '(False,False)\n',
  ],
])('standard library demand preserves lazy results: %s', (source, stdout) => {
  expect(executeProgram('haskell', source)).toMatchObject({ kind: 'executed', stdout, uncaughtException: undefined });
});

test.each([
  'main=print((undefined::[Int])!!(-1))',
  'main=print(splitAt undefined [1::Int] `seq` 1)',
  'main=print(splitAt 1 (undefined::[Int]) `seq` 1)',
  'main=print(unzip(undefined::[(Int,Int)]) `seq` 1)',
  'import Data.List\nmain=print(unzip3(undefined::[(Int,Int,Int)]) `seq` 1)',
  'import Data.List\nmain=print(unzip7(undefined::[(Int,Int,Int,Int,Int,Int,Int)]) `seq` 1)',
  'import Data.Either\nmain=print(partitionEithers[undefined::Either Int Int] `seq` 1)',
])('standard library operations demand their initial input: %s', (source) => {
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    stdout: '',
    uncaughtException: 'Prelude.undefined',
  });
});

test('generic RealFloat formatting preserves wrapper instances', () => {
  const source =
    'import Data.Ord\nimport Numeric\nmain=print(showEFloat Nothing (Down 0::Down Float) "",showFFloat (Just 2) (Down 0::Down Double) "",showEFloat Nothing (Down 1::Down Float) "")';
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    stdout: '("0.0e0","0.00","-',
    uncaughtException: 'Char.intToDigit: not a digit -1',
  });
});

test('numeric boundary operations preserve GHC rounding and exponent bounds', () => {
  const source =
    'import Data.Bits\nmain=do\n  print(exp(-0.212::Float),sin(0.095::Float))\n  print(scaleFloat minBound (1::Float),scaleFloat maxBound (1e100::Double))\n  print(shift (1::Integer) minBound,shift (7::Word) minBound,shift (7::Int) minBound)';
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    stdout: '(0.80896467,9.485717e-2)\n(0.0,Infinity)\n(1,7,7)\n',
    uncaughtException: undefined,
  });
});

test('decimal reads handle huge floating exponents and preserve exact Rational conversion', () => {
  const source =
    'import Numeric\nimport Data.Ratio\nmain=do\n  print(read "1e1000000"::Double,read "1e-1000000"::Float)\n  print(fst(head(readFloat "1e1000000000"::[(Double,String)])),fst(head(readFloat "1e-1000000000"::[(Double,String)])))\n  print(fst(head(readFloat "1e400"::[(Rational,String)])) == 10^400 % 1)';
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    stdout: '(Infinity,0.0)\n(Infinity,0.0)\nTrue\n',
    uncaughtException: undefined,
  });
});

test('zero block buffering errors preserve numeric precedence', () => {
  expect(
    executeProgram('haskell', 'import System.IO\nmain=hSetBuffering stdout (BlockBuffering(Just 0))')
  ).toMatchObject({
    kind: 'executed',
    stdout: '',
    uncaughtException: 'hSetBuffering: invalid argument (illegal buffer size 0)',
  });
});

test('fmapDefault derives mapping through traverse independently of the Functor method', () => {
  const source =
    'import Data.Traversable\ndata Box a=Box a deriving Show\ninstance Functor Box where fmap=fmapDefault\ninstance Foldable Box where foldMap f(Box x)=f x\ninstance Traversable Box where traverse f(Box x)=Box <$> f x\nmain=print(fmap (+1)(Box (1::Int)))';
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    stdout: 'Box 2\n',
    uncaughtException: undefined,
  });
});

test('lex preserves string-gap spelling while Read removes the gap', () => {
  const source = String.raw`main=do
  let token=['"','a','\\','\n',' ','\\','b','"']
  print(lex token)
  print(read token::String)`;
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    stdout: '[("\\\"a\\\\\\n \\\\b\\\"","")]\n"ab"\n',
    uncaughtException: undefined,
  });
});

test.each(['toRational (undefined::Int)', 'fromInteger undefined::Rational'])(
  'rational constructors demand numeric fields: %s',
  (expression) => {
    expect(executeProgram('haskell', `main=print((${expression}) \`seq\` (1::Int))`)).toMatchObject({
      kind: 'executed',
      stdout: '',
      uncaughtException: 'Prelude.undefined',
    });
  }
);

test.each([
  ['%lf', '(1.5::Double)', 'l'],
  ['%hs', '"ab"', 'h'],
  ...['z', 'j', 't', 'q'].map((modifier) => [`%${modifier}d`, '(40000::Int)', modifier]),
])('printf rejects unsupported type-specific modifiers: %s', (format, value, char) => {
  const source = `import Text.Printf\nmain=printf "${format}" ${value}`;
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    stdout: '',
    uncaughtException: `printf: bad formatting char '${char}'`,
  });
});

test('printf integral modifiers retain unsigned widths and reject character conversions', () => {
  const source =
    'import Text.Printf\nmain=do\n  printf "%hd|%hhx|%ld|%lld|%hhx\\n" (40000::Int) (40000::Int) (40000::Int) (40000::Int) (-1::Integer)';
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    stdout: '40000|9c40|40000|40000|ff\n',
    uncaughtException: undefined,
  });
  expect(executeProgram('haskell', 'import Text.Printf\nmain=printf "%hc" (65::Int)')).toMatchObject({
    kind: 'executed',
    uncaughtException: 'printf: illegal char conversion',
  });
});

test.each(['%*d', '%*s', '%*f'])('minimum dynamic printf widths do not overflow padding: %s', (format) => {
  const value = format.endsWith('s') ? '"ab"' : format.endsWith('f') ? '(1.5::Double)' : '(2::Int)';
  const expected = format.endsWith('s') ? '[ab]' : format.endsWith('f') ? '[1.5]' : '[2]';
  expect(
    executeProgram('haskell', `import Text.Printf\nmain=printf "[${format}]" (minBound::Int) ${value}`)
  ).toMatchObject({ kind: 'executed', stdout: expected, uncaughtException: undefined });
});

test.each(['shiftL', 'shiftR'])('Integer %s validates the count before forcing its value', (shift) => {
  for (const [count, uncaughtException] of [
    ['(-1)', 'arithmetic overflow'],
    ['error "count"', 'count'],
  ]) {
    const source = `import Data.Bits\nmain=print(${shift} (error "value"::Integer) (${count}))`;
    expect(executeProgram('haskell', source)).toMatchObject({ kind: 'executed', stdout: '', uncaughtException });
  }
  for (const type of ['Int', 'Word']) {
    const source = `import Data.Bits\nmain=print(${shift} (error "value"::${type}) (-1))`;
    expect(executeProgram('haskell', source)).toMatchObject({
      kind: 'executed',
      stdout: '',
      uncaughtException: 'value',
    });
  }
});

test('empty data deriving retains non-strict equality, ordering and failed reads', () => {
  const source =
    'data T deriving (Eq,Ord,Show,Read)\nmain=print((undefined::T)==undefined,compare(undefined::T)undefined,reads "x"::[(T,String)])';
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    stdout: '(True,EQ,[])\n',
    uncaughtException: undefined,
  });
  expect(executeProgram('haskell', 'data T deriving Show\nmain=print(1::Int)')).toMatchObject({
    kind: 'executed',
    stdout: '1\n',
    uncaughtException: undefined,
  });
  expect(executeProgram('haskell', 'data T deriving Show\nmain=print(show(undefined::T))')).toMatchObject({
    kind: 'executed',
    stdout: '"',
    uncaughtException: 'Prelude.undefined',
  });
});

test.each([
  ['maximumBy', 'LT'],
  ['minimumBy', 'GT'],
])('%s forces intermediate selections', (name, ordering) => {
  for (const values of ['[error "bad",2::Int]', '[1,error "bad",3::Int]']) {
    expect(
      executeProgram('haskell', `import Data.List\nmain=print(${name} (\\_ _->${ordering}) ${values})`)
    ).toMatchObject({ kind: 'executed', stdout: '', uncaughtException: 'bad' });
  }
});

test.each([
  ['([]::[Int]) undefined', '', 'Prelude.undefined'],
  ['(error "needle"::[Int]) (error "haystack")', '', 'needle'],
  ['[1..] [1,2,3::Int]', 'False\n', undefined],
  ['[error "element"::Int] []', 'False\n', undefined],
  ['[2,3::Int] [1,2,3]', 'True\n', undefined],
  ['[1,2::Int] [1,2,3]', 'False\n', undefined],
])('suffix checks retain list demand: %s', (args, stdout, uncaughtException) => {
  expect(executeProgram('haskell', `import Data.List\nmain=print(isSuffixOf ${args})`)).toMatchObject({
    kind: 'executed',
    stdout,
    uncaughtException,
  });
});

test.each([
  [String.raw`foldl' (\_ _->error "function"::Int) 0 (1:error "tail")`, 'function'],
  ['sum (error "first":error "tail"::[Int])', 'first'],
  [String.raw`foldl' (\_ _->1::Int) (error "seed") [2]`, 'seed'],
  [String.raw`foldl' (\_ _->1::Int) (error "seed") (error "tail"::[Int])`, 'tail'],
])('strict list folds force updates before subsequent cells: %s', (expression, uncaughtException) => {
  expect(executeProgram('haskell', `import Data.List\nmain=print(${expression})`)).toMatchObject({
    kind: 'executed',
    stdout: '',
    uncaughtException,
  });
});
