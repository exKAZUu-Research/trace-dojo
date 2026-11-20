import { expect, test } from 'vitest';

import { ExecutionLimitError } from '../../src/interpreter/limits';
import { executeProgram, traceProgram } from '../../src/interpreter/program';
import type { DisplayNode, TraceItem } from '../../src/problems/trace';

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

test('a lazy replacement list releases its old turtle when the replacement is demanded', () => {
  const program = `main :: IO ()
main = do
  ts <- mapM (\\x -> newTurtleAt x 0) [0, 1]
  ts <- return (drop 1 ts)
  mapM_ 前に進む ts
`;
  const { traceItems } = traceProgram('haskell', program, program);
  expect(traceItems.slice(-3).map(({ line, turtles }) => ({ line, count: turtles.length }))).toEqual([
    { line: 3, count: 2 },
    { line: 4, count: 2 },
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

test('tracing lazy long literals with a turtle uses no host recursion', { timeout: 30_000 }, () => {
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

test.each([
  { count: 100, body: 'id(f(n-1))' },
  { count: 200, body: 'id(f(n-1))' },
  { count: 400, body: 'id(f(n-1))' },
  { count: 400, body: 'let y=f(n-1) in y' },
  { count: 400, body: String.raw`(\x->x)(f(n-1))` },
])('display aborts leave finite thunk chains usable: $count, $body', ({ count, body }) => {
  const source = `f :: Int -> Int\nf 0=0\nf n=${body}\nmain=do\n  let x=f ${count}\n  print x`;
  const recording = traceProgram('haskell', source, source);
  expect(recording.stdout).toBe('0\n');
  expect(recording.uncaughtException).toBeUndefined();
  expect(recording.traceItems).toHaveLength(3);
});

test.each([100, 200, 400])('aborted polymorphic displays leave repeated reads usable: %i', (count) => {
  const source = `f :: Int -> [a]\nf 0=[]\nf n=id(f(n-1))\nmain=do\n  let x=f ${count}\n  print(length x)\n  print(length x)`;
  const recording = traceProgram('haskell', source, source);
  expect(recording.stdout).toBe('0\n0\n');
  expect(recording.uncaughtException).toBeUndefined();
  expect(recording.traceItems).toHaveLength(4);
});

test.each([401, 800])('later call and pattern types survive prior metadata work: %i', (count) => {
  const source = `data Box a=Box a
shared=Box []
f :: Int -> [a]
f 0=[]
f n=id(f(n-1))
g x=print(1::Int)
pass x=case x of y->g y
unbox (Box x)=print(1::Int)
main=do
  let x=f ${count}
  print(length x)
  g(shared::Box String)
  g(shared::Box [Int])
  pass(Box (""::String))
  pass(Box (0.1::Float))
  unbox(Box (""::String))
  unbox(Box (0.1::Float))`;
  const recording = traceProgram('haskell', source, source);
  expect(recording.stdout).toBe('0\n1\n1\n1\n1\n1\n1\n');
  expect(recording.uncaughtException).toBeUndefined();
  const boxes = recording.traceItems
    .map(({ referenceVars }) => referenceVars.x)
    .filter((node) => node?.kind === 'object');
  expect(boxes).toEqual([
    { kind: 'object', entries: { 0: { kind: 'value', value: '' } } },
    { kind: 'object', entries: { 0: { kind: 'array', entries: {} } } },
    { kind: 'object', entries: { 0: { kind: 'value', value: '' } } },
    { kind: 'object', entries: { 0: { kind: 'value', value: 0.1 } } },
  ]);
  const fields = recording.traceItems.map(({ vars }) => vars.x);
  expect(fields).toContain('');
  expect(fields).toContain(0.1);
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
    const control = javaMain(
      '    for (int x : new int[] {1,2}) { System.out.println(x); }\n    System.out.println(3);'
    );
    expect(withoutLines(recording.traceItems)).toEqual(withoutLines(traceProgram('java', control, control).traceItems));
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

test.each([
  'c::a->IO () -- atomic',
  'c::a\n   ->IO () -- atomic',
  'c -- atomic\n   ::a->IO ()',
  'c:: -- atomic\n   a->IO ()',
])('class defaults retain atomic signature spans: %s', (signature) => {
  const source = `class C a where\n ${signature}\n c _=do\n   print(1::Int)\n   print(2::Int)\ninstance C Int\nmain=c(0::Int)`;
  const recording = traceProgram('haskell', source, source);
  expect(recording.stdout).toBe('1\n2\n');
  expect(recording.traceItems.every(({ callLines }) => callLines.length === 0)).toBe(true);
});

test.each([
  'walk _ 0=return ()\nwalk t n=do\n  forward t\n  walk t(n-1)',
  'walk _ 0=pure ()\nwalk t n=do\n  forward t\n  walk t(n-1)',
  'walk t n | n==0=return ()\n         | otherwise=do\n  forward t\n  walk t(n-1)',
])('tail loops have no call-line epilogue with base clause %s', (definition) => {
  const prefix = 'main=do\n  t<-newTurtle\n  walk t(3::Int)\n';
  const source = prefix + definition;
  const control = prefix + 'walk t n=if n>0 then do\n  forward t\n  walk t(n-1)\n  else return ()';
  expect(withoutLines(traceProgram('haskell', source, source).traceItems)).toEqual(
    withoutLines(traceProgram('haskell', control, control).traceItems)
  );
});

test('recursive calls inside traversal lambdas retain their call steps', () => {
  const source = `import Control.Monad

main :: IO ()
main = do
  t <- newTurtle
  walk t 1

walk :: Turtle -> Int -> IO ()
walk t 0 = return ()
walk t n = do
  forM_ [1, 2 :: Int] $ \\i -> do
    右を向く t
    walk t (n - 1)
`;
  const recording = traceProgram('haskell', source, source);
  expect(recording.traceItems.map(({ line, callLines }) => ({ line, callLines }))).toEqual([
    { line: 0, callLines: [] },
    { line: 5, callLines: [] },
    { line: 11, callLines: [6] },
    { line: 12, callLines: [6] },
    { line: 13, callLines: [6] },
    { line: 11, callLines: [6] },
    { line: 12, callLines: [6] },
    { line: 13, callLines: [6] },
  ]);
});

test('recursive calls in nested blocks with continuations retain their call steps', () => {
  const source = `main :: IO ()
main=do
  t <- newTurtle
  walk t 1

walk :: Turtle -> Int -> IO ()
walk t 0 = return ()
walk t n = do
  if n > 0 then do
    右を向く t
    walk t (n-1)
  else return ()
  return ()
`;
  const recording = traceProgram('haskell', source, source);
  expect(recording.traceItems.map(({ line, callLines }) => ({ line, callLines }))).toEqual([
    { line: 0, callLines: [] },
    { line: 3, callLines: [] },
    { line: 10, callLines: [4] },
    { line: 11, callLines: [4] },
  ]);
});

test.each(
  ['error(f(n+1))', 'errorWithoutStackTrace(f(n+1))', 'errorWithoutStackTrace("x"++f(n+1))'].flatMap((rhs) =>
    ['f(0::Int)', '(f(0::Int),42::Int)'].map((binding) => [rhs, binding])
  )
)('native depth exhaustion leaves unused lazy values and later displays independent: %s, %s', (rhs, binding) => {
  const source = `f n=${rhs}
main=do
 let x=${binding}
 let y=1::Int
 print y
 print(y+1)`;
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    stdout: '1\n2\n',
    uncaughtException: undefined,
  });
  const recording = traceProgram('haskell', source, source);
  expect(recording.stdout).toBe('1\n2\n');
  expect(recording.uncaughtException).toBeUndefined();
  expect(recording.traceItems.some((item) => item.vars.y === 1)).toBe(true);
  const demanded = source + '\n print x';
  expect(executeProgram('haskell', demanded)).toMatchObject({ kind: 'limitExceeded', limit: 'operations' });
  expect(() => traceProgram('haskell', demanded, demanded)).toThrowError(ExecutionLimitError);
});

test('shared visibility scopes preserve shadowing order and restore enclosing bindings', () => {
  const source = `main=do
  let x=1::Int
  let y=2::Int
  let x=True
  if True then do
    let x='z'
    print x
  else pure ()
  print x`;
  const recording = traceProgram('haskell', source, source);
  expect(recording.stdout).toBe("'z'\nTrue\n");
  expect(recording.finalVars).toEqual({ x: true, y: 2 });
  expect(Object.keys(recording.finalVars)).toEqual(['x', 'y']);
  expect(recording.traceItems.find((item) => item.line === 6)?.vars).toEqual({ x: 'z', y: 2 });
});

test.each([
  ['(Just t)', '[Just t1,Just t2]'],
  ['m@(Just t)', '[Just t1,Just t2]'],
  ['(Just (Just t))', '[Just(Just t1),Just(Just t2)]'],
  ['(t,_)', '[(t1,()),(t2,())]'],
  ['pair@(t,_)', '[(t1,()),(t2,())]'],
])('reference-only loop pattern %s omits unchanged binding steps', (pattern, values) => {
  const source = `import Control.Monad
main=do
 t1<-newTurtleAt 1 1
 t2<-newTurtleAt 3 3
 let ts=${values}
 forM_ ts $ \\${pattern}->do
  forward t`;
  const recording = traceProgram('haskell', source, source);
  expect(recording.uncaughtException).toBeUndefined();
  expect(
    recording.traceItems.map(({ line, vars, turtles }) => ({
      line,
      vars,
      positions: turtles.map(({ x, y }) => [x, y]),
    }))
  ).toEqual([
    { line: 0, vars: {}, positions: [] },
    { line: 3, vars: {}, positions: [[1, 1]] },
    {
      line: 4,
      vars: {},
      positions: [
        [1, 1],
        [3, 3],
      ],
    },
    {
      line: 5,
      vars: {},
      positions: [
        [1, 1],
        [3, 3],
      ],
    },
    {
      line: 7,
      vars: {},
      positions: [
        [1, 2],
        [3, 3],
      ],
    },
    {
      line: 7,
      vars: {},
      positions: [
        [1, 2],
        [3, 4],
      ],
    },
  ]);
});

test.each([
  ['n', '[1,1::Int]'],
  ['(Just n)', '[Just(1::Int),Just 1]'],
  ['m@(Just n)', '[Just(1::Int),Just 1]'],
  ['pair@((),n)', '[((),1::Int),((),1)]'],
])('scalar loop pattern %s retains each repeated binding step', (pattern, values) => {
  const source = `import Control.Monad
main=forM_ ${values} $ \\${pattern}->do
 print n`;
  const recording = traceProgram('haskell', source, source);
  expect(recording).toMatchObject({ stdout: '1\n1\n', uncaughtException: undefined });
  expect(recording.traceItems.map(({ line, vars }) => ({ line, vars }))).toEqual([
    { line: 0, vars: {} },
    { line: 2, vars: { n: 1 } },
    { line: 3, vars: { n: 1 } },
    { line: 2, vars: { n: 1 } },
    { line: 3, vars: { n: 1 } },
  ]);
});

test('a scalar inside a mixed loop pattern retains its binding steps', () => {
  const source = `import Control.Monad
main=do
 t1<-newTurtleAt 1 1
 t2<-newTurtleAt 3 3
 let ts=[(t1,1::Int),(t2,1)]
 forM_ ts $ \\pair@(t,n)->do
  forward t`;
  const recording = traceProgram('haskell', source, source);
  expect(recording.uncaughtException).toBeUndefined();
  expect(recording.traceItems.map(({ line, vars }) => ({ line, vars }))).toEqual([
    { line: 0, vars: {} },
    { line: 3, vars: {} },
    { line: 4, vars: {} },
    { line: 5, vars: {} },
    { line: 6, vars: { n: 1 } },
    { line: 7, vars: { n: 1 } },
    { line: 6, vars: { n: 1 } },
    { line: 7, vars: { n: 1 } },
  ]);
});

test.each(['toString', 'valueOf', '__proto__', 'constructor', 'hasOwnProperty'])(
  'preserves the variable and record field named %s',
  (name) => {
    const source = `import Control.Monad
 data Box = Box { ${name} :: Int }
 main = do
   let ${name} = "x"
   let box = Box 7
   forM_ [()] $ \\_ -> print (1 :: Int)
`.replaceAll(/^ /gm, '');
    const result = traceProgram('haskell', source, source);
    expect(result.stdout).toBe('1\n');
    expect(Object.entries(result.finalVars)).toContainEqual([name, 'x']);
    expect(result.traceItems.at(-1)?.referenceVars.box).toEqual({
      kind: 'object',
      entries: { [name]: { kind: 'value', value: 7 } },
    });
    expect(result.traceItems).toHaveLength(4);
  }
);

test.each([
  ['[1,1 :: Int]', '1\n1\n', 1],
  ['["x","x"]', '"x"\n"x"\n', 'x'],
])('records repeated inferred scalar loop bindings over %s', (values, stdout, value) => {
  const source = `import Control.Monad
printAll xs = forM_ xs $ \\n -> do
  print n
main = printAll ${values}`;
  const result = traceProgram('haskell', source, source);
  expect(result.stdout).toBe(stdout);
  expect(result.traceItems.map(({ line, vars }) => [line, vars.n])).toEqual([
    [0, undefined],
    [2, value],
    [3, value],
    [2, value],
    [3, value],
  ]);
});

test('traces each action and call frame of an inferred monadic helper', () => {
  const source = `repeatAction action = do
  action
  action
main = do
  t <- newTurtle
  repeatAction (forward t)`;
  const result = traceProgram('haskell', source, source);
  expect(result.traceItems.map(({ line, callLines, turtles }) => [line, callLines, turtles[0]?.y])).toEqual([
    [0, [], undefined],
    [5, [], 0],
    [2, [6], 1],
    [3, [6], 2],
  ]);
  expect(result.finalTurtles[0]?.y).toBe(2);
});

test('keeps pure monads pure when selecting traced IO blocks', () => {
  const source = `repeatAction action = do
  action
  action
main = print (repeatAction (Just (2 :: Int)), repeatAction [1,2 :: Int])`;
  const result = traceProgram('haskell', source, source);
  expect(result.stdout).toBe('(Just 2,[1,2,1,2])\n');
  expect(result.traceItems.map(({ line, callLines }) => [line, callLines])).toEqual([
    [0, []],
    [4, []],
  ]);
});

test.each(['Int', 'Turtle'])('classifies inferred IO result bindings as %s at runtime', (type) => {
  const record = (signature: string): ReturnType<typeof traceProgram> => {
    const source = `${signature}
helper action = do
  x <- action
  pure x
producer = do
  print (1 :: Int)
  ${type === 'Int' ? 'pure (1 :: Int)' : 'newTurtle'}
main = do
  n <- helper producer
  print (1 :: Int)`;
    return traceProgram('haskell', source, source);
  };
  const inferred = record('');
  const annotated = record(`helper :: IO ${type} -> IO ${type}`);
  expect(inferred.stdout).toBe('1\n1\n');
  expect(inferred.traceItems).toEqual(annotated.traceItems);
  expect(inferred.finalVars).toEqual(annotated.finalVars);
  expect(inferred.finalTurtles).toEqual(annotated.finalTurtles);
});

test.each(['action', 'let n = 1 :: Int\n  action'])(
  'retains inferred IO do metadata without a Monad dictionary: %s',
  (body) => {
    const record = (signature: string): ReturnType<typeof traceProgram> => {
      const source = `${signature}
helper action = do
  ${body}
main = do
  t <- newTurtle
  helper (forward t)`;
      return traceProgram('haskell', source, source);
    };
    const inferred = record('');
    const annotated = record('helper :: IO () -> IO ()');
    expect(inferred.finalTurtles[0]?.y).toBe(1);
    expect(inferred.traceItems).toEqual(annotated.traceItems);
  }
);

test('retains generic IO metadata after its action is forced as a pure value', () => {
  const [inferred, annotated] = ['', 'helper :: IO () -> IO ()'].map((signature) => {
    const source = `${signature}
helper action = do
  let n = 1 :: Int
  action
main = do
  t <- newTurtle
  let action = helper (forward t)
  action \`seq\` pure ()
  action`;
    return traceProgram('haskell', source, source);
  });
  expect(inferred.finalTurtles[0]?.y).toBe(1);
  expect(inferred.traceItems).toEqual(annotated.traceItems);
});

test('selects generic do behavior independently for pure values and IO calls', () => {
  const source = `helper value = do
  let n = 1 :: Int
  value
main = do
  let m = helper (Just (2 :: Int))
  let xs = helper [3,4 :: Int]
  let x = helper (5 :: Int)
  print (m,xs,x)
  t <- newTurtle
  helper (forward t)`;
  const result = traceProgram('haskell', source, source);
  expect(result.stdout).toBe('(Just 2,[3,4],5)\n');
  expect(result.finalTurtles[0]?.y).toBe(1);
  expect(
    result.traceItems
      .filter(({ callLines }) => callLines.length > 0)
      .map(({ line, vars, turtles }) => [line, vars.n, turtles[0]?.y])
  ).toEqual([
    [2, 1, 0],
    [3, 1, 1],
  ]);
});

test('generic do metadata preserves ordinary pure demand and lazy fields', () => {
  const source = `helper value = do
  let unused = error "unused" :: Int
  value
main = print (take 1 (helper [7,error "tail" :: Int]), fst (helper (8 :: Int,error "field" :: Int)), helper (Just (undefined :: Int)) \`seq\` True)`;
  const result = traceProgram('haskell', source, source);
  expect(result.stdout).toBe('([7],8,True)\n');
  expect(result.uncaughtException).toBeUndefined();
  expect(result.traceItems).toHaveLength(2);
});

test('forcing a generic do action as a pure value preserves construction exceptions', () => {
  const source = `helper action = do
  let n = 1 :: Int
  action
main = print (helper (error "construction" :: IO ()) \`seq\` True)`;
  const result = traceProgram('haskell', source, source);
  expect(result.stdout).toBe('');
  expect(result.uncaughtException).toBe('construction');
  expect(result.traceItems).toHaveLength(1);
});

test.each([
  ['(1.2345678 :: Float)', '1.2345678\n'],
  ['"x"', '"x"\n'],
])('retains instantiated display types through pure generic do: %s', (value, stdout) => {
  const source = `idDo value = do
  value
record value = do
  let copy = idDo value
  print copy
main = record ${value}`;
  const result = traceProgram('haskell', source, source);
  expect(result.stdout).toBe(stdout);
  const displayed = result.traceItems.filter(({ vars }) => Object.hasOwn(vars, 'copy'));
  expect(displayed).toHaveLength(2);
  for (const { vars, referenceVars } of displayed) {
    expect(vars.copy).toEqual(vars.value);
    expect(referenceVars.copy).toEqual(referenceVars.value);
  }
});

test('retains scalar binding steps for a generic single-expression do lambda', () => {
  const source = `import Control.Monad
repeatEach action values = forM_ values $ \\n -> do
  action n
main = repeatEach print [1,1 :: Int]`;
  const result = traceProgram('haskell', source, source);
  expect(result.stdout).toBe('1\n1\n');
  expect(result.traceItems.map(({ line, vars }) => [line, vars.n])).toEqual([
    [0, undefined],
    [2, 1],
    [3, 1],
    [2, 1],
    [3, 1],
  ]);
});

test.each(['', 'i+200'])('fresh lazy lists have bounded cumulative previews: %s', (end) => {
  const source = `import Control.Monad
main=forM_ [1..1000::Int] $ \\i -> do
 let a=[i..${end}]; b=[i*2..${end ? 'i*2+200' : ''}]; c=[i*3..${end ? 'i*3+200' : ''}] :: [Int]
 print (head a + head b + head c)`;
  const recording = traceProgram('haskell', source, source);
  expect(recording.uncaughtException).toBeUndefined();
  expect(recording.stdout).toBe(Array.from({ length: 1000 }, (_, index) => `${(index + 1) * 6}\n`).join(''));
  expect(recording.traceItems).toHaveLength(3001);
  expect(recording.traceItems.at(-1)?.vars.i).toBe(1000);
  expect(recording.traceItems.at(-1)?.referenceVars).toMatchObject({
    a: { kind: 'value', value: '…' },
    b: { kind: 'value', value: '…' },
    c: { kind: 'value', value: '…' },
  });
});

test('helper turtle results record named binding steps', () => {
  const source = `main :: IO ()
main = do
  a <- make
  print (1::Int)
make :: IO Turtle
make = do
  t <- newTurtleAt 2 2
  forward t
  return t`;
  const recording = traceProgram('haskell', source, source);
  expect(recording.stdout).toBe('1\n');
  expect(recording.uncaughtException).toBeUndefined();
  expect(recording.traceItems.some(({ line, callLines }) => line === 3 && callLines.length === 0)).toBe(true);
});

test.each(['newTurtle', 'newTurtleAt 2 2', 'newTurtleWithColor 2 2 "Y"'])(
  'direct turtle creation retains its declaration step policy: %s',
  (creation) => {
    const source = `main=do\n t<-${creation}\n forward t`;
    const recording = traceProgram('haskell', source, source);
    expect(recording.uncaughtException).toBeUndefined();
    expect(recording.traceItems.map(({ line }) => line)).toEqual([0, 2, 3]);
  }
);

test('record factories and shadowed creation names retain their binding steps', () => {
  const source = `data Person=Person Int
make :: IO Person
make=do
 print (1::Int)
 return (Person 2)
newTurtle :: IO Person
newTurtle=make
main=do
 p<-make
 q<-newTurtle
 print (3::Int)`;
  const recording = traceProgram('haskell', source, source);
  expect(recording.stdout).toBe('1\n1\n3\n');
  expect(recording.uncaughtException).toBeUndefined();
  expect(recording.traceItems.filter(({ callLines }) => callLines.length === 0).map(({ line }) => line)).toEqual([
    0, 9, 10, 11,
  ]);
});

test('wildcard IO bindings retain bare-call step behavior', () => {
  const source = `main=do
 _<-make
 print(1::Int)
make=do
 t<-newTurtle
 forward t
 return t`;
  const wildcard = traceProgram('haskell', source, source);
  const bareSource = source.replace('_<-make', 'make');
  const bare = traceProgram('haskell', bareSource, bareSource);
  expect(wildcard.stdout).toBe('1\n');
  expect(wildcard.uncaughtException).toBeUndefined();
  expect(wildcard.traceItems).toEqual(bare.traceItems);
});

test.each(['i+200', ''])(
  'normal demand exposes scalar values and aliases after composite previews: %s',
  (end) => {
    const source = scalarAliasesProgram(1000, end);
    const recording = traceProgram('haskell', source, source);
    expect(recording.uncaughtException).toBeUndefined();
    expect(recording.stdout).toBe(Array.from({ length: 1000 }, (_, i) => `${(i + 1) * 2}\n`).join(''));
    expect(recording.traceItems).toHaveLength(5001);
    for (const line of [2, 4, 5, 6]) {
      const last = recording.traceItems.findLast((item) => item.line === line);
      expect(last?.vars.i).toBe(1000);
      if (line === 6) {
        expect(last?.vars.n).toBe(2000);
        expect(last?.vars.copy).toBe(2000);
      }
    }
  },
  30_000
);

test.each(['i+200', ''])('scalar aliases retain assignment views under composite operation quotas: %s', (end) => {
  const source = scalarAliasesProgram(50, end);
  const recording = traceWithClock(source, () => 0);
  expect(recording.uncaughtException).toBeUndefined();
  expect(recording.stdout).toBe(Array.from({ length: 50 }, (_, i) => `${(i + 1) * 2}\n`).join(''));
  for (const line of [4, 5]) {
    const assignments = recording.traceItems.filter((item) => item.line === line);
    expect(assignments).toHaveLength(50);
    for (const [index, item] of assignments.entries()) {
      expect(item.vars.n).toBe((index + 1) * 2);
      if (line === 5) expect(item.vars.copy).toBe((index + 1) * 2);
    }
  }
});

test.each(['reverse [1..100::Int]', 'reverse [1..200::Int]', 'last [[1..100::Int],[1..200]]'])(
  'composite root previews preserve later scalar assignments: %s',
  (collection) => {
    const iterations = 300;
    const source = `import Control.Monad
main=forM_ [1..${iterations}::Int] $ \\i -> do
 let a=${collection}
 let n=i*2
 print n`;
    const recording = traceWithClock(source, () => 0);
    expect(recording.uncaughtException).toBeUndefined();
    expect(recording.stdout).toBe(Array.from({ length: iterations }, (_, i) => `${(i + 1) * 2}\n`).join(''));
    const assignments = recording.traceItems.filter((item) => item.line === 4);
    expect(assignments).toHaveLength(iterations);
    for (const [index, item] of assignments.entries()) {
      expect(item.vars.i).toBe(index + 1);
      expect(item.vars.n).toBe((index + 1) * 2);
    }
  }
);

test.each([
  ['', 's', 'show i', 's', '500'],
  ['', 's', 'if even i then "even" else "odd"', 's', 'even'],
  ['data Color=Red|Blue', 'c', 'if even i then Red else Blue', 'c', 'Red'],
  ['', 'c', 'compare i 250', 'c', 'GT'],
  ['import Data.Ratio', 'n', 'i % 2', 'n', '250 % 1'],
  ['data P=P {first::Int,second::Int}', 'this', 'P (i*2) (i*3)', 'this.first', 1000],
  ['data P=P {first::Int,second::Int}', 'this', 'id(P (i*2) (i*3))', 'this.second', 1500],
  ['data P=P {label::String}', 'this', 'P(show i)', 'this.label', '500'],
])('composite exhaustion preserves scalar answer views: %s %s=%s', (declaration, name, expression, shown, last) => {
  const iterations = 500;
  const source = `import Control.Monad
${declaration}
main=forM_ [1..${iterations}::Int] $ \\i -> do
 let a=reverse [1..200::Int]
 let ${name}=${expression}
 print i`;
  const recording = traceWithClock(source, () => 0);
  expect(recording.uncaughtException).toBeUndefined();
  expect(recording.stdout).toBe(Array.from({ length: iterations }, (_, i) => `${i + 1}\n`).join(''));
  const assignments = recording.traceItems.filter((item) => item.line === 5);
  expect(assignments).toHaveLength(iterations);
  for (const item of assignments) expect(Object.hasOwn(item.vars, shown)).toBe(true);
  expect(assignments.at(-1)?.vars[shown]).toBe(last);
});

test.each([
  ['data T=E|T [Int]', 'a'],
  ['data T=T {items::[Int]}', 'this'],
])('uncertain composite roots preserve scalar capacity: %s', { timeout: 30_000 }, (declaration, name) => {
  const source = `import Control.Monad
${declaration}
main=forM_ [1..1000::Int] $ \\i -> do
 let ${name}=last(map T(replicate 100 [1..10]))
 let n=i*2
 print n`;
  const recording = traceWithClock(source, () => 0);
  expect(recording.uncaughtException).toBeUndefined();
  expect(recording.stdout).toBe(Array.from({ length: 1000 }, (_, i) => `${(i + 1) * 2}\n`).join(''));
  const assignments = recording.traceItems.filter((item) => item.line === 5);
  expect(assignments).toHaveLength(1000);
  for (const [index, item] of assignments.entries()) {
    expect(item.vars.i).toBe(index + 1);
    expect(item.vars.n).toBe((index + 1) * 2);
  }
});

test('mixed constructor types retain cheap enum answers after composite exhaustion', () => {
  const iterations = 500;
  const source = `import Control.Monad
data T=E|T [Int]
main=forM_ [1..${iterations}::Int] $ \\i -> do
 let a=reverse [1..200::Int]
 let n=if even i then E else E
 print i`;
  const recording = traceWithClock(source, () => 0);
  expect(recording.uncaughtException).toBeUndefined();
  expect(recording.stdout).toBe(Array.from({ length: iterations }, (_, i) => `${i + 1}\n`).join(''));
  const assignments = recording.traceItems.filter((item) => item.line === 5);
  expect(assignments).toHaveLength(iterations);
  for (const item of assignments) expect(item.vars.n).toBe('E');
});

test.each([
  ['', 'n', 'if even i then E else E', 'n', 'E'],
  ['data P=P {x::Int}', 'this', 'P (i*2)', 'this.x', 600],
  ['data P=P {items::[Int],x::Int}', 'this', 'P (reverse [1..200]) (i*2)', 'this.x', 600],
])(
  'independent bindings retain cheap views after expensive previews: %s %s',
  (declaration, name, expression, shown, last) => {
    const iterations = 300;
    const source = `import Control.Monad
data T=E|T [Int]
${declaration}
main=forM_ [1..${iterations}::Int] $ \\i -> do
 let a=last(map T(replicate 100 [1..10]))
 let ${name}=${expression}
 print i`;
    const recording = traceWithClock(source, () => 0);
    expect(recording.uncaughtException).toBeUndefined();
    expect(recording.stdout).toBe(Array.from({ length: iterations }, (_, i) => `${i + 1}\n`).join(''));
    const assignments = recording.traceItems.filter((item) => item.line === 6);
    expect(assignments).toHaveLength(iterations);
    for (const item of assignments) expect(Object.hasOwn(item.vars, shown)).toBe(true);
    expect(assignments.at(-1)?.vars[shown]).toBe(last);
  }
);

test.each([
  ['before', 'ready'],
  ['before', 'computed'],
  ['after', 'ready'],
  ['never', 'ready'],
  ['locals', 'ready'],
  ['locals', 'blocked'],
  ['sequence', 'computed'],
])('inactive declarations do not hide active loop values: %s %s', (order, valueKind) => {
  const helpers = Array.from(
    { length: 5 },
    (_, j) => `f${j}=do\n let x=${valueKind === 'computed' ? `sum [1..10::Int]+${j}` : `${j}::Int`}\n print x`
  ).join('\n');
  const calls = Array.from({ length: 5 }, (_, j) => ` f${j}`).join('\n');
  const locals = Array.from(
    { length: 5 },
    (_, j) => ` let x${j}=${valueKind === 'blocked' ? `map (\\n->sum [1..10000::Int]+n+${j}) [1..]` : `${j}::Int`}`
  ).join('\n');
  const entry = order === 'sequence' ? 'main=sequence_ [f0,f1,f2,f3,f4,work]\nwork=do' : 'main=do';
  const source = `import Control.Monad
${entry}
${order === 'locals' ? locals : order === 'before' ? calls : ''}
 forM_ [1..1000::Int] $ \\i -> do
  let n=sum [1..10::Int]+i
  print i
${order === 'after' ? calls : ''}
${helpers}`;
  const execution = executeProgram('haskell', source);
  expect(execution.kind).toBe('executed');
  if (execution.kind !== 'executed') return;
  const recording = traceWithClock(source, () => 0);
  expect(recording.uncaughtException).toBeUndefined();
  expect(recording.stdout).toBe(execution.stdout);
  const line = source.split('\n').findIndex((text) => text.includes('let n=')) + 1;
  const assignments = recording.traceItems.filter((item) => item.line === line);
  expect(assignments).toHaveLength(1000);
  for (const [index, item] of assignments.entries()) {
    expect(item.vars.i).toBe(index + 1);
    expect(item.vars.n).toBe(index + 56);
  }
});

test.each([
  [100, 1000, true],
  [1000, 200, true],
  [100, 1000, false],
])(
  'completed expensive cohorts release operation quota: %i iterations, %i elements, distinct=%s',
  (iterations, size, distinct) => {
    const names = distinct ? ['burn0', 'burn1'] : ['burn', 'burn'];
    const helpers = [...new Set(names)]
      .map(
        (name) => `${name}=forM_ [1..${iterations}::Int] $ \\j -> do
 let a=reverse [1..${size}::Int]
 print j`
      )
      .join('\n');
    const source = `import Control.Monad
main=do
 ${names[0]}
 ${names[1]}
 forM_ [1..300::Int] $ \\i -> do
  let n=sum [1..10::Int]+i
  print i
${helpers}`;
    const execution = executeProgram('haskell', source);
    expect(execution.kind).toBe('executed');
    if (execution.kind !== 'executed') return;
    let ticks = 0;
    const recording = traceWithClock(source, () => ticks++ / 1000);
    expect(recording.uncaughtException).toBeUndefined();
    expect(recording.stdout).toBe(execution.stdout);
    const assignments = recording.traceItems.filter((item) => item.line === 6);
    expect(assignments).toHaveLength(300);
    for (const [index, item] of assignments.entries()) expect(item.vars.n).toBe(index + 56);
  }
);

test.each([
  [1000, 50, true],
  [3000, 10, false],
])(
  'unused scalar loop answers retain preview allowance: %i iterations, sum 1..%i, prefix=%s',
  (iterations, size, prefix) => {
    const source = `import Control.Monad
main=do
${prefix ? ' putStrLn "start"' : ''}
 forM_ [1..${iterations}::Int] $ \\i -> do
  let total=sum [1..${size}::Int]+i
  print i`;
    const execution = executeProgram('haskell', source);
    expect(execution.kind).toBe('executed');
    if (execution.kind !== 'executed') return;
    const recording = traceWithClock(source, () => 0);
    expect(recording.uncaughtException).toBeUndefined();
    expect(recording.stdout).toBe(execution.stdout);
    const assignments = recording.traceItems.filter((item) => item.line === 5);
    expect(assignments).toHaveLength(iterations);
    for (const [index, item] of assignments.entries()) {
      expect(item.vars.total).toBe((size * (size + 1)) / 2 + index + 1);
    }
  }
);

test.each([
  ['tuple', '(i,sum [1..50::Int]+i)'],
  ['maybe', 'Just (sum [1..50::Int]+i)'],
  ['list', 'map (*i) [1..20::Int]'],
  ['record', 'Pair i (sum [1..50::Int]+i)'],
  ['map', 'M.fromList [(i,sum [1..50::Int]+i)]'],
  ['set', 'S.fromList [sum [1..50::Int]+i]'],
])('completed %s loop views retain preview allowance', (kind, expression) => {
  const source = `import Control.Monad
import qualified Data.Map as M
import qualified Data.Set as S
data Pair=Pair {first::Int,second::Int}
main=do
 putStrLn "start"
 forM_ [1..1000::Int] $ \\i -> do
  let xs=${expression}
  print i`;
  const execution = executeProgram('haskell', source);
  expect(execution.kind).toBe('executed');
  if (execution.kind !== 'executed') return;
  const recording = traceWithClock(source, () => 0);
  expect(recording.uncaughtException).toBeUndefined();
  expect(recording.stdout).toBe(execution.stdout);
  const assignments = recording.traceItems.filter((item) => item.line === 8);
  expect(assignments).toHaveLength(1000);
  for (const [index, item] of assignments.entries()) {
    const i = index + 1;
    const total = i + 1275;
    let expected: DisplayNode | undefined;
    switch (kind) {
      case 'tuple': {
        expected = traceArray([traceValue(i), traceValue(total)]);
        break;
      }
      case 'maybe': {
        expected = traceValue(total);
        break;
      }
      case 'list': {
        expected = traceArray(Array.from({ length: 20 }, (_, j) => traceValue(i * (j + 1))));
        break;
      }
      case 'record': {
        expected = { kind: 'object', entries: { first: traceValue(i), second: traceValue(total) } };
        break;
      }
      case 'map': {
        expected = traceArray([traceArray([traceValue(i), traceValue(total)])]);
        break;
      }
      case 'set': {
        expected = traceArray([traceValue(total)]);
        break;
      }
    }
    expect(item.referenceVars?.xs).toEqual(expected);
  }
});

const traceValue = (value: number): DisplayNode => ({ kind: 'value', value });
const traceArray = (values: DisplayNode[]): DisplayNode => ({
  kind: 'array',
  entries: Object.fromEntries(values.map((node, index) => [index, node])),
});

test('aborted previews leave later cheap loop answers available', () => {
  const source = `step :: Int -> IO ()
step i = do
 let a=sum [1..100000::Int]+i
 let n=sum [1..10::Int]+i
 print i
main=mapM_ step [1..700]`;
  const execution = executeProgram('haskell', source);
  expect(execution.kind).toBe('executed');
  if (execution.kind !== 'executed') return;
  const recording = traceWithClock(source, () => 0);
  expect(recording.uncaughtException).toBeUndefined();
  expect(recording.stdout).toBe(execution.stdout);
  const assignments = recording.traceItems.filter((item) => item.line === 4);
  expect(assignments).toHaveLength(700);
  for (const [index, item] of assignments.entries()) expect(item.vars.n).toBe(index + 56);
}, 30_000);

test('expired preview time preserves evaluated loop variables', () => {
  const source = `step :: Int -> IO ()
step i = do
 let a=sum [1..100000::Int]+i
 let n=sum [1..10::Int]+i
 print i
main=mapM_ step [1..1000]`;
  const execution = executeProgram('haskell', source);
  expect(execution.kind).toBe('executed');
  if (execution.kind !== 'executed') return;
  let ticks = 0;
  const recording = traceWithClock(source, () => ticks++ / 100);
  expect(recording.uncaughtException).toBeUndefined();
  expect(recording.stdout).toBe(execution.stdout);
  const prints = recording.traceItems.filter((item) => item.line === 5);
  expect(prints).toHaveLength(1000);
  expect(prints[0].vars.n).toBe(56);
  expect(prints.at(-1)?.vars.n).toBeUndefined();
  for (const [index, item] of prints.entries()) expect(item.vars.i).toBe(index + 1);
});

test.each([
  ['Base', 'Bool', 'Red|Green|Blue', 'Blue'],
  ['Base', 'Maybe', 'Red|Green|Blue', 'Blue'],
  ['Base', 'Ratio', 'Red|Green|Blue', 'Blue'],
  ['Data.Map.Internal', 'Map', 'Red|Green|Blue', 'Blue'],
  ['Data.Set.Internal', 'Set', 'Red|Green|Blue', 'Blue'],
])('user-defined %s.%s retains its constructor identity', (module, type, constructors, value) => {
  const source = `module ${module} where
import Prelude hiding (${type}(..))
data ${type}=${constructors} deriving Show
main=do
 let color=${value}
 let colors=[${value}]
 print color`;
  const recording = traceProgram('haskell', source, source);
  expect(recording.uncaughtException).toBeUndefined();
  expect(recording.stdout).toBe(`${value}\n`);
  expect(recording.finalVars.color).toBe(value);
  expect(recording.finalVars.colors).toEqual([value]);
  expect(recording.traceItems.at(-1)?.referenceVars?.colors).toMatchObject({
    kind: 'array',
    entries: { 0: { kind: 'value', value } },
  });
});

test.each([10, 100])('returned previewed values retain execution costs across retired cohorts: sum 1..%i', (count) => {
  const source = `import Control.Monad
build i=do
 let n=sum [1..${count}::Int]+i
 return n
main=forM_ [1..1000::Int] $ \\i -> do
 n<-build i
 print n`;
  const execution = executeProgram('haskell', source);
  if (count === 100) {
    expect(execution).toMatchObject({ kind: 'limitExceeded', limit: 'operations' });
    expect(() => traceProgram('haskell', source, source)).toThrowError(ExecutionLimitError);
    return;
  }
  expect(execution.kind).toBe('executed');
  if (execution.kind !== 'executed') return;
  const recording = traceProgram('haskell', source, source);
  expect(recording.uncaughtException).toBeUndefined();
  expect(recording.stdout).toBe(execution.stdout);
});

test.each([20, 30, 77])('demanded scalar previews preserve every loop assignment: sum 1..%i', (count) => {
  const source = `import Control.Monad
main=forM_ [1..1000::Int] $ \\i -> do
 let n=sum [1..${count}::Int]+i
 print n`;
  const recording = traceWithClock(source, () => 0);
  expect(recording.uncaughtException).toBeUndefined();
  expect(recording.stdout).toBe(
    Array.from({ length: 1000 }, (_, i) => `${(count * (count + 1)) / 2 + i + 1}\n`).join('')
  );
  const assignments = recording.traceItems.filter((item) => item.line === 3);
  expect(assignments).toHaveLength(1000);
  for (const [index, item] of assignments.entries()) {
    expect(item.vars.i).toBe(index + 1);
    expect(item.vars.n).toBe((count * (count + 1)) / 2 + index + 1);
  }
});

test('demanding previewed computations still enforces the execution budget', () => {
  const source = 'import Control.Monad\nmain=forM_ [1..1000::Int] $ \\i -> do\n let n=sum [1..100::Int]+i\n print n';
  expect(executeProgram('haskell', source)).toMatchObject({ kind: 'limitExceeded', limit: 'operations' });
  expect(() => traceProgram('haskell', source, source)).toThrowError(ExecutionLimitError);
});

test.each([
  ['map (+i) [1..160::Int]', 'sum xs'],
  ['map (+i) [1..162::Int]', 'let ys=xs in sum ys'],
  ['scanl (+) i [1..100::Int]', 'sum xs'],
])('demanded list previews preserve the execution budget: %s', (list, result) => {
  const source = `import Control.Monad
main=forM_ [1..300::Int] $ \\i -> do
 let xs=${list}
 print(${result})`;
  const execution = executeProgram('haskell', source);
  expect(execution.kind).toBe('executed');
  if (execution.kind !== 'executed') return;
  const recording = traceProgram('haskell', source, source);
  expect(recording.uncaughtException).toBeUndefined();
  expect(recording.stdout).toBe(execution.stdout);
});

test.each([
  ['(x+1,x+2)', 'snd p'],
  ['(x+1,x+2,x+3)', 'case p of (_,_,z)->z'],
])('shared inner previews preserve execution limits: %s', (tuple, result) => {
  const source = `import Control.Monad
main=forM_ [1..800::Int] $ \\i -> do
 let p=let x=sum [1..100::Int]+i in ${tuple}
 print (${result})`;
  expect(executeProgram('haskell', source)).toMatchObject({ kind: 'limitExceeded', limit: 'operations' });
  expect(() => traceProgram('haskell', source, source)).toThrowError(ExecutionLimitError);
});

test('shared inner previews charge a demanded computation once', () => {
  const source = `import Control.Monad
main=forM_ [1..400::Int] $ \\i -> do
 let p=let x=sum [1..100::Int]+i in (x+1,x+2,x+3)
 case p of (a,b,c)->print(a+b+c)`;
  const execution = executeProgram('haskell', source);
  expect(execution).toMatchObject({ kind: 'executed' });
  const recording = traceProgram('haskell', source, source);
  expect(recording.uncaughtException).toBeUndefined();
  expect(recording.stdout).toBe(Array.from({ length: 400 }, (_, i) => `${15_159 + 3 * i}\n`).join(''));
});

test('unused shared inner previews do not consume the execution budget', () => {
  const source = `import Control.Monad
main=forM_ [1..800::Int] $ \\i -> do
 let p=let x=sum [1..100::Int]+i in (x+1,i)
 print(snd p)`;
  expect(executeProgram('haskell', source)).toMatchObject({ kind: 'executed' });
  const recording = traceProgram('haskell', source, source);
  expect(recording.uncaughtException).toBeUndefined();
  expect(recording.stdout).toBe(Array.from({ length: 800 }, (_, i) => `${i + 1}\n`).join(''));
});

test('an evaluated list stays visible through repeated unchanged renders', () => {
  const source = `main=do
 let xs=[1..10::Int]
 loop 1 xs
loop::Int->[Int]->IO()
loop i xs | i>1500=print(length xs) | otherwise=do
 let k=i*2
 print k
 loop(i+1)xs`;
  const recording = traceProgram('haskell', source, source);
  expect(recording.uncaughtException).toBeUndefined();
  expect(recording.stdout).toBe(Array.from({ length: 1500 }, (_, i) => `${(i + 1) * 2}\n`).join('') + '10\n');
  const shown = recording.traceItems.filter((item) => Object.hasOwn(item.referenceVars, 'xs'));
  expect(shown.length).toBeGreaterThan(2500);
  for (const item of shown) expect(item.vars.xs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('demanded list transformations keep displaying later iterations', () => {
  const source = `main=loop 1 [1..20::Int]
loop::Int->[Int]->IO()
loop i xs | i>150=print(length xs) | otherwise=do
 let ys=map(+1)xs
 let zs=reverse ys
 print(sum zs)
 loop(i+1)ys`;
  const recording = traceProgram('haskell', source, source);
  expect(recording.uncaughtException).toBeUndefined();
  expect(recording.stdout).toBe(Array.from({ length: 150 }, (_, i) => `${230 + i * 20}\n`).join('') + '20\n');
  const last = recording.traceItems.findLast((item) => Object.hasOwn(item.referenceVars, 'ys'));
  expect(last?.vars.ys).toEqual(Array.from({ length: 20 }, (_, i) => 151 + i));
  expect(last?.vars.zs).toEqual(Array.from({ length: 20 }, (_, i) => 170 - i));
});

test('evaluated maps retain their ordered contents across repeated steps', () => {
  const source = `import Control.Monad
import qualified Data.Map as M
main=do
 let m=M.fromList[(i,i*2)|i<-[1..100::Int]]
 print(M.size m)
 forM_[1..150::Int] $ \\i->print i`;
  const recording = traceProgram('haskell', source, source);
  expect(recording.uncaughtException).toBeUndefined();
  expect(recording.stdout).toBe('100\n' + Array.from({ length: 150 }, (_, i) => `${i + 1}\n`).join(''));
  const last = recording.traceItems.at(-1)?.referenceVars.m;
  expect(last?.kind).toBe('array');
  if (last?.kind !== 'array') return;
  expect(Object.keys(last.entries)).toHaveLength(100);
  expect(last.entries[99]).toEqual({
    kind: 'array',
    entries: { 0: { kind: 'value', value: 100 }, 1: { kind: 'value', value: 200 } },
  });
});

const nested = (value: string): string => `${'Just('.repeat(20)}${value}${')'.repeat(20)}`;

test.each([true, false])('shared list views preserve depth truncation, shallow first=%s', (first) => {
  const bindings = ['xs=[1,2::Int]', `nested=${nested('xs')}`];
  if (!first) bindings.reverse();
  const source = `main=do
 let {${bindings.join(';')}}
 print(1::Int)
 print(2::Int)`;
  const control = `main=do
 let nested=${nested('[1,2::Int]')}
 print(1::Int)
 print(2::Int)`;
  const recording = traceProgram('haskell', source, source);
  const isolated = traceProgram('haskell', control, control);
  expect(recording.stdout).toBe('1\n2\n');
  expect(recording.uncaughtException).toBeUndefined();
  expect(recording.traceItems.at(-1)?.referenceVars?.nested).toEqual(isolated.traceItems.at(-1)?.referenceVars?.nested);
  expect(recording.traceItems.at(-1)?.referenceVars?.xs).toEqual({
    kind: 'array',
    entries: { 0: { kind: 'value', value: 1 }, 1: { kind: 'value', value: 2 } },
  });
});

test.each([false, true])('failed loop values do not hide later cheap values, prefix=%s', (prefix) => {
  const source = `import Control.Monad
main=do
${prefix ? ' putStrLn "start"' : ''}
 forM_ [1..1000::Int] $ \\i -> do
  let x=if i \`mod\` 20==0 then sum [1..5000::Int] else i
  print i`;
  const recording = traceWithClock(source, () => 0);
  expect(recording.uncaughtException).toBeUndefined();
  expect(recording.stdout).toBe(
    `${prefix ? 'start\n' : ''}${Array.from({ length: 1000 }, (_, i) => `${i + 1}\n`).join('')}`
  );
  const assignments = recording.traceItems.filter((item) => item.line === 5);
  expect(assignments).toHaveLength(1000);
  for (const [index, item] of assignments.entries()) {
    if ((index + 1) % 20 !== 0) expect(item.vars.x).toBe(index + 1);
  }
});

test('failed list previews leave later cheap values available', () => {
  const source = `import Control.Monad
main=do
 putStrLn "start"
 forM_ [1..1000::Int] $ \\i -> do
  let xs=take (if i \`mod\` 20==0 then 3000 else 3) [i..]
  print i`;
  const recording = traceWithClock(source, () => 0);
  expect(recording.uncaughtException).toBeUndefined();
  expect(recording.stdout).toBe(`start\n${Array.from({ length: 1000 }, (_, i) => `${i + 1}\n`).join('')}`);
  const assignments = recording.traceItems.filter((item) => item.line === 5);
  expect(assignments).toHaveLength(1000);
  for (const [index, item] of assignments.entries()) {
    if ((index + 1) % 20 !== 0) expect(item.vars.xs).toEqual(Array.from({ length: 3 }, (_, j) => index + j + 1));
  }
}, 30_000);

test('nested local calls retire their own failed preview work', () => {
  const source = `import Control.Monad
main=do
 let work i=do
      let x=if even i then sum [1..5000::Int] else i
      print i
      when (i<100) (work(i+1))
      print(0::Int)
 work(1::Int)`;
  const recording = traceWithClock(source, () => 0);
  expect(recording.uncaughtException).toBeUndefined();
  expect(recording.stdout).toBe(`${Array.from({ length: 100 }, (_, i) => `${i + 1}\n`).join('')}${'0\n'.repeat(100)}`);
  const assignments = recording.traceItems.filter((item) => item.line === 4);
  expect(assignments).toHaveLength(100);
  for (const [index, item] of assignments.entries()) {
    if (index % 2 === 0) expect(item.vars.x).toBe(index + 1);
  }
});

function scalarAliasesProgram(iterations: number, end: string): string {
  return `import Control.Monad
main=forM_ [1..${iterations}::Int] $ \\i -> do
 let a=[i..${end}]; b=[i*2..${end ? 'i*2+200' : ''}]; c=[i*3..${end ? 'i*3+200' : ''}] :: [Int]
 let n=id(i*2)
 let copy=id n
 print copy`;
}

function traceWithClock(source: string, now: () => number): ReturnType<typeof traceProgram> {
  const clock = Object.getOwnPropertyDescriptor(performance, 'now');
  Object.defineProperty(performance, 'now', { configurable: true, value: now });
  try {
    return traceProgram('haskell', source, source);
  } finally {
    if (clock) Object.defineProperty(performance, 'now', clock);
    else Reflect.deleteProperty(performance, 'now');
  }
}
