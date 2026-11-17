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

test('numeric boundary operations preserve native floating arithmetic and exponent bounds', () => {
  const source =
    'import Data.Bits\nmain=do\n  print(exp(-0.212::Float),sin(0.095::Float))\n  print(scaleFloat minBound (1::Float),scaleFloat maxBound (1e100::Double))\n  print(shift (1::Integer) minBound,shift (7::Word) minBound,shift (7::Int) minBound)';
  const result = executeProgram('haskell', source);
  expect(result).toMatchObject({ kind: 'executed', uncaughtException: undefined });
  if (result.kind !== 'executed') return;
  const [transcendentals, ...bounds] = result.stdout.trimEnd().split('\n');
  const [exponential, sine] = transcendentals.slice(1, -1).split(',').map(Number);
  // Native libm implementations may differ by one Float ULP.
  expect(exponential).toBeCloseTo(Math.exp(Math.fround(-0.212)), 7);
  expect(sine).toBeCloseTo(Math.sin(Math.fround(0.095)), 7);
  expect(bounds).toEqual(['(0.0,Infinity)', '(1,7,7)']);
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

test.each([
  String.raw`Just (error "element"::Int)`,
  '(Right 2::Either () Int)',
  '((),2::Int)',
  String.raw`Down (error "element"::Int)`,
  'Box [2::Int]',
])('generic strict right folds demand the seed before a discarding callback: %s', (container) => {
  const source = String.raw`import Data.Foldable
import Data.Ord
data Box a=Box [a]
instance Foldable Box where foldMap f(Box xs)=foldMap f xs
main=print(foldr' (\_ _->1::Int) (error "seed") (${container}))`;
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    stdout: '',
    uncaughtException: 'seed',
  });
});

test('strict Foldable defaults retain structure demand, empty seeds and the list override', () => {
  const source = String.raw`import Data.Foldable
main=do
  print(foldr' (\_ _->1::Int) (error "seed") [2::Int])
  print(foldr' (error "function") (7::Int) (Nothing::Maybe Int))
  print(foldr (\_ _->1::Int) (error "seed") (Just(2::Int)))
  print(foldr' (\_ _->Just(1::Int)) (Just(error "inner")) (Just(2::Int)))`;
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    stdout: '1\n7\n1\nJust 1\n',
    uncaughtException: undefined,
  });
  const failing = String.raw`import Data.Foldable
main=print(foldr' (\_ _->1::Int) (error "seed") (error "structure"::Maybe Int))`;
  expect(executeProgram('haskell', failing)).toMatchObject({
    kind: 'executed',
    stdout: '',
    uncaughtException: 'structure',
  });
});

test.each([
  ['fmap show (1::Int,True)', '(1,"True")\n'],
  ['fmap length (1,2,"ab")', '(1,2,2)\n'],
  ['fmap show ("left",\'x\',True,4::Int)', '("left",\'x\',True,"4")\n'],
  ['fmap (+1) ((),False,\'x\',"y",5::Int)', '((),False,\'x\',"y",6)\n'],
  ['fmap not ((),1,2,3,4,True)', '((),1,2,3,4,False)\n'],
  ['fmap length ((),1,2,3,4,5,"ab")', '((),1,2,3,4,5,2)\n'],
  ['("a",[1::Int],LT)<>("b",[2],EQ)', '("ab",[1,2],LT)\n'],
  ['("a","b",[1::Int],EQ)<>("c","d",[2],GT)', '("ac","bd",[1,2],GT)\n'],
  ['("",[],EQ,"x",[1::Int])<>("a",[True],LT,"y",[2])', '("a",[True],LT,"xy",[1,2])\n'],
  ['mempty::(String,[Int],Ordering)', '("",[],EQ)\n'],
  ['mempty::(String,String,[Int],Ordering)', '("","",[],EQ)\n'],
  ['mempty::(String,String,String,[Int],Ordering)', '("","","",[],EQ)\n'],
  ['("a",[1::Int],(+1))<*>("b",[2],3::Int)', '("ab",[1,2],4)\n'],
  ['("a","b",[1::Int],(+1))<*>("c","d",[2],3::Int)', '("ac","bd",[1,2],4)\n'],
  ['pure(3::Int)::(String,[Int],Int)', '("",[],3)\n'],
  ['pure(3::Int)::(String,String,[Int],Int)', '("","",[],3)\n'],
  [String.raw`("a",[1::Int],3::Int)>>= \x->("b",[2],x+1)`, '("ab",[1,2],4)\n'],
  [String.raw`("a","b",[1::Int],3::Int)>>= \x->("c","d",[2],x+1)`, '("ac","bd",[1,2],4)\n'],
  ['liftA2 (+) ("a",[1::Int],3::Int) ("b",[2],4)', '("ab",[1,2],7)\n'],
])('standard tuple instances transform only the result and combine each prefix: %s', (expression, stdout) => {
  expect(executeProgram('haskell', `import Control.Applicative\nmain=print(${expression})`)).toMatchObject({
    kind: 'executed',
    stdout,
    uncaughtException: undefined,
  });
});

test('tuple instance methods retain outer constructor demand and lazy fields', () => {
  const source = `main=do
  let (a,_,_)=fmap (error "mapper") (1::Int,2::Int,3::Int)
  print a
  print(fmap (error "mapper") (error "tuple"::(Int,Int,Int)) \`seq\` (1::Int))`;
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    stdout: '1\n',
    uncaughtException: 'tuple',
  });
});

test.each([
  'shift(B a)n=B(shift a n)\n rotate(B a)n=B(rotate a n)',
  'shiftL(B a)n=B(shiftL a n)\n shiftR(B a)n=B(shiftR a n)\n rotateL(B a)n=B(rotateL a n)\n rotateR(B a)n=B(rotateR a n)',
])('Bits and FiniteBits inherit supported default methods: %s', (methods) => {
  const source = bitsWrapperSource(
    methods,
    `main=do
  print(setBit(B 0)2,clearBit(B 7)1,complementBit(B 0)1,zeroBits::B)
  print(shiftL(B 3)2,shiftR(B 12)2,unsafeShiftL(B 1)3,unsafeShiftR(B 8)2,rotateR(B 8)2)
  print(bitSize(undefined::B),countLeadingZeros(B 8),countTrailingZeros(B 8),countLeadingZeros(B 0),countTrailingZeros(B 0))
  print(shift(B 3)0,rotate(B 4)0,shift(B 8)(-2),rotate(B 8)(-2))`
  );
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    stdout: '(B 4,B 5,B 2,B 0)\n(B 12,B 3,B 8,B 2,B 2)\n(64,60,3,64,64)\n(B 3,B 4,B 2,B 2)\n',
    uncaughtException: undefined,
  });
});

test('default zero-count shifts and rotations leave directional methods unevaluated', () => {
  const methods =
    'shiftL _ _=error "left"\n shiftR _ _=error "right"\n rotateL _ _=error "left"\n rotateR _ _=error "right"';
  expect(executeProgram('haskell', bitsWrapperSource(methods, 'main=print(shift(B 3)0,rotate(B 4)0)'))).toMatchObject({
    kind: 'executed',
    stdout: '(B 3,B 4)\n',
    uncaughtException: undefined,
  });
});

const bitsWrapperSource = (methods: string, main: string): string => `import Data.Bits
data B=B Int deriving(Eq,Show)
instance Bits B where
 B a .&. B b=B(a .&. b)
 B a .|. B b=B(a .|. b)
 xor(B a)(B b)=B(xor a b)
 complement(B a)=B(complement a)
 bit n=B(bit n)
 testBit(B a)n=testBit a n
 popCount(B a)=popCount a
 bitSizeMaybe _=Just 64
 isSigned _=True
 ${methods}
instance FiniteBits B where finiteBitSize _=64
${main}`;

test('Integer bit queries avoid index-sized masks and retain sign extension', () => {
  const source =
    'import Data.Bits\nmain=do\n  print(length[i|i<-[1..200::Int],testBit(1::Integer)(1000000+i)])\n  print(testBit(-1::Integer)100000000,testBit(1::Integer)(maxBound::Int),testBit(-2::Integer)(maxBound::Int),testBit(1::Integer)(-1))\n  print([testBit(-3::Integer)i|i<-[0..4]])';
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    stdout: '0\n(True,False,True,False)\n[True,False,True,True,True]\n',
    uncaughtException: undefined,
  });
});

test.each([
  ['error "value"::Integer', '(-1)', 'value'],
  ['error "value"::Integer', 'error "index"', 'value'],
  ['0::Integer', 'error "index"', 'index'],
  ['1::Int', '(-1)', 'arithmetic overflow'],
  ['1::Word', '(-1)', 'arithmetic overflow'],
])('bit queries preserve argument demand: %s at %s', (value, index, uncaughtException) => {
  expect(executeProgram('haskell', `import Data.Bits\nmain=print(testBit(${value})(${index}))`)).toMatchObject({
    kind: 'executed',
    stdout: '',
    uncaughtException,
  });
});

test('Integer bit updates skip unchanged high bits and preserve signed word indices', () => {
  const source =
    'import Data.Bits\nmain=do\n  print(sum[clearBit(1::Integer)(1000000+i)|i<-[1..200::Int]])\n  print(clearBit(0::Integer)(error "index"),setBit(-1::Integer)(error "index"))\n  print(clearBit(1::Integer)100000000,setBit(-2::Integer)100000000)\n  print(testBit(-1::Integer)(-1),testBit(-3::Integer)(minBound::Int))\n  print(clearBit(-1::Integer)3,setBit(0::Integer)3,complementBit(5::Integer)2,bit 5::Integer)';
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    stdout: '200\n(0,-1)\n(1,-2)\n(True,True)\n(-9,8,1,32)\n',
    uncaughtException: undefined,
  });
});

test.each([
  ['clearBit(1::Integer)(-1)', 'heap overflow'],
  ['complementBit(0::Integer)(-1)', 'heap overflow'],
  ['complementBit(error "value"::Integer)(-1)', 'heap overflow'],
  ['complementBit(error "value"::Integer)(error "index")', 'index'],
  ['complementBit(error "value"::Integer)2', 'value'],
  ['bit(-1)::Integer', 'heap overflow'],
  ['clearBit(error "value"::Integer)(error "index")', 'value'],
  ['setBit(error "value"::Integer)(error "index")', 'value'],
  ['(error "left"::Integer) .&. 0', 'left'],
  ['(error "left"::Integer) .|. (-1)', 'left'],
])('Integer bit operations preserve demanded exceptions: %s', (expression, uncaughtException) => {
  expect(executeProgram('haskell', `import Data.Bits\nmain=print(${expression})`)).toMatchObject({
    kind: 'executed',
    stdout: '',
    uncaughtException,
  });
});

test('Integer logical identities skip only their undemanded right operand', () => {
  expect(
    executeProgram(
      'haskell',
      'import Data.Bits\nmain=print((0::Integer) .&. error "right",(-1::Integer) .|. error "right")'
    )
  ).toMatchObject({ kind: 'executed', stdout: '(0,-1)\n', uncaughtException: undefined });
});

test.each(['setBit(0::Integer)100000000', 'clearBit(-1::Integer)100000000', 'complementBit(0::Integer)100000000'])(
  'changed high bits remain allocation bounded: %s',
  (expression) => {
    expect(executeProgram('haskell', `import Data.Bits\nmain=print(${expression})`)).toMatchObject({
      kind: 'limitExceeded',
      limit: 'operations',
    });
  }
);

test.each([
  ['hh', '-257'],
  ['h', '-65537'],
  ['l', '-4294967297'],
  ['ll', '-18446744073709551617'],
  ['L', '-18446744073709551617'],
])('printf rejects negatives below the %s unsigned range', (modifier, value) => {
  for (const conversion of ['u', 'o', 'x', 'X', 'b']) {
    expect(
      executeProgram('haskell', `import Text.Printf\nmain=printf "%${modifier}${conversion}" (${value}::Integer)`)
    ).toMatchObject({ kind: 'executed', stdout: '', uncaughtException: 'printf: bad argument' });
  }
});

test('printf unsigned offsets retain lower boundaries and unbounded positive inputs', () => {
  const source =
    'import Text.Printf\nmain=do\n  printf "%hhu|%hhu|%hhu|%hhu\\n" (-256::Int) (-255::Integer) (-1::Int) (256::Integer)\n  printf "%hx|%lx|%llx|%Lx\\n" (-65536::Integer) (-4294967296::Integer) (-18446744073709551616::Integer) (-18446744073709551616::Integer)';
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    stdout: '0|1|255|256\n0|0|0|0\n',
    uncaughtException: undefined,
  });
});

test.each(['Float', 'Double'])('Down delegates partial floating comparisons for %s', (type) => {
  const source = `import Data.Ord\nimport Data.List\nmain=do\n  let n=Down(0/0::${type}); x=Down 1\n  print(n<x,n>x,n<=x,n>=x)\n  print(sort[n,x])`;
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    stdout: '(False,False,False,False)\n[Down NaN,Down 1.0]\n',
    uncaughtException: undefined,
  });
});

test('Down preserves independently defined ordering and extrema methods', () => {
  const source =
    'import Data.Ord\ndata K=K Int deriving(Eq,Show)\ninstance Ord K where\n compare _ _=EQ\n _ < _=True\n max(K x)(K y)=K(100+x)\n min(K x)(K y)=K(200+y)\nmain=print(Down(K 0)<Down(K 0),max(Down(K 1))(Down(K 2)),min(Down(K 1))(Down(K 2)))';
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    stdout: '(True,Down (K 201),Down (K 102))\n',
    uncaughtException: undefined,
  });
});

test.each([
  [String.raw`main=putStr ['\xd800','\xdc00']`, '??'],
  [String.raw`main=putChar '\xd800'`, '?'],
  [
    String.raw`import Data.Char
main=putStr "before" >> putChar(chr 55296) >> putStr "after"`,
    'before?after',
  ],
  [String.raw`main=putStr "a\xdfff\&b"`, 'a?b'],
  [
    String.raw`import System.IO
main=hPutStr stdout "\xd800\xdc00\x10000\xfffd"`,
    '??𐀀�',
  ],
])('output encodes each Haskell Char before buffering: %s', (source, stdout) => {
  expect(executeProgram('haskell', source)).toMatchObject({ kind: 'executed', stdout, uncaughtException: undefined });
});

test('output transliteration preserves internal code points and partial writes', () => {
  expect(
    executeProgram(
      'haskell',
      String.raw`import Data.Char
main=print(ord '\xd800',ord '\xdc00')`
    )
  ).toMatchObject({ kind: 'executed', stdout: '(55296,56320)\n', uncaughtException: undefined });
  expect(executeProgram('haskell', String.raw`main=putStr ('\xd800':error "tail")`)).toMatchObject({
    kind: 'executed',
    stdout: '?',
    uncaughtException: 'tail',
  });
});

test('string literals preserve escaped surrogate boundaries and supplementary characters', () => {
  const source = String.raw`import Data.Char
f "\xd800\xdc00"=1::Int
f _=2
main=do
  print(length "\xd800\xdc00",map ord "\xd800\xdc00",length "\x10000")
  print(f "\x10000",f ['\xd800','\xdc00'])`;
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    stdout: '(2,[55296,56320],1)\n(2,1)\n',
    uncaughtException: undefined,
  });
});

test.each(['showHex', 'showOct', 'showBin'])(
  'Numeric.%s retains the negative argument in diagnostics',
  (conversion) => {
    for (const value of ['-1', '-123456789012345678901234567890']) {
      expect(
        executeProgram('haskell', `import Numeric\nmain=putStrLn(${conversion}(${value}::Integer) "")`)
      ).toMatchObject({
        kind: 'executed',
        stdout: '',
        uncaughtException: `GHC.Internal.Numeric.showIntAtBase: applied to negative number ${value}`,
      });
    }
  }
);

test.each(['-2', '0', '1'])('Numeric base validation precedes number and digit demand: %s', (base) => {
  const source = `import Numeric\nmain=putStrLn(showIntAtBase (${base}::Int) (error "digit") (error "number") "")`;
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    stdout: '',
    uncaughtException: `GHC.Internal.Numeric.showIntAtBase: applied to unsupported base ${base}`,
  });
});

test('derived readers round-trip Unicode and ASCII symbolic constructors', () => {
  const source = String.raw`data T=Int :⊕ Int | Int :★ Int | Int :— Int | Int :‿ Int | Int :· Int | Int :€ Int | Int :¨ Int | Int :+ Int deriving(Show,Read)
main=mapM_ (\value -> print(read(show value)::T)) [1 :⊕ 2,1 :★ 2,1 :— 2,1 :‿ 2,1 :· 2,1 :€ 2,1 :¨ 2,1 :+ 2]`;
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    stdout: '1 :⊕ 2\n1 :★ 2\n1 :— 2\n1 :‿ 2\n1 :· 2\n1 :€ 2\n1 :¨ 2\n1 :+ 2\n',
    uncaughtException: undefined,
  });
});

test('lex preserves Unicode operator boundaries and excludes identifier and punctuation characters', () => {
  const source = 'main=mapM_ (print.lex) [":⊕rest","_name","[★]","‘rest","﹙rest"]';
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    stdout: '[(":\\8853","rest")]\n[("_name","")]\n[("[","\\9733]")]\n[]\n[]\n',
    uncaughtException: undefined,
  });
});

const lazyOrderingFields = `data K=K Int Int
instance Eq K where K a _==K b _=a==b
instance Ord K where
  compare(K a x)(K b y)=x \`seq\` y \`seq\` compare a b
  K a _ < K b _=a<b
`;

test.each([
  ['data Box=Box K deriving(Eq,Ord)', 'Box(K 1 undefined)', 'Box(K 2 undefined)'],
  ['data Box=Box () K deriving(Eq,Ord)', 'Box () (K 1 undefined)', 'Box () (K 2 undefined)'],
  ['data Box=Box K|Other K deriving(Eq,Ord)', 'Box(K 1 undefined)', 'Box(K 2 undefined)'],
  ['data Box=Box K|Other K|Last K deriving(Eq,Ord)', 'Box(K 1 undefined)', 'Box(K 2 undefined)'],
  ['', '((),K 1 undefined)', '((),K 2 undefined)'],
  [
    '',
    '(' + [...Array.from({ length: 14 }, () => '()'), 'K 1 undefined'].join(',') + ')',
    '(' + [...Array.from({ length: 14 }, () => '()'), 'K 2 undefined'].join(',') + ')',
  ],
  ['', 'Just(K 1 undefined)', 'Just(K 2 undefined)'],
  ['', '(Left(K 1 undefined)::Either K ())', 'Left(K 2 undefined)'],
  ['', '(Right(K 1 undefined)::Either () K)', 'Right(K 2 undefined)'],
])('derived-style relational methods use the last field less-than method: %s %s', (declaration, left, right) => {
  const source = `${lazyOrderingFields}${declaration}\nmain=let x=${left}; y=${right} in print(x<y,x<=y,x>y,x>=y)`;
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    stdout: '(True,True,False,False)\n',
    uncaughtException: undefined,
  });
  expect(
    executeProgram('haskell', `${lazyOrderingFields}${declaration}\nmain=print(compare (${left}) (${right}))`)
  ).toMatchObject({ kind: 'executed', stdout: '', uncaughtException: 'Prelude.undefined' });
});

test.each([
  ['data Box=Box K () deriving(Eq,Ord)', 'Box(K 1 undefined) ()', 'Box(K 2 undefined) ()'],
  ['data Box=Box K|B|C|D deriving(Eq,Ord)', 'Box(K 1 undefined)', 'Box(K 2 undefined)'],
])(
  'derived ordering retains comparison demand on nonterminal fields and large sums: %s',
  (declaration, left, right) => {
    expect(
      executeProgram('haskell', `${lazyOrderingFields}${declaration}\nmain=print((${left}) < (${right}))`)
    ).toMatchObject({ kind: 'executed', stdout: '', uncaughtException: 'Prelude.undefined' });
  }
);

test('large non-enumeration sums keep default relational argument order', () => {
  const source = 'data Box=Box Int|B|C|D deriving(Eq,Ord)\nmain=print((error "left"::Box)<=(error "right"))';
  expect(executeProgram('haskell', source)).toMatchObject({ kind: 'executed', stdout: '', uncaughtException: 'left' });
});

test.each([
  ['Rational', '', ['left', 'left', 'left', 'right']],
  ['Ratio Int', '', ['left', 'left', 'left', 'right']],
  ['[Int]', '', ['right', 'left', 'left', 'right']],
  ['Bool', '', ['left', 'right', 'right', 'left']],
  ['Ordering', '', ['left', 'right', 'right', 'left']],
  ['Maybe Int', '', ['left', 'right', 'right', 'left']],
  ['(Int,Int)', '', ['left', 'left', 'right', 'left']],
  ['(Int,Int,Int)', '', ['left', 'right', 'right', 'left']],
  [
    'K',
    'data K=K Int deriving Eq\ninstance Ord K where compare(K x)(K y)=compare x y',
    ['right', 'left', 'left', 'right'],
  ],
  ['K', 'data K=K Int deriving Eq\ninstance Ord K where K x <= K y = x<=y', ['right', 'left', 'left', 'right']],
  ['K', 'data K=A Int|B|C|D deriving(Eq,Ord)', ['right', 'left', 'left', 'right']],
])('Ord defaults and specialized %s methods preserve operand demand: %s', (type, declarations, exceptions) => {
  for (const [index, operator] of ['<', '<=', '>', '>='].entries()) {
    const source = `import Data.Ratio\n${declarations}\nmain=print((error "left"::${type})${operator}(error "right"))`;
    expect(executeProgram('haskell', source)).toMatchObject({
      kind: 'executed',
      stdout: '',
      uncaughtException: exceptions[index],
    });
  }
});

test('Ord relational defaults delegate to an explicit less-than-or-equal method', () => {
  const declarations = `data K=K Int Int
instance Eq K where K a _==K b _=a==b
instance Ord K where
  compare(K a x)(K b y)=x \`seq\` y \`seq\` compare a b
  K a _ <= K b _=a<=b`;
  expect(
    executeProgram('haskell', `${declarations}\nmain=let x=K 1 undefined; y=K 2 undefined in print(x<y,x<=y,x>y,x>=y)`)
  ).toMatchObject({ kind: 'executed', stdout: '(True,True,False,False)\n', uncaughtException: undefined });
  expect(executeProgram('haskell', `${declarations}\nmain=print(compare(K 1 undefined)(K 2 undefined))`)).toMatchObject(
    {
      kind: 'executed',
      stdout: '',
      uncaughtException: 'Prelude.undefined',
    }
  );
});

test.each([
  ['Int', ['start', 'start', 'next', 'next', 'start', 'start', 'start', 'start', 'next', '0']],
  ['Integer', ['start', 'start', '1', 'next', 'start', 'next', 'next', 'start', 'next', '0']],
  ['Word', ['start', 'start', 'next', 'next', 'start', 'start', 'start', 'start', 'next', '0']],
  ['Double', ['start', 'next', 'next', 'next', 'start', 'bound', 'next', 'bound', 'bound', '0']],
  ['Float', ['start', 'next', 'next', 'next', 'start', 'bound', 'next', 'bound', 'bound', '0']],
  ['Rational', ['start', 'start', 'next', 'next', 'start', 'bound', 'next', 'bound', 'bound', '0']],
  ['Ratio Int', ['start', 'start', 'next', 'next', 'start', 'bound', 'next', 'bound', 'bound', '0']],
  ['Char', ['start', 'start', 'next', 'next', 'start', 'start', 'start', 'start', 'next', '0']],
])('%s enumeration spines preserve GHC start, step and bound demand', (type, expected) => {
  const [zero, one, bound] = type === 'Char' ? ["'a'", "'b'", "'d'"] : ['0', '1', '3'];
  const cases: [string, number][] = [
    ['[error "start" ..]', 1],
    ['[error "start",error "next" ..]', 1],
    [`[${zero},error "next" ..]`, 1],
    [`[${zero},error "next" ..]`, 2],
    ['[error "start" .. error "bound"]', 1],
    ['[error "start",error "next" .. error "bound"]', 1],
    [`[error "start",error "next" .. ${bound}]`, 1],
    [`[error "start",${one} .. error "bound"]`, 1],
    [`[${zero},error "next" .. error "bound"]`, 1],
    ['[error "start",error "next" .. error "bound"]', 0],
  ];
  for (const [index, [range, count]] of cases.entries()) {
    const source = `import Data.Ratio\nmain=print(length(take ${count} (${range}::[${type}])))`;
    const result = expected[index];
    expect(executeProgram('haskell', source), source).toMatchObject({
      kind: 'executed',
      stdout: result === '0' || result === '1' ? `${result}\n` : '',
      uncaughtException: result === '0' || result === '1' ? undefined : result,
    });
  }
});

test('strict numeric enumeration spines retain finite values and floating-point stability', () => {
  const source = `import Data.Ratio
main=do
 print(take 5 [10,8..]::[Integer],[10,8..1]::[Integer])
 print(take 4 [1.25,1.5..]::[Double],[1.25,1.5..2]::[Double])
 print([2,1.75..1]::[Rational])
 print(take 5 [9007199254740990..]::[Double])`;
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    stdout:
      '([10,8,6,4,2],[10,8,6,4,2])\n([1.25,1.5,1.75,2.0],[1.25,1.5,1.75,2.0])\n[2 % 1,7 % 4,3 % 2,5 % 4,1 % 1]\n[9.00719925474099e15,9.007199254740991e15,9.007199254740992e15,9.007199254740992e15,9.007199254740994e15]\n',
    uncaughtException: undefined,
  });
});

test.each([
  ['Bool', 'first'],
  ['Ordering', 'second'],
  ['E', 'first'],
])('%s stepped enumeration retains its instance-specific endpoint demand', (type, uncaughtException) => {
  const source = `data E=A|B|C deriving(Enum,Bounded)\nmain=print(null([error "first",error "second"..]::[${type}]))`;
  expect(executeProgram('haskell', source)).toMatchObject({ kind: 'executed', stdout: '', uncaughtException });
});

test('Bool stepped enumeration preserves ascending, descending and repeated values', () => {
  const source = 'main=print([False,True ..],[True,False ..],take 3 [False,False ..],take 3 [True,True ..])';
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    stdout: '([False,True],[True,False],[False,False,False],[True,True,True])\n',
    uncaughtException: undefined,
  });
});
