import { execFileSync } from 'node:child_process';

import { expect, test } from 'vitest';
import { z } from 'zod';

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
  ['[(),x]', '[]', '[(), x]'],
  [String.raw`['\x41',x]`, '""', String.raw`['\x41', x]`],
  ['[0x41,x]', '[]', '[0x41, x]'],
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

test.each([
  ['main=do\nprint 1', 1],
  ['main=do\n  print 1 >> do\n  print 2', 2],
  ['main=do\n  let f=do\n      print 2\n  f', 2],
  ['main=do\n  if True then print 1 else do\n  print 2', 2],
  ['main=do\n  print [1,\n  2]', 2],
  ['main=do\n  print(foldr (+) 0\n  [1,2])', 2],
  ['main=print [1,\n2]', 1],
  ['f default x=default+x\nmain=print(f 1 2)', 0],
  ['main=let foreign=1 in print foreign', 0],
  ['main=let forall=1 in print forall', 0],
])('GHC layout and reserved identifiers produce syntax errors: %s', (source, row) => {
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row, message: '書き方に誤りがあります。' }],
  });
});

test.each([
  ['module Main(main,M.fromMaybe) where\nimport qualified Data.Maybe as M\nmain=print 1', '1\n'],
  ['module Main(main,M.Maybe(..)) where\nimport qualified Data.Maybe as M\nmain=print 1', '1\n'],
  ['module Main(main,M.Maybe(M.Just)) where\nimport qualified Data.Maybe as M\nmain=print 1', '1\n'],
  ['module Main(main,Maybe(M.Just)) where\nimport qualified Data.Maybe as M\nmain=print 1', '1\n'],
  [
    'module Main(main,M.Maybe(N.Just)) where\nimport qualified Data.Maybe as M\nimport qualified Data.Maybe as N\nmain=print 1',
    '1\n',
  ],
  ['main=do {print [1,\n2]}', '[1,2]\n'],
  ['main=do\n  print [1,\n    2]', '[1,2]\n'],
  ['main=print(map(show.fst)[(1,2::Int)])', '["1"]\n'],
  ['main=print(length.show $ 12345)', '5\n'],
  ['main=print(sum.map (*2) $ [1,2])', '6\n'],
  ['main=print((.succ) (+1) 1)', '3\n'],
  ['main=print((succ.succ) 1)', '3\n'],
  ['main=print[x|x<-[1..3]]', '[1,2,3]\n'],
  ['pattern=2\nmdo=3\nrec=4\nmain=print(pattern+mdo+rec)', '9\n'],
  ['main=print$negate 1', '-1\n'],
  ['main=print$(sum [1,2])', '3\n'],
  ['import qualified Data.Map as M\nmain=print$(M.size.M.fromList)[(1,2)]', '1\n'],
  ['main=print(map (+1).filter odd $ [1..5])', '[2,4,6]\n'],
  ['main=print(sum.map (*2).filter odd $ [1..5])', '18\n'],
  ['main=do\n  if True\n  then print 1\n  else print 2', '1\n'],
  ['f x=if x>0\nthen 1\nelse 2\nmain=print(f 1)', '1\n'],
  ['main=do\n  let y=if True\n      then 1\n      else 2\n  print y', '1\n'],
  ['main=print(case True of\n  True -> if True\n  then 1\n  else 2\n  False -> 3)', '1\n'],
])('supported syntax retains GHC meaning: %s', (source, stdout) => {
  expect(executeProgram('haskell', source)).toMatchObject({ kind: 'executed', stdout, uncaughtException: undefined });
});

test('ambiguous imports exclude origins from other qualified scopes', () => {
  const source =
    'import qualified Data.List as L\nfilter p xs = [x | x <- xs, p x]\nmain=print(filter even [1,2::Int])';
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row: 2, message: 'filter が、Prelude.filter と Main.filter のどれを指すか決まりません。' }],
  });
});

test.each(['disjoint', 'compose'])('explicit imports reject unsupported values: %s', (name) => {
  expect(executeProgram('haskell', `import Data.Map (${name})\nmain=print 1`)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row: 0, message: `ライブラリ関数（Data.Map.${name}）は、この採点環境では使えません。` }],
  });
  expect(executeProgram('haskell', `import Data.Map hiding (${name})\nmain=print 1`)).toMatchObject({
    kind: 'executed',
    stdout: '1\n',
    uncaughtException: undefined,
  });
});

test('class fixities cannot change another class method', () => {
  const source =
    'class A a where\n  foo :: a -> a -> a\nclass B a where\n  infixl 4 `foo`\n  bar :: a -> a\nmain=print 1';
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row: 3, message: expect.stringContaining('foo') }],
  });
});

test.each([
  ['import Numeric\nf :: Floating a => a -> a\nf x=sqrt x\nmain=print(f 4,showHex 255 "")', '(2.0,"ff")\n'],
  ['import Text.Read\ng :: ReadS Int\ng=reads\nmain=print(g "1 x",readMaybe "2"::Maybe Int)', '([(1," x")],Just 2)\n'],
])('public type re-exports retain their implementation identity: %s', (source, stdout) => {
  expect(executeProgram('haskell', source)).toMatchObject({ kind: 'executed', stdout, uncaughtException: undefined });
});

test('string pattern failures preserve lexical escape spelling', () => {
  const result = executeProgram('haskell', String.raw`main=print (let ["\x80\&0",x]=[] in length x)`);
  expect(result).toMatchObject({
    kind: 'executed',
    stdout: '',
    uncaughtException: expect.stringContaining(String.raw`Non-exhaustive patterns in ["\x80\&0", x]`),
  });
});

test.each([
  ['data P=P {\nx :: Int\n} deriving Show\nmain=print(P {\nx=1\n})', 'P {x = 1}\n'],
  ['main=do {\n print 1;\n print 2\n}', '1\n2\n'],
  ['main=do\n  let {\nx=1\n}\n  print x', '1\n'],
  ['f x=case x of {\n True -> 1;\n False -> 2\n}\nmain=print(f True)', '1\n'],
  ['data P=P {x::Int}\nmain=do\n  let p=P {\nx=1\n}\n  print(case p of P {\nx=y\n} -> y)', '1\n'],
])('explicit braces suspend outer layout while preserving nested blocks: %s', (source, stdout) => {
  expect(executeProgram('haskell', source)).toMatchObject({ kind: 'executed', stdout, uncaughtException: undefined });
});

test('implicit blocks inside braces still enforce their own layout', () => {
  expect(executeProgram('haskell', 'main=do {\n print 1;\n let x=[1,\n     2];\n print x\n}').kind).toBe(
    'compileError'
  );
});

test.each([
  'import Data.List (\n  sort\n)\nmain=print(sort [2,1])',
  'import Data.List (sort,\nsortBy)\nmain=print(sort [2,1])',
])('import continuations obey module layout: %s', (source) => {
  expect(executeProgram('haskell', source).kind).toBe('compileError');
});

test('indented import continuations remain valid', () => {
  expect(executeProgram('haskell', 'import Data.List (\n  sort\n  )\nmain=print(sort [2,1])')).toMatchObject({
    kind: 'executed',
    stdout: '[1,2]\n',
    uncaughtException: undefined,
  });
});

test.each([
  'f R{b=0,a=0}=1\nf _=2\nmain=print(f(R(error "a")1))',
  'main=print(case R(error "a")1 of R{b=0,a=0}->1;_->2)',
  'main=print(let R{b=0,a=x}=R(error "a")1 in x)',
])('record patterns match fields in their written order: %s', (body) => {
  const result = executeProgram('haskell', `data R=R {a::Int,b::Int}\n${body}`);
  if (body.startsWith('main=print(let'))
    expect(result).toMatchObject({
      kind: 'executed',
      stdout: '',
      uncaughtException: expect.stringContaining('Non-exhaustive patterns'),
    });
  else expect(result).toMatchObject({ kind: 'executed', stdout: '2\n', uncaughtException: undefined });
});

test.each(['\t', '\r', '\u007F', '\u0085', '\u200B', '\u2028'])(
  'raw nongraphic characters are rejected in literals: %j',
  (char) => {
    expect(executeProgram('haskell', `main=print "a${char}b"`).kind).toBe('compileError');
    expect(executeProgram('haskell', `main=print '${char}'`).kind).toBe('compileError');
  }
);

test.each([
  ['main=putStr "😀" >> print(case [] of x:_->x::Int)', '😀', 'Main.hs:1:26-47: Non-exhaustive patterns in case'],
  ['main\t= print(case [] of x:_->x::Int)', '', 'Main.hs:1:17-38: Non-exhaustive patterns in case'],
  ['main=print(let [x]=("😀" `seq` []) in (x::Int))', '', 'Main.hs:1:16-33: Non-exhaustive patterns in [x]'],
  ['main = do\n\tprint (let [x]=[] in (x::Int))', '', 'Main.hs:2:20-25: Non-exhaustive patterns in [x]'],
])('source spans count code points and tab stops: %s', (source, stdout, uncaughtException) => {
  expect(executeProgram('haskell', source)).toMatchObject({ kind: 'executed', stdout, uncaughtException });
});

test.each([
  ['if True then 1 else 2', '1\n'],
  ['case True of {True->1;False->2}', '1\n'],
  ['do 1', '1\n'],
  ['let x=1 in x', '1\n'],
])('block arguments require parentheses or an infix operator: %s', (expression, stdout) => {
  expect(executeProgram('haskell', `main=print ${expression}`).kind).toBe('compileError');
  expect(executeProgram('haskell', `main=print(${expression})`)).toMatchObject({
    kind: 'executed',
    stdout,
    uncaughtException: undefined,
  });
  expect(executeProgram('haskell', `main=print $ ${expression}`)).toMatchObject({
    kind: 'executed',
    stdout,
    uncaughtException: undefined,
  });
});

test.each(['Data.List (Foldable)', 'Data.Char (String)', 'Control.Monad ((<$>))'])(
  'explicit imports reject names absent from the GHC module: %s',
  (item) => {
    expect(executeProgram('haskell', `import ${item}\nmain=print 1`).kind).toBe('compileError');
  }
);

test('source modules follow runghc main export rules', () => {
  expect(
    executeProgram('haskell', 'module Geometry(main,area) where\narea r=pi*r*r\nmain=print(area 1::Double)')
  ).toMatchObject({ kind: 'executed', stdout: '3.141592653589793\n', uncaughtException: undefined });
  expect(executeProgram('haskell', 'module Example() where\nmain=print(1::Int)')).toMatchObject({
    kind: 'executed',
    stdout: '1\n',
    uncaughtException: undefined,
  });
  expect(executeProgram('haskell', 'module Main() where\nmain=print 1').kind).toBe('compileError');
});

test.each([
  'main::Monad m=>m ()\nmain=return ()',
  'main::Num a=>IO a\nmain=return 1',
  'main=(return 1::Num a=>IO a)',
  'main=((do return 1)::Num a=>IO a)',
  'main=(do return 1::Num a=>IO a)',
  'main=do\n  (if True then return 1 else return 2::Num a=>IO a)',
])('entry and IO annotations retain dictionary evidence: %s', (source) => {
  expect(executeProgram('haskell', source)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
});

test.each([
  'module Example(x) where\n(main,x)=(putStrLn "ok",1::Int)',
  'module Example() where\nJust main=Just(putStrLn "ok")',
])('named modules run their unexported pattern-bound main: %s', (source) => {
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    stdout: 'ok\n',
    uncaughtException: undefined,
  });
});

test.each(['[R..B]', '[R..]', '[R,G..B]', '[R,G..]', '[R.. B]', '[Main.R..Main.B]'])(
  'constructor-adjacent range dots follow qualified lexical syntax: %s',
  (range) => {
    expect(executeProgram('haskell', `data C=R|G|B deriving(Show,Enum)\nmain=print ${range}`).kind).toBe(
      'compileError'
    );
  }
);

test.each(['[R ..B]', '[R,G ..B]', '[x..y]', '[(R)..B]', '[Main.R ..Main.B]'])(
  'range dots remain valid after whitespace and variables: %s',
  (range) => {
    expect(executeProgram('haskell', `data C=R|G|B deriving(Show,Enum)\nx=R\ny=B\nmain=print ${range}`)).toMatchObject({
      kind: 'executed',
      stdout: '[R,G,B]\n',
      uncaughtException: undefined,
    });
  }
);

test.each([
  ['Text.Printf (PrintfArg(formatArg))', 'formatArg'],
  ['Text.Printf (PrintfArg(parseFormat))', 'parseFormat'],
  ['Text.Read (Read(readPrec))', 'readPrec'],
  ['Text.Read (Read(readListPrec))', 'readListPrec'],
  ['Text.Read (Read(..))', 'readListPrec'],
])('known class methods retain unsupported diagnostics: %s', (item, method) => {
  const result = executeProgram('haskell', `import ${item}\nmain=print(1::Int)`);
  expect(result).toMatchObject({
    kind: 'compileError',
    diagnostics: expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining('この採点環境では使えません') }),
    ]),
  });
  if (result.kind === 'compileError')
    expect(result.diagnostics.some(({ message }) => message.includes(method))).toBe(true);
});

test.each(['Text.Read (Read(readsPrec))', 'Text.Printf (PrintfArg)', 'Text.Read hiding (Read(readPrec))'])(
  'supported and hidden class selections remain usable: %s',
  (item) => {
    expect(executeProgram('haskell', `import ${item}\nmain=print(1::Int)`)).toMatchObject({
      kind: 'executed',
      stdout: '1\n',
      uncaughtException: undefined,
    });
  }
);

test.each([false, true])(
  'long binding chains compile without host recursion (cyclic=%s)',
  { timeout: 30_000 },
  (cyclic) => {
    const count = 30_000;
    const source =
      Array.from({ length: count }, (_, index) => `x${index}=x${index + 1}`).join('\n') +
      `\nx${count}=${cyclic ? 'x0' : '1'}\nmain=print(1::Int)`;
    expect(executeProgram('haskell', source)).toMatchObject({
      kind: 'executed',
      stdout: '1\n',
      uncaughtException: undefined,
    });
  }
);

test.each([
  '  import Data.List\n  main=print(1::Int)',
  'module Main where\n  import Data.List\n  main=print(1::Int)',
  'main=do\n{ print(1::Int) }',
  'main=case 1 of\n{ 1->print(1::Int); _->print(2::Int) }',
  'main=print x where\n{ x=1::Int }',
  'main=print(let\n{ x=1::Int } in x)',
  'class C a where\n{ m::a->Int }\ninstance C Int where\n{ m _=1 }\nmain=print(m(0::Int))',
  'module Main where\n{ main::IO (); main=print(1::Int) }\n-- trailing comment\n',
  'module Main(main,) where\nimport Data.List(sort,)\nmain=print(head(sort[1::Int]))',
])('grammar releases preserve valid module and block layouts: %s', (source) => {
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    stdout: '1\n',
    uncaughtException: undefined,
  });
});

test.each([
  '  import Data.List\nmain=print(1::Int)',
  'module Main where { main=print(1::Int)',
  'main=print[1,2,3,]',
  'main=case [1::Int] of { [a,]->print a }',
  'data T=T { a::Int,b::Int, } deriving Show\nmain=print(T 1 2)',
  'main=print(let [x,y,]=[1,2::Int] in x)',
  'main=print[(x,y)|x<-[1,2::Int],y<-[3,],True]',
])('grammar releases reject malformed module and comma syntax: %s', (source) => {
  expect(executeProgram('haskell', source).kind).toBe('compileError');
});

test.each([
  ['Text.Read', 'Read', 'readPrec'],
  ['Text.Read', 'Read', 'readListPrec'],
  ['Text.Printf', 'PrintfArg', 'formatArg'],
  ['Text.Printf', 'PrintfArg', 'parseFormat'],
  ['qualified Text.Read', 'Read', 'readPrec'],
])('known instance methods retain unsupported diagnostics: %s.%s.%s', (module, cls, method) => {
  const result = executeProgram(
    'haskell',
    `import ${module}\ndata T=T\ninstance ${cls} T where ${method}=undefined\nmain=print(1::Int)`
  );
  expect(result).toMatchObject({
    kind: 'compileError',
    diagnostics: expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining('この採点環境では使えません') }),
    ]),
  });
  if (result.kind === 'compileError')
    expect(result.diagnostics.some(({ message }) => message.includes(method))).toBe(true);
});

test('implemented Read instance methods preserve dictionary slots', () => {
  expect(
    executeProgram(
      'haskell',
      'import Text.Read\ndata T=T deriving Show\ninstance Read T where readsPrec _ _=[(T,"")]\nmain=print(read "ignored"::T)'
    )
  ).toMatchObject({ kind: 'executed', stdout: 'T\n', uncaughtException: undefined });
});

test('hidden instance methods remain unavailable', () => {
  const result = executeProgram(
    'haskell',
    'import Text.Read hiding (readPrec)\ndata T=T\ninstance Read T where readPrec=undefined\nmain=print(1::Int)'
  );
  expect(result).toMatchObject({
    kind: 'compileError',
    diagnostics: expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining('見えるメソッドではありません') }),
    ]),
  });
});

test.each([
  ['case', 'case 1 of\n{ 1->print(1::Int); _->print 2 }'],
  ['let', 'let\n{ x=1::Int }\n  print x'],
  ['where', 'let f=x where\n{ x=1::Int }\n  print f'],
])('opening %s braces cannot dedent left of enclosing layout', (_name, block) => {
  expect(executeProgram('haskell', `main=do\n  ${block}`).kind).toBe('compileError');
});

test.each([
  'case 1 of\n  { 1->print(1::Int); _->print 2 }',
  'let\n  { x=1::Int }\n  print x',
  'let f=x where\n      { x=1::Int }\n  print f',
])('opening braces at or right of enclosing layout remain valid: %s', (block) => {
  expect(executeProgram('haskell', `main=do\n  ${block}`)).toMatchObject({
    kind: 'executed',
    stdout: '1\n',
    uncaughtException: undefined,
  });
});

test.each([2, 4])('explicit opening braces respect enclosing indentation %i', (indent) => {
  const prefix = `main=do\n${' '.repeat(indent)}do\n`;
  for (const column of [0, indent - 1]) {
    const source = `${prefix}${' '.repeat(column)}{ print(1::Int) }`;
    expect(executeProgram('haskell', source).kind).toBe('compileError');
  }
  for (const column of [indent, indent + 2]) {
    const source = `${prefix}${' '.repeat(column)}{ print(1::Int) }`;
    expect(executeProgram('haskell', source)).toMatchObject({
      kind: 'executed',
      stdout: '1\n',
      uncaughtException: undefined,
    });
  }
});

test.each([
  'import Data.Ord hiding (Down)\nmain=print(Down(1::Int))',
  'import Data.Ord hiding (Down(..))\nmain=print(Down(1::Int))',
  'import Data.Ord hiding (Down(Down))\nmain=print(Down(1::Int))',
  'import qualified Data.Ord as O hiding (Down)\nmain=print(O.Down(1::Int))',
  'import Data.Ord hiding (Down)\nmain=print(undefined::Down Int)',
  'import qualified Data.Ord as O hiding (Down)\nmain=print(undefined::O.Down Int)',
  'import Data.Ord (Down)\nmain=print(Down(1::Int))',
])('type hiding removes same-named constructors without widening explicit imports: %s', (source) => {
  expect(executeProgram('haskell', source).kind).toBe('compileError');
});

test.each([
  ['import Data.Ord (Down(..))\nmain=print(Down(1::Int))', 'Down 1\n'],
  ['import Data.Ord hiding (Down())\nmain=print(Down(1::Int))', 'Down 1\n'],
  ['import Data.Ord hiding (Down)\nmain=print(comparing id (1::Int) 1)', 'EQ\n'],
  ['import qualified Data.Ord as O hiding (Down)\nmain=print(O.comparing id (1::Int) 1)', 'EQ\n'],
])('constructor selection and unrelated imports remain usable: %s', (source, stdout) => {
  expect(executeProgram('haskell', source)).toMatchObject({ kind: 'executed', stdout, uncaughtException: undefined });
});

test.each(['inits1', 'tails1'])('NonEmpty-producing %s reports its missing API', (name) => {
  for (const source of [
    `import Data.List\nmain=print(${name} [1,2::Int])`,
    `import Data.List (${name})\nmain=print(1::Int)`,
  ]) {
    const result = executeProgram('haskell', source);
    expect(result).toMatchObject({
      kind: 'compileError',
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining('この採点環境では使えません') }),
      ]),
    });
    if (result.kind === 'compileError')
      expect(result.diagnostics.some(({ message }) => message.includes(name))).toBe(true);
  }
});

test.each([
  'System.IO hiding (IOMode(ReadMode))',
  'System.IO hiding (SeekMode(AbsoluteSeek))',
  'System.IO hiding (NewlineMode(inputNL))',
  'Text.Read hiding (Lexeme(Ident))',
  'Text.Printf hiding (FieldFormat(fmtChar))',
  'Text.Printf hiding (FormatParse(fpRest))',
  'Control.Applicative hiding (Const(getConst))',
  'Data.Tuple hiding (Solo(MkSolo))',
  'Data.Bits hiding (And(getAnd))',
  'Data.Set hiding (Intersection(getIntersection))',
])('unsupported type children can be hidden: %s', (item) => {
  expect(executeProgram('haskell', `import ${item}\nmain=print(1::Int)`)).toMatchObject({
    kind: 'executed',
    stdout: '1\n',
    uncaughtException: undefined,
  });
});

test.each(['System.IO (IOMode(ReadMode))', 'Text.Read (Lexeme(Ident))', 'Text.Printf (FieldFormat(fmtChar))'])(
  'selecting unsupported type children still rejects use: %s',
  (item) => {
    expect(executeProgram('haskell', `import ${item}\nmain=print(1::Int)`)).toMatchObject({
      kind: 'compileError',
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining('この採点環境では使えません') }),
      ]),
    });
  }
);

test.each(['T', 't'])('record braces require continuation indentation: %s', (record) => {
  const prefix = 'data T=T {a::Int} deriving Show\nmain=do\n  let t=T 1\n';
  expect(executeProgram('haskell', `${prefix}  print(${record}\n  {a=2})`).kind).toBe('compileError');
  expect(executeProgram('haskell', `${prefix}  print(${record}\n   {a=2})`)).toMatchObject({
    kind: 'executed',
    stdout: 'T {a = 2}\n',
    uncaughtException: undefined,
  });
});

test.each([2000, 3000])('large pattern bindings share their match (%i variables)', { timeout: 30_000 }, (count) => {
  const pattern = `[${Array.from({ length: count }, (_, index) => `x${index}`).join(',')}]=[1..${count}::Int]`;
  const result = `(x0,x${count - 1},x0)`;
  for (const source of [`${pattern}\nmain=print${result}`, `main=print(let ${pattern} in ${result})`]) {
    expect(executeProgram('haskell', source)).toMatchObject({
      kind: 'executed',
      stdout: `(1,${count},1)\n`,
      uncaughtException: undefined,
    });
  }
});

test('shared pattern matches remain deferred and retain full-pattern failures', () => {
  expect(executeProgram('haskell', 'main=print(let (x,Just y)=(1,Nothing::Maybe Int) in 1::Int)')).toMatchObject({
    kind: 'executed',
    stdout: '1\n',
    uncaughtException: undefined,
  });
  for (const target of ['x', 'y']) {
    expect(
      executeProgram('haskell', `main=print(let (x,Just y)=(1::Int,Nothing::Maybe Int) in ${target})`)
    ).toMatchObject({
      kind: 'executed',
      stdout: '',
      uncaughtException: expect.stringContaining('Non-exhaustive patterns'),
    });
  }
});

test.each([
  'Data.Tuple hiding (Solo(getSolo))',
  'qualified Data.Tuple hiding (Solo(wibble))',
  'Data.Ord hiding (Down(imaginary))',
  'Data.Ord hiding (Unknown(getDown))',
])('unknown hiding children are ignored: %s', (item) => {
  expect(executeProgram('haskell', `import ${item}\nmain=print(1::Int)`)).toMatchObject({
    kind: 'executed',
    stdout: '1\n',
    uncaughtException: undefined,
  });
});

test('a non-child hiding name leaves its independent value imported', () => {
  expect(
    executeProgram('haskell', 'import Data.Ord hiding (Down(comparing))\nmain=print(comparing id (1::Int) 1)')
  ).toMatchObject({ kind: 'executed', stdout: 'EQ\n', uncaughtException: undefined });
});

test('compact shared types compile without exponential memory growth', { timeout: 30_000 }, () => {
  const output = execFileSync('bun', ['run', 'test/helpers/haskellCompilerMemory.ts'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  const result = z
    .object({ kind: z.literal('executed'), stdout: z.literal('1\n'), peakRatio: z.number() })
    .parse(JSON.parse(output));
  expect(result.peakRatio).toBeLessThan(1.5);
});

test('shared polymorphic types remain independent across instantiations', () => {
  const count = 24;
  const duplicate = 'f ('.repeat(count) + 'x' + ')'.repeat(count);
  const project = (value: string): string => 'fst ('.repeat(count) + `g ${value}` + ')'.repeat(count);
  const source = `f x=(x,x)\ng x=${duplicate}\nmain=print(${project('True')},${project("'x'")})`;
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    stdout: "(True,'x')\n",
    uncaughtException: undefined,
  });
});

test('compiler work limits contain expanding diagnostics and constraints and reset between programs', () => {
  const value = 'f ('.repeat(30) + 'True' + ')'.repeat(30);
  for (const main of ['main=print(y::Int)', 'main=print(y==y)']) {
    expect(executeProgram('haskell', `f x=(x,x)\ny=${value}\n${main}`)).toMatchObject({
      kind: 'limitExceeded',
      limit: 'operations',
    });
    expect(executeProgram('haskell', 'main=print(1::Int)')).toMatchObject({
      kind: 'executed',
      stdout: '1\n',
      uncaughtException: undefined,
    });
  }
});
