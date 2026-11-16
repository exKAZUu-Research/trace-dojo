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

const phpTrace = (program: string): TraceItem[] => traceProgram('php', program, program).traceItems;

/** The steps without lines, and with PHP's `$` names written as Java's, so that equivalent programs compare. */
const asJava = (items: TraceItem[]): unknown[] =>
  items.map(({ line: _line, callLines, vars, referenceVars: _references, ...item }) => ({
    ...item,
    callDepth: callLines.length,
    vars: Object.fromEntries(
      Object.entries(vars).map(([name, value]) => [
        name.replace(/^\$this->/, 'this.').replace(/^\$/, '').replace('::$', '.'),
        value,
      ])
    ),
  }));

test('counting loops, calls, and methods record the steps Java records', () => {
  const java = `public class Main {
  public static void main(String[] args) {
    Turtle t = new Turtle();
    int n = twice(1);
    t.右を向く();
    for (int i = 0; i < n; i++) {
      walk(t, i);
    }
  }
  static void walk(Turtle t, int n) {
    for (int i = 0; i <= n; i++) {
      t.前に進む();
    }
  }
  static int twice(int a) {
    return a * 2;
  }
}`;
  const php = `<?php
$t = new Turtle();
$n = twice(1);
$t->右を向く();
for ($i = 0; $i < $n; $i++) {
    walk($t, $i);
}
function walk(Turtle $t, int $n): void {
    for ($i = 0; $i <= $n; $i++) {
        $t->前に進む();
    }
}
function twice(int $a): int {
    return $a * 2;
}`;
  expect(asJava(phpTrace(php))).toEqual(asJava(traceProgram('java', java, java).traceItems));
});

test('objects, static properties, and exceptions record the steps Java records', () => {
  const java = `public class Main {
  public static void main(String[] args) {
    Walker w = new Walker(1);
    try {
      w.walk();
      w.walk();
    } catch (RuntimeException e) {
      w.t.右を向く();
    }
  }
}
class Walker {
  static int walks = 0;
  Turtle t;
  int speed;
  Walker(int speed) {
    this.t = new Turtle(0, 5);
    this.speed = speed;
  }
  void walk() {
    if (!this.t.前に進めるか()) {
      throw new RuntimeException("stop");
    }
    this.t.前に進む();
    Walker.walks++;
  }
}`;
  const php = `<?php
$w = new Walker(1);
try {
    $w->walk();
    $w->walk();
} catch (RuntimeException $e) {
    $w->t->右を向く();
}
class Walker {
    public static int $walks = 0;
    public Turtle $t;
    public int $speed = 0;
    public function __construct(int $speed) {
        $this->t = new Turtle(0, 5);
        $this->speed = $speed;
    }
    public function walk(): void {
        if (!$this->t->前に進めるか()) {
            throw new RuntimeException("stop");
        }
        $this->t->前に進む();
        Walker::$walks++;
    }
}`;
  expect(asJava(phpTrace(php))).toEqual(asJava(traceProgram('java', java, java).traceItems));
});

test('a function marked atomic counts as one step of its caller', () => {
  const program = `<?php
$t = new Turtle();
twoSteps($t);
$t->右を向く();
function twoSteps(Turtle $t): void { // atomic
    $t->前に進む();
    $t->前に進む();
}`;
  expect(phpTrace(program).map((item) => [item.line, item.callLines])).toEqual([
    [0, []],
    [2, []],
    [3, []],
    [4, []],
  ]);
});

test('# atomic also marks a function', () => {
  const program = '<?php\nfunction f() { # atomic\n  $a = 1;\n}\nf();';
  expect(phpTrace(program).map((item) => item.line)).toEqual([0, 5]);
});

test('an atomic annotation outside a function header is a compile error', () => {
  expect(() => traceProgram('php', '<?php\n$x = 1; // atomic', '<?php\n$x = 1;')).toThrow(/atomic/);
});

test('foreach records a step for each value it binds, but only for changes when it binds objects', () => {
  const values = phpTrace('<?php\nforeach ([1, 2] as $v) {\n}');
  expect(values.filter((item) => item.line === 2).map((item) => item.vars.$v)).toEqual([1, 2]);
  const objects = phpTrace('<?php\n$ts = [new Turtle(), new Turtle(1, 1)];\nforeach ($ts as $t) {\n}');
  expect(objects.filter((item) => item.line === 3)).toHaveLength(0);
});

test('a turtle that nothing refers to any more disappears from the trace', () => {
  const items = phpTrace('<?php\n$a = new Turtle();\n$a = new Turtle(2, 2);');
  expect(items.at(-1)?.turtles).toEqual([{ x: 2, y: 2, color: '#', dir: 'N' }]);
});

test('variables show with PHP names, and null only as a reference', () => {
  const program = `<?php
class P { public static int $count = 3; public function __construct(public int $x) {} public function show() { $y = null; $z = 2; } }
$p = new P(5);
$p->show();`;
  const items = phpTrace(program);
  const inShow = items.find((item) => item.callLines.length > 0 && item.vars.$z === 2);
  expect(inShow?.vars).toEqual({ $z: 2, '$this->x': 5, 'P::$count': 3 });
  expect(inShow?.referenceVars.$y).toEqual({ kind: 'value', value: null });
});
