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

test('typedef declarators and abstract array/function types retain their meanings', () => {
  const program = `#include <stdio.h>
#include <stdbool.h>
typedef int T;
typedef struct { int x; } Point;
T (*global)(T, T);
T (*arrayPointer)[3];
T (*get(void))[3];
T add(T a, T b) { return a+b; }
Point origin(void) { Point p={42}; return p; }
int main(void) {
 T (*op)(T,T)=add;
 Point (*mk)(void)=origin;
 bool (*pred)(int)=0;
 int a[3]={1,2,3}; arrayPointer=&a;
 printf("%d %d %d %zu %zu %d\\n", op(1,2), mk().x, pred==0, sizeof(T[4]), sizeof(T(*)(int)), (*arrayPointer)[2]);
}`;
  expect(executeProgram('c', program)).toMatchObject({
    kind: 'executed',
    stdout: '3 42 1 16 8 3\n',
    uncaughtException: undefined,
  });
});

test('float classification macros retain the argument precision and math variants are callable', () => {
  const program = `#include <stdio.h>
#include <math.h>
int main(void) {
 float f=1e-40f; double d=1e-40;
 printf("%d %d %d %d\\n",fpclassify(f)==FP_SUBNORMAL,isnormal(f),fpclassify(d)==FP_NORMAL,isnormal(d));
 printf("%d %.0f %.0Lf %.0Lf\\n",ilogbf(8.0f),scalbnf(1.0f,2),scalblnl(1.0L,3L),fmal(2.0L,3.0L,1.0L));
}`;
  expect(executeProgram('c', program)).toMatchObject({
    kind: 'executed',
    stdout: '1 0 1 1\n3 4 8 7\n',
    uncaughtException: undefined,
  });
});

test('macOS hexadecimal rounding and zero-padded text fields retain their formatting', () => {
  const program = `#include <stdio.h>
int main(void) {
 printf("%05s|%05c|%05.1s|%05%|%-05s|%05.3d|\\n","ab",'x',"xyz","ab",12);
 printf("%.3a %.0a %.3a %.3a\\n",-336291.0255587237,1.5,1.0+31.0/65536.0+1e-12,1.0+25.0/65536.0);
}`;
  expect(executeProgram('c', program)).toMatchObject({
    kind: 'executed',
    stdout: '000ab|0000x|0000x|0000%|ab   |  012|\n-0x1.486p+18 0x1p+0 0x1.002p+0 0x1.002p+0\n',
    uncaughtException: undefined,
  });
});

test('qsort preserves the target ordering and comparator count at its insertion-sort boundary', () => {
  const program = `#include <stdio.h>
#include <stdlib.h>
typedef struct { int k; int id; } R;
static int calls;
int cmp(const void *a,const void *b){ calls++; const R *x=a,*y=b; return (x->k>y->k)-(x->k<y->k); }
int main(void){ R a[7]; for(int i=0;i<7;i++){a[i].k=(i*7)%3;a[i].id=i;} qsort(a,7,sizeof a[0],cmp); for(int i=0;i<7;i++) printf("%d",a[i].id); printf(" %d\\n",calls); }`;
  expect(executeProgram('c', program)).toMatchObject({
    kind: 'executed',
    stdout: '0361425 13\n',
    uncaughtException: undefined,
  });
});

test.each([
  'return a[0][2];',
  'return a[1][-1];',
  'int *p=a[0]; return p[2];',
  'return *(a[0]+2);',
  'return *(&a[0][2]);',
])('array subobjects reject accesses into an adjacent row: %s', (body) => {
  expect(executeProgram('c', `int main(void) { int a[2][2]={{1,2},{3,4}}; ${body} }`)).toMatchObject({
    kind: 'executed',
    uncaughtException: '配列や確保した領域の範囲の外を読み書きしました。',
  });
});

test('one-past array addresses remain valid for pointer comparisons', () => {
  const program = `#include <stdio.h>\nint main(void) { int a[2][2]={{1,2},{3,4}}; int *p=&a[0][2]; printf("%d %d %d\\n",p==a[1],a[1][0],a[0][1]); }`;
  expect(executeProgram('c', program)).toMatchObject({
    kind: 'executed',
    stdout: '1 3 2\n',
    uncaughtException: undefined,
  });
});

test('constant string comparisons use clang folding while runtime comparisons use libc', () => {
  const program = `#include <stdio.h>
#include <string.h>
const char a[]="apple";
int main(void) {
 const char local[]="cherry";
 const char *p="apple", *q="cherry";
 printf("%d %d %d %d %d\\n",strcmp("apple","cherry"),strcmp(p,q),memcmp("az","aa",2),strcmp("apple"+1,"cherry"),strcmp(a,local));
}`;
  expect(executeProgram('c', program)).toMatchObject({
    kind: 'executed',
    stdout: '-1 -2 1 1 -1\n',
    uncaughtException: undefined,
  });
});

test('sizeof checks extern operands without requiring a linked definition', () => {
  const program = `#include <stdio.h>\nextern int x; extern int a[2]; int main(void){printf("%zu %zu %zu\\n",sizeof x,sizeof &x,sizeof a);}`;
  expect(executeProgram('c', program)).toMatchObject({
    kind: 'executed',
    stdout: '4 8 8\n',
    uncaughtException: undefined,
  });
});

test.each([
  'struct S { int x; }; int main(void){register struct S s={1}; int*p=&s.x;}',
  'int main(void){register int a[2]={1,2}; int*p=&a[0];}',
])('register subobjects retain their address restriction: %s', (program) => {
  expect(executeProgram('c', program).kind).toBe('compileError');
});

test('register pointer variables do not restrict addressing their pointees', () => {
  const program = `#include <stdio.h>\nstruct S{int x;}; int main(void){struct S s={7};register struct S *p=&s;int *q=&p->x;printf("%d\\n",*q);}`;
  expect(executeProgram('c', program)).toMatchObject({ kind: 'executed', stdout: '7\n', uncaughtException: undefined });
});

test('goto bypassing a declaration keeps the lexical local visible after assignment', () => {
  const program = `int x=9;
int main(void){
 goto L;
 int x;
 L: x=3;
 x++;
}`;
  const result = traceProgram('c', program, program);
  expect(result.traceItems.find((item) => item.line === 5)?.vars).toEqual({ x: 3 });
  expect(result.finalVars).toEqual({ x: 4 });
});

test('assignment evaluates and converts the right side before binding the target once', () => {
  const program = `#include <stdio.h>
int a;int *left(void){putchar(76);return &a;}int right(void){putchar(82);return 7;}
int main(void){*left()=right();printf("%d\\n",a);*left()+=right();printf("%d\\n",a);}`;
  expect(executeProgram('c', program)).toMatchObject({
    kind: 'executed',
    stdout: 'RL7\nRL14\n',
    uncaughtException: undefined,
  });
});

test.each(['\n', '\r\n'])('comment terminators after line splices are recognized: %j', (newline) => {
  expect(executeProgram('c', `#include <stdio.h>\nint main(void){/*\\${newline}*/puts("ok");}`)).toMatchObject({
    kind: 'executed',
    stdout: 'ok\n',
    uncaughtException: undefined,
  });
});

test('bit-field snapshots preserve uninitialized neighbors', () => {
  const program = `struct S{unsigned x:1,y:1;};
int main(void){
 struct S s;
 s.x=1;
}`;
  const result = traceProgram('c', program, program);
  expect(result.traceItems.find((item) => item.line === 4)?.referenceVars.s).toEqual({
    kind: 'object',
    // oxlint-disable-next-line unicorn/no-null -- The trace protocol represents uninitialized fields as null.
    entries: { x: { kind: 'value', value: 1 }, y: { kind: 'value', value: null } },
  });
});

test('float nextafter and nexttoward advance by a float representable step', () => {
  const program = `#include <stdio.h>\n#include <math.h>\nint main(void){printf("%a %a %a\\n",nextafterf(1.0f,2.0f),nexttowardf(1.0f,1.0000000001L),nextafterf(0.0f,-1.0f));}`;
  expect(executeProgram('c', program)).toMatchObject({
    kind: 'executed',
    stdout: '0x1.000002p+0 0x1.000002p+0 -0x1p-149\n',
    uncaughtException: undefined,
  });
});

test('bit-field prefix and postfix update results use their distinct promotions', () => {
  const source = `#include <stdio.h>
int main(void){struct S{unsigned x:3;}s={1};printf("%d ",s.x++ < -1);printf("%d ",--s.x < -1);printf("%d ",s.x-- < -1);printf("%d ",++s.x < -1);printf("%d\\n",(s.x=1)<-1);}`;
  expect(executeProgram('c', source)).toMatchObject({
    kind: 'executed',
    stdout: '1 0 1 0 0\n',
    uncaughtException: undefined,
  });
});

test.each(['int a={1,f(),x};return a-1;', 'int a[1]={1,f(),x};return a[0]-1;'])(
  'discarded initializers are checked without linker references: %s',
  (body) => {
    expect(executeProgram('c', `int f(void);extern int x;int main(void){${body}}`)).toMatchObject({
      kind: 'executed',
      uncaughtException: undefined,
    });
  }
);

test('function and void pointers remain visible as pointer values', () => {
  const source = `int dbl(int x){return 2*x;}
int main(void){
 int (*op)(int)=dbl;
 int (*ops[1])(int)={dbl};
 void *p=(void*)dbl;
 int r=op(2);
}`;
  const trace = traceProgram('c', source, source);
  const step = trace.traceItems.find((item) => item.line === 6);
  expect(step?.vars.op).toMatch(/^0x[\da-f]+$/);
  expect(step?.vars.p).toEqual(step?.vars.op);
  expect(step?.referenceVars.ops).toEqual({ kind: 'array', entries: { 0: { kind: 'value', value: step?.vars.op } } });
});

test('math decomposition preserves exponents, exact remainders, NaN and signed zero', () => {
  const source = `#include <stdio.h>
#include <math.h>
int main(void){double i;float f;int q;
printf("%g %g %g\\n",logb(1.7976931348623157e308),logb(1023.9999999999999),logb(2.225073858507201e-308));
printf("%.17g %g %g\\n",remainder(1e300,811.75),remainder(-0.0,3),remquo(7,2,&q));printf("%d\\n",q);
printf("%g %g %g %g %g\\n",modf(-0.0,&i),modff(-0.0f,&f),modff(NAN,&f),modff(-INFINITY,&f),modff(INFINITY,&f));
printf("[%+g][% e][%+010g][%-+10.3f][%+a]\\n",NAN,NAN,NAN,NAN,NAN);}`;
  expect(executeProgram('c', source)).toMatchObject({
    kind: 'executed',
    stdout: '1023 9 -1023\n-380.75 -0 -1\n4\n-0 -0 nan -0 0\n[nan][nan][       nan][nan       ][nan]\n',
    uncaughtException: undefined,
  });
});

test('floating conversion reports inexact underflow while allowing exact subnormals', () => {
  const source = `#include <stdlib.h>
#include <stdio.h>
#include <errno.h>
int main(void){char*inputs[]={"1e-40","0x1p-149","1e-310","0x1p-1074","0x1p-1022","0"};for(int i=0;i<6;i++){errno=0;float f=strtof(inputs[i],0);printf("%d ",errno);errno=0;double d=strtod(inputs[i],0);printf("%d\\n",errno);}}`;
  expect(executeProgram('c', source)).toMatchObject({
    kind: 'executed',
    stdout: '34 0\n0 0\n34 34\n34 0\n34 0\n0 0\n',
    uncaughtException: undefined,
  });
});

test.each([
  'int *p=a[0]+2;printf("%d",*p);',
  'int *p=&a[0][2];printf("%d",p[0]);',
  'int *p=a[0];p+=2;printf("%d",*p);',
  'int *p=a[0]+1;p++;printf("%d",*p);',
  'int *p=a[0]+2;int **q=&p;printf("%d",**q);',
  'int *p=a[0]+2;int *q=identity(p);printf("%d",*q);',
  'int *p=a[0]+2;printf("%d",read(p));',
  'struct S s={a[0]+2};struct S t=s;printf("%d",*t.p);',
  'struct S s={a[0]+2};printf("%d",*copy(s).p);',
  'int *p[1]={a[0]+2};printf("%d",*p[0]);',
  'int *p=a[0]+2;int *q;memcpy(&q,&p,sizeof p);printf("%d",*q);',
  'int *p=a[0]+2;int *q;memmove(&q,&p,sizeof p);printf("%d",*q);',
  'int **p=malloc(sizeof *p);*p=a[0]+2;p=realloc(p,2*sizeof *p);printf("%d",**p);',
  'int *p=a[0]+2;printf("%d",*(1?p:a[1]));',
  'int *p=a[0]+2;printf("%d",*((void)0,p));',
  'int *p=a[0]+2;void*q=p;printf("%d",*(int*)q);',
  'int *p;printf("%d",*(p=a[0]+2));',
])('stored pointer provenance stops row overrun: %s', (body) => {
  const source = `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
struct S{int*p;};struct S copy(struct S s){return s;}int*identity(int*p){return p;}int read(int*p){return *p;}
int main(void){int a[2][2]={{1,2},{3,4}};${body}}`;
  const result = executeProgram('c', source);
  expect(result).toMatchObject({ kind: 'executed', stdout: '' });
  expect(result.kind === 'executed' && result.uncaughtException).toBeDefined();
});

test('equal numeric row pointers retain different bounds and valid backward updates', () => {
  const source = `#include <stdio.h>
int a[2][2]={{1,2},{3,4}};int *p=a[0]+2;int*q=a[1];int main(void){printf("%d %d ",p==q,*q);p--;printf("%d ",*p);p=a[1];printf("%d\\n",*p);}`;
  expect(executeProgram('c', source)).toMatchObject({
    kind: 'executed',
    stdout: '1 3 2 3\n',
    uncaughtException: undefined,
  });
});
