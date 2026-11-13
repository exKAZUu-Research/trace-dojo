import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

beforeEach(() => {
  vi.spyOn(performance, 'now').mockReturnValue(0);
});
afterEach(() => {
  vi.restoreAllMocks();
});

test.each(['again: goto again;', 'int i = 0; again: i++; goto again;', 'again: { goto again; }'])(
  'goto cycles obey the execution budget: %s',
  (body) => {
    expect(executeProgram('c', `int main(void) { ${body} }`)).toEqual({
      kind: 'limitExceeded',
      limit: 'operations',
    });
  }
);

test('preprocessing skips evaluation of unselected operands while checking their syntax', () => {
  const program = `#include <stdio.h>
#if 0 && (1 / 0)
#error unreachable
#endif
#if 1 || (1 / 0)
#define A 1
#endif
#if 1 ? 1 : (1 / 0)
#define B 2
#endif
#if 0 ? (1 / 0) : (1 && (1 ? 1 : (1 / 0)))
#define C 3
#endif
int main(void) { printf("%d %d %d\\n", A, B, C); }`;
  expect(executeProgram('c', program)).toMatchObject({
    kind: 'executed',
    stdout: '1 2 3\n',
    uncaughtException: undefined,
  });
  expect(executeProgram('c', '#if 0 && (1 + )\n#endif\nint main(void) {}').kind).toBe('compileError');
  expect(executeProgram('c', '#if 1 && (1 / 0)\n#endif\nint main(void) {}').kind).toBe('compileError');
});

test.each(['%1000000000d', '%.1000000000d', '%1000000000s', '%.1000000000f'])(
  'formatting obeys the execution budget before constructing an enormous field: %s',
  (format) => {
    const argument = format.endsWith('s') ? '"x"' : format.endsWith('f') ? '1.0' : '1';
    expect(executeProgram('c', `#include <stdio.h>\nint main(void) { printf("${format}", ${argument}); }`)).toEqual({
      kind: 'limitExceeded',
      limit: 'operations',
    });
  }
);

test('updates and assignments evaluate side effects in their targets once', () => {
  const program = `#include <stdio.h>
struct S { unsigned int x:3; int y; };
int main(void) {
  int a[] = {10, 20, 30, 40, 50};
  int i = 0;
  a[i++]++;
  a[i++] += 2;
  printf("%d %d %d %d\\n", i, a[0], a[1], a[2]);
  int *p = a;
  printf("%d ", ++*p++);
  *p++ *= 2;
  printf("%d %d %d\\n", (int)(p-a), a[0], a[1]);
  struct S s[] = {{7, 5}, {2, 6}, {3, 7}};
  i = 0;
  printf("%u ", ++s[i++].x);
  printf("%d %u %u\\n", i, s[0].x, s[1].x);
  printf("%u ", s[i++].x = 9);
  printf("%d %u %u\\n", i, s[1].x, s[2].x);
  i = 0;
  printf("%u ", s[i++].x += 10);
  printf("%d %u %u\\n", i, s[0].x, s[1].x);
}`;
  expect(executeProgram('c', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: '2 11 22 30\n12 2 12 44\n0 1 0 2\n1 2 1 3\n2 1 2 1\n',
  });
});

test('block locals expire and fresh block entries get new uninitialized storage', () => {
  const invalid = `int main(void) { int *p; { int x = 42; p = &x; } return *p; }`;
  expect(executeProgram('c', invalid)).toMatchObject({
    kind: 'executed',
    uncaughtException: '有効期間が終わった変数を読み書きしました。',
  });
  const loop = `int main(void) { for (int i = 0; i < 2; i++) { int x; int *p = &x; if (i == 0) x = 7; else return *p; } }`;
  expect(executeProgram('c', loop)).toMatchObject({
    kind: 'executed',
    uncaughtException: '値を入れていない変数（または領域）の値を読みました。',
  });
  const turtles = `int main(void) { { Turtle *a[1] = {new_turtle()}; forward(a[0]); } }`;
  expect(executeProgram('c', turtles)).toMatchObject({
    kind: 'executed',
    finalTurtles: [],
    uncaughtException: undefined,
    finalBoard: '#......\n#......\n.......\n.......\n.......\n.......\n.......',
  });
});

test('unsigned bit-fields promote according to their width', () => {
  const program = `#include <stdio.h>
int main(void) {
  struct S { unsigned int x:3; unsigned int y:32; } s = {7, 7};
  printf("%d %d %d %d %d\\n", s.x - 8 < 0, s.x < -1, -s.x < 0, (s.x + 1) > 0, s.y - 8 < 0);
}`;
  expect(executeProgram('c', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: '1 0 1 1 0\n',
  });
});

test('floating operations handle subnormals, extreme exponents, and fused cancellation', () => {
  const program = `#include <stdio.h>
#include <math.h>
#include <float.h>
int main(void) {
  int e;
  double m = frexp(DBL_TRUE_MIN, &e);
  printf("%a %d\\n", m, e);
  m = frexp(1e-320, &e);
  printf("%a %d\\n", m, e);
  m = frexp(DBL_MAX, &e);
  printf("%a %d\\n", m, e);
  printf("%.17g %.17g\\n", ldexp(1e-300, 1100), ldexp(1e300, -1100));
  printf("%a %a %a\\n", ldexp(DBL_TRUE_MIN, 1074), ldexp(1.0, -1074), ldexpf(1.0f, -149));
  printf("%.17g %.17g\\n", fma(1.0000000000000002, 0.9999999999999998, -1.0), fma(DBL_MAX, 2.0, -DBL_MAX));
  printf("%a %a %a\\n", fmaf(1.00000011920928955078125f, 0.99999988079071044921875f, -1.0f), fma(-0.0, 1.0, -0.0), fma(1.0, 1.0, -1.0));
}`;
  expect(executeProgram('c', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout:
      '0x1p-1 -1073\n0x1.fap-1 -1063\n0x1.fffffffffffffp-1 1024\n1.3582985290493859e+31 7.3621518290228631e-32\n0x1p+0 0x1p-1074 0x1p-149\n-4.9303806576313238e-32 1.7976931348623157e+308\n-0x1p-46 -0x0p+0 0x0p+0\n',
  });
});
