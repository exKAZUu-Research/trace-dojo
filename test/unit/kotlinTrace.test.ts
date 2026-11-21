import { expect, test } from 'vitest';

import { traceProgram } from '../../src/interpreter/program';
import { misplacedAtomicMessage } from '../../src/interpreter/traceAnnotations';
import type { TraceItem } from '../../src/problems/trace';

/** The programs of the two languages place their statements on different lines, so their steps compare without them. */
const withoutLines = (items: TraceItem[]): unknown[] =>
  items.map(({ line, callLines, ...item }) => ({ ...item, callDepth: callLines.length }));

/** Curriculum-style programs that behave alike in both languages, so Kotlin must reproduce the Java interpreter's trace. */
test.each([
  {
    name: 'atomic constructors',
    java: `public class Main {
  public static void main(String[] args) {
    Counter counter = new Counter(1);
    int result = counter.n;
  }
}
class Counter {
  int n;
  Counter(int initial) { // atomic
    n = initial;
    n++;
    n++;
  }
}`,
    kotlin: `fun main() {
    val counter = Counter(1)
    val result = counter.n
}
class Counter(initial: Int) { // atomic
    var n = initial
    init {
        n++
        n++
    }
}`,
  },
  {
    name: 'value-producing branches count as part of their enclosing statement',
    java: `public class Main {
  public static void main(String[] args) {
    int n = 7;
    String size = n > 5 ? "big" : "small";
    int next = n == 7 ? 8 : 0;
    int total = n + next;
  }
}`,
    kotlin: `fun main() {
    val n = 7
    val size = if (n > 5) "big" else "small"
    val next = when (n) {
        7 -> 8
        else -> 0
    }
    val total = try { n + next } catch (e: Exception) { 0 }
}`,
  },
  {
    name: 'moves, turns, loops, and conditions',
    java: `public class Main {
  public static void main(String[] args) {
    Turtle t = new Turtle(2, 1, "R");
    int n = 0;
    while (t.前に進めるか() && n < 3) {
      if (n % 2 == 0) {
        t.前に進む();
      } else {
        t.右を向く();
      }
      n++;
    }
    int[] commands = { 1, 0, 1 };
    for (int command : commands) {
      if (command == 1) t.forward();
      else t.turnLeft();
    }
  }
}`,
    kotlin: `fun main() {
    val t = Turtle(2, 1, "R")
    var n = 0
    while (t.前に進めるか() && n < 3) {
        if (n % 2 == 0) {
            t.前に進む()
        } else {
            t.右を向く()
        }
        n++
    }
    val commands = intArrayOf(1, 0, 1)
    for (command in commands) {
        if (command == 1) t.forward()
        else t.turnLeft()
    }
}`,
  },
  {
    name: 'fields assigned in a constructor, which show their defaults before the assignments',
    java: `public class Main {
  public static void main(String[] args) {
    MyTurtle m = new MyTurtle(1, 2);
    m.moveForward();
  }
}
class MyTurtle {
  Turtle t;
  int speed;
  boolean moved = false;
  MyTurtle(int x, int speed) {
    this.t = new Turtle(x, 0);
    this.speed = speed;
  }
  void moveForward() {
    int i = 0;
    while (i < this.speed) {
      this.t.前に進む();
      i++;
    }
    this.moved = true;
  }
}`,
    kotlin: `fun main() {
    val m = MyTurtle(1, 2)
    m.moveForward()
}
class MyTurtle(x: Int, speed: Int) {
    var t: Turtle
    var speed: Int
    var moved = false
    init {
        this.t = Turtle(x, 0)
        this.speed = speed
    }
    fun moveForward() {
        var i = 0
        while (i < this.speed) {
            this.t.前に進む()
            i++
        }
        this.moved = true
    }
}`,
  },
  {
    name: 'a static field, as an object property',
    java: `public class Main {
  public static void main(String[] args) {
    Turtle t = new Turtle();
    Controller.step(t);
    Controller.step(t);
  }
}
class Controller {
  static int stepCount = 0;
  static void step(Turtle t) {
    t.前に進む();
    stepCount++;
  }
}`,
    kotlin: `fun main() {
    val t = Turtle()
    Controller.step(t)
    Controller.step(t)
}
object Controller {
    var stepCount = 0
    fun step(t: Turtle) {
        t.前に進む()
        stepCount++
    }
}`,
  },
  {
    name: 'inheritance, overriding, and calls of super',
    java: `public class Main {
  public static void main(String[] args) {
    FastTurtle f = new FastTurtle();
    f.move();
  }
}
class MyTurtle {
  Turtle t = new Turtle();
  void move() {
    t.前に進む();
  }
}
class FastTurtle extends MyTurtle {
  @Override
  void move() {
    super.move();
    super.move();
  }
}`,
    kotlin: `fun main() {
    val f = FastTurtle()
    f.move()
}
open class MyTurtle {
    var t = Turtle()
    open fun move() {
        t.前に進む()
    }
}
class FastTurtle : MyTurtle() {
    override fun move() {
        super.move()
        super.move()
    }
}`,
  },
  {
    name: 'arrays of turtles and exceptions',
    java: `public class Main {
  public static void main(String[] args) {
    Turtle[] turtles = new Turtle[2];
    turtles[0] = new Turtle(0, 0);
    turtles[1] = new Turtle(2, 0);
    for (Turtle t : turtles) {
      try {
        move(t);
      } catch (RuntimeException e) {
        t.右を向く();
      }
    }
  }
  static void move(Turtle t) {
    if (!t.前に進めるか()) {
      throw new RuntimeException("前に進めない！");
    }
    t.前に進む();
  }
}`,
    kotlin: `fun main() {
    val turtles = arrayOfNulls<Turtle>(2)
    turtles[0] = Turtle(0, 0)
    turtles[1] = Turtle(2, 0)
    for (t in turtles) {
        try {
            move(t!!)
        } catch (e: RuntimeException) {
            t!!.右を向く()
        }
    }
}
fun move(t: Turtle) {
    if (!t.前に進めるか()) {
        throw RuntimeException("前に進めない！")
    }
    t.前に進む()
}`,
  },
])('traces $name as Java does', ({ java, kotlin }) => {
  const javaTrace = traceProgram('java', java, java);
  const kotlinTrace = traceProgram('kotlin', kotlin, kotlin);
  expect(withoutLines(kotlinTrace.traceItems)).toEqual(withoutLines(javaTrace.traceItems));
  expect(kotlinTrace.finalBoard).toBe(javaTrace.finalBoard);
});

test("records the step of a top-level property's initializer, as Java records a static field's", () => {
  const source = 'fun g() = 3\nval top = g()\nfun main() {\n    println(top)\n}';
  const trace = traceProgram('kotlin', source, source);
  expect(trace.traceItems.map(({ line, vars }) => ({ line, vars }))).toEqual([
    { line: 0, vars: {} },
    { line: 2, vars: { top: 3 } },
    { line: 4, vars: { top: 3 } },
  ]);
});

test.each([
  '// atomic\nfun helper() {}\nfun main() { helper() }',
  'fun main() {\n    val x = 1 // atomic\n    println(x)\n}',
  'fun main() {}\n// atomic',
  'fun main() {\r\n    val x = 1 // atomic\r\n    println(x)\r\n}',
])('reports a misplaced Kotlin atomic annotation in %s', (program) => {
  expect(() => traceProgram('kotlin', program, program)).toThrow(misplacedAtomicMessage);
});

test('keeps Kotlin atomic steps with CRLF line endings', () => {
  const source = [
    'fun main() {',
    '    val result = double(2)',
    '    println(result)',
    '}',
    'fun double(value: Int): Int { // atomic',
    '    val doubled = value * 2',
    '    return doubled',
    '}',
  ].join('\n');
  const crlf = source.replaceAll('\n', '\r\n');
  const trace = traceProgram('kotlin', source, source);
  expect(trace.traceItems.every(({ callLines }) => callLines.length === 0)).toBe(true);
  expect(traceProgram('kotlin', crlf, crlf).traceItems).toEqual(trace.traceItems);
});

test('records only the statements inside a value-returning lambda', () => {
  const source = `fun main() {
    val result = listOf(1, 2).map {
        val doubled = it * 2
        doubled
    }
    val grid = Array(2) { IntArray(3) }
}`;
  const trace = traceProgram('kotlin', source, source);
  expect(trace.traceItems.map(({ line }) => line)).toEqual([0, 3, 3, 2, 6]);
  expect(trace.traceItems.every(({ callLines }) => callLines.length === 0)).toBe(true);
});

test('lambda steps keep the enclosing user call in the trace', () => {
  const kotlin = `fun repeatTwice(action: () -> Unit) {
    action()
    action()
}
fun main() {
    var n = 0
    repeatTwice {
        n++
    }
}`;
  const java = `public class Main {
    static void repeatTwice(Runnable action) {
        action.run();
        action.run();
    }
    public static void main(String[] args) {
        int[] n = {0};
        repeatTwice(() -> {
            n[0]++;
        });
    }
}`;
  const kotlinSteps = traceProgram('kotlin', kotlin, kotlin).traceItems.filter(({ line }) => line === 8);
  const javaSteps = traceProgram('java', java, java).traceItems.filter(({ line }) => line === 9);
  expect(kotlinSteps.map(({ callLines }) => callLines)).toEqual([[7], [7]]);
  expect(kotlinSteps.map(({ callLines }) => callLines.length)).toEqual(
    javaSteps.map(({ callLines }) => callLines.length)
  );
});

test('a deferred val appears in the trace after its scope lambda assigns it', () => {
  const source = `fun main() {
    val answer: Int
    println(0)
    run { answer = 3 }
    println(answer)
}`;
  const trace = traceProgram('kotlin', source, source);
  expect(trace.traceItems.find(({ line }) => line === 3)?.vars).toEqual({});
  expect(trace.traceItems.at(-1)?.vars.answer).toBe(3);
});

test('records narrow unsigned arrays including nested scalar arrays', () => {
  const program = `fun main() {
    val bytes = arrayOf(128u.toUByte(), 255u.toUByte())
    val shorts = arrayOf(32768u.toUShort(), 65535u.toUShort())
    val nested = arrayOf(bytes)
    println("done")
}`;
  const trace = traceProgram('kotlin', program, program);
  expect(trace.finalVars).toMatchObject({
    bytes: [128, 255],
    shorts: [32_768, 65_535],
    nested: [[128, 255]],
  });
  expect(trace.traceItems.at(-1)?.vars.nested).toEqual([[128, 255]]);
});

test('cyclic reference arrays remain inspectable and do not interrupt execution', () => {
  const program = `fun main() {
    val first = arrayOfNulls<Any>(1)
    val second = arrayOfNulls<Any>(1)
    first[0] = second
    second[0] = first
    println("done")
}`;
  const trace = traceProgram('kotlin', program, program);
  expect(trace.uncaughtException).toBeUndefined();
  expect(trace.stdout).toBe('done\n');
  expect(trace.traceItems.at(-1)?.referenceVars.first).toEqual({
    kind: 'array',
    // oxlint-disable-next-line unicorn/no-null -- The trace format represents absent references with null.
    entries: { 0: { kind: 'array', entries: { 0: { kind: 'value', value: null } } } },
  });
});
