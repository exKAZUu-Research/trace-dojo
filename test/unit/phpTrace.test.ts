import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { executeProgram, traceProgram } from '../../src/interpreter/program';
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
        name
          .replace(/^\$this->/, 'this.')
          .replace(/^\$/, '')
          .replace('::$', '.'),
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

test('promoted properties record constructor writes like explicit Java assignments', () => {
  const java = `public class Main {
    public static void main(String[] args) {
        new Counter(21, 42);
    }
}
class Counter {
    int value;
    Integer limit;
    Counter(int value, int limit) {
        this.value = value;
        this.limit = limit;
    }
}`;
  const php = `<?php
class Counter {
    function __construct(
        public int $value,
        private int $limit,
    ) {}
}
new Counter(21, 42);`;
  const items = phpTrace(php);
  expect(asJava(items)).toEqual(asJava(traceProgram('java', java, java).traceItems));
  expect(items.filter(({ callLines }) => callLines.length > 0).map(({ line }) => line)).toEqual([4, 5]);
});

test.each(['$grid[$i]', '$grid[]'])('lets constructor steps show an object stored at %s', (destination) => {
  const php = `<?php
class Cell { public $value; function __construct($value) { $this->value = $value; } }
$grid = [];
for ($i = 0; $i < 2; $i++) {
    ${destination} = new Cell($i);
}
echo count($grid);`;
  const java = `class Cell { int value; Cell(int value) { this.value = value; } }
public class Main {
    public static void main(String[] args) {
        Cell[] grid = new Cell[2];
        for (int i = 0; i < 2; i++) {
            grid[i] = new Cell(i);
        }
        System.out.print(grid.length);
    }
}`;
  const steps = phpTrace(php);
  const afterEachAssignment = steps
    .slice(0, -1)
    .map(({ vars: { $grid: _grid, ...vars }, ...step }) => ({ ...step, vars }));
  expect(asJava(afterEachAssignment)).toEqual(asJava(traceProgram('java', java, java).traceItems.slice(0, -1)));
  expect(steps.at(-1)?.referenceVars.$grid).toMatchObject({
    kind: 'array',
    entries: { 0: { entries: { value: { value: 0 } } }, 1: { entries: { value: { value: 1 } } } },
  });
});

test('declared property defaults are visible from the first constructor statement', () => {
  const source = `<?php
class Counter {
    public int $value = 42;
    function __construct() {
        $first = $this->value;
    }
}
new Counter();`;
  const constructorSteps = phpTrace(source).filter(({ callLines }) => callLines.length > 0);
  expect(constructorSteps).toMatchObject([{ line: 5, vars: { $first: 42, '$this->value': 42 } }]);
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
  // oxlint-disable-next-line unicorn/no-null -- The trace format shows null as null.
  expect(inShow?.referenceVars.$y).toEqual({ kind: 'value', value: null });
});

test('private fields keep their declaring scope in context and object expansion', () => {
  const source = `<?php
class A{private $x=1;function f(){
$n=$this->x;
echo $n;
}}
class B extends A{private $x=2;}
$b=new B;
$b->f();`;
  const items = phpTrace(source);
  expect(items.find((item) => item.vars.$n === 1)).toMatchObject({ vars: { $n: 1, '$this->x': 1 } });
  expect(items.find((item) => item.referenceVars.$b)?.referenceVars.$b).toMatchObject({
    kind: 'object',
    entries: { 'A::$x': { kind: 'value', value: 1 }, 'B::$x': { kind: 'value', value: 2 } },
  });
});

test.each([
  ["class C{public static $x=VALUE;}\necho 'hello';\ndefine('VALUE',3);\necho C::$x;", 'hello3'],
  ["class C{public static $x=1/0;}\necho 'unused';", 'unused'],
])('trace snapshots leave deferred static initializers untouched: %s', (body, stdout) => {
  const source = `<?php\n${body}`;
  expect(traceProgram('php', source, source)).toMatchObject({ stdout, uncaughtException: undefined });
});

test.each(['$t = null;', 'unset($t);'])(
  'removes the last released turtle from steps and the final board state: %s',
  (release) => {
    const program = `<?php
$t = new Turtle();
${release}
echo "released";`;
    expect(phpTrace(program).at(-1)?.turtles).toEqual([]);
    expect(executeProgram('php', program)).toMatchObject({
      kind: 'executed',
      finalBoard: expect.stringMatching(/^#/),
      finalTurtles: [],
    });
  }
);

test('retains a reachable turtle at the end of execution when PHP runs object destructors during shutdown', () => {
  expect(
    executeProgram(
      'php',
      '<?php class C { function __destruct() { echo "closed"; } } $object = new C; $t = new Turtle();'
    )
  ).toMatchObject({ kind: 'executed', stdout: 'closed', finalTurtles: [{ x: 0, y: 0, color: '#', dir: 'N' }] });
});

test('uses the last turtle state after shutdown destructors move or release it', () => {
  const moving = `<?php
class WalkOnQuit { function __destruct() { global $t; $t->forward(); $t->turnRight(); } }
$t = new Turtle();
$walk = new WalkOnQuit();`;
  const moved = [{ x: 0, y: 1, color: '#', dir: 'E' }];
  expect(phpTrace(moving).at(-1)?.turtles).toEqual(moved);
  expect(executeProgram('php', moving)).toMatchObject({ kind: 'executed', finalTurtles: moved });
  const releasing = moving.replace('$t->forward(); $t->turnRight();', '$t = null;');
  expect(executeProgram('php', releasing)).toMatchObject({ kind: 'executed', finalTurtles: [] });
});

test('clones a turtle before running the subclass hook and tracks the copy independently', () => {
  const program = `<?php
class WalkingTurtle extends Turtle { function __clone() { $this->forward(); } }
$source = new WalkingTurtle(1, 1);
$source->turnRight();
$copy = clone $source;
echo "cloned";
unset($source);
$copy->forward();`;
  const source = { x: 1, y: 1, color: '#', dir: 'E' };
  const copy = { ...source, x: 2 };
  const moved = { ...copy, x: 3 };
  expect(phpTrace(program).find(({ line }) => line === 6)?.turtles).toEqual([source, copy]);
  expect(phpTrace(program).at(-1)?.turtles).toEqual([moved]);
  expect(executeProgram('php', program)).toMatchObject({ kind: 'executed', stdout: 'cloned', finalTurtles: [moved] });
});

test('records a growing array without charging display expansion as program operations', () => {
  const program = `<?php
$values = [];
for ($i = 0; $i < 800; $i++) {
    $values[] = $i;
}`;
  const result = traceProgram('php', program, program);
  expect(result.traceItems).toHaveLength(1603);
  expect(result.finalVars.$values).toEqual(Array.from({ length: 800 }, (_, index) => index));
});

test.each([
  ['range(1, 10000)', '10000'],
  ['array_fill(0, 10000, 0)', '10000'],
  ['array_fill(0, 100, range(1, 200))', '100'],
])('keeps recording when a scalar array needs a bounded preview: %s', (value, count) => {
  const program = `<?php
$a = ${value};
echo count($a);
function update() {
    global $a;
    $recorded = 1;
    return $a[0] = 42;
}
update();
`;
  const recording = traceProgram('php', program, program);
  expect(recording.stdout).toBe(count);
  const step = recording.traceItems.find(({ line }) => line === 2);
  expect(step?.vars).not.toHaveProperty('$a');
  const preview = step?.referenceVars?.$a;
  expect(preview).toMatchObject({ kind: 'array', entries: { 0: expect.any(Object) } });
  expect(recording.traceItems.at(-1)).toMatchObject({
    line: 9,
    referenceVars: { $a: { kind: 'array', entries: { 0: { value: 42 } } } },
  });
});

test('records a turtle subclass field during movement', () => {
  const program = `<?php
class Walker extends Turtle {
    private int $steps = 0;
    function walk() {
        $this->steps++;
        $this->forward();
    }
}
$walker = new Walker();
$walker->walk();
`;
  const moves = phpTrace(program).filter(({ callLines }) => callLines.length > 0);
  expect(moves.map(({ vars }) => vars['$this->steps'])).toEqual([1, 1]);
  expect(moves.at(-1)?.turtles).toEqual([{ x: 0, y: 1, color: '#', dir: 'N' }]);
});

test.each([
  ['["x" => 0]', '"x"', 'x'],
  ['[1 => 0]', '1', '1'],
])('records caller step after a call updates an associative or sparse PHP array: %s', (init, keyExpr, entryKey) => {
  const program = `<?php
$a = ${init};
f($a);
function f(&$a) {
    $x = 1;
    return $a[${keyExpr}] = 2;
}`;
  const recording = traceProgram('php', program, program);
  expect(recording.traceItems.at(-1)).toMatchObject({
    line: 3,
    referenceVars: { $a: { kind: 'object', entries: { [entryKey]: { kind: 'value', value: 2 } } } },
  });
});

test.each(['["b" => 10, "a" => 20]', '[3 => 10, 1 => 20]'])(
  'records caller step when a call only reorders PHP array entries: %s',
  (init) => {
    const program = `<?php
$a = ${init};
f($a);
echo json_encode($a);
function f(&$a) {
    $x = 1;
    return $a = array_reverse($a, true);
}`;
    expect(phpTrace(program).map((item) => item.line)).toEqual([0, 2, 6, 3, 4]);
  }
);

test('records caller step for writes beyond the 2000-element display preview on scalar lists', () => {
  const program = `<?php
$a = range(1, 3000);
f($a);
echo $a[2500];
function f(&$a) {
    $x = 1;
    return $a[2500] = 42;
}`;
  expect(phpTrace(program).map((item) => item.line)).toEqual([0, 2, 6, 3, 4]);
});
