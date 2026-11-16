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
