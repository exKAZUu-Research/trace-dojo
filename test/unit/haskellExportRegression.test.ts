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

test('large child lists resolve while repeated wildcard expansion stays bounded', { timeout: 30_000 }, () => {
  const constructors = Array.from({ length: 6000 }, (_, index) => `C${index}`);
  const declarations = `data T=${constructors.join('|')}\nmain=print(1::Int)`;
  const named = `module Main(main,T(${constructors.join(',')})) where\n${declarations}`;
  expect(executeProgram('haskell', named)).toMatchObject({
    kind: 'executed',
    stdout: '1\n',
    uncaughtException: undefined,
  });
  const repeated = `module Main(main,${constructors.map(() => 'T(..)').join(',')}) where\n${declarations}`;
  expect(executeProgram('haskell', repeated)).toMatchObject({ kind: 'limitExceeded', limit: 'operations' });
});

test.each([
  ['T(null)', 'data T=T {null::Int}'],
  ['T(length)', 'data T=T {length::Int}'],
  ['T(Main.null)', 'data T=T {null::Int}'],
  ['Main.T(null)', 'data T=T {null::Int}'],
  ['C(null)', 'class C a where\n null::a->Bool'],
  ['T(Just)', 'data T=Just Int'],
  ['Prelude.Maybe(Just)', 'data T=Just Int'],
  ['D.Down(getDown)', 'import qualified Data.Ord as D'],
  ['D.Down(D.getDown)', 'import qualified Data.Ord as D'],
  ['D.Down(getDown)', 'import qualified Data.Ord as D\ndata T=T {getDown::Int}'],
  ['Down(getDown)', 'import Data.Ord(Down)\nimport qualified Data.Ord as D(Down(..))'],
  ['Down(D.getDown)', 'import Data.Ord(Down)\nimport qualified Data.Ord as D(Down(..))'],
  ['A.Down(getDown)', 'import qualified Data.Ord as A(Down)\nimport qualified Data.Ord as B(Down(..))'],
  ['A.Down(B.getDown)', 'import qualified Data.Ord as A(Down)\nimport qualified Data.Ord as B(Down(..))'],
])('explicit export children resolve within their parent: %s', (exports, declarations) => {
  const source = `module Main(main,${exports}) where\n${declarations}\nmain=print(1::Int)`;
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    stdout: '1\n',
    uncaughtException: undefined,
  });
});

test.each([
  ['T(Prelude.null)', 'data T=T {null::Int}'],
  ['T(Wrong.null)', 'data T=T {null::Int}'],
  ['T(D.null)', 'import qualified Data.Ord as D\ndata T=T {null::Int}'],
  ['D.Down(getDown)', 'import qualified Data.Ord as D(Down)'],
  ['T(..),Down(..)', 'import Data.Ord(Down)\nimport qualified Data.Ord as D(Down(..))\ndata T=T {getDown::Int}'],
  [
    'T(..),A.Down(..)',
    'import qualified Data.Ord as A(Down)\nimport qualified Data.Ord as B(Down(..))\ndata T=T {getDown::Int}',
  ],
])('export child selection preserves visibility and conflicts: %s', (exports, declarations) => {
  const source = `module Main(main,${exports}) where\n${declarations}\nmain=print(1::Int)`;
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'compileError',
    diagnostics: [expect.objectContaining({ row: 0 })],
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

test.each(['compose', 'disjoint', 'isProperSubmapOf', 'filterKeys', 'splitRoot'])(
  'unsupported Map re-exports preserve the identity of %s',
  (name) => {
    const single = executeProgram('haskell', `import Data.Map\nx=${name}\nmain=print(1::Int)`);
    const combined = executeProgram(
      'haskell',
      `import Data.Map\nimport Data.Map.Strict\nx=${name}\nmain=print(1::Int)`
    );
    expect(single.kind).toBe('compileError');
    if (single.kind !== 'compileError') throw new Error('Expected an unsupported API diagnostic');
    expect(combined).toMatchObject({
      kind: 'compileError',
      diagnostics: [{ message: single.diagnostics[0].message }],
    });
    expect(single.diagnostics[0].message).toContain('この採点環境では使えません');
  }
);

test.each([
  ['import Data.Map\nimport Data.Map.Strict', 'fromAscListWith'],
  ['import Data.Map\nimport Data.Map.Strict', 'differenceWithKey'],
  ['import Data.Map\nimport Data.Set', 'splitRoot'],
])('distinct unsupported exports remain ambiguous: %s / %s', (imports, name) => {
  const source = `${imports}\nx=${name}\nmain=print(1::Int)`;
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ message: expect.stringContaining('どれを指すか') }],
  });
});

test.each([
  ['import Text.Printf', 'fmtChar', "'x'"],
  ['import qualified Text.Printf as P', 'P.fpRest', '""'],
  ['import System.IO', 'inputNL', 'undefined'],
])('visible unsupported record fields retain their diagnostic: %s / %s', (imports, field, value) => {
  const source = `${imports}\nx=undefined {${field}=${value}}\nmain=print(1::Int)`;
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ message: expect.stringContaining('この採点環境では使えません') }],
  });
});

test.each([
  ['import Text.Printf hiding(fmtChar)', 'fmtChar'],
  ['import qualified Text.Printf as P', 'fmtChar'],
  ['import Text.Printf', 'printf'],
  ['import Text.Printf', 'notAField'],
])('hidden or non-field exports are not record fields: %s / %s', (imports, field) => {
  const source = `${imports}\nx=undefined {${field}=undefined}\nmain=print(1::Int)`;
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ message: expect.stringContaining('スコープにありません') }],
  });
});
