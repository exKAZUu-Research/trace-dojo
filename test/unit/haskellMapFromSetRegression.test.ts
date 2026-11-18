import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

const cases = [
  {
    name: 'three keys after root succeeds',
    source: `import qualified Data.Set as S
import qualified Data.Map.Strict as M
main=let m=M.fromSet(\\k->if k/=2 then error(show k) else 0::Int)(S.fromList([1,2,3]::[Int])) in print(M.size m)`,
    stdout: '',
    uncaughtException: '3',
  },
  {
    name: 'odd keys after root succeeds',
    source: `import qualified Data.Set as S
import qualified Data.Map.Strict as M
main=let m=M.fromSet(\\k->if odd k then error(show k) else 0::Int)(S.fromList([1..7]::[Int])) in print(M.size m)`,
    stdout: '',
    uncaughtException: '7',
  },
  {
    name: 'only root succeeds',
    source: `import qualified Data.Set as S
import qualified Data.Map.Strict as M
main=let m=M.fromSet(\\k->if k/=4 then error(show k) else 0::Int)(S.fromList([1..7]::[Int])) in print(M.size m)`,
    stdout: '',
    uncaughtException: '6',
  },
  {
    name: 'mixed insertion order',
    source: `import qualified Data.Set as S
import qualified Data.Map.Strict as M
main=let m=M.fromSet(\\k->if even k then error(show k) else 0::Int)(S.fromList([7,3,1,6,4,2,5]::[Int])) in print(M.size m)`,
    stdout: '',
    uncaughtException: '6',
  },
  {
    name: 'root fails before subtrees',
    source: `import qualified Data.Set as S
import qualified Data.Map.Strict as M
main=let m=M.fromSet(\\k->if True then error(show k) else 0::Int)(S.fromList([1..7]::[Int])) in print(M.size m)`,
    stdout: '',
    uncaughtException: '4',
  },
  {
    name: 'power-set keys of 3 elements',
    source: `import qualified Data.Set as S
import qualified Data.Map.Strict as M
main=let m=M.fromSet(\\k->if S.size k \`mod\` 3==0 then error(show k) else 0::Int)(S.powerSet(S.fromList[1..3::Int])) in print(M.size m)`,
    stdout: '',
    uncaughtException: 'fromList [1,2,3]',
  },
  {
    name: 'power-set keys of 4 elements',
    source: `import qualified Data.Set as S
import qualified Data.Map.Strict as M
main=let m=M.fromSet(\\k->if S.size k \`mod\` 3==0 then error(show k) else 0::Int)(S.powerSet(S.fromList[1..4::Int])) in print(M.size m)`,
    stdout: '',
    uncaughtException: 'fromList [2,3,4]',
  },
  {
    name: 'power-set keys of 5 elements',
    source: `import qualified Data.Set as S
import qualified Data.Map.Strict as M
main=let m=M.fromSet(\\k->if S.size k \`mod\` 3==0 then error(show k) else 0::Int)(S.powerSet(S.fromList[1..5::Int])) in print(M.size m)`,
    stdout: '',
    uncaughtException: 'fromList [3,4,5]',
  },
  {
    name: 'power-set keys of 6 elements',
    source: `import qualified Data.Set as S
import qualified Data.Map.Strict as M
main=let m=M.fromSet(\\k->if S.size k \`mod\` 3==0 then error(show k) else 0::Int)(S.powerSet(S.fromList[1..6::Int])) in print(M.size m)`,
    stdout: '',
    uncaughtException: 'fromList [4,5,6]',
  },
  {
    name: 'power set from reverse insertion',
    source: `import qualified Data.Set as S
import qualified Data.Map.Strict as M
main=let m=M.fromSet(\\k->if S.size k \`mod\` 3==0 then error(show k) else 0::Int)(S.powerSet(S.fromList[6,5..1::Int])) in print(M.size m)`,
    stdout: '',
    uncaughtException: 'fromList [4,5,6]',
  },
  {
    name: 'Data.Map retains values and order',
    source: `import qualified Data.Set as S
import qualified Data.Map as M
main=let m=M.fromSet (\\k->k*2)(S.fromList[3,1,4,2::Int]) in print(M.size m,M.toAscList m)`,
    stdout: '(4,[(1,2),(2,4),(3,6),(4,8)])\n',
    uncaughtException: undefined,
  },
  {
    name: 'Data.Map.Strict retains values and order',
    source: `import qualified Data.Set as S
import qualified Data.Map.Strict as M
main=let m=M.fromSet (\\k->k*2)(S.fromList[3,1,4,2::Int]) in print(M.size m,M.toAscList m)`,
    stdout: '(4,[(1,2),(2,4),(3,6),(4,8)])\n',
    uncaughtException: undefined,
  },
  {
    name: 'Data.Map empty input leaves function unevaluated',
    source: `import qualified Data.Set as S
import qualified Data.Map as M
main=let m=M.fromSet (undefined::Int->Int)(S.empty::S.Set Int) in print(M.size m)`,
    stdout: '0\n',
    uncaughtException: undefined,
  },
  {
    name: 'Data.Map.Strict empty input leaves function unevaluated',
    source: `import qualified Data.Set as S
import qualified Data.Map.Strict as M
main=let m=M.fromSet (undefined::Int->Int)(S.empty::S.Set Int) in print(M.size m)`,
    stdout: '0\n',
    uncaughtException: undefined,
  },
  {
    name: 'lazy map leaves partial payloads unevaluated',
    source: `import qualified Data.Set as S
import qualified Data.Map as M
main=let m=M.fromSet (\\_ -> error "value"::Int)(S.fromList[1..7::Int]) in print(M.size m,M.keys m)`,
    stdout: '(7,[1,2,3,4,5,6,7])\n',
    uncaughtException: undefined,
  },
  {
    name: 'input is demanded before function',
    source: `import qualified Data.Set as S
import qualified Data.Map.Strict as M
main=let m=M.fromSet (error "function"::Int->Int)(error "set") in print(M.size m)`,
    stdout: '',
    uncaughtException: 'set',
  },
];

test.each(cases)('Map.fromSet preserves GHC demand: $name', ({ source, stdout, uncaughtException }) => {
  expect(executeProgram('haskell', source)).toMatchObject({ kind: 'executed', stdout, uncaughtException });
});
