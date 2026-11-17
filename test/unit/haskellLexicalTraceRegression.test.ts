import { expect, test } from 'vitest';

import { executeProgram, traceProgram } from '../../src/interpreter/program';

test.each([
  ['main=do\n do\n  print(1::Int)\n  print(2::Int)\n print(3::Int)', '1\n2\n3\n', [0, 3, 4, 5]],
  ['main=do\n do\n  pure()\n print(1::Int)', '1\n', [0, 4]],
  ['main=do\n do\n  do\n   print(1::Int)\n print(2::Int)', '1\n2\n', [0, 4, 5]],
  ['main=do\n (do\n   print(1::Int)\n   print(2::Int))::IO()\n print(3::Int)', '1\n2\n3\n', [0, 3, 4, 5]],
])('nested IO blocks record only their statements: %s', (source, stdout, lines) => {
  const result = traceProgram('haskell', source, source);
  expect(result.stdout).toBe(stdout);
  expect(result.uncaughtException).toBeUndefined();
  expect(result.traceItems.map((item) => item.line)).toEqual(lines);
});

test('a bare nested IO block restores its enclosing visible scope', () => {
  const source = `main=do
 let outer=9::Int
 do
  let inner=1::Int
  print inner
 print outer`;
  const result = traceProgram('haskell', source, source);
  expect(result.stdout).toBe('1\n9\n');
  expect(result.uncaughtException).toBeUndefined();
  expect(result.traceItems.map((item) => item.line)).toEqual([0, 2, 4, 5, 6]);
  expect(result.traceItems.find((item) => item.line === 5)?.vars).toEqual({ outer: 9, inner: 1 });
  expect(result.traceItems.at(-1)?.vars).toEqual({ outer: 9 });
});

test('binding the result of a nested IO block keeps its assignment step', () => {
  const source = `main=do
 x<-do
  print(0::Int)
  pure(2::Int)
 print x`;
  const result = traceProgram('haskell', source, source);
  expect(result.stdout).toBe('0\n2\n');
  expect(result.uncaughtException).toBeUndefined();
  expect(result.traceItems.find((item) => item.line === 2)?.vars.x).toBe(2);
});

test.each([
  'let (f,g)=(id,not)',
  'let Just f=Just id',
  'let [f,g]=[id,id]',
  'let (f,g)=(pure(1::Int)::IO Int,pure(2::Int)::IO Int)',
  'let Just f=Nothing::Maybe(Int->Int)',
])('pattern declarations containing only functions and actions add no step: %s', (declaration) => {
  const source = `main=do\n ${declaration}\n print(0::Int)`;
  const result = traceProgram('haskell', source, source);
  expect(result.stdout).toBe('0\n');
  expect(result.uncaughtException).toBeUndefined();
  expect(result.traceItems.map((item) => item.line)).toEqual([0, 3]);
});

test('destructured actions keep their execution steps without an empty declaration step', () => {
  const source = `main=do
 let (hello,bye)=(putStrLn "hello",putStrLn "bye")
 hello
 bye`;
  const control = source.replace(
    '(hello,bye)=(putStrLn "hello",putStrLn "bye")',
    '{hello=putStrLn "hello";bye=putStrLn "bye"}'
  );
  const result = traceProgram('haskell', source, source);
  const ordinary = traceProgram('haskell', control, control);
  expect(result.stdout).toBe('hello\nbye\n');
  expect(ordinary.stdout).toBe(result.stdout);
  expect(result.uncaughtException).toBeUndefined();
  expect(result.traceItems.map((item) => item.line)).toEqual([0, 3, 4]);
  expect(ordinary.traceItems.map((item) => item.line)).toEqual([0, 2, 2]);
});

test('mixed function and scalar pattern declarations retain their assignment step', () => {
  const source = 'main=do\n let (f,n)=(id,2::Int)\n print(f n)';
  const result = traceProgram('haskell', source, source);
  expect(result.stdout).toBe('2\n');
  expect(result.uncaughtException).toBeUndefined();
  expect(result.traceItems.map((item) => item.line)).toEqual([0, 2, 3]);
  expect(result.traceItems[1].vars).toEqual({ n: 2 });
});

test('using a failed function pattern preserves its normal pattern-match exception', () => {
  const source = 'main=do\n let Just f=Nothing::Maybe(Int->Int)\n print(f 1)';
  const executed = executeProgram('haskell', source);
  expect(executed).toMatchObject({ kind: 'executed', stdout: '', uncaughtException: expect.any(String) });
  const result = traceProgram('haskell', source, source);
  expect(result.stdout).toBe('');
  if (executed.kind === 'executed') expect(result.uncaughtException).toBe(executed.uncaughtException);
  expect(result.traceItems.some((item) => item.line === 2)).toBe(false);
});

const declarations = [
  { declaration: String.raw`f= \n->do`, suffix: '', call: 'f', main: 'f 2' },
  { declaration: String.raw`f=(\n->do`, suffix: ')', call: 'f', main: 'f 2' },
  { declaration: String.raw`f=id(\n->do`, suffix: ')', call: 'f', main: 'f 2' },
  { declaration: String.raw`f=if True then(\n->do`, suffix: ') else error "unused"', call: 'f', main: 'f 2' },
  { declaration: String.raw`f= \x n->do`, suffix: '', call: 'f x', main: 'f (7::Int) 2' },
  { declaration: String.raw`f= \x-> \n->do`, suffix: '', call: 'f x', main: 'f (7::Int) 2' },
  { declaration: String.raw`f x= \n->do`, suffix: '', call: 'f x', main: 'f (7::Int) 2' },
  { declaration: String.raw`f=(\x n->do`, suffix: ') (7::Int)', call: 'f', main: 'f 2' },
  { declaration: String.raw`(f,_)=((\n->do`, suffix: '),())', call: 'f', main: 'f 2' },
];

test.each(declarations)(
  'named lambda calls have independent invocations: $declaration',
  ({ declaration, suffix, call, main }) => {
    const source = `${declaration}
 print(n::Int)
 if n>0 then ${call}(n-1) else pure()
 print n${suffix}
main=${main}`;
    const result = traceProgram('haskell', source, source);
    expect(result.stdout).toBe('2\n1\n0\n0\n1\n2\n');
    const statements = result.traceItems.filter((item) => item.line === 2 || item.line === 4);
    expect(statements.map((item) => item.callLines.length)).toEqual([1, 2, 3, 3, 2, 1]);
    expect(statements.map((item) => item.vars.n)).toEqual([2, 1, 0, 0, 1, 2]);
    expect(result.traceItems.filter((item) => item.line === 1)).toHaveLength(0);
    if (declaration.includes('x')) expect(statements.map((item) => item.vars.x)).toEqual([7, 7, 7, 7, 7, 7]);
  }
);

test('a reused curried function creates a new call frame on each final application', () => {
  const source = `f= \\x-> \\n->do
 print(n::Int)
 if n>0 then f x(n-1) else pure()
 print n
main=do
 let g=f(7::Int)
 g 2
 g 1`;
  const result = traceProgram('haskell', source, source);
  expect(result.stdout).toBe('2\n1\n0\n0\n1\n2\n1\n0\n0\n1\n');
  expect(
    result.traceItems.filter((item) => item.line === 2 || item.line === 4).map((item) => item.callLines.length)
  ).toEqual([1, 2, 3, 3, 2, 1, 1, 2, 2, 1]);
});

test('named lambda tail calls retain one trace frame', () => {
  const source = `f= \\n->if n<=0 then pure() else do
 print(n::Int)
 f(n-1)
main=f 600`;
  const result = traceProgram('haskell', source, source);
  expect(result.stdout).toBe(Array.from({ length: 600 }, (_, index) => `${600 - index}\n`).join(''));
  const statements = result.traceItems.filter((item) => item.line === 2);
  expect(statements).toHaveLength(600);
  expect(statements.every((item) => item.callLines.length === 1)).toBe(true);
});

test('tail recursion returning a function keeps bounded construction and normal output', () => {
  const source = `choose::Int->Int->IO()
choose n=if n<=0 then(\\x->print x)else choose(n-1)
main=choose 5000 1`;
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    stdout: '1\n',
    uncaughtException: undefined,
  });
  expect(traceProgram('haskell', source, source).stdout).toBe('1\n');
});

test('atomic grouping applies to a named lambda and its recursion', () => {
  const body = `
 print(n::Int)
 if n>0 then f(n-1)else pure()
 print n
main=do
 f 2
 print(9::Int)`;
  const control = `f n=do -- atomic${body}`;
  const lambda = `f= \\n->do -- atomic${body}`;
  expect(traceProgram('haskell', lambda, lambda).traceItems).toEqual(
    traceProgram('haskell', control, control).traceItems
  );
});

test.each([
  [String.raw`\(Just x)-> \y->print(x+y)`, false],
  [String.raw`\(Just x) y->print(x+y)`, true],
])('naming a partially applied pattern lambda preserves its construction demand: %s', (lambda, defined) => {
  const source = `f::Maybe Int->Int->IO()
f= ${lambda}
main=print((f Nothing) \`seq\`(1::Int))`;
  const executed = executeProgram('haskell', source);
  const traced = traceProgram('haskell', source, source);
  if (defined) {
    expect(executed).toMatchObject({ kind: 'executed', stdout: '1\n', uncaughtException: undefined });
    expect(traced.stdout).toBe('1\n');
    expect(traced.uncaughtException).toBeUndefined();
  } else {
    expect(executed).toMatchObject({
      kind: 'executed',
      stdout: '',
      uncaughtException: expect.stringContaining('Non-exhaustive patterns in lambda'),
    });
    expect(traced.stdout).toBe('');
    expect(traced.uncaughtException).toContain('Non-exhaustive patterns in lambda');
  }
});

test('comprehension IO actions retain their generator and let variables', () => {
  const source = 'main=sequence_ [do {let {n=x*2}; print n} | x<-[1..3::Int]]';
  const result = traceProgram('haskell', source, source);
  expect(result.stdout).toBe('2\n4\n6\n');
  expect(result.traceItems.filter((item) => Object.hasOwn(item.vars, 'n')).map((item) => item.vars)).toEqual([
    { x: 1, n: 2 },
    { x: 1, n: 2 },
    { x: 2, n: 4 },
    { x: 2, n: 4 },
    { x: 3, n: 6 },
    { x: 3, n: 6 },
  ]);
});

test('nested comprehension generators retain distinct lexical values', () => {
  const source = 'main=sequence_ [do {print (x+y)} | x<-[1,2::Int], y<-[3,4]]';
  const result = traceProgram('haskell', source, source);
  expect(result.stdout).toBe('4\n5\n5\n6\n');
  expect(result.traceItems.filter((item) => Object.hasOwn(item.vars, 'x')).map((item) => item.vars)).toEqual([
    { x: 1, y: 3 },
    { x: 1, y: 4 },
    { x: 2, y: 3 },
    { x: 2, y: 4 },
  ]);
});

test('comprehension patterns and shadows preserve the scope used to build actions', () => {
  const source = 'main=sequence_ [do {print (x,y,z)} | (x,y)<-([(1,2),(3,4)]::[(Int,Int)]), let z=x+y, x<-[x+10]]';
  const result = traceProgram('haskell', source, source);
  expect(result.stdout).toBe('(11,2,3)\n(13,4,7)\n');
  expect(result.traceItems.filter((item) => Object.hasOwn(item.vars, 'z')).map((item) => item.vars)).toEqual([
    { x: 11, y: 2, z: 3 },
    { x: 13, y: 4, z: 7 },
  ]);
});

test('pure comprehension evaluation adds no generator steps or leaked bindings', () => {
  const source = `main=do
 let xs=[x*2|x<-[1..3::Int]]
 print(sum xs)`;
  const result = traceProgram('haskell', source, source);
  expect(result.stdout).toBe('12\n');
  expect(result.traceItems.map((item) => item.line)).toEqual([0, 2, 3]);
  expect(result.traceItems.some((item) => Object.hasOwn(item.vars, 'x'))).toBe(false);
});

test('recursive named lambdas retain independent turtle scopes', () => {
  const body = `
 t<-newTurtleAt n 0
 if n>0 then f(n-1)else pure()
 turnRight t
main=f(2::Int)`;
  const control = `f n=do${body}`;
  const lambda = `f= \\n->do${body}`;
  const result = traceProgram('haskell', lambda, lambda);
  expect(result.traceItems).toEqual(traceProgram('haskell', control, control).traceItems);
  expect(
    result.traceItems.filter((item) => item.line === 2 || item.line === 4).map((item) => item.callLines.length)
  ).toEqual([1, 2, 3, 3, 2, 1]);
});

test('comprehension-created turtle actions display their generator values as they move', () => {
  const source = `main=do
 ts<-mapM(\\x->newTurtleAt x 0)[0,2]
 sequence_[do {turnRight t;forward t}|t<-ts]`;
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    stdout: '',
    uncaughtException: undefined,
  });
  const result = traceProgram('haskell', source, source);
  const variables = result.traceItems
    .filter((item) => Object.hasOwn(item.referenceVars, 't'))
    .map((item) => item.referenceVars.t);
  expect(variables).toHaveLength(4);
  for (const [index, x] of [0, 1, 2, 3].entries())
    expect(variables[index]).toEqual({
      kind: 'object',
      entries: { x: { kind: 'value', value: x }, y: { kind: 'value', value: 0 } },
    });
  expect(result.finalTurtles).toEqual([
    { x: 1, y: 0, color: '#', dir: 'E' },
    { x: 3, y: 0, color: '#', dir: 'E' },
  ]);
  expect(result.finalVars).not.toHaveProperty('t');
});
