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

/** Programs that behave alike in both languages, so Dart must reproduce the Java interpreter's trace. */
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
    dart: `void main() {
  var t = Turtle();
  twoSteps(t);
  t.turnRight();
  twoSteps(t);
}

void twoSteps(Turtle t) {
  t.forward();
  t.forward();
}
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
    dart: `void main() {
  Turtle t1 = Turtle(1, 1);
  t1.forward();
  Turtle t2 = Turtle(3, 3);
  t2.forward();
  t2 = t1;
  t2.forward();
}
`,
  },
  {
    name: 'loops over a list and a range that call a function with conditions',
    java: javaMain(
      `
    Turtle t = new Turtle();
    String[] cmds = { "ri", "aa", "fo" };
    for (String cmd : cmds) {
      t.前に進む();
      parse(t, cmd);
    }
    for (int i = 0; i < 2; i++) {
      t.後に戻る();
    }`,
      `
  static void parse(Turtle t, String c) {
    if (c.equals("fo"))
      t.前に進む();
    else if (c.equals("ri"))
      t.右を向く();
  }`
    ),
    dart: `void main() {
  var t = Turtle();
  var cmds = ['ri', 'aa', 'fo'];
  for (var cmd in cmds) {
    t.forward();
    parse(t, cmd);
  }
  for (int i = 0; i < 2; i++) {
    t.backward();
  }
}

void parse(Turtle t, String c) {
  if (c == 'fo')
    t.forward();
  else if (c == 'ri')
    t.turnRight();
}
`,
  },
  {
    name: 'an object whose field initializer, initializer list, and method run as Java constructors do',
    java: javaMain(
      `
    Walker w = new Walker(2, 2);
    w.walk(2);
    w.turn();
    w.walk(1);`,
      `
}

class Walker {
  Turtle t;
  int steps = 0;

  Walker(int x, int y) {
    this.t = new Turtle(x, y);
  }

  void walk(int n) {
    for (int i = 0; i < n; i++) {
      this.t.前に進む();
      this.steps++;
    }
  }

  void turn() {
    this.t.右を向く();
  }`
    ),
    dart: `void main() {
  var w = Walker(2, 2);
  w.walk(2);
  w.turn();
  w.walk(1);
}

class Walker {
  Turtle t;
  int steps = 0;

  Walker(int x, int y) : t = Turtle(x, y);

  void walk(int n) {
    for (int i = 0; i < n; i++) {
      this.t.forward();
      this.steps++;
    }
  }

  void turn() {
    this.t.turnRight();
  }
}
`,
  },
  {
    name: 'a function marked atomic, which counts as one step of its caller',
    java: javaMain(
      `
    Turtle t = new Turtle();
    square(t);
    t.前に進む();`,
      `
  static void square(Turtle t) { // atomic
    for (int i = 0; i < 4; i++) {
      t.前に進む();
      t.右を向く();
    }
  }`
    ),
    dart: `void main() {
  var t = Turtle();
  square(t);
  t.forward();
}

void square(Turtle t) { // atomic
  for (int i = 0; i < 4; i++) {
    t.forward();
    t.turnRight();
  }
}
`,
  },
])('$name', ({ java, dart }) => {
  const expected = traceProgram('java', java, java);
  const actual = traceProgram('dart', dart, dart);
  expect(withoutLines(actual.traceItems)).toEqual(withoutLines(expected.traceItems));
  expect(actual.finalTurtles).toEqual(expected.finalTurtles);
});

test('empty statements add no execution steps', () => {
  const dart = `void main() {
  ;
  for (int i = 0; i < 2; i++);
  if (true);
  bool looping = false;
  while (looping);
  print(3);;
}`;
  const java = `class Main {
  public static void main(String[] args) {
    ;
    for (int i = 0; i < 2; i++);
    if (true);
    boolean looping = false;
    while (looping);
    System.out.println(3);;
  }
}`;
  const actual = traceProgram('dart', dart, dart);
  const expected = traceProgram('java', java, java);
  expect(actual.stdout).toBe('3\n');
  expect(withoutLines(actual.traceItems)).toEqual(withoutLines(expected.traceItems));
});

test('a cyclic list produces finite snapshots and execution continues', () => {
  const program = `void main() {
  var cycle = <dynamic>[];
  cycle.add(cycle);
  var nonCyclic = <dynamic>[null];
  print(cycle);
  print(nonCyclic);
}
`;
  const direct = traceProgram('dart', program, program);
  expect(direct).toMatchObject({
    stdout: '[[...]]\n[null]\n',
    uncaughtException: undefined,
    // oxlint-disable-next-line unicorn/no-null -- An actual Dart null is distinct from a cycle marker.
    finalVars: { cycle: ['… (cycle)'], nonCyclic: [null] },
  });
  expect(direct.traceItems.at(-1)?.referenceVars?.cycle).toMatchObject({
    kind: 'array',
    entries: { 0: { kind: 'value', value: '… (cycle)', verbatim: true } },
  });
  const shared = `void main() {
  dynamic values = [];
  values.add(values);
  for (var i = 0; i < 20; i++) {
    values = [values, values];
  }
  final followed = [7];
  final marker = 42;
  print(marker);
}`;
  const result = traceProgram('dart', shared, shared);
  expect(result).toMatchObject({
    stdout: '42\n',
    uncaughtException: undefined,
    finalVars: { followed: [7], marker: 42 },
  });
  expect(JSON.stringify(result.finalVars.values).length).toBeLessThan(20_000);
  const references = result.traceItems.at(-1)?.referenceVars;
  expect(references?.followed).toMatchObject({ kind: 'array', entries: { 0: { kind: 'value', value: 7 } } });
  expect(JSON.stringify(references?.values)).toContain('"value":"…"');
});

test('a synchronous generator records the counted-loop header', () => {
  const program = `Iterable<int> values() sync* {
  for (var i = 0; i < 2; i++) {
    yield i;
  }
}
void main() { print(values().toList()); }
`;
  const actual = traceProgram('dart', program, program);
  expect(actual.stdout).toBe('[0, 1]\n');
  expect(actual.traceItems.filter((item) => item.line === 2).map((item) => item.vars.i)).toEqual([0, 1, 2]);
});

test('large scalar list snapshots show omitted entries for each variable', () => {
  const dart = `void main() {
  var first = List.filled(3000, 1);
  var second = List.filled(3000, 2);
  var label = 42;
  print(label);
}`;
  const actual = traceProgram('dart', dart, dart);
  expect(actual).toMatchObject({ stdout: '42\n', finalVars: { label: 42 } });
  const { first, second } = actual.finalVars;
  expect(first).toEqual([...Array.from({ length: 2046 }, () => 1), '… (954 more)']);
  expect(second).toEqual([...Array.from({ length: 2046 }, () => 2), '… (954 more)']);
  expect(actual.traceItems.at(-1)?.vars).toMatchObject({ first, second, label: 42 });
});

test('finally keeps returns and suspended throws reachable', () => {
  const dart = `Turtle result() {
  try { return Turtle(1, 1); }
  finally { print('cleanup'); }
}
Iterable<int> interrupted() sync* {
  try { throw Turtle(2, 1); }
  finally { yield 7; }
}
void main() {
  var first = result();
  first.forward();
  var iterator = interrupted().iterator;
  iterator.moveNext();
  print(iterator.current);
  Turtle(3, 3).canMoveForward();
  Turtle? retained;
  try { iterator.moveNext(); }
  on Turtle catch (turtle) { retained = turtle; }
  retained?.forward();
}`;
  const actual = traceProgram('dart', dart, dart);
  expect(actual).toMatchObject({
    stdout: 'cleanup\n7\n',
    uncaughtException: undefined,
    finalTurtles: [
      { x: 1, y: 2 },
      { x: 2, y: 2 },
    ],
  });
});

test('nested grid updates complete with the Java trace length', () => {
  const dart = `void main() {
  var grid = List.generate(30, (_) => List.filled(30, 0));
  for (var row = 0; row < 30; row++) {
    for (var col = 0; col < 30; col++) {
      grid[row][col] = row * col;
    }
  }
  print(grid[1][1]);
}`;
  const java = `public class Main {
  public static void main(String[] args) {
    int[][] grid = new int[30][30];
    for (int row = 0; row < 30; row++) {
      for (int col = 0; col < 30; col++) {
        grid[row][col] = row * col;
      }
    }
    System.out.println(grid[1][1]);
  }
}`;
  const expected = traceProgram('java', java, java);
  const actual = traceProgram('dart', dart, dart);
  expect(actual.traceItems).toHaveLength(expected.traceItems.length);
  expect(actual).toMatchObject({ finalVars: expected.finalVars, stdout: expected.stdout });
});

test('temporary declaration pattern subjects keep their turtles during matching', () => {
  const program = `class Trigger {
    int get value { Turtle(3, 3).canMoveForward(); return 0; }
  }
  void main() {
    var (Trigger(value: n), turtle) = (Trigger(), Turtle(1, 1));
    turtle.forward();
  }`;
  expect(traceProgram('dart', program, program)).toMatchObject({
    finalTurtles: [{ x: 1, y: 2 }],
    uncaughtException: undefined,
  });
});

test('map snapshots preserve distinct entries with indistinguishable source labels', () => {
  const program = `void main() {
    final values = <Object, int>{1: 10, '1': 20, true: 30, 'true': 40, '…': 50};
    print(values.length);
  }`;
  const result = traceProgram('dart', program, program);
  expect(result.stdout).toBe('5\n');
  expect(result.traceItems.at(-1)?.referenceVars.values).toMatchObject({
    kind: 'object',
    entries: {
      '1': { kind: 'value', value: 10 },
      '1 (2)': { kind: 'value', value: 20 },
      true: { kind: 'value', value: 30 },
      'true (2)': { kind: 'value', value: 40 },
      '… (2)': { kind: 'value', value: 50 },
    },
  });
});
