import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { traceProgram } from '../../src/interpreter/program';
import type { TraceItem } from '../../src/problems/trace';

// The interpreter's clock stands still in these tests, so that the program, not the load of the host, decides each one.
beforeEach(() => {
  vi.spyOn(performance, 'now').mockReturnValue(0);
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** The programs of the two languages place their statements on different lines, so their steps compare without them. */
const withoutLines = (items: TraceItem[]): unknown[] =>
  items.map(({ line, callLines, ...item }) => ({ ...item, callDepth: callLines.length }));

/** The names of each step's variables in the order learners see them, with Python's `self` named as Java's `this`. */
const variableNamesOf = (language: 'java' | 'python', program: string): string[][] =>
  traceProgram(language, program, program).traceItems.map(({ vars }) =>
    Object.keys(vars).map((name) => name.replace(/^self\./, 'this.'))
  );

/** Programs that behave alike in both languages, so Python must reproduce the Java interpreter's trace. */
test.each([
  {
    name: 'moves, turns, conditions, and while loops',
    java: `public class Main {
  public static void main(String[] args) {
    Turtle 亀 = new Turtle(2, 1, "R");
    int n = 0;
    while (n < 3) {
      if (n % 2 == 0) {
        亀.前に進む();
      } else {
        亀.右を向く();
      }
      n++;
    }
    亀.後に戻る();
  }
}`,
    python: `亀 = Turtle(2, 1, 'R')
n = 0
while n < 3:
    if n % 2 == 0:
        亀.前に進む()
    else:
        亀.右を向く()
    n += 1
亀.後に戻る()`,
  },
  {
    name: 'classes with fields, constructors calling methods, and helpers marked atomic',
    java: `public class Main {
  static void walk(Turtle t, int steps) { // atomic
    for (int i = 0; i < steps; i++) t.forward();
  }
  public static void main(String[] args) {
    Walker w = new Walker(3);
    w.go(2);
    walk(w.t, 2);
  }
}
class Walker {
  Turtle t;
  Walker(int x) {
    this.t = new Turtle(x, 0);
  }
  void go(int turns) {
    for (int i = 0; i < turns; i++) {
      this.t.turnRight();
    }
  }
}`,
    python: `def walk(t, steps):  # atomic
    for i in range(steps):
        t.forward()

class Walker:
    def __init__(self, x):
        self.t = Turtle(x, 0)

    def go(self, turns):
        i = 0
        while i < turns:
            self.t.turnRight()
            i += 1

w = Walker(3)
w.go(2)
walk(w.t, 2)`,
  },
])('Python traces $name as Java does', ({ java, python }) => {
  const expected = withoutLines(traceProgram('java', java, java).traceItems);
  const actual = withoutLines(traceProgram('python', python, python).traceItems);
  // Java names the instance `this`, which Python names `self`.
  expect(JSON.parse(JSON.stringify(actual).replaceAll('"self', '"this'))).toEqual(expected);
});

test('the variables follow the order of the Java trace: locals, class variables, then the fields of the instance', () => {
  const java = `public class Main {
  public static void main(String[] args) {
    Counter c = new Counter();
    c.add(2);
  }
}
class Counter {
  static int count = 0;
  int value;
  Counter() {
    this.value = 1;
  }
  void add(int n) {
    this.value += n;
    Counter.count++;
  }
}`;
  const python = `class Counter:
    count = 0
    def __init__(self):
        self.value = 1
    def add(self, n):
        self.value += n
        Counter.count += 1
c = Counter()
c.add(2)`;
  expect(variableNamesOf('python', python)).toEqual(variableNamesOf('java', java));
  expect(variableNamesOf('python', python).at(-1)).toEqual(['n', 'Counter.count', 'this.value']);
});

test('a for loop over a range records a step for each value it binds', () => {
  const program = 't = Turtle()\nfor i in range(2):\n    t.forward()';
  const trace = traceProgram('python', program, program);
  expect(trace.traceItems.map(({ line, vars }) => [line, vars.i])).toEqual([
    [0, undefined],
    [1, undefined],
    [2, 0],
    [3, 0],
    [2, 1],
    [3, 1],
  ]);
});

test('a turtle no variable reaches any more vanishes when the call that held it returns', () => {
  const program = `def make():
    t = Turtle()
    t.forward()
make()
done = True`;
  const trace = traceProgram('python', program, program);
  expect(trace.traceItems.map(({ turtles }) => turtles.length)).toEqual([0, 1, 1, 0, 0]);
});

test.each([
  {
    name: 'the inner iterable of chain.from_iterable',
    program: `from itertools import chain
def make(i):
    return [Turtle(0, 0), Turtle(1, 0)]
g = chain.from_iterable(map(make, range(1)))
t = next(g)
t = next(g)
t.forward()`,
    expected: ['', '', '0,0 1,0', '0,0 1,0', '0,0 1,1'],
  },
  {
    name: 'the iterator that __iter__ returned to enumerate',
    program: `class Pair:
    def __iter__(self):
        return iter([Turtle(0, 0), Turtle(1, 0)])
g = enumerate(Pair())
i, t = next(g)
i, t = next(g)
t.forward()`,
    expected: ['', '0,0 1,0', '0,0 1,0', '0,0 1,0', '0,0 1,1'],
  },
  {
    name: 'the item pairwise keeps for its next pair',
    program: `from itertools import pairwise
def gen():
    yield Turtle(0, 0)
    yield Turtle(1, 0)
    yield Turtle(2, 0)
p = pairwise(gen())
first = next(p)[0]
second = next(p)[1]
second.forward()`,
    expected: ['', '', '0,0 1,0', '0,0 2,0', '0,0 2,1'],
  },
])('a turtle that only $name reaches stays visible', ({ program, expected }) => {
  const trace = traceProgram('python', program, program);
  expect(trace.traceItems.map(({ turtles }) => turtles.map(({ x, y }) => `${x},${y}`).join(' '))).toEqual(expected);
});

test('class bodies and definitions record no steps, and class variables show as Class.name', () => {
  const program = `class Counter:
    count = 0
    def add(self):
        Counter.count += 1
c = Counter()
c.add()`;
  const trace = traceProgram('python', program, program);
  expect(trace.traceItems.map(({ line }) => line)).toEqual([0, 5, 4]);
  expect(trace.traceItems.at(-1)?.vars).toEqual({ 'Counter.count': 1 });
});

test('an assignment whose value only creates objects records no step of its own, with or without a type hint', () => {
  const program = `class W:
    def __init__(self, n):
        self.n = n
a = W(1)
b: W = W(2)
c: list = [W(3), W(4)]
d: int = 5`;
  expect(traceProgram('python', program, program).traceItems.map(({ line }) => line)).toEqual([0, 3, 3, 3, 3, 7]);
});

test('standard library code written in Python records no steps, and the code it calls back is called from the program line', () => {
  const program = `from dataclasses import dataclass
import heapq
@dataclass
class P:
    x: int
    def __post_init__(self):
        self.x += 1
p = P(1)
merged = list(heapq.merge([1], [2], key=lambda v: -v))`;
  const trace = traceProgram('python', program, program);
  expect(trace.traceItems.map(({ line, callLines }) => [line, callLines])).toEqual([
    [0, []],
    [7, [8]],
    [9, []],
  ]);
  expect(trace.traceItems.at(-1)?.vars).toMatchObject({ merged: [2, 1] });
});

test('integers a number cannot hold exactly keep every digit in the variables', () => {
  const program = 'x = 9007199254740993\ny = [x + 1, 2]';
  const last = traceProgram('python', program, program).traceItems.at(-1) as TraceItem;
  expect(last.vars).toEqual({ x: 9_007_199_254_740_993n, y: [9_007_199_254_740_994n, 2] });
  expect(last.referenceVars).toEqual({
    y: {
      kind: 'array',
      entries: { 0: { kind: 'value', value: 9_007_199_254_740_994n }, 1: { kind: 'value', value: 2 } },
    },
  });
});

test.each([
  ['an int and a string', 'd = {2: "a", 1: "b", "1": "c"}', ['1', '2', "'1'"]],
  ['None and a string', 'd = {None: 0, "None": 1}', ['None', "'None'"]],
  ['two instances of one class', 'class A:\n    pass\nd = {A(): 1, A(): 2}', ['<A> (1)', '<A> (2)']],
  [
    'tuples and a text like a numbered label',
    'd = {(1, "2"): "a", ("1", 2): "b", "(1, 2) (1)": "c"}',
    ["(1, '2')", "('1', 2)", "'(1, 2) (1)'"],
  ],
])('dict keys of the same text, %s, keep distinct entries', (_name, program, labels) => {
  const node = traceProgram('python', program, program).traceItems.at(-1)?.referenceVars.d;
  expect(node?.kind === 'object' && Object.keys(node.entries)).toEqual(labels);
});

test('a dict of many keys is traced in time', () => {
  // Labeling each key by scanning all the others takes seconds for this dict, beyond the test's timeout.
  const program = 'd = {i: i for i in range(30000)}\nx = 1';
  const node = traceProgram('python', program, program).traceItems.at(-1)?.referenceVars.d;
  expect(node?.kind === 'object' ? Object.keys(node.entries) : []).toHaveLength(30_000);
});

test.each([
  ['a for loop', 'for t in Pair():\n    t.forward()'],
  ['a list comprehension', 'moved = [move(t) for t in Pair()]'],
  ['a nested comprehension', 'moved = [move(t) for i in range(1) for t in Pair()]'],
])('turtles that only the iterator returned by __iter__ holds stay visible in %s', (_name, loop) => {
  const program = `class Pair:
    def __iter__(self):
        return iter([Turtle(0, 0), Turtle(1, 0)])
def move(t):
    t.forward()
    return t
${loop}`;
  const counts = traceProgram('python', program, program).traceItems.map(({ turtles }) => turtles.length);
  expect(counts.slice(1)).toEqual(counts.slice(1).map(() => 2));
});

test('a turtle captured by a generator expression stays visible after its function returns', () => {
  const program = `def f():
    t = Turtle()
    return (t for _ in range(1))
g = f()
x = next(g)
x.forward()`;
  const counts = traceProgram('python', program, program).traceItems.map(({ turtles }) => turtles.length);
  expect(counts).toEqual([0, 1, 1, 1, 1]);
});

test('display programs lose their annotations', () => {
  const program = 'def move(t):  # atomic\n    t.forward()\nt = Turtle()\nmove(t)';
  const trace = traceProgram('python', program, program);
  expect(trace.displayProgram).toBe(program.replace('  # atomic', ''));
  expect(trace.traceItems.map(({ line }) => line)).toEqual([0, 3, 4]);
});

test.each([
  ['an atomic annotation outside a function header', 'i = 0  # atomic', '# atomic は'],
  ['an atomic annotation in a function body', 'def f():\n    x = 1  # atomic', '# atomic は'],
  ['invalid syntax', 't = Turtle(', '書き方に誤りがあります'],
])('a model program with %s is rejected', (_, program, message) => {
  expect(() => traceProgram('python', program, program)).toThrow(message);
});

test("a static method shows its parameters' fields no more than Java's static method does", () => {
  const python = `class Point:
    def __init__(self):
        self.x = 3
    @staticmethod
    def show(p):
        y = 1
    @classmethod
    def make(cls):
        z = 2
Point.show(Point())
Point.make()`;
  const java = `public class Main {
  static class Point {
    int x;
    Point() {
      this.x = 3;
    }
    static void show(Point p) {
      int y = 1;
    }
    static void make() {
      int z = 2;
    }
  }
  public static void main(String[] args) {
    Point.show(new Point());
    Point.make();
  }
}`;
  expect(varsOf('python', python)).toEqual(varsOf('java', java));
});

function varsOf(language: 'java' | 'python', program: string): unknown[] {
  return traceProgram(language, program, program).traceItems.map(({ vars }) =>
    Object.fromEntries(Object.entries(vars).map(([name, value]) => [name.replace(/^self\./, 'this.'), value]))
  );
}
