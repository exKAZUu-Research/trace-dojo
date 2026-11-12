import { expect, test } from 'vitest';

import { traceProgram } from '../../src/interpreter/program';
import type { TraceItem } from '../../src/problems/trace';

/** The programs of the two languages place their statements on different lines, so their steps compare without them. */
const withoutLines = (items: TraceItem[]): unknown[] =>
  items.map(({ line, callLines, ...item }) => ({ ...item, callDepth: callLines.length }));

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
