import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

test.each([
  ['filter', 'Prelude.filter, M.filter', 'import qualified Data.Map as M'],
  ['filter', 'M.filter, Prelude.filter', 'import qualified Data.Map as M'],
  ['null', 'Prelude.null, M.null', 'import qualified Data.Map as M'],
  ['null', 'Prelude.null, Local(..), M.null', 'import qualified Data.Map as M\ndata Local=Local {null::Int}'],
  ['Maybe', 'Main.Maybe, Prelude.Maybe', 'data Maybe=Mine'],
  ['Foldable', 'Main.Foldable, Prelude.Foldable', 'data Foldable=Mine'],
  ['Just', 'Local(..), Prelude.Maybe(..)', 'data Local=Just Int'],
  ['Just', 'Prelude.Maybe(..), Local(..)', 'data Local=Just Int'],
  ['Just', 'Local(..), Prelude.Maybe(Prelude.Just)', 'data Local=Just Int'],
  ['null', 'C(..), Prelude.null', 'class C a where\n  null::a->Bool'],
  ['null', 'Prelude.null, C(..)', 'class C a where\n  null::a->Bool'],
  ['getDown', 'Local(..), D.Down(..)', 'import qualified Data.Ord as D\ndata Local=Local {getDown::Int}'],
  ['getDown', 'D.Down(..), Local(..)', 'import qualified Data.Ord as D\ndata Local=Local {getDown::Int}'],
])('different entities cannot share the exported name %s: %s', (name, exports, declarations) => {
  const source = `module Main(main, ${exports}) where\n${declarations}\nmain=print(1::Int)`;
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row: 0, message: expect.stringContaining(`${name} として異なる定義を export`) }],
  });
});

test.each([
  ['Prelude.filter, L.filter', 'import qualified Data.List as L'],
  ['L.Map, S.Map', 'import qualified Data.Map as L\nimport qualified Data.Map.Strict as S'],
  ['Maybe(..), Maybe(Just)', ''],
  ['Maybe(Just), Maybe(..)', ''],
  ['Main.Local(A), Main.Local(B)', 'data Local=A|B'],
  ['Local(..)', 'data Local=Local'],
  ['Local(..), Prelude.null', 'data Local=Local {null::Int}'],
  ['Prelude.null, Local(..)', 'data Local=Local {null::Int}'],
  ['D.Down(..), Main.getDown', 'import qualified Data.Ord as D\ngetDown x=x'],
  ['Main.getDown, D.Down(..)', 'import qualified Data.Ord as D\ngetDown x=x'],
])('exports retain legal repeated identities and distinct namespaces: %s', (exports, declarations) => {
  const source = `module Main(main, ${exports}) where\n${declarations}\nmain=print(1::Int)`;
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    stdout: '1\n',
    uncaughtException: undefined,
  });
});
