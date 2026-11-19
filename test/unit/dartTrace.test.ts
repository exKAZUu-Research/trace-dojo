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
