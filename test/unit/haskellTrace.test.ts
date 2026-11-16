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
