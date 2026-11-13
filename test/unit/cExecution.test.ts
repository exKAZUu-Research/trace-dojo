import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

// The interpreter's clock stands still in these tests, so that the program, not the load of the host, decides each one.
beforeEach(() => {
  vi.spyOn(performance, 'now').mockReturnValue(0);
});
afterEach(() => {
  vi.restoreAllMocks();
});

// Apple clang 21 (-std=c17) on arm64 macOS prints this output for the same program.
test('printf, rand, qsort, and pow give the output of clang and macOS libc', () => {
  const program = `#include <stdio.h>
#include <stdlib.h>
#include <math.h>
static int byTens(const void *a, const void *b) { return *(const int *)a / 10 - *(const int *)b / 10; }
int main(void) {
  printf("%.2f %.0f %.0f %.1f %g %g %.3e %a %.17g %5.1f|%-6.2e|\\n", 2.675, 0.5, 2.5, 0.05, 1e-5, 123456789.0, 6.02e23, 0.1, 0.1, -0.04, 1.0);
  srand(2026);
  printf("%d %d %d\\n", rand(), rand() % 100, rand());
  int a[] = {31, 12, 38, 15, 33, 19, 11, 37, 14, 35};
  qsort(a, 10, sizeof a[0], byTens);
  for (int i = 0; i < 10; i++) printf("%d ", a[i]);
  printf("\\n%.17g %.17g\\n", pow(1.1, 10.0), pow(3.0, -5.0));
  return 0;
}`;
  expect(executeProgram('c', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout:
      '2.67 0 2 0.1 1e-05 1.23457e+08 6.020e+23 0x1.999999999999ap-4 0.10000000000000001  -0.0|1.00e+00|\n' +
      '34050982 72 1839067988\n' +
      '19 11 15 14 12 35 38 33 37 31 \n' +
      '2.5937424601000023 0.00411522633744856\n',
  });
});

test('zero-sized allocations can be freed and resized', () => {
  const program = `#include <stdio.h>
#include <stdlib.h>
int main(void) {
  void *empty = malloc(0);
  void *other = calloc(0, sizeof(int));
  printf("%d %d %d\\n", empty != NULL, other != NULL, empty != other);
  free(empty);
  int *values = realloc(other, 2 * sizeof(int));
  values[0] = 17;
  values[1] = 25;
  printf("%d\\n", values[0] + values[1]);
  empty = realloc(values, 0);
  free(empty);
  free(realloc(NULL, 0));
  puts("done");
  return 0;
}`;
  expect(executeProgram('c', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: '1 1 1\n42\ndone\n',
  });
});

test('a program that draws reports its final board and the turtles its variables still reach', () => {
  const program = `#include <stdlib.h>
void draw(void) {
  Turtle *temporary = new_turtle(4, 4, "Y");
  forward(temporary);
}
int main(void) {
  Turtle *keep = new_turtle(1, 1, "G");
  draw();
  右を向く(keep);
  前に進む(keep);
  return 0;
}`;
  expect(executeProgram('c', program)).toEqual({
    kind: 'executed',
    finalBoard: ['.......', '.GG....', '.......', '.......', '....Y..', '....Y..', '.......'].join('\n'),
    finalTurtles: [{ x: 2, y: 1, color: 'G', dir: 'E' }],
    uncaughtException: undefined,
    stdout: '',
    stderr: '',
    finalFiles: {},
  });
});

// clang reports each of these programs' first error on the given line.
test.each([
  ['an undeclared function, which C99 no longer declares implicitly', 'int main(void) {\n  foo(1);\n  return 0;\n}', 2],
  ['a library function without its header', 'int main(void) {\n  printf("x");\n  return 0;\n}', 2],
  ['an integer stored in a pointer', 'int main(void) {\n  int *p = 5;\n  return 0;\n}', 2],
  ['too few arguments', 'int f(int a, int b) { return a + b; }\nint main(void) {\n  return f(1);\n}', 3],
  ['a chained comparison', 'int main(void) {\n  int a = 1;\n  return 3 > a > 1;\n}', 3],
  [
    'a second default, which clang reports at the first',
    'int main(void) {\n  switch (1) {\n  default: break;\n  default: break;\n  }\n}',
    3,
  ],
  ['a closing brace missing at the end of the file', 'int main(void) {\n  if (1) {\n    return 0;\n}\n', 4],
  ['true without stdbool.h', 'int main(void) {\n  return true;\n}', 2],
])('%s is a compile error on the line clang reports', (_title, program, line) => {
  const execution = executeProgram('c', program);
  expect(execution.kind === 'compileError' && execution.diagnostics[0].row + 1).toBe(line);
});

test.each([
  ['int a[3] = {1, 2, 3};\n  int i = 3;\n  return a[i];', '配列や確保した領域の範囲の外を読み書きしました。'],
  ['int *p = malloc(sizeof(int));\n  free(p);\n  return *p;', 'free で解放した領域を読み書きしました。'],
  ['int x = INT_MAX;\n  x++;\n  return 0;', 'int の計算の結果が、int の範囲を超えました（オーバーフロー）。'],
  ['int sum;\n  sum += 1;\n  return sum;', '値を入れていない変数（または領域）の値を読みました。'],
  ['char *s = "abc";\n  s[0] = \'x\';\n  return 0;', '文字列リテラルは書き換えられません。'],
])('undefined behavior stops the program: %s', (body, message) => {
  const program = `#include <stdlib.h>\n#include <limits.h>\nint main(void) {\n  ${body}\n}`;
  expect(executeProgram('c', program)).toMatchObject({ kind: 'executed', uncaughtException: message });
});

test('output before an assertion failure is kept, and the failure goes to standard error as macOS prints it', () => {
  const program =
    '#include <stdio.h>\n#include <assert.h>\nint main(void) {\n  printf("before\\n");\n  assert(1 == 2);\n}';
  const message = 'Assertion failed: (1 == 2), function main, file main.c, line 5.';
  expect(executeProgram('c', program)).toMatchObject({
    kind: 'executed',
    stdout: 'before\n',
    stderr: `${message}\n`,
    uncaughtException: message,
  });
});

test.each([
  [
    '#include <stdio.h>\nint main(void) {\n  int x;\n  scanf("%d", &x);\n}',
    '標準入力（scanf）は、この採点環境では使えません。',
  ],
  [
    '#include <stdio.h>\nint main(void) {\n  FILE *f = fopen("a.txt", "r");\n}',
    'ファイルの読み書き（fopen）は、この採点環境では使えません。',
  ],
  [
    '#include "mine.h"\nint main(void) { return 0; }',
    '自分で作ったヘッダや別のファイル（#include "mine.h"）は、この採点環境では使えません。',
  ],
  [
    'struct P { int x; };\nint main(void) {\n  struct P p = { .x = 1 };\n}',
    '要素を指定した初期化（.x = 1 や [2] = 5）は、この採点環境では使えません。',
  ],
])('features left out of the interpreter are rejected before running: %s', (program, message) => {
  const execution = executeProgram('c', program);
  expect(execution.kind === 'compileError' && execution.diagnostics[0].message).toBe(message);
});
