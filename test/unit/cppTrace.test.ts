import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { executeProgram, traceProgram } from '../../src/interpreter/program';

// The interpreter's clock stands still in these tests, so that the program, not the load of the host, decides each one.
beforeEach(() => {
  vi.spyOn(performance, 'now').mockReturnValue(0);
});
afterEach(() => {
  vi.restoreAllMocks();
});

function steps(language: 'cpp' | 'java', program: string): { vars: Record<string, unknown>; board: string }[] {
  return traceProgram(language, program, program).traceItems.map(({ vars, board }) => ({
    vars: Object.fromEntries(Object.entries(vars).map(([name, value]) => [name.replace('this->', 'this.'), value])),
    board,
  }));
}

test('a C++ program records the steps that the Java version of it records', () => {
  const cpp = `#include <string>
#include <vector>
class Walker {
 public:
  int speed = 1;
  Turtle t;
  void walk(int n) {
    for (int i = 0; i < n * speed; i++) {
      t.前に進む();
    }
  }
};
int twice(int a) {
  return a * 2;
}
int main() {
  Walker w;
  int n = twice(1);
  w.walk(n);
  std::vector<int> arr = {1, 2};
  for (int x : arr) {
    w.t.右を向く();
  }
  std::string s = "fr";
  char c = s[1];
}`;
  const java = `public class Main {
  public static void main(String[] args) {
    Walker w = new Walker();
    int n = twice(1);
    w.walk(n);
    int[] arr = { 1, 2 };
    for (int x : arr) {
      w.t.右を向く();
    }
    String s = "fr";
    char c = s.charAt(1);
  }
  static int twice(int a) {
    return a * 2;
  }
}
class Walker {
  int speed = 1;
  Turtle t = new Turtle();
  void walk(int n) {
    for (int i = 0; i < n * speed; i++) {
      t.前に進む();
    }
  }
}`;
  expect(steps('cpp', cpp)).toEqual(steps('java', java));
});

test('a turtle leaves the board when its object ends its lifetime or becomes unreachable', () => {
  const program = `int main() {
  {
    Turtle a(1, 1);
  }
  Turtle* p = new Turtle(2, 2);
  p = new Turtle(3, 3);
  Turtle* q = new Turtle(4, 4);
  delete q;
  Turtle last(5, 5);
}`;
  const trace = traceProgram('cpp', program, program);
  const turtlesAt = (line: number): string[] =>
    (trace.traceItems.findLast((item) => item.line === line)?.turtles ?? []).map(({ x, y }) => `${x},${y}`);
  expect(turtlesAt(3)).toEqual(['1,1']);
  expect(turtlesAt(5)).toEqual(['2,2']);
  expect(turtlesAt(6)).toEqual(['3,3']);
  expect(turtlesAt(8)).toEqual(['3,3']);
  // The final turtles are those main's variables reach when its body completes, before they end their lifetime.
  expect(trace.finalTurtles.map(({ x, y }) => `${x},${y}`)).toEqual(['3,3', '5,5']);
});

// The declaration of m records no step of its own: the member's construction recorded one, as in Java.
test('// atomic on a member function makes each call of it one step of the caller', () => {
  const program = `class Mover {
 public:
  Turtle t;
  void twoSteps() { // atomic
    t.前に進む();
    t.前に進む();
  }
};
int main() {
  Mover m;
  m.twoSteps();
}`;
  expect(traceProgram('cpp', program, program).traceItems.map(({ line }) => line)).toEqual([0, 3, 11]);
});

test('a heap object stays on the board while a later element of the same list is constructed', () => {
  const program = `#include <vector>
class Mark {
 public:
  Turtle t;
  Mark(int x) : t(x, 0) {}
};
int main() {
  std::vector<Mark*> marks = {new Mark(1), new Mark(2)};
}`;
  const trace = traceProgram('cpp', program, program);
  expect(trace.finalTurtles.map(({ x }) => x)).toEqual([1, 2]);
});

test('the interpreter rejects the syntax it leaves out with a message naming it', () => {
  const execution = executeProgram('cpp', 'int main() {\n  auto f = [](int x) { return x; };\n}');
  expect(execution).toEqual({
    kind: 'compileError',
    diagnostics: [{ row: 1, message: 'ラムダ式は、この採点環境では使えません。' }],
  });
});
