import { expect, test } from 'vitest';

import { ExecutionLimitError } from '../../src/interpreter/limits';
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

test('trace snapshots retain Dart identifiers that are JavaScript prototype properties', () => {
  const program = `class Box {
    int __proto__ = 2;
    int constructor = 3;
  }
  void check(Box __proto__) { print(__proto__.__proto__); }
  void main() {
    final __proto__ = 42;
    final constructor = 9;
    final object = Box();
    final record = (hasOwnProperty: 4, constructor: 5);
    check(object);
    print([__proto__, constructor, object.__proto__, record.hasOwnProperty]);
  }`;
  const trace = traceProgram('dart', program, program);
  expect(trace.stdout).toBe('2\n[42, 9, 2, 4]\n');
  expect(trace.traceItems.some(({ referenceVars }) => Object.hasOwn(referenceVars, '__proto__'))).toBe(true);
  expect(Object.entries(trace.finalVars)).toEqual([
    ['__proto__', 42],
    ['constructor', 9],
  ]);
  const item = trace.traceItems.findLast(({ referenceVars }) => Object.hasOwn(referenceVars, 'record'));
  for (const [name, pairs] of [
    [
      'object',
      [
        ['__proto__', 2],
        ['constructor', 3],
      ],
    ],
    [
      'record',
      [
        ['constructor', 5],
        ['hasOwnProperty', 4],
      ],
    ],
  ] as const) {
    const node = item?.referenceVars[name];
    expect(node?.kind).toBe('object');
    if (node?.kind === 'object') {
      expect(Object.entries(node.entries)).toEqual(pairs.map(([key, value]) => [key, { kind: 'value', value }]));
    }
  }
});

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

test('Dart limits cumulative trace size across individually small snapshots', () => {
  const source = `void main() {
    final text = 'x' * 500000;
    for (var i = 0; i < 100; i++) { final length = text.length; print(length); }
  }`;
  expect(() => traceProgram('dart', source, source)).toThrow(new ExecutionLimitError('trace'));
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

test('a changing list of hundreds of elements traces with the Java trace length', () => {
  const dart = `void main() {
  final values = List.filled(500, 0);
  for (var i = 0; i < 400; i++) {
    values[i % 500] = i;
  }
}`;
  const java = `public class Main {
  public static void main(String[] args) {
    int[] values = new int[500];
    for (int i = 0; i < 400; i++) {
      values[i % 500] = i;
    }
  }
}`;
  expect(traceProgram('dart', dart, dart).traceItems).toHaveLength(traceProgram('java', java, java).traceItems.length);
});

test('null variables trace as references, as in Java', () => {
  const java =
    'public class Main { public static void main(String[] args) { String name = null; int[] arr = null; int n = 1; String[] xs = {null, "a"}; } }';
  const dart = "void main() { String? name = null; List<int>? arr = null; int n = 1; List<String?> xs = [null, 'a']; }";
  const expected = traceProgram('java', java, java);
  const actual = traceProgram('dart', dart, dart);
  expect(actual.finalVars).toEqual(expected.finalVars);
  expect(Object.keys(actual.traceItems.at(-1)?.referenceVars ?? {})).toEqual(
    Object.keys(expected.traceItems.at(-1)?.referenceVars ?? {})
  );
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

test('a captured late local is shown only after its initializer runs', () => {
  const program = `void main() {
  late final int value = 1;
  void show() {
    print('before');
    print(value);
  }
  show();
}`;
  const trace = traceProgram('dart', program, program);
  expect(trace.stdout).toBe('before\n1\n');
  expect(trace.traceItems.find(({ line }) => line === 4)?.vars).not.toHaveProperty('value');
  expect(trace.traceItems.find(({ line }) => line === 5)?.vars).toMatchObject({ value: 1 });
});

test('learner callbacks retain a single call row for native and SDK operations', () => {
  for (const expression of [
    '[1, 2].forEach((n) {\n    t.forward();\n  });',
    'Iterable.generate(2).forEach((n) {\n    t.forward();\n  });',
    '[1, 2].map((n) {\n    t.forward(); return n;\n  }).toList();',
    'List<int>.generate(2, (n) {\n    t.forward(); return n;\n  });',
  ]) {
    const program = `void main() {\n  var t = Turtle();\n  ${expression}\n}`;
    const calls = traceProgram('dart', program, program)
      .traceItems.filter(({ line }) => line === 4)
      .map(({ callLines }) => callLines);
    expect(calls).toEqual([[3], [3]]);
  }
});

test('Dart async functions record their steps where they resume, without the call that awaited them', () => {
  const program = `Future<int> walk(Turtle t, int n) async {
  for (var i = 0; i < n; i++) {
    t.forward();
    await Future.delayed(Duration(milliseconds: 10));
  }
  return n;
}

Future<void> main() async {
  var a = Turtle(1, 1);
  var b = Turtle(4, 1);
  var fa = walk(a, 2);
  var fb = walk(b, 2);
  var total = await fa + await fb;
  a.turnRight();
  print(total);
}`;
  const trace = traceProgram('dart', program, program);
  expect(trace.traceItems.map(({ line, callLines }) => [line, callLines])).toEqual([
    [0, []],
    [10, []],
    [11, []],
    [2, [12]],
    [3, [12]],
    [12, []],
    [2, [13]],
    [3, [13]],
    [13, []],
    [4, [12]],
    [2, [12]],
    [3, [12]],
    [4, [13]],
    [2, [13]],
    [3, [13]],
    [4, [12]],
    [2, [12]],
    [4, [13]],
    [2, [13]],
    [14, []],
    [15, []],
    [16, []],
  ]);
  expect(trace.finalVars).toEqual({ total: 4 });
  expect(trace.stdout).toBe('4\n');
});
