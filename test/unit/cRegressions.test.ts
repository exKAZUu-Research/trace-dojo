import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { executeProgram, traceProgram } from '../../src/interpreter/program';

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

test('preprocessing shares character decoding and uses signed or unsigned widest integers', () => {
  const program = `#include <stdio.h>
#include <limits.h>
#if 'A' == '\\x41' && '\\?' == 63 && '\\377' < 0 && 'ab' == 24930 && !(-1 < 0u) && ULONG_MAX == -1 && ~0u > 0 && ((1 ? -1 : 0u) > 0)
#define RESULT 42
#else
#define RESULT 0
#endif
int main(void) { printf("%d\\n", RESULT); }`;
  expect(executeProgram('c', program)).toMatchObject({
    kind: 'executed',
    stdout: '42\n',
    uncaughtException: undefined,
  });
});

test.each([
  'int main(void) {} /* unfinished',
  'extern int x; int main(void) { return x; }',
  'extern int x; int main(void) { int *p = &x; }',
  'int x; int main(void) { extern float x; }',
  'int x[2]; int main(void) { extern char x[2]; }',
  'int main(void) { int x = {1, missing}; }',
  'int main(void) { register int x=1; int *p=&x; }',
  'int f(); int f(float x) { return x; } int main(void) {}',
  'int f(); int f(char x) { return x; } int main(void) {}',
])('invalid declarations or unfinished comments fail before execution: %s', (program) => {
  expect(executeProgram('c', program).kind).toBe('compileError');
});

test.each(['int x = 1e300;', 'int x = -1e308;', 'int x = 0.0/0.0;', 'return (int)1e300;'])(
  'undefined constant conversions stop at execution rather than throwing during compilation: %s',
  (body) => {
    expect(executeProgram('c', `int main(void) { ${body} }`)).toMatchObject({
      kind: 'executed',
      uncaughtException: '浮動小数点数を整数にした値が、整数の型の範囲を超えています。',
    });
  }
);

test('initializers consume complete subobjects when inferring array lengths', () => {
  const program = `#include <stdio.h>
int a[];
int *p = (int *)0;
char globalNames[][6] = {"ann", "bob"};
int main(void) {
  char names[][6] = {"ann", "bob"};
  struct Entry { char s[4]; int n; } entries[] = {"ab", 1, "cd", 2};
  struct Pair { int x; int y[2]; } pairs[] = {1, {2, 3}, 4, 5, 6};
  a[0] = 7;
  printf("%zu %zu %zu %s %s %d %d %d\\n", sizeof names, sizeof entries / sizeof entries[0], sizeof pairs / sizeof pairs[0], names[1], globalNames[1], entries[1].n, pairs[1].y[1], a[0]);
  printf("%d\\n", p == 0);
}`;
  expect(executeProgram('c', program)).toMatchObject({
    kind: 'executed',
    stdout: '12 2 2 bob bob 2 6 7\n1\n',
    uncaughtException: undefined,
  });
});

test('inner standalone tag declarations hide outer tags and keep their own definitions', () => {
  const program = `#include <stdio.h>
struct S { int x; };
int main(void) { struct S; struct S *p; struct S { double y; } v={3}; p=&v; printf("%.0f\\n",p->y); }`;
  expect(executeProgram('c', program)).toMatchObject({ kind: 'executed', stdout: '3\n', uncaughtException: undefined });
});

test('bit-field barriers determine record size, and unwritten fields remain uninitialized across copies', () => {
  const sizes =
    '#include <stdio.h>\nstruct S { char c; int :0; }; struct T { char c; long :0; }; int main(void) { printf("%zu %zu\\n", sizeof(struct S), sizeof(struct T)); }';
  expect(executeProgram('c', sizes)).toMatchObject({ kind: 'executed', stdout: '4 8\n', uncaughtException: undefined });
  for (const body of ['s.x=1; return s.y;', 's.y=1; return s.x;', 's.x=1; struct S t=s; return t.y;']) {
    expect(
      executeProgram('c', `struct S { unsigned x:1; unsigned y:1; }; int main(void) { struct S s; ${body} }`)
    ).toMatchObject({ kind: 'executed', uncaughtException: '値を入れていない変数（または領域）の値を読みました。' });
  }
});

test('text and number library calls return macOS results and share errno storage', () => {
  const program = `#include <stdio.h>
#include <stdlib.h>
#include <errno.h>
#include <float.h>
int main(void) {
  errno=0; float f=strtof("1e40",0); printf("%g %d\\n",f,errno);
  errno=0; perror("clear"); errno=EDOM; perror("domain");
  char a[3]="--"; int n=sscanf("a","%2c",a); printf("%d %s\\n",n,a);
  int p=puts("abc"); int q=fputs("xyz",stdout); printf(" %d %d\\n",p,q);
  printf("%.0a %.2a %.0a %.0a\\n", 1.5, 1.068359375, 0.1, DBL_MAX);
}`;
  expect(executeProgram('c', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
    stdout: 'inf 34\n1 a-\nabc\nxyz 10 3\n0x1p+0 0x1.11p+0 0x2p-4 0x2p+1023\n',
    stderr: 'clear: Undefined error: 0\ndomain: Numerical argument out of domain\n',
  });
});

test.each(['strcat(s,s);', 'strncat(s,s,1);', 'strncpy(s,s,2);'])('overlapping string copies stop: %s', (call) => {
  expect(executeProgram('c', `#include <string.h>\nint main(void) { char s[16]="ab"; ${call} }`)).toMatchObject({
    kind: 'executed',
    uncaughtException: 'コピー元とコピー先の領域が重なっています（memmove を使ってください）。',
  });
});

test('CRLF line-comment continuations hide the continued line', () => {
  expect(
    executeProgram(
      'c',
      '#include <stdio.h>\r\nint main(void) {\r\n// comment \\\r\nprintf("bad");\r\nputs("ok");\r\n}\r\n'
    )
  ).toMatchObject({ kind: 'executed', stdout: 'ok\n', uncaughtException: undefined });
});

test.each(['void f(int n, int a[n]); int main(void) {}', 'void f(int n, int a[n]) { a[0] = n; } int main(void) {}'])(
  'parameter-dependent array bounds report unsupported VLAs: %s',
  (program) => {
    const result = executeProgram('c', program);
    expect(result.kind === 'compileError' && result.diagnostics[0].message).toContain(
      '可変長配列）は、この採点環境では使えません。'
    );
  }
);

test('trace variables retain shadowing locals and pointers without live targets', () => {
  const program = `#include <stdlib.h>
int x=1;
int main(void) {
 int x=2;
 x++;
 int a[2]={1,2};
 int *end=a+2;
 int *q=malloc(sizeof(int));
 *q=4;
 free(q);
 x++;
}`;
  const result = traceProgram('c', program, program);
  expect(result.traceItems.find((item) => item.line === 4)?.vars.x).toBe(2);
  expect(result.finalVars).toMatchObject({
    x: 4,
    end: expect.stringMatching(/^0x[0-9a-f]+$/),
    q: expect.stringMatching(/^0x[0-9a-f]+$/),
  });
});

test.each([
  '// atomic\nvoid helper(void) {}\nint main(void) {}',
  'void helper(void) {\n int x=1; // atomic\n}\nint main(void) {}',
  'int main(void) {}\n// atomic',
])('misplaced atomic annotations are diagnosed: %s', (program) => {
  expect(() => traceProgram('c', program, program)).toThrow('// atomic は、メソッド・コンストラクタ・関数を宣言する行');
});
