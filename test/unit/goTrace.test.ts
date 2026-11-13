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
  items.map(({ line, callLines, ...item }) => ({ ...item, callDepth: callLines.length }));

/** The turtles' states each time they change. */
function moves(items: TraceItem[]): string[] {
  return items
    .map(({ turtles }) => JSON.stringify(turtles))
    .filter((turtles, index, all) => turtles !== all[index - 1]);
}

/** Programs that behave alike in both languages, so Go must reproduce the Java interpreter's trace. */
test.each([
  {
    name: 'loops, conditions, and variables',
    java: javaMain(`
    Turtle t = new Turtle();
    int n = 4;
    for (int i = 0; i < n; i++) {
      if (i % 2 == 0) {
        t.forward();
      } else {
        t.turnRight();
      }
    }
    int k = 0;
    while (k < 2) {
      k++;
    }`),
    go: `package main

func main() {
	t := NewTurtle()
	n := 4
	for i := 0; i < n; i++ {
		if i%2 == 0 {
			t.Forward()
		} else {
			t.TurnRight()
		}
	}
	k := 0
	for k < 2 {
		k++
	}
}`,
  },
  {
    name: 'a method that moves a turtle it holds, with an array of numbers',
    java: javaMain(
      `
    int[] steps = {1, 2};
    Walker w = new Walker();
    for (int s : steps) {
      w.walk(s);
    }`,
      `
  static class Walker {
    Turtle t = new Turtle(1, 1);

    void walk(int n) {
      for (int i = 0; i < n; i++) {
        t.forward();
      }
    }
  }`
    ),
    go: `package main

type Walker struct {
	t *Turtle
}

func (w *Walker) walk(n int) {
	for i := 0; i < n; i++ {
		w.t.Forward()
	}
}

func main() {
	steps := []int{1, 2}
	w := &Walker{t: NewTurtle(1, 1)}
	for _, s := range steps {
		w.walk(s)
	}
}`,
    // Go names the receiver's fields w.t where Java writes this.t, and Java initializes the field in a step of its own,
    // so only the turtles' moves compare.
    turtlesOnly: true,
  },
])('$name', ({ java, go, turtlesOnly }) => {
  const javaTrace = withoutLines(traceProgram('java', java, java).traceItems) as TraceItem[];
  const goTrace = withoutLines(traceProgram('go', go, go).traceItems) as TraceItem[];
  if (!turtlesOnly) {
    expect(goTrace).toEqual(javaTrace);
    return;
  }
  expect(moves(goTrace)).toEqual(moves(javaTrace));
});

test('the turtles a slice literal holds stay while later elements are created', () => {
  const program = `package main

func newTurtleAt(x int) *Turtle {
	t := NewTurtle(x, 0)
	return t
}

func main() {
	ts := []*Turtle{newTurtleAt(0), newTurtleAt(1)}
	ts[0].Forward()
}`;
  const { traceItems } = traceProgram('go', program, program);
  // After the second turtle is created, the first is still on the board, although no variable holds it yet.
  expect(traceItems.map(({ turtles }) => turtles.length)).toEqual([0, 1, 2, 2]);
});

test('a function marked atomic counts as one step of its caller', () => {
  const program = `package main

func walk(t *Turtle) { // atomic
	t.Forward()
	t.Forward()
}

func main() {
	t := NewTurtle()
	walk(t)
}`;
  const { traceItems, displayProgram } = traceProgram('go', program, program);
  expect(traceItems.map(({ line }) => line)).toEqual([0, 9, 10]);
  expect(displayProgram).not.toContain('atomic');
});

test('a misplaced atomic annotation is a compile error', () => {
  const program = `package main

func main() {
	t := NewTurtle() // atomic
	t.Forward()
}`;
  expect(() => traceProgram('go', program, program)).toThrow();
});

test('a loop over numbers records a step for each binding, as Java for-each does', () => {
  const program = `package main

func main() {
	sum := 0
	for _, v := range []int{3, 4} {
		sum += v
	}
}`;
  const { traceItems } = traceProgram('go', program, program);
  expect(traceItems.map(({ line, vars }) => [line, vars])).toEqual([
    [0, {}],
    [4, { sum: 0 }],
    [5, { sum: 0, v: 3 }],
    [6, { sum: 3, v: 3 }],
    [5, { sum: 3, v: 4 }],
    [6, { sum: 7, v: 4 }],
  ]);
});

test('a turtle captured by an evaluated callee stays reachable while call arguments run', () => {
  const program = `package main

func maker() func(int) {
	t := NewTurtle(0, 0)
	return func(n int) { t.Forward() }
}

func arg() int {
	x := 1
	return x
}

func main() {
	maker()(arg())
}`;
  const { traceItems } = traceProgram('go', program, program);
  expect(traceItems.map(({ turtles }) => turtles.length)).toEqual([0, 1, 1, 1, 0]);
});

test('integers beyond safe number precision remain exact bigints in trace snapshots', () => {
  const program = `package main

func main() {
	x := uint64(9007199254740993)
	_ = x
}`;
  const { finalVars } = traceProgram('go', program, program);
  expect(finalVars.x).toBe(9_007_199_254_740_993n);
});
