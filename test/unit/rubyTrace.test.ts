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

const rubyTrace = (program: string): TraceItem[] => traceProgram('ruby', program, program).traceItems;

test('a recursive Array Hash key remains traceable', () => {
  const program = 'a=[]; a << a; h={}; h[a]=1; p h.size';
  expect(traceProgram('ruby', program, program).stdout).toBe('1\n');
});

test('Turtles accumulated by map stay visible through later block steps', () => {
  const program = `ts = [1, 3].map do |x|
  t = Turtle.new(x, 0)
  t
end
ts.each { |t| t.forward }`;
  expect(traceProgram('ruby', program, program).finalTurtles).toMatchObject([
    { x: 1, y: 1 },
    { x: 3, y: 1 },
  ]);
});

test('Turtles accumulated by transform_values stay visible through later block steps', () => {
  const program = `h = {a:1, b:3}.transform_values do |x|
  t = Turtle.new(x, 0)
  t
end
h.each_value { |t| t.forward }`;
  expect(traceProgram('ruby', program, program).finalTurtles).toMatchObject([
    { x: 1, y: 1 },
    { x: 3, y: 1 },
  ]);
});

/** Programs that behave alike in both languages, so Ruby must reproduce the Java interpreter's trace. */
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
    ruby: `亀 = Turtle.new(2, 1, "R")
n = 0
while n < 3
  if n % 2 == 0
    亀.前に進む
  else
    亀.右を向く
  end
  n += 1
end
亀.後に戻る`,
  },
  {
    name: 'methods whose calls show their steps, and a method whose return value is stored',
    java: `public class Main {
  public static void main(String[] args) {
    Turtle t = new Turtle();
    int x = twice(1);
    move(t);
    t.右を向く();
    move(t);
  }
  static int twice(int a) {
    return a * 2;
  }
  static void move(Turtle t) {
    t.前に進む();
    t.前に進む();
  }
}`,
    ruby: `def twice(a)
  return a * 2
end

def move(t)
  t.前に進む
  t.前に進む
end

t = Turtle.new
x = twice(1)
move(t)
t.右を向く
move(t)`,
  },
  {
    name: 'exceptions raised in a method and rescued by the caller',
    java: `public class Main {
  public static void main(String[] args) {
    Turtle t = new Turtle();
    try {
      walk(t);
      t.右を向く();
    } catch (IllegalArgumentException e) {
      t.左を向く();
    }
  }
  static void walk(Turtle t) {
    t.前に進む();
    throw new IllegalArgumentException();
  }
}`,
    ruby: `def walk(t)
  t.前に進む
  raise ArgumentError
end

t = Turtle.new
begin
  walk(t)
  t.右を向く
rescue ArgumentError => e
  t.左を向く
end`,
  },
])('$name', ({ java, ruby }) => {
  expect(withoutLines(rubyTrace(ruby))).toEqual(withoutLines(traceProgram('java', java, java).traceItems));
});

test('a block an iterator calls binds its parameter as a step, and the block shows the variables around it', () => {
  const items = rubyTrace(`t = Turtle.new
count = 0
2.times do |i|
  t.前に進む
  count += i
end`);
  expect(items.map(({ line, vars }) => [line, vars])).toEqual([
    [0, {}],
    [1, {}],
    [2, { count: 0 }],
    [3, { count: 0, i: 0 }],
    [4, { count: 0, i: 0 }],
    [5, { count: 0, i: 0 }],
    [3, { count: 0, i: 1 }],
    [4, { count: 0, i: 1 }],
    [5, { count: 1, i: 1 }],
  ]);
});

test('the last expression of a method or block records no step when its value is used, as a return does', () => {
  const items = rubyTrace(`def double(a)
  a * 2
end

x = double(3)
y = [1, 2].map { |v| v + x }`);
  expect(items.map(({ line, vars }) => [line, vars])).toEqual([
    [0, {}],
    [5, { x: 6 }],
    [6, { x: 6, v: 1 }],
    [6, { x: 6, v: 2 }],
    [6, { x: 6, y: [7, 8] }],
  ]);
});

test('# atomic makes a call to the method one step', () => {
  const items = rubyTrace(`def walk(t, n) # atomic
  n.times do |i|
    t.前に進む
  end
end

t = Turtle.new
walk(t, 3)
t.右を向く`);
  expect(items.map(({ line }) => line)).toEqual([0, 7, 8, 9]);
  expect(items[2].turtles).toEqual([{ x: 0, y: 3, color: '#', dir: 'N' }]);
});

test('a turtle in an array literal stays while the rest of the literal runs, and vanishes once unreachable', () => {
  const items = rubyTrace(`class Walker
  def initialize(x)
    @t = Turtle.new(x, 0)
  end
end

ws = [Walker.new(1), Walker.new(3)]
ws = nil`);
  expect(items.map(({ turtles }) => turtles.length)).toEqual([0, 1, 2, 0]);
});

test('instance, class, and global variables show as Ruby names them', () => {
  const items = rubyTrace(`class Counter
  @@total = 0

  def initialize
    @count = 1
    @@total += 1
  end
end

$runs = 1
c = Counter.new`);
  // The assignment of the new object records no step of its own, since the constructor's steps show what it did.
  expect(items.map(({ vars }) => vars)).toEqual([
    {},
    { 'Counter.@@total': 0, $runs: 1 },
    { '@count': 1, 'Counter.@@total': 0, $runs: 1 },
    { '@count': 1, 'Counter.@@total': 1, $runs: 1 },
  ]);
});

test('Enumerator with_index preserves direct each_with_index steps', () => {
  const traces = ['each_with_index', 'each.with_index'].map((method) =>
    rubyTrace(`t = Turtle.new
[1, 2].${method} do |x, i|
  t.forward
end`).map(({ line, vars, turtles }) => ({ line, vars, y: turtles[0]?.y }))
  );
  expect(traces[1]).toEqual(traces[0]);
});

test('shared Array keys have bounded trace labels', () => {
  const program = `def mk # atomic
  a = [1]
  20.times { a = [a, a] }
  a
end
h = { mk => 1 }`;
  expect(JSON.stringify(rubyTrace(program)).length).toBeLessThan(100_000);
});
