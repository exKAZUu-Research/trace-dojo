import { expect, test } from 'vitest';

import { executeProgram, traceProgram } from '../../src/interpreter/program';
import type { TraceItem } from '../../src/problems/trace';

const javaMain = (body: string, members = ''): string => `public class Main {
  public static void main(String[] args) {
${body}
  }
${members}
}`;

/** The programs of the two languages place their statements on different lines, so their steps compare without them. */
const withoutLines = (items: TraceItem[]): unknown[] =>
  items.map(({ line, callLines, referenceVars, ...item }) => ({ ...item, callDepth: callLines.length }));

/** Programs that behave alike in both languages, so Haskell must reproduce the Java interpreter's trace. */
test.each([
  {
    name: 'functions that move a turtle, called as statements',
    java: javaMain(
      `
    Turtle t = new Turtle();
    twoSteps(t);
    t.右を向く();
    twoSteps(t);`,
      `
  static void twoSteps(Turtle t) {
    t.前に進む();
    t.前に進む();
  }`
    ),
    haskell: `main :: IO ()
main = do
  t <- newTurtle
  twoSteps t
  右を向く t
  twoSteps t

twoSteps :: Turtle -> IO ()
twoSteps t = do
  前に進む t
  前に進む t
`,
  },
  {
    name: 'a turtle that garbage collection removes when its variable takes another',
    java: javaMain(`
    Turtle t1 = new Turtle(1, 1);
    t1.前に進む();
    Turtle t2 = new Turtle(3, 3);
    t2.前に進む();
    t2 = t1;
    t2.前に進む();`),
    haskell: `main :: IO ()
main = do
  t1 <- newTurtleAt 1 1
  前に進む t1
  t2 <- newTurtleAt 3 3
  前に進む t2
  let t2 = t1
  前に進む t2
`,
  },
  {
    name: 'a for-each loop over strings that calls a function with conditions',
    java: javaMain(
      `
    Turtle t = new Turtle();
    String[] cmds = { "ri", "aa", "fo" };
    for (String cmd : cmds) {
      t.前に進む();
      parse(t, cmd);
    }`,
      `
  static void parse(Turtle t, String c) {
    if (c.equals("fo"))
      t.前に進む();
    else if (c.equals("ri"))
      t.右を向く();
  }`
    ),
    haskell: `import Control.Monad

main :: IO ()
main = do
  t <- newTurtle
  let cmds = ["ri", "aa", "fo"]
  forM_ cmds $ \\cmd -> do
    前に進む t
    parse t cmd

parse :: Turtle -> String -> IO ()
parse t c =
  if c == "fo"
    then 前に進む t
    else if c == "ri"
      then 右を向く t
      else return ()
`,
  },
  {
    name: 'reassigned numbers and a turtle placed by them',
    java: javaMain(`
    int x = 0;
    int y = (x * 3) + 2;
    x = (y * 2) % 7;
    Turtle t = new Turtle(x, y);
    t.後に戻る();`),
    haskell: `main :: IO ()
main = do
  x <- return 0
  y <- return ((x * 3) + 2)
  x <- return ((y * 2) \`mod\` 7)
  t <- newTurtleAt x y
  後に戻る t
`,
  },
])('$name', ({ java, haskell }) => {
  const expected = traceProgram('java', java, java);
  const actual = traceProgram('haskell', haskell, haskell);
  expect(withoutLines(actual.traceItems)).toEqual(withoutLines(expected.traceItems));
  expect(actual.finalTurtles).toEqual(expected.finalTurtles);
});

test('a loop binds its variable at the loop line before each pass, as Java for-each does', () => {
  const program = `import Control.Monad

main :: IO ()
main = do
  t <- newTurtle
  forM_ [0 .. 1] $ \\i -> do
    前に進む t
`;
  const { traceItems } = traceProgram('haskell', program, program);
  expect(traceItems.map(({ line, vars }) => ({ line, vars }))).toEqual([
    { line: 0, vars: {} },
    { line: 5, vars: {} },
    { line: 6, vars: { i: 0 } },
    { line: 7, vars: { i: 0 } },
    { line: 6, vars: { i: 1 } },
    { line: 7, vars: { i: 1 } },
  ]);
});

test('a function marked atomic counts as one step of its caller', () => {
  const program = `import Control.Monad

main :: IO ()
main = do
  t <- newTurtle
  steps t 3
  右を向く t

steps :: Turtle -> Int -> IO () -- atomic
steps t n = forM_ [1 .. n] $ \\_ -> 前に進む t
`;
  const { traceItems } = traceProgram('haskell', program, program);
  expect(traceItems.map(({ line, callLines }) => ({ line, callLines }))).toEqual([
    { line: 0, callLines: [] },
    { line: 5, callLines: [] },
    { line: 6, callLines: [] },
    { line: 7, callLines: [] },
  ]);
});

test('a misplaced atomic annotation is a compile error', () => {
  const program = `main :: IO ()
main = do
  print 1 -- atomic
`;
  expect(() => traceProgram('haskell', program, program)).toThrow('-- atomic');
  expect(executeProgram('haskell', program).kind).toBe('executed');
});

test('a loop written as tail recursion keeps one frame, as a Java loop does', () => {
  const program = `main :: IO ()
main = do
  t <- newTurtle
  walk t 0

walk :: Turtle -> Int -> IO ()
walk t i =
  if i < 3
    then do
      前に進む t
      walk t (i + 1)
    else return ()
`;
  const { traceItems } = traceProgram('haskell', program, program);
  expect(traceItems.slice(2).map(({ line, callLines, vars }) => ({ line, callLines, vars }))).toEqual([
    { line: 10, callLines: [4], vars: { i: 0 } },
    { line: 10, callLines: [4], vars: { i: 1 } },
    { line: 10, callLines: [4], vars: { i: 2 } },
  ]);
});

test('a list element that a new list replaces releases its turtle at that step', () => {
  const program = `main :: IO ()
main = do
  ts <- mapM (\\x -> newTurtleAt x 0) [0, 1]
  ts <- return (drop 1 ts)
  mapM_ 前に進む ts
`;
  const { traceItems } = traceProgram('haskell', program, program);
  expect(traceItems.slice(-3).map(({ line, turtles }) => ({ line, count: turtles.length }))).toEqual([
    { line: 3, count: 2 },
    { line: 4, count: 1 },
    { line: 5, count: 1 },
  ]);
});

test('tracing modest loops does not charge garbage collection to program operations', () => {
  const source =
    'import Control.Monad\nmain=do\n  let xs=[1..500::Int]\n  forM_ xs $ \\x -> do\n    let y=x*2\n    when(y `mod` 100 == 0)(print y)';
  const recording = traceProgram('haskell', source, source);
  expect(recording.stdout).toBe('100\n200\n300\n400\n500\n600\n700\n800\n900\n1000\n');
  expect(recording.traceItems.length).toBeGreaterThan(1000);
});

test('tracing lazy long literals with a turtle uses no host recursion', () => {
  const source = `main=do\n  t <- newTurtle\n  let xs=[${Array.from({ length: 30_000 }, () => 1).join(',')}]\n  print 1\n  print(head xs)\n  forward t`;
  const recording = traceProgram('haskell', source, source);
  expect(recording.stdout).toBe('1\n1\n');
  expect(recording.traceItems.at(-1)?.line).toBe(6);
});

test.each([2, 3])('cyclic constructors with %i children display truncated references', (arity) => {
  const source = `data T=T ${Array.from({ length: arity }, () => 'T').join(' ')}\nmain=do\n  let x=T ${Array.from({ length: arity }, () => 'x').join(' ')}\n  print 1`;
  const recording = traceProgram('haskell', source, source);
  expect(recording.stdout).toBe('1\n');
  expect(recording.traceItems.find((item) => item.referenceVars.x)?.referenceVars.x).toEqual({
    kind: 'object',
    entries: Object.fromEntries(
      Array.from({ length: arity }, (_, index) => [String(index), { kind: 'value', value: '…' }])
    ),
  });
});

test('shared acyclic constructor graphs use one cumulative display allowance', () => {
  const source = 'data T=Leaf|T T T\ngrow x=T x x\nmain=do\n  let x=iterate grow Leaf !! 30\n  print 1\n  print 2';
  const recording = traceProgram('haskell', source, source);
  expect(recording.stdout).toBe('1\n2\n');
  expect(recording.traceItems.find((item) => item.referenceVars.x)?.referenceVars.x).toEqual({
    kind: 'value',
    value: '…',
  });
});

test('recursive instance methods retain independent call frames', () => {
  const source = `class C a where c::a->IO ()
instance C Int where
 c n=do
   print n
   if n>0 then c(n-1) else return()
   print n
main=c(2::Int)`;
  const recording = traceProgram('haskell', source, source);
  expect(recording.stdout).toBe('2\n1\n0\n0\n1\n2\n');
  expect(
    recording.traceItems.filter(({ line }) => line === 4 || line === 6).map(({ callLines }) => callLines.length)
  ).toEqual([1, 2, 3, 3, 2, 1]);
});

test.each([
  'class C a where c::a->IO ()\ninstance C Int where\n c n=do -- atomic\n   print n\n   print n\nmain=c(2::Int)',
  'class C a where\n c::a->IO ()\n c _=do -- atomic\n   print(1::Int)\n   print(2::Int)\ninstance C Int\nmain=c(0::Int)',
])('user methods accept atomic declarations', (source) => {
  const recording = traceProgram('haskell', source, source);
  expect(recording.stdout).toMatch(/^(?:2\n2\n|1\n2\n)$/);
  expect(recording.traceItems.every(({ callLines }) => callLines.length === 0)).toBe(true);
});

test.each(['forM [1,2] $', 'for [1,2] $', 'traverse', 'flip traverse [1,2] $'])(
  'applicative loop %s has no extra epilogue step',
  (loop) => {
    const call =
      loop === 'traverse' ? String.raw`traverse (\x->do print(x::Int)) [1,2]` : `${loop} \\x->do print(x::Int)`;
    const source = `import Control.Monad\nimport Data.Traversable\nmain=do\n  ${call}\n  print(3::Int)`;
    const recording = traceProgram('haskell', source, source);
    expect(recording.stdout).toBe('1\n2\n3\n');
    const control = source.replace(call, String.raw`forM [1,2] $ \x->do print(x::Int)`);
    expect(withoutLines(recording.traceItems)).toEqual(
      withoutLines(traceProgram('haskell', control, control).traceItems)
    );
  }
);

test.each(['where', 'let'])('zero-argument %s actions preserve turtles in the caller scope', (scope) => {
  const source =
    scope === 'where'
      ? 'main=do\n  t<-newTurtleAt 1 1\n  forward t\n  separator\n  where\n    separator=putStrLn "----"'
      : 'main=do\n  t<-newTurtleAt 1 1\n  forward t\n  let separator=putStrLn "----"\n  separator';
  const recording = traceProgram('haskell', source, source);
  expect(recording.stdout).toBe('----\n');
  expect(recording.finalTurtles).toMatchObject([{ x: 1, y: 2 }]);
  expect(recording.traceItems.at(-1)?.turtles).toMatchObject([{ x: 1, y: 2 }]);
});

test('constructor fields retain declared String and Float display types', () => {
  const source =
    'data Box a=Box {empty::String, nested::Maybe a, number::Float}\nmain=do\n  let box=Box "" (Just "") 0.1\n  let xs=[0.1::Float]\n  print(1::Int)';
  const recording = traceProgram('haskell', source, source);
  expect(recording.traceItems.at(-1)?.referenceVars.box).toEqual({
    kind: 'object',
    entries: {
      empty: { kind: 'value', value: '' },
      nested: { kind: 'value', value: '' },
      number: { kind: 'value', value: 0.1 },
    },
  });
  expect(recording.traceItems.at(-1)?.vars.xs).toEqual([0.1]);
  expect(recording.traceItems.at(-1)?.referenceVars.xs).toEqual({
    kind: 'array',
    entries: { 0: { kind: 'value', value: 0.1 } },
  });
});

test('this fields share declared constructor types with the object display', () => {
  const source =
    'data Car=Car {owner::String,tags::[String]}\ndescribe this=do\n  print(1::Int)\nmain=describe(Car "" ["","x"])';
  const recording = traceProgram('haskell', source, source);
  const item = recording.traceItems.find(({ vars }) => Object.hasOwn(vars, 'this.owner'));
  expect(item?.vars['this.owner']).toBe('');
  expect(item?.vars['this.tags']).toEqual(['', 'x']);
});

test.each(['Box (Box (1::Int))', 'Box (Just (1::Int))'])(
  'polymorphic constructor display tolerates unknown arguments: %s',
  (value) => {
    const source = `data Box a=Box a deriving Show\nf::Show a=>a->IO ()\nf x=do\n  print x\nmain=f(${value})`;
    const recording = traceProgram('haskell', source, source);
    expect(recording.stdout).toBe(value.startsWith('Box (Box') ? 'Box (Box 1)\n' : 'Box (Just 1)\n');
    expect(recording.traceItems.some(({ referenceVars }) => referenceVars.x?.kind === 'object')).toBe(true);
  }
);

test.each([
  ['Box (""::String)', { kind: 'value', value: '' }],
  ['Box (Just "")', { kind: 'value', value: '' }],
  ['Box (0.1::Float)', { kind: 'value', value: 0.1 }],
  ['Box [0.1::Float]', { kind: 'array', entries: { 0: { kind: 'value', value: 0.1 } } }],
])('polymorphic calls preserve concrete display types: %s', (value, node) => {
  const source = `data Box a=Box a deriving Show\nf::Show a=>a->IO ()\nf x=do\n  print x\nmain=f(${value})`;
  const recording = traceProgram('haskell', source, source);
  const item = recording.traceItems.find(({ referenceVars }) => referenceVars.x?.kind === 'object');
  expect(item?.referenceVars.x).toEqual({ kind: 'object', entries: { 0: node } });
});

test('display types survive generic constructors, forwarding and list cases', () => {
  const source =
    'data Box a=Box a deriving Show\nbox x=Box x\npass x=case x of y->f y\nf x=print(1::Int)\nmain=do\n  pass(box "")\n  mapM_ f [box(0.1::Float)]';
  const recording = traceProgram('haskell', source, source);
  const nodes = recording.traceItems
    .filter(({ referenceVars }) => referenceVars.x?.kind === 'object')
    .map(({ referenceVars }) => referenceVars.x);
  expect(nodes).toContainEqual({ kind: 'object', entries: { 0: { kind: 'value', value: '' } } });
  expect(nodes).toContainEqual({ kind: 'object', entries: { 0: { kind: 'value', value: 0.1 } } });
});

test('shared polymorphic values keep each call display instantiation separate', () => {
  const source =
    'data Box a=Box a\nshared=Box []\nf x=print(1::Int)\nmain=do\n  f(shared::Box String)\n  f(shared::Box [Int])';
  const recording = traceProgram('haskell', source, source);
  const nodes = recording.traceItems
    .filter(({ referenceVars }) => referenceVars.x?.kind === 'object')
    .map(({ referenceVars }) => referenceVars.x);
  expect(nodes).toEqual([
    { kind: 'object', entries: { 0: { kind: 'value', value: '' } } },
    { kind: 'object', entries: { 0: { kind: 'array', entries: {} } } },
  ]);
});
