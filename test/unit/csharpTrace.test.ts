import { expect, test } from 'vitest';

import { traceProgram } from '../../src/interpreter/program';
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

/** Programs that behave alike in both languages, so C# must reproduce the Java interpreter's trace. */
test.each([
  {
    name: 'a local function that hides a top-level variable of the same name',
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
    csharp: `Turtle t = new Turtle();
twoSteps(t);
t.右を向く();
twoSteps(t);

void twoSteps(Turtle t)
{
    t.前に進む();
    t.前に進む();
}
`,
  },
  {
    name: 'a class whose field holds a turtle, with an overridden method and English method names',
    java: javaMain(
      `
    FastTurtle f = new FastTurtle();
    f.drawLine();`,
      `
}
class MyTurtle {
  Turtle t = new Turtle();
  void drawLine() {
    for (int i = 0; i < this.length(); i++) {
      this.t.前に進む();
    }
  }
  int length() {
    return 2;
  }
}
class FastTurtle extends MyTurtle {
  @Override int length() {
    return 3;
  }`
    ),
    csharp: `FastTurtle f = new FastTurtle();
f.drawLine();

class MyTurtle
{
    public Turtle t = new Turtle();
    public void drawLine()
    {
        for (int i = 0; i < this.length(); i++)
        {
            this.t.Forward();
        }
    }
    public virtual int length()
    {
        return 2;
    }
}
class FastTurtle : MyTurtle
{
    public override int length()
    {
        return 3;
    }
}
`,
  },
  {
    name: 'turtles created by the elements of an array initializer, which stay alive while the rest are created',
    java: javaMain(
      `
    Turtle[] ts = { make(0), make(2) };
    for (Turtle t : ts) {
      t.前に進む();
    }`,
      `
  static Turtle make(int x) {
    Turtle u = new Turtle(x, 0);
    return u;
  }`
    ),
    csharp: `Turtle[] ts = { make(0), make(2) };
foreach (Turtle t in ts)
{
    t.前に進む();
}

Turtle make(int x)
{
    Turtle u = new Turtle(x, 0);
    return u;
}
`,
  },
  {
    name: 'an exception thrown in a method and caught by the caller',
    java: javaMain(
      `
    Turtle t = new Turtle();
    try {
      walk(t, 9);
    } catch (RuntimeException e) {
      t.右を向く();
    }`,
      `
  static void walk(Turtle t, int n) {
    for (int i = 0; i < n; i++) {
      if (!t.前に進めるか()) {
        throw new RuntimeException("wall");
      }
      t.前に進む();
    }
  }`
    ),
    csharp: `Turtle t = new Turtle();
try
{
    walk(t, 9);
}
catch (Exception e)
{
    t.右を向く();
}

void walk(Turtle t, int n)
{
    for (int i = 0; i < n; i++)
    {
        if (!t.前に進めるか())
        {
            throw new Exception("wall");
        }
        t.前に進む();
    }
}
`,
  },
])('$name', ({ java, csharp }) => {
  const expected = traceProgram('java', java, java);
  const actual = traceProgram('csharp', csharp, csharp);
  expect(withoutLines(actual.traceItems)).toEqual(withoutLines(expected.traceItems));
  expect(actual.finalTurtles).toEqual(expected.finalTurtles);
});

test('a method marked atomic counts as one step of its caller', () => {
  const program = `Turtle t = new Turtle();
Square(t);
t.前に進む();

void Square(Turtle t) // atomic
{
    for (int i = 0; i < 4; i++)
    {
        t.前に進む();
        t.右を向く();
    }
}
`;
  const { traceItems } = traceProgram('csharp', program, program);
  expect(traceItems.map(({ line }) => line)).toEqual([0, 1, 2, 3]);
});

test('collections show their elements by the elements’ types', () => {
  const program = `var xs = new List<int> { 3 };
var names = new Dictionary<string, double> { ["a"] = 1.5 };
var pair = (Count: 2, Name: "x");
Console.WriteLine(xs.Count + names.Count + pair.Count);
`;
  const { traceItems } = traceProgram('csharp', program, program);
  expect(traceItems.at(-1)?.referenceVars).toEqual({
    xs: { kind: 'array', entries: { 0: { kind: 'value', value: 3 } } },
    names: { kind: 'object', entries: { a: { kind: 'value', value: 1.5 } } },
    pair: { kind: 'object', entries: { Item1: { kind: 'value', value: 2 }, Item2: { kind: 'value', value: 'x' } } },
  });
});

test('locals leave the trace when control leaves their scopes, whichever way it leaves', () => {
  const program = `int a = 1;
try { throw new Exception("x"); } catch (Exception e) when (int.TryParse("bad", out int parsed)) { } catch (Exception f) { Console.WriteLine(f.Message); }
try { throw new ArgumentException("m"); } catch (Exception e) when (e is ArgumentException arg) { Console.WriteLine(arg.Message); }
try { try { throw new FormatException("1"); } finally { throw new InvalidOperationException(); } }
catch (FormatException e) when (int.TryParse(e.Message, out int parsed)) { } catch (InvalidOperationException) { Console.WriteLine("abandoned"); }
switch (1) { case var x when x > 5: break; }
for (int i = 0; i < 2; i++) { int inner = i; if (i == 1) break; }
{ int blockLocal = 3; }
int b = 2;
`;
  const { finalVars, stdout } = traceProgram('csharp', program, program);
  expect(finalVars).toEqual({ a: 1, b: 2 });
  expect(stdout).toBe('x\nm\nabandoned\n');
});
