import { expect, test } from 'vitest';

import { traceProgram } from '../../src/interpreter/program';

test.each([
  { constraint: 'Num a', type: 'Int', seed: '0', increment: '1', value: 1 },
  { constraint: 'Fractional a', type: 'Float', seed: '0.1', increment: '0.1', value: 0.2 },
])(
  'overloaded $type arithmetic preserves scalar loop steps and display digits',
  ({ constraint, type, seed, increment, value }) => {
    const source = `import Control.Monad
loop::${constraint}=>a->IO ()
loop n=do
 forM_ [n+${increment},n+${increment}] $ \\i->do
  print(0::Int)
main=loop(${seed}::${type})`;
    const generic = traceProgram('haskell', source, source);
    const specializedSource = source.replace(`${constraint}=>a`, type);
    const specialized = traceProgram('haskell', specializedSource, specializedSource);
    expect(generic.stdout).toBe('0\n0\n');
    expect(generic.traceItems).toEqual(specialized.traceItems);
    expect(generic.traceItems.map(({ line }) => line)).toEqual([0, 4, 5, 4, 5]);
    expect(generic.traceItems.slice(1).map(({ vars }) => vars.i)).toEqual([value, value, value, value]);
  }
);

test('context dictionaries preserve overloaded constructor fields', () => {
  const source = `data Box a=Box {payload::a} deriving Show
class Build a where build::a->a
instance Build Float where build x=x+0.1
instance Build a=>Build(Box a) where build(Box x)=Box(build x)
pass::Build a=>a->IO ()
pass n=do
 let x=build n
 print(0::Int)
main=pass(Box(0.1::Float))`;
  const result = traceProgram('haskell', source, source);
  expect(result.stdout).toBe('0\n');
  expect(result.traceItems.at(-1)?.referenceVars.x).toMatchObject({
    kind: 'object',
    entries: { payload: { kind: 'value', value: 0.2 } },
  });
});

test('pending overloaded arithmetic keeps its operand lazy', () => {
  const source = `import Control.Monad
loop::Num a=>a->IO ()
loop n=do
 forM_ [n+error "unused"] $ \\i->do
  print(0::Int)
main=loop(0::Int)`;
  const result = traceProgram('haskell', source, source);
  expect(result.stdout).toBe('0\n');
  expect(result.traceItems.map(({ line }) => line)).toEqual([0, 4, 5]);
});

test('partially applied overloaded functions retain their result instantiation', () => {
  const source = `import Control.Monad
loop::Fractional a=>a->IO ()
loop n=do
 let add=(+) n
 forM_ [add 0.1,add 0.1] $ \\i->do
  print(0::Int)
main=loop(0.1::Float)`;
  const result = traceProgram('haskell', source, source);
  expect(result.stdout).toBe('0\n0\n');
  expect(result.traceItems.map(({ line }) => line)).toEqual([0, 5, 6, 5, 6]);
  expect(result.traceItems.at(-1)?.vars.i).toBe(0.2);
});

test('method-local constraints do not consume value arrows in display hints', () => {
  const source = `import Control.Monad
class C a where combine::Eq b=>a->b->a
instance C Float where combine n x=if x==x then n+0.1 else n
loop::C a=>a->IO ()
loop n=do
 forM_ [combine n True,combine n True] $ \\i->do
  print(0::Int)
main=loop(0.1::Float)`;
  const result = traceProgram('haskell', source, source);
  expect(result.stdout).toBe('0\n0\n');
  expect(result.traceItems.map(({ line }) => line)).toEqual([0, 6, 7, 6, 7]);
  expect(result.traceItems.at(-1)?.vars.i).toBe(0.2);
});

test.each([
  'forM_ [add n 0.1,add n 0.1]',
  'let {first=later 0.1; later=(+) n}\n forM_ [first,first]',
  'let {first=later 0.1; later x=n+x}\n forM_ [first,first]',
  'let {first=later(error "unused"); later _=n+0.1}\n forM_ [first,first]',
])('generic helpers and forward bindings preserve pending scalar types: %s', (body) => {
  const source = `import Control.Monad
add::Fractional a=>a->a->a
add n x=n+x
loop::Fractional a=>a->IO ()
loop n=do
 ${body} $ \\i->do
  print(0::Int)
main=loop(0.1::Float)`;
  const specialized = source.replace('loop::Fractional a=>a', 'loop::Float');
  const generic = traceProgram('haskell', source, source);
  const control = traceProgram('haskell', specialized, specialized);
  expect(generic.stdout).toBe('0\n0\n');
  expect(generic.traceItems).toEqual(control.traceItems);
  expect(generic.traceItems.filter(({ vars }) => vars.i === 0.2)).toHaveLength(4);
});

test('generic helper calls keep Int and Float type scopes independent', () => {
  const source = `import Control.Monad
add::Num a=>a->a->a
add x y=x+y
loop::Num a=>a->IO ()
loop n=do
 forM_ [add n 1,add n 1] $ \\i->do
  print(0::Int)
main=do
 loop(0::Int)
 loop(0.1::Float)`;
  const result = traceProgram('haskell', source, source);
  expect(result.stdout).toBe('0\n0\n0\n0\n');
  expect(result.traceItems.filter(({ vars }) => vars.i === 1)).toHaveLength(4);
  expect(result.traceItems.filter(({ vars }) => vars.i === 1.1)).toHaveLength(4);
});
