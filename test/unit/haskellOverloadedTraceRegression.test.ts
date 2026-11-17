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

test.each([
  ['Fractional', 'Float', '0.1', '0.1'],
  ['Num', 'Int', '0', '1'],
])('partial evidence cannot erase %s scalar types in either constraint order', (numeric, type, seed, increment) => {
  const traces = [`(${numeric} a,Eq(Box a))`, `(Eq(Box a),${numeric} a)`].map((context) => {
    const source = `import Control.Monad
data Box a=Box a
instance Eq(Box a) where _==_=True
loop::${context}=>a->IO ()
loop n=do
 forM_ [n+${increment},n+${increment}] $ \\i->do
  print(0::Int)
main=loop(${seed}::${type})`;
    const result = traceProgram('haskell', source, source);
    const control = source.replace(`${context}=>a`, type);
    expect(result.stdout).toBe('0\n0\n');
    expect(result.traceItems).toEqual(traceProgram('haskell', control, control).traceItems);
    return result.traceItems;
  });
  expect(traces[0]).toEqual(traces[1]);
});

test.each(['(LeftType(a,b),RightType(a,b))', '(RightType(a,b),LeftType(a,b))'])(
  'partial structural evidence refines each component across inherited helper scopes: %s',
  (context) => {
    const source = `import Control.Monad
class LeftType a
instance LeftType(Float,b)
class RightType a
instance RightType(a,Int)
loop::${context}=>(a,b)->IO ()
loop n=do
 let run xs=forM_ xs $ \\i->do {print(0::Int)}
 run [fst n,fst n]
 run [snd n,snd n]
main=loop(0.1::Float,1::Int)`;
    const result = traceProgram('haskell', source, source);
    const control = source.replace(`${context}=>(a,b)`, '(Float,Int)');
    expect(result.stdout).toBe('0\n0\n0\n0\n');
    expect(result.traceItems).toEqual(traceProgram('haskell', control, control).traceItems);
    expect(result.traceItems.filter(({ vars }) => vars.i === 0.1)).toHaveLength(4);
    expect(result.traceItems.filter(({ vars }) => vars.i === 1)).toHaveLength(4);
  }
);

test.each([
  ['Fractional', 'Float', '0.1', '0.1'],
  ['Num', 'Int', '0', '1'],
])(
  'constrained %s expression annotations retain lambda and statement type scopes',
  (constraint, type, seed, increment) => {
    const sources = [
      `import Control.Monad
main =
 ((\\n -> do
    forM_ [n+${increment},n+${increment}] $ \\i -> do
      print(0::Int)
  ) :: ${constraint} a => a -> IO ()) (${seed}::${type})`,
      `import Control.Monad
main=do
 x<-((do
   let n=${seed}
   forM_ [n+${increment},n+${increment}] $ \\i->do
    print(0::Int)
   pure n
  )::${constraint} a=>IO a)
 print(x::${type})`,
    ];
    for (const source of sources) {
      const specialized = source.replace(`${constraint} a => a`, type).replace(`${constraint} a=>IO a`, `IO ${type}`);
      const result = traceProgram('haskell', source, source);
      expect(result.stdout).toBe(source === sources[0] ? '0\n0\n' : `0\n0\n${seed}\n`);
      expect(result.traceItems).toEqual(traceProgram('haskell', specialized, specialized).traceItems);
    }
  }
);
