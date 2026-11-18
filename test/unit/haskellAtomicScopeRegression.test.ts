import { expect, test } from 'vitest';

import { executeProgram, traceProgram } from '../../src/interpreter/program';

const cases = [
  { declarations: 'f=seq -- atomic', call: 'f (1::Int)(do {print(2::Int);print(3::Int)})', output: '2\n3\n' },
  { declarations: 'f=seq(1::Int) -- atomic', call: 'f (do {print(2::Int);print(3::Int)})', output: '2\n3\n' },
  { declarations: 'g n=do\n print(n::Int)\n print n\nf=g -- atomic', call: 'f 2', output: '2\n2\n' },
  { declarations: 'make _= \\n->do\n print(n::Int)\n print n\nf=make() -- atomic', call: 'f 2', output: '2\n2\n' },
  { declarations: 'g n=do\n print(n::Int)\n print n\nmake _=g\nf=make() -- atomic', call: 'f 2', output: '2\n2\n' },
  { declarations: 'g x n=do\n print(x+n::Int)\n print(x+n)\nf=g 7 -- atomic', call: 'f 2', output: '9\n9\n' },
  {
    declarations: 'make _= \\x -> \\n->do\n print(x+n::Int)\n print(x+n)\nf=make() 7 -- atomic',
    call: 'f 2',
    output: '9\n9\n',
  },
  { declarations: 'f=sequence_ -- atomic', call: 'f [print(1::Int),print(2::Int)]', output: '1\n2\n' },
  {
    declarations: String.raw`f=mapM_ (\n->do {print(n::Int);print n}) -- atomic`,
    call: 'f [1,2]',
    output: '1\n1\n2\n2\n',
  },
];

test.each(cases)(
  'atomic function values group the caller statement: $declarations',
  ({ declarations, call, output }) => {
    const source = `${declarations}\nmain=do\n ${call}\n print(99::Int)`;
    expect(executeProgram('haskell', source)).toMatchObject({
      kind: 'executed',
      stdout: output + '99\n',
      uncaughtException: undefined,
    });
    const result = traceProgram('haskell', source, source);
    expect(result.stdout).toBe(output + '99\n');
    const last = source.split('\n').length;
    expect(result.traceItems.map(({ line, callLines }) => ({ line, callLines }))).toEqual([
      { line: 0, callLines: [] },
      { line: last - 1, callLines: [] },
      { line: last, callLines: [] },
    ]);
  }
);

test('annotating an alias does not change the original function or an unannotated alias', () => {
  const source = `f n=do
 print(n::Int)
 print n
g=f -- atomic
h=f
main=do
 f 1
 g 2
 h 3
 f 4
 print(99::Int)`;
  const result = traceProgram('haskell', source, source);
  expect(result.stdout).toBe('1\n1\n2\n2\n3\n3\n4\n4\n99\n');
  expect(result.traceItems.filter((item) => item.line === 2 || item.line === 3).map((item) => item.vars.n)).toEqual([
    1, 1, 3, 3, 4, 4,
  ]);
  expect(result.traceItems.find((item) => item.line === 8)?.callLines).toEqual([]);
});

test('reused atomic actions retain their shared pure prefix and fresh execution scope', () => {
  const source = `import Control.Monad
g x=do
 let n=sum[1..100::Int]+x
 print n
 print n
f=g -- atomic
main=do
 let action=f 1
 replicateM_ 1000 action
 print(9::Int)`;
  const stdout = '5051\n5051\n'.repeat(1000) + '9\n';
  expect(executeProgram('haskell', source)).toMatchObject({ kind: 'executed', stdout, uncaughtException: undefined });
  const result = traceProgram('haskell', source, source);
  expect(result.stdout).toBe(stdout);
  expect(result.traceItems.every((item) => item.callLines.length === 0)).toBe(true);
});

test('atomic function-valued aliases retain construction demand before IO execution', () => {
  const source = `g= \\(Just x) -> \\y -> print(x+y::Int)
f=g -- atomic
main=print((f Nothing) \`seq\`(1::Int))`;
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    stdout: '',
    uncaughtException: expect.stringContaining('Non-exhaustive patterns in lambda'),
  });
  const result = traceProgram('haskell', source, source);
  expect(result.stdout).toBe('');
  expect(result.uncaughtException).toContain('Non-exhaustive patterns in lambda');
});

test('an atomic library alias groups turtle callback actions and retains their roots', () => {
  const source = `f=sequence_ -- atomic
main=do
 t<-newTurtle
 f [forward t,turnRight t,forward t]
 print(1::Int)`;
  const result = traceProgram('haskell', source, source);
  expect(result.stdout).toBe('1\n');
  expect(result.traceItems.map((item) => item.line)).toEqual([0, 3, 4, 5]);
  expect(result.finalTurtles).toEqual([{ x: 1, y: 1, color: '#', dir: 'E' }]);
});

test('atomic scope metadata does not retain an argument the shared action discards', () => {
  const source = `g=const(print(0::Int))
f=g -- atomic
main=do
 t<-newTurtleAt 0 1
 action<-pure(f t)
 let t=()
 action
 r<-newTurtle
 clear<-canMoveForward r
 print clear
 action`;
  const stdout = '0\nTrue\n0\n';
  expect(executeProgram('haskell', source)).toMatchObject({ kind: 'executed', stdout, uncaughtException: undefined });
  expect(traceProgram('haskell', source, source).stdout).toBe(stdout);
});

test('atomic tail recursion keeps its call scope bounded', () => {
  const source = `f= \\n->if n<=0 then pure()else do -- atomic
 print(n::Int)
 f(n-1)
main=do
 f 2000
 print(9::Int)`;
  const result = traceProgram('haskell', source, source);
  expect(result.stdout).toBe(Array.from({ length: 2000 }, (_, index) => `${2000 - index}\n`).join('') + '9\n');
  expect(result.traceItems.map((item) => item.line)).toEqual([0, 5, 6]);
});

test('alternating ordinary and annotated aliases preserve the enclosing atomic tail scope', () => {
  const source = `f::Int->IO()
f n
 |n<=0=print(0::Int)
 |even n=f(n-1)
 |otherwise=g(n-1)
g::Int->IO()
g=f -- atomic
main=do
 f 1500
 print(9::Int)`;
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    stdout: '0\n9\n',
    uncaughtException: undefined,
  });
  const result = traceProgram('haskell', source, source);
  expect(result.stdout).toBe('0\n9\n');
  expect(result.traceItems.some((item) => item.line === 3)).toBe(false);
  expect(result.traceItems.some((item) => item.line === 5)).toBe(true);
  expect(result.traceItems.every((item) => item.callLines.length <= 1)).toBe(true);
});

test('an atomic helper groups a caller lambda without renaming or mutating it', () => {
  const source = `pick f=f -- atomic
main=do
 let action= \\z->do
       print(z::Int)
       print(z+1)
 pick action 1
 action 2
 print(0::Int)`;
  const result = traceProgram('haskell', source, source);
  expect(result.stdout).toBe('1\n2\n2\n3\n0\n');
  expect(result.uncaughtException).toBeUndefined();
  expect(result.traceItems.map((item) => [item.line, item.callLines, item.vars.z])).toEqual([
    [0, [], undefined],
    [6, [], undefined],
    [3, [], 2],
    [4, [], 2],
    [5, [], 2],
    [7, [], undefined],
    [8, [], undefined],
  ]);
});

const localCases = [
  ['where definition', 'where', 'go n=do -- atomic\n  print(n::Int)\n  print n'],
  ['let definition', 'let', 'go n=do -- atomic\n  print(n::Int)\n  print n'],
  ['where signature', 'where', 'go::Int->IO() -- atomic\ngo n=do\n  print n\n  print n'],
  ['let signature', 'let', 'go::Int->IO() -- atomic\ngo n=do\n  print n\n  print n'],
  ['where lambda', 'where', 'go= \\n->do -- atomic\n  print(n::Int)\n  print n'],
  ['let lambda', 'let', 'go= \\n->do -- atomic\n  print(n::Int)\n  print n'],
  ['where alias', 'where', 'go=twice -- atomic'],
  ['let partial alias', 'let', 'go=offset 7 -- atomic'],
] as const;

test.each(localCases)('local atomic annotations group the call: %s', (name, placement, declaration) => {
  const body = placement === 'let' ? ` let ${declaration.replaceAll('\n', '\n     ')}\n` : '';
  const where = placement === 'where' ? `\n where\n  ${declaration.replaceAll('\n', '\n  ')}` : '';
  const source = `twice n=do
 print(n::Int)
 print n
offset x n=twice(x+n)
main=do
${body} go 1
 print(0::Int)${where}`;
  const stdout = name === 'let partial alias' ? '8\n8\n0\n' : '1\n1\n0\n';
  expect(executeProgram('haskell', source)).toMatchObject({ kind: 'executed', stdout, uncaughtException: undefined });
  const result = traceProgram('haskell', source, source);
  expect(result.stdout).toBe(stdout);
  expect(result.uncaughtException).toBeUndefined();
  const lines = source.split('\n');
  expect(result.traceItems.map((item) => [item.line, item.callLines])).toEqual([
    [0, []],
    [lines.indexOf(' go 1') + 1, []],
    [lines.indexOf(' print(0::Int)') + 1, []],
  ]);
});

test('local atomic recursion preserves captured variables and restores ordinary tracing', () => {
  const source = `main=do
 let k=7
     go n=if n<=0 then pure()else do -- atomic
       print(n+k::Int)
       go(n-1)
 go 5000
 print k`;
  const result = traceProgram('haskell', source, source);
  expect(result.stdout).toBe(Array.from({ length: 5000 }, (_, index) => `${5007 - index}\n`).join('') + '7\n');
  expect(result.uncaughtException).toBeUndefined();
  expect(result.traceItems.map((item) => [item.line, item.callLines, item.vars.k])).toEqual([
    [0, [], undefined],
    [2, [], 7],
    [6, [], 7],
    [7, [], 7],
  ]);
});

test('a local atomic IO value groups each execution without changing its original action', () => {
  const source = `main=do
 let action=do
       print(1::Int)
       print(2::Int)
     grouped=action -- atomic
 grouped
 action
 grouped
 print(0::Int)`;
  const result = traceProgram('haskell', source, source);
  expect(result.stdout).toBe('1\n2\n1\n2\n1\n2\n0\n');
  expect(result.uncaughtException).toBeUndefined();
  expect(result.traceItems.map((item) => [item.line, item.callLines])).toEqual([
    [0, []],
    [6, []],
    [3, []],
    [4, []],
    [8, []],
    [9, []],
  ]);
});

test.each([
  'data T=T -- atomic',
  'data T=T deriving Show -- atomic',
  'data T=T -- atomic\n deriving Show',
  'data T=T\n deriving Show -- atomic',
  'data R=R {a::Int} deriving(Eq,Show) -- atomic',
  'data T=A|B deriving(Eq,Ord,Show,Read,Enum,Bounded) -- atomic',
])('generated deriving methods cannot claim a data annotation: %s', (declaration) => {
  const source = `${declaration}\nmain=print(1::Int)`;
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    stdout: '1\n',
    uncaughtException: undefined,
  });
  expect(() => traceProgram('haskell', source, source)).toThrow('-- atomic');
});

test.each([
  'data T=T deriving(Eq,Show)\nclass C a where\n act::a->IO()\n act _=do -- atomic\n  print(1::Int)\n  print(2::Int)\ninstance C T',
  'data T=T deriving(Eq,Show)\nclass C a where act::a->IO()\ninstance C T where\n act _=do -- atomic\n  print(1::Int)\n  print(2::Int)',
])('source-defined class methods keep atomic eligibility after deriving: %s', (declarations) => {
  const source = `${declarations}\nmain=do\n act T\n print(0::Int)`;
  const result = traceProgram('haskell', source, source);
  expect(result.stdout).toBe('1\n2\n0\n');
  expect(result.uncaughtException).toBeUndefined();
  const lines = source.split('\n');
  expect(result.traceItems.map((item) => [item.line, item.callLines])).toEqual([
    [0, []],
    [lines.indexOf(' act T') + 1, []],
    [lines.indexOf(' print(0::Int)') + 1, []],
  ]);
});
