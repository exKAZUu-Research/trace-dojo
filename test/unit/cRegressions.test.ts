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

test.each(['*p=3;', 'int value=3;memcpy(p,&value,sizeof value);'])(
  'final snapshots retain bypassed lexical locals after indirect writes: %s',
  (write) => {
    const source = `#include <string.h>
int x=9;
int main(void){
 goto L;
 int x;
 L:;
 int *p=&x;
 ${write}
}`;
    const trace = traceProgram('c', source, source);
    expect(trace.traceItems.at(-1)?.vars.x).toBe(3);
    expect(trace.finalVars.x).toBe(3);
  }
);

test('final snapshots restore outer visibility when nested blocks end', () => {
  const source = `int main(void){int x=1;{int x=2;}return 0;}`;
  expect(traceProgram('c', source, source).finalVars).toEqual({ x: 1 });
});

test.each(['// 本当に動く??!\n/* (??) */', '/* ??/??/ */', ' #if 0\n"what??!"\n#endif'])(
  'trigraphs discarded as comments or inactive tokens do not reject programs: %s',
  (prefix) => {
    expect(executeProgram('c', `#include <stdio.h>\n${prefix}\nint main(void){puts("ok");}`)).toMatchObject({
      kind: 'executed',
      stdout: 'ok\n',
      uncaughtException: undefined,
    });
  }
);

test.each(['??=define X 1', 'int x=??-1;', 'char*s="??!";', '// ??/\n int hidden;'])(
  'active trigraph syntax remains unsupported: %s',
  (code) => {
    expect(executeProgram('c', `${code}\nint main(void){}`)).toMatchObject({
      kind: 'compileError',
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ message: 'トライグラフは、この採点環境では使えません。' }),
      ]),
    });
  }
);

test('integer conversion failures report platform errno across signed and unsigned families', () => {
  const source = `#include <stdio.h>
#include <stdlib.h>
#include <inttypes.h>
#include <errno.h>
int main(void){char*inputs[]={"abc","","   ","-","10","10"};int bases[]={10,10,0,10,1,37};char*end;
for(int i=0;i<6;i++){errno=0;long n=strtol(inputs[i],&end,bases[i]);printf("%ld %d %ld\\n",n,errno,end-inputs[i]);}
errno=0;strtoul("abc",0,10);printf("%d ",errno);errno=0;strtoimax("-",0,10);printf("%d ",errno);errno=0;strtoumax("",0,10);printf("%d\\n",errno);}`;
  expect(executeProgram('c', source)).toMatchObject({
    kind: 'executed',
    stdout: '0 22 0\n0 22 0\n0 22 0\n0 22 0\n0 22 0\n0 22 0\n22 22 22\n',
    uncaughtException: undefined,
  });
});

test('learner definitions supersede platform extensions while typed conflicts remain errors', () => {
  const source = `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int strcasecmp(const char*a,const char*b){return 0;}long random(void){return 7;}size_t strnlen(const char*s,size_t n){return 2;}
int main(void){printf("%d %ld %zu\\n",strcasecmp("a","b"),random(),strnlen("abc",3));}`;
  expect(executeProgram('c', source)).toMatchObject({
    kind: 'executed',
    stdout: '0 7 2\n',
    uncaughtException: undefined,
  });
  expect(executeProgram('c', '#include <stdlib.h>\nint random(void){return 7;}int main(void){}').kind).toBe(
    'compileError'
  );
});

test('larger tie-heavy qsort partitions preserve Apple order and comparator count', () => {
  const source = `#include <stdio.h>
#include <stdlib.h>
int calls;int cmp(const void*a,const void*b){calls++;return *(const int*)a/10-*(const int*)b/10;}
int main(void){int z[32]={40,43,19,43,69,7,88,39,50,41,22,38,2,85,89,67,91,14,105,31,37,63,37,5,49,70,86,77,35,36,12,8};qsort(z,32,sizeof z[0],cmp);for(int i=0;i<32;i++)printf("%d,",z[i]);printf(" %d\\n",calls);}`;
  expect(executeProgram('c', source)).toMatchObject({
    kind: 'executed',
    stdout: '8,7,2,5,14,19,12,22,39,37,31,37,36,38,35,40,43,43,41,49,50,67,69,63,70,77,89,86,85,88,91,105, 108\n',
    uncaughtException: undefined,
  });
});

test('qsort comparison order and tie ordering match Apple across partition sizes', () => {
  const source = `#include <stdio.h>
#include <stdlib.h>
unsigned digest;
int cmp(const void*a,const void*b){int x=*(const int*)a,y=*(const int*)b;digest=digest*33u+(unsigned)(x*131+y);return x/10-y/10;}
int main(void){for(int n=1;n<=64;n++){int a[64];unsigned seed=7;for(int i=0;i<n;i++){seed=seed*1664525u+1013904223u;a[i]=(int)(seed%110u);}qsort(a,n,sizeof *a,cmp);for(int i=0;i<n;i++)digest=digest*33u+(unsigned)a[i];}printf("%u\\n",digest);}`;
  expect(executeProgram('c', source)).toMatchObject({
    kind: 'executed',
    stdout: '3139257128\n',
    uncaughtException: undefined,
  });
});

test('a typed learner prototype permits calls before an extension function definition', () => {
  const source = `#include <string.h>
#include <stdio.h>
size_t strnlen(const char*s,size_t n);size_t length(const char*s){return strnlen(s,3);}size_t strnlen(const char*s,size_t n){return 2;}
int main(void){printf("%zu\\n",length("abc"));}`;
  expect(executeProgram('c', source)).toMatchObject({ kind: 'executed', stdout: '2\n', uncaughtException: undefined });
});

test.each(['x == 1 || y = 5', '-x = 3', 'x + y = 4', 'x ? y : x = 7', '(int)x = 4', '~x = 9', 'x == y = 9'])(
  'unparenthesized assignment cannot replace a higher-precedence operand: %s',
  (expression) => {
    expect(executeProgram('c', `int main(void){int x=1,y=2;int z=${expression};}`).kind).toBe('compileError');
  }
);

test.each([
  'cosnt int N=5;',
  'unsigned1 int g;',
  'foo int f(void){return 1;}',
  'int f(cosnt int a){return a;}',
  'struct S{cosnt int a;};',
  'int a;int *h p=&a;',
  'int f(int a,int b)a{return a+b;}',
  'int f(int x){return x;}int x=f(1,);',
])('unexpanded grammar recovery syntax is rejected: %s', (declaration) => {
  expect(executeProgram('c', `${declaration}\nint main(void){}`).kind).toBe('compileError');
});

test.each([
  'static long random(void){return 7;}',
  'int fileno(int x){return x;}',
  'char *index(int x){return 0;}',
  'int getline(void){return 4;}',
  'size_t strlcpy(char*d,const char*s,size_t n){return n;}',
  'void bzero(void*p,size_t n){}',
])('SDK prototypes, linkage and fortify macros reject incompatible definitions: %s', (definition) => {
  expect(
    executeProgram('c', `#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>\n${definition}\nint main(void){}`)
      .kind
  ).toBe('compileError');
});

test('undefining a fortify macro permits a compatible learner definition', () => {
  const source = `#include <stdio.h>
#include <string.h>
#undef strlcpy
size_t strlcpy(char*d,const char*s,size_t n){return n;}
int main(void){char b[4];printf("%zu\\n",strlcpy(b,"x",sizeof b));}`;
  expect(executeProgram('c', source)).toMatchObject({ kind: 'executed', stdout: '4\n', uncaughtException: undefined });
});

test.each(['void x;', 'struct P p;'])('incomplete file-scope objects are rejected: %s', (declaration) => {
  expect(executeProgram('c', `${declaration}int main(void){}`).kind).toBe('compileError');
});

test('compatible local extern and typedef declarations can repeat', () => {
  expect(
    executeProgram('c', 'int x;int main(void){extern int x;extern int x;typedef int T;typedef int T;T n=1;x=n;}')
  ).toMatchObject({ kind: 'executed', uncaughtException: undefined });
});

test('block includes introduce typedefs locally without leaking them to later functions', () => {
  expect(executeProgram('c', 'int main(void){\n#include <stddef.h>\nsize_t n=1;return (int)n-1;}')).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
  });
  expect(
    executeProgram('c', 'void f(void){\n#include <stddef.h>\nsize_t n=1;}\nint main(void){size_t n=1;}').kind
  ).toBe('compileError');
});

test('extern function declarations retain linkage without leaking lexical visibility', () => {
  expect(executeProgram('c', 'void f(void){int g(void);}int main(void){return g();}int g(void){return 0;}').kind).toBe(
    'compileError'
  );
  expect(
    executeProgram('c', 'void f(void){int g(void);}int g(void){return 0;}int main(void){return g();}')
  ).toMatchObject({ kind: 'executed', uncaughtException: undefined });
});

test('nested C variables retain Java declaration ordering', () => {
  const source = `int main(void){
 int x=4;
 for(int i=0;i<1;i++){
  int t=i;
  x+=t;
 }
}`;
  const trace = traceProgram('c', source, source);
  expect(Object.keys(trace.traceItems.find((item) => item.line === 5)!.vars)).toEqual(['x', 'i', 't']);
});

test.each(['s.a[0]=3;', 'const struct S*p=&s;p->a[0]=3;'])(
  'const array members retain element qualification: %s',
  (write) => {
    expect(executeProgram('c', `struct S{int a[2];};int main(void){const struct S s={{1,2}};${write}}`).kind).toBe(
      'compileError'
    );
  }
);

test('constant folding reads scalar metadata without accessing runtime frames', () => {
  const source = `#include <stdio.h>
const int g=2;int main(void){const int n=1;printf("%d %d %d %d %d %d\\n",!n,n&&2,n||2,-g,~n,n+g);}`;
  expect(executeProgram('c', source)).toMatchObject({
    kind: 'executed',
    stdout: '0 1 1 -2 -2 3\n',
    uncaughtException: undefined,
  });
});

test('math constants initialize static objects and half exponents round without intermediate limits', () => {
  const source = `#include <stdio.h>
#include <math.h>
double a=HUGE_VAL;float b=INFINITY;double c=NAN;int main(void){printf("%g %g %g\\n",a,b,c);printf("%.17g %.17g %.17g %.17g\\n",exp2(600.5),exp2(-600.5),pow(2,-0.5),pow(3,-0.5));}`;
  expect(executeProgram('c', source)).toMatchObject({
    kind: 'executed',
    stdout: 'inf inf nan\n5.8683011947898095e+180 1.7040706787304193e-181 0.70710678118654757 0.57735026918962573\n',
    uncaughtException: undefined,
  });
});

test('suppressed sscanf fields do not count as assignments before input failure', () => {
  const source = `#include <stdio.h>
int main(void){int a;char c;printf("%d %d %d %d\\n",sscanf("5","%*s %d",&a),sscanf("5 x","%*d x %d",&a),sscanf("-5","%*d%c",&c),sscanf("-5 x","%*d %d",&a));}`;
  expect(executeProgram('c', source)).toMatchObject({
    kind: 'executed',
    stdout: '-1 -1 -1 0\n',
    uncaughtException: undefined,
  });
});

test('folded string comparisons apply parameter conversions', () => {
  const source = `#include <stdio.h>
#include <string.h>
int main(void){printf("%d %d\\n",strncmp("aa","ab",1.5),memcmp("aa","ab",1.5));}`;
  expect(executeProgram('c', source)).toMatchObject({
    kind: 'executed',
    stdout: '0 0\n',
    uncaughtException: undefined,
  });
});

test.each(['memset(a,0,-1);', 'strncpy(a,"x",-1);'])(
  'oversized library writes fail within modeled memory: %s',
  (write) => {
    const result = executeProgram('c', `#include <string.h>\nint main(void){char a[4];${write}}`);
    expect(result).toMatchObject({ kind: 'executed' });
    expect(result.kind === 'executed' && result.uncaughtException).toBeDefined();
  }
);

test('aligned allocations honor alignment and reject invalid argument combinations', () => {
  const source = `#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <errno.h>
int main(void){for(int i=0;i<2;i++){void*p=aligned_alloc(64,64);void*q=aligned_alloc(128,128);printf("%lu %lu\\n",(unsigned long)((uintptr_t)p%64),(unsigned long)((uintptr_t)q%128));free(p);free(q);}errno=0;void*p=aligned_alloc(3,64);printf("%d %d\\n",p==0,errno);}`;
  expect(executeProgram('c', source)).toMatchObject({
    kind: 'executed',
    stdout: '0 0\n0 0\n1 22\n',
    uncaughtException: undefined,
  });
});

test('assert inclusion tracks NDEBUG changes and predefined macros share definition lookup', () => {
  const source = `#include <assert.h>
#define NDEBUG
#include <assert.h>
#include <stdio.h>
#if defined(__FILE__) && defined(__LINE__)
#define N 1
#else
#define N 0
#endif
int main(void){assert(0);printf("%d\\n",N);}`;
  expect(executeProgram('c', source)).toMatchObject({ kind: 'executed', stdout: '1\n', uncaughtException: undefined });
});

test('empty pasted arguments preserve neighboring tokens across chains', () => {
  const source = `#include <stdio.h>
#define DECL(prefix,name) int prefix ## name
#define F(x) 100 + x ## 1
#define JOIN(a,b,c) a ## b ## c
int main(void){DECL(,x)=7;int JOIN(,y,)=9;printf("%d %d %d\\n",x,y,F());}`;
  expect(executeProgram('c', source)).toMatchObject({
    kind: 'executed',
    stdout: '7 9 101\n',
    uncaughtException: undefined,
  });
});

test('substring scans spend the run budget across long repetitive inputs', () => {
  const source = `#include <string.h>
int main(void){char text[60000],pattern[30000];memset(text,97,sizeof text);memset(pattern,97,sizeof pattern);text[59999]=0;pattern[29998]=98;pattern[29999]=0;for(int i=0;i<20;i++)strstr(text,pattern);}`;
  expect(executeProgram('c', source)).toEqual({ kind: 'limitExceeded', limit: 'operations' });
});

test('large numeric strings decode without host argument-stack growth', () => {
  const source = `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(void){char a[1000000];memset(a,32,sizeof a);a[0]=49;a[999999]=0;printf("%.0f\\n",strtod(a,0));}`;
  expect(executeProgram('c', source)).toMatchObject({ kind: 'executed', stdout: '1\n', uncaughtException: undefined });
});

test('legacy conversions share platform failure classification without changing successful parsing', () => {
  const source = `#include <stdio.h>
#include <stdlib.h>
#include <errno.h>
int main(void){errno=0;int i=atoi("abc");printf("%d %d ",i,errno);errno=0;long n=atol(" ");printf("%ld %d ",n,errno);errno=0;double f=atof("1e999");printf("%g %d ",f,errno);printf("%d %ld %.1f\\n",atoi("42x"),atol("42x"),atof("3.5x"));}`;
  expect(executeProgram('c', source)).toMatchObject({
    kind: 'executed',
    stdout: '0 22 0 22 inf 34 42 42 3.5\n',
    uncaughtException: undefined,
  });
});

test('temporary record array members share full-expression memory semantics', () => {
  const source = `#include <stdio.h>
struct S{int a[2];char s[3];};struct S make(void){struct S x={{1,2},"hi"};return x;}int sum(const int*a){return a[0]+a[1];}
int main(void){struct S x=make();printf("%d %d %s\\n",make().a[0],sum(make().a),(1?x:x).s);if(make().a[1]==2)puts("yes");for(int i=0;i<make().a[0];i++)printf("%d\\n",i);}`;
  expect(executeProgram('c', source)).toMatchObject({
    kind: 'executed',
    stdout: '1 3 hi\nyes\n0\n',
    uncaughtException: undefined,
  });
});

test('a pointer to a temporary array expires after its initializer full expression', () => {
  const source = `struct S{int a[2];};struct S make(void){struct S s={{1,2}};return s;}int main(void){int*p=make().a;return p[0];}`;
  const result = executeProgram('c', source);
  expect(result).toMatchObject({ kind: 'executed' });
  expect(result.kind === 'executed' && result.uncaughtException).toBeDefined();
});

test('unevaluated extern declarations do not allocate their declared storage', () => {
  const source = `#include <stdio.h>
extern int a[10000000];int main(void){printf("%zu\\n",sizeof a);}`;
  expect(executeProgram('c', source)).toMatchObject({
    kind: 'executed',
    stdout: '40000000\n',
    uncaughtException: undefined,
  });
});

test.each([
  'memcpy(&q,&p,4);memcpy((char*)&q+4,(char*)&p+4,4);',
  'memmove(&q,&p,3);memmove((char*)&q+3,(char*)&p+3,5);',
  'for(int i=0;i<8;i++)((unsigned char*)&q)[i]=((unsigned char*)&p)[i];',
  'for(int i=0;i<8;i++){unsigned char b=((unsigned char*)&p)[i];((unsigned char*)&q)[i]=pass(b);}',
  'uintptr_t n=(uintptr_t)p;q=(int*)n;',
  'q=(int*)(uintptr_t)p;',
  'struct N{uintptr_t n;};struct N n={(uintptr_t)p};struct N copy=n;q=(int*)identity(copy.n);',
  'uintptr_t n=(uintptr_t)p;q=(int*)(1?n:0);',
  'uintptr_t n=(uintptr_t)p;q=(int*)(0,n);',
])('pointer identity survives representation copies and integer round trips: %s', (copy) => {
  const source = `#include <stdio.h>
#include <string.h>
#include <stdint.h>
unsigned char pass(unsigned char b){return b;}uintptr_t identity(uintptr_t n){return n;}
int main(void){int a[2][2]={{1,2},{3,4}};int*p=a[0]+2;int*q;${copy}printf("%d\\n",*q);}`;
  const result = executeProgram('c', source);
  expect(result).toMatchObject({ kind: 'executed', stdout: '' });
  expect(result.kind === 'executed' && result.uncaughtException).toBeDefined();
});

test('copied pointer identities distinguish adjacent rows and preserve backward movement', () => {
  const source = `#include <stdio.h>
#include <stdint.h>
int main(void){int a[2][2]={{1,2},{3,4}};int*p=a[0]+2;int*q=(int*)(uintptr_t)p;--q;int*r=(int*)(uintptr_t)a[1];printf("%d %d\\n",*q,*r);}`;
  expect(executeProgram('c', source)).toMatchObject({
    kind: 'executed',
    stdout: '2 3\n',
    uncaughtException: undefined,
  });
});

test('memchr stops at a valid match before inaccessible or uninitialized trailing bytes', () => {
  const source = `#include <stdio.h>
#include <string.h>
int main(void){char a[2]={1,2};char b[3];b[0]=7;printf("%ld %ld\\n",(char*)memchr(a,2,100)-a,(char*)memchr(b,7,3)-b);}`;
  expect(executeProgram('c', source)).toMatchObject({
    kind: 'executed',
    stdout: '1 0\n',
    uncaughtException: undefined,
  });
});

test('integer overflow scanning retains the end pointer with bounded arithmetic', () => {
  const source = `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
int main(void){char a[300001];memset(a,57,300000);a[300000]=0;char*end;errno=0;long n=strtol(a,&end,10);printf("%ld %d %ld\\n",n,errno,end-a);}`;
  expect(executeProgram('c', source)).toMatchObject({
    kind: 'executed',
    stdout: '9223372036854775807 34 300000\n',
    uncaughtException: undefined,
  });
});

test.each(['isascii', 'toascii', 'digittoint', 'isnumber', 'ishexnumber', 'isrune'])(
  'SDK inline definitions cannot be replaced: %s',
  (name) => {
    expect(executeProgram('c', `#include <ctype.h>\nint ${name}(int c){return 1;}int main(void){}`).kind).toBe(
      'compileError'
    );
  }
);

test.each([
  'int main(void){int h(void);return h();}static int h(void){return 0;}',
  'void f(void){int h(void);}static int h(void){return 0;}int main(void){return h();}',
])('block declarations and file declarations share function linkage checks: %s', (source) => {
  expect(executeProgram('c', source).kind).toBe('compileError');
});

test.each([
  'n+0',
  '0+n',
  'n-0',
  'n*1',
  'n/1',
  'n|0',
  'n^0',
  'n&~(uintptr_t)0',
  'n<<0',
  'n>>0',
  '+n',
  '-(-n)',
  '~~n',
  '(n+=0)',
  '(n|=0)',
])('integer pointer operations retain origins: %s', (expression) => {
  const source = `#include <stdio.h>
#include <stdint.h>
int main(void){int a[2][2]={{1,2},{3,4}};uintptr_t n=(uintptr_t)(a[0]+2);int*q=(int*)(${expression});printf("%d\\n",*q);}`;
  const result = executeProgram('c', source);
  expect(result).toMatchObject({ kind: 'executed', stdout: '' });
  expect(result.kind === 'executed' && result.uncaughtException).toBeDefined();
});

test('integer pointer arithmetic preserves valid offsets and character representation copies', () => {
  const source = `#include <stdio.h>
#include <stdint.h>
int main(void){int a[2][2]={{1,2},{3,4}};uintptr_t n=(uintptr_t)(a[0]+2);n-=sizeof(int);int*q=(int*)n;int*r;for(int i=0;i<8;i++)((unsigned char*)&r)[i]=((unsigned char*)&q)[i]+0;printf("%d\\n",*r);}`;
  expect(executeProgram('c', source)).toMatchObject({ kind: 'executed', stdout: '2\n', uncaughtException: undefined });
});

test.each([
  'int*p=a[0]+2,*r=a[0]+2,*q;memcpy(&q,&p,4);memcpy((char*)&q+4,(char*)&r+4,4);',
  'int*p=a[0]+2,*q;memcpy(&q,&p,4);p=a[0]+2;memcpy((char*)&q+4,(char*)&p+4,4);',
])('equivalent pointer stores preserve byte reconstruction origins: %s', (copy) => {
  const result = executeProgram(
    'c',
    `#include <stdio.h>\n#include <string.h>\nint main(void){int a[2][2]={{1,2},{3,4}};${copy}printf("%d\\n",*q);}`
  );
  expect(result).toMatchObject({ kind: 'executed', stdout: '' });
  expect(result.kind === 'executed' && result.uncaughtException).toBeDefined();
});

test.each(['strncmp("a","b",1e300)', 'memcmp("a","b",0.0/0.0)'])(
  'invalid comparison counts stay inside the runtime boundary: %s',
  (call) => {
    const result = executeProgram('c', `#include <string.h>\nint main(void){return ${call};}`);
    expect(result).toMatchObject({ kind: 'executed' });
    expect(result.kind === 'executed' && result.uncaughtException).toBeDefined();
  }
);

test.each(['isascii', 'isalpha', 'digittoint'])('SDK inline definitions reject either inclusion order: %s', (name) => {
  expect(executeProgram('c', `int ${name}(int c){return 1;}\n#include <ctype.h>\nint main(void){}`).kind).toBe(
    'compileError'
  );
});

test('postfix updates bind before unary operators in values, members and pointers', () => {
  const source = `#include <stdio.h>
struct S{int x;};int main(void){int b=3;int a=-b++;int c=!b--;int d=~b++;int e=+b++;struct S s={7};struct S*p=&s;int f=-s.x++;int g=-p->x--;printf("%d %d %d %d %d %d %d %d\\n",a,b,c,d,e,f,g,s.x);}`;
  expect(executeProgram('c', source)).toMatchObject({
    kind: 'executed',
    stdout: '-3 5 0 -4 4 -7 -8 7\n',
    uncaughtException: undefined,
  });
  expect(executeProgram('c', 'int main(void){int x=1;(-x)++;}').kind).toBe('compileError');
});

test('float powers retain Apple rounding near halfway results', () => {
  const source = `#include <stdio.h>
#include <math.h>
int main(void){for(int k=0;k<8;k++){volatile float x=1+(2*k+1)/8388608.0f;volatile float y=0.5f;printf("%a %a\\n",powf(x,y),sqrtf(x));}}`;
  expect(executeProgram('c', source)).toMatchObject({
    kind: 'executed',
    stdout:
      '0x1.000002p+0 0x1p+0\n0x1.000004p+0 0x1.000002p+0\n0x1.000006p+0 0x1.000004p+0\n0x1.000008p+0 0x1.000006p+0\n0x1.00000ap+0 0x1.000008p+0\n0x1.00000cp+0 0x1.00000ap+0\n0x1.00000ep+0 0x1.00000cp+0\n0x1.00001p+0 0x1.00000ep+0\n',
    uncaughtException: undefined,
  });
});

test.each(['int*q=p;q+=zero;', 'int*q=(int*)((uintptr_t)p+zero);'])(
  'pointer-bearing results retain their origin when offsets were pointer differences: %s',
  (operation) => {
    const source = `#include <stdio.h>\n#include <stdint.h>\nint main(void){int a[2][2]={{1,2},{3,4}};int*p=a[0]+2;uintptr_t m=(uintptr_t)a[1];uintptr_t zero=m-m;${operation}printf("%d\\n",*q);}`;
    const result = executeProgram('c', source);
    expect(result).toMatchObject({ kind: 'executed', stdout: '' });
    expect(result.kind === 'executed' && result.uncaughtException).toBeDefined();
  }
);

test.each(['b=(b^1)^1;', 'b=(b+1)-1;', 'b++;b--;', 'b+=1;b-=1;'])(
  'pointer bytes retain their origins through reversible integer transforms: %s',
  (transform) => {
    const source = `#include <stdio.h>\nint main(void){int a[2][2]={{1,2},{3,4}};int*p=a[0]+2,*q;for(int i=0;i<8;i++){unsigned char b=((unsigned char*)&p)[i];${transform}((unsigned char*)&q)[i]=b;}printf("%d\\n",*q);}`;
    const result = executeProgram('c', source);
    expect(result).toMatchObject({ kind: 'executed', stdout: '' });
    expect(result.kind === 'executed' && result.uncaughtException).toBeDefined();
  }
);

test.each(['sizeof(int)n', 'sizeof(int)4', 'sizeof(int)(n)'])(
  'sizeof rejects unparenthesized casts: %s',
  (expression) => {
    expect(executeProgram('c', `int main(void){int n=3;return ${expression};}`).kind).toBe('compileError');
  }
);

test.each([
  'int default=1;',
  'double float=2.5;',
  'int f(int double){return 0;}',
  'struct S{int while;};',
  'int goto(void){return 0;}',
])('keywords cannot become contextual identifiers: %s', (declaration) => {
  expect(executeProgram('c', `${declaration}int main(void){}`).kind).toBe('compileError');
});

test('header merge diagnostics point at the include without mutating cached header locations', () => {
  for (const padding of [2, 5]) {
    const source = `int isascii(int c){return 1;}\n${'\n'.repeat(padding)}#include <ctype.h>\nint main(void){}`;
    expect(executeProgram('c', source)).toMatchObject({ kind: 'compileError', diagnostics: [{ row: padding + 1 }] });
  }
});

test('ordinary scalar arithmetic remains inside the execution budget', () => {
  const source = `#include <stdio.h>
int main(void){int n=740;long total=0;for(int i=1;i<=n;i++){for(int j=1;j<=n;j++){total+=(i*j+i/j-j%i)*(i^j)+((i<<1)|(j>>1))-(total%7);}}printf("%ld\\n",total);}`;
  expect(executeProgram('c', source)).toMatchObject({
    kind: 'executed',
    stdout: '37534503955344\n',
    uncaughtException: undefined,
  });
});

test.each([
  '\u0085',
  '\u00A0',
  '\u1680',
  '\u180E',
  '\u2000',
  '\u2003',
  '\u200A',
  '\u2028',
  '\u2029',
  '\u202F',
  '\u205F',
  '\u3000',
])('Clang Unicode whitespace separates tokens: %j', (space) => {
  expect(
    executeProgram(
      'c',
      `#include <stdio.h>\nint main(void){int${space}変数=1;int y${space}=2;printf("%d\\n",変数${space}+${space}y);}`
    )
  ).toMatchObject({ kind: 'executed', stdout: '3\n', uncaughtException: undefined });
});

test('leading BOM and supplementary C17 identifier characters are accepted', () => {
  expect(executeProgram('c', '\uFEFF#include <stdio.h>\nint main(void){int 😀=7;printf("%d\\n",😀);}')).toMatchObject({
    kind: 'executed',
    stdout: '7\n',
    uncaughtException: undefined,
  });
  expect(executeProgram('c', 'int ☃=1;int main(void){}').kind).toBe('compileError');
});

test('preprocessor integer candidates use intmax widths before choosing signedness', () => {
  expect(
    executeProgram(
      'c',
      `#include <stdio.h>
#if 0xffffffff < -1
#define A 1
#else
#define A 0
#endif
#if ~037777777777 < 0
#define B 1
#else
#define B 0
#endif
#if 0xffffffffU < -1
#define C 1
#else
#define C 0
#endif
int main(void){printf("%d %d %d\\n",A,B,C);}`
    )
  ).toMatchObject({ kind: 'executed', stdout: '0 1 1\n', uncaughtException: undefined });
});

test.each(['object', 'function'])('macro expansion obeys the operation budget: %s', (form) => {
  const definitions = Array.from({ length: 24 }, (_, i) =>
    form === 'object' ? `#define M${i} M${i + 1} M${i + 1}` : `#define M${i}(x) M${i + 1}(x) M${i + 1}(x)`
  );
  const source = `${definitions.join('\n')}\n#define M24${form === 'function' ? '(x) x' : ' 1'}\nint main(void){int x=M0${form === 'function' ? '(1)' : ''};}`;
  expect(executeProgram('c', source)).toEqual({ kind: 'limitExceeded', limit: 'operations' });
});

test.each(['sizeof(Node)(n)', 'sizeof(Node)(n)(n)', 'sizeof(Node)(a)[0]'])(
  'sizeof cannot silently discard a typedef postfix operand: %s',
  (expression) => {
    expect(executeProgram('c', `typedef char Node;int main(void){int n=2,a[2];long size=${expression};}`).kind).toBe(
      'compileError'
    );
  }
);

test.each([
  ['(T)(b)++', '4 5'],
  ['(T)(a)[0]++', '1 4'],
  ['(T)(p)->x', '7 4'],
  ['(T)(s).x', '7 4'],
  ['(T)(a)[1]', '2 4'],
  ['(T)(f)(3)', '6 4'],
  ['((T)(b))++', undefined],
])('postfix chains bind inside recovered typedef casts: %s', (expression, expected) => {
  const result = executeProgram(
    'c',
    `#include <stdio.h>
typedef long T;struct S{int x;};int f(int n){return n*2;}
int main(void){int b=4,a[2]={1,2};struct S s={7},*p=&s;long r=${expression};printf("%ld %d",r,b);}`
  );
  if (expected === undefined) expect(result.kind).toBe('compileError');
  else expect(result).toMatchObject({ kind: 'executed', stdout: expected, uncaughtException: undefined });
});

test.each([
  ['int main(void){\nint i=0;\nprintf("a")\ni=1;\n}', 2],
  ['int main(void){\nint i=0;\nprintf("a")\nputs("b");\n}', 2],
  ['int main(void){\nint i=0;\ni++\ni++;\n}', 2],
  ['int main(void){\nif(1>0\n{ return 0; }\n}', 2],
  ['int f(int a,int b\n{ return a+b; }\nint main(void){}', 1],
  ['int main(void){\nint a[2];\nreturn a[1\n;\n}', 3],
  ['int main(void){\ndo {}\nputs("a");\n}', 2],
  ['void f(void){\nputs("a");\nint main(void){\nreturn 0;\n}\n', 2],
  ['int main(void){\nfor(int i=0;i<3;i++) puts("a");\n}\nreturn 0;\n}', 3],
  ['int main(void){}\nprintf("a");\n}', 1],
])('syntax recovery points at the line clang diagnoses: %s', (body, row) => {
  expect(executeProgram('c', `#include <stdio.h>\n${body}`)).toMatchObject({
    kind: 'compileError',
    diagnostics: [expect.objectContaining({ row: row + 1 })],
  });
});

test.each(['k^(k^b)', 'k+(b-k)', '(b+k)-k', '(b^k)^k'])(
  'mixed byte origins retain reversible pointer representations: %s',
  (expression) => {
    const result = executeProgram(
      'c',
      `#include <stdio.h>
int main(void){int a[2][2]={{1,2},{3,4}};int*p=a[0]+2,*m=a[0],*q;
for(int i=0;i<8;i++){unsigned char b=((unsigned char*)&p)[i],k=((unsigned char*)&m)[i];((unsigned char*)&q)[i]=${expression};}printf("%d",*q);}`
    );
    expect(result).toMatchObject({ kind: 'executed', stdout: '', uncaughtException: expect.any(String) });
  }
);

test.each(['m^m', 'm&0', 'm%1', 'm-m', '(m^m)+4', '(m^m)-4'])(
  'transformed pointer integers act as offsets: %s',
  (offset) => {
    const shifted = offset.endsWith('+4')
      ? 'a[0]+1'
      : offset.endsWith('-4')
        ? '(int*)((uintptr_t)(a[0]+2)+4)'
        : 'a[0]+2';
    const result = executeProgram(
      'c',
      `#include <stdio.h>
#include <stdint.h>
int main(void){int a[2][2]={{1,2},{3,4}};uintptr_t p=(uintptr_t)(${shifted}),m=(uintptr_t)a[1];int*q=(int*)(p+(${offset}));printf("%d",*q);}`
    );
    expect(result).toMatchObject({ kind: 'executed', stdout: '', uncaughtException: expect.any(String) });
  }
);

test('mixed integer transformations can restore either pointer representation', () => {
  expect(
    executeProgram(
      'c',
      `#include <stdio.h>
#include <stdint.h>
int main(void){int a[2][2]={{1,2},{3,4}};uintptr_t p=(uintptr_t)&a[0][0],m=(uintptr_t)&a[1][0];uintptr_t n=m^(m^p);printf("%d",*(int*)n);}`
    )
  ).toMatchObject({ kind: 'executed', stdout: '1', uncaughtException: undefined });
});

test('ordinary arithmetic retains its operation budget after pointer declarations', () => {
  const expression = '(i*j+i/j-j%i)*(i^j)+((i<<1)|(j>>1))-(total%7)';
  expect(
    executeProgram(
      'c',
      `#include <stdio.h>
int main(void){int arr[4];int*p=arr;char*s="abc";long total=0;for(int i=1;i<=700;i++)for(int j=1;j<=700;j++){total+=${expression}+${expression}+${expression}+${expression};}printf("%ld",total);}`
    )
  ).toMatchObject({ kind: 'executed', stdout: '121453674519304', uncaughtException: undefined });
});

test.each(['m+(p-m)', '(p+m)-m'])('additive pointer origins cancel across calls and byte copies: %s', (expression) => {
  for (const end of [false, true]) {
    const result = executeProgram(
      'c',
      `#include <stdio.h>
#include <stdint.h>
#include <string.h>
uintptr_t save(uintptr_t n){uintptr_t copy;memcpy(&copy,&n,sizeof copy);return copy;}
int main(void){int a[2][2]={{1,2},{3,4}};uintptr_t p=(uintptr_t)(a[0]+${end ? 2 : 0}),m=(uintptr_t)a[1];uintptr_t n=save(${expression});printf("%d",*(int*)n);}`
    );
    expect(result).toMatchObject({
      kind: 'executed',
      stdout: end ? '' : '1',
      uncaughtException: end ? expect.any(String) : undefined,
    });
  }
});

test.each([
  ['printf("%d",i', 'return 1;', 3],
  ['s=f(1', 's=5;', 3],
  ['s=(s+1', 's=5;', 3],
  ['int a[3', 's=2;', 3],
  ['int a[3]={1,2,3;', 'return 0;', 2],
  ['do {i++;}', 'puts("x");return 0;', 3],
  ['do {i++;} puts("x");', 'return 0;', 2],
  ['if i>0 {}', 'return 0;', 2],
])('the first failed parse position locates syntax errors: %s / %s', (first, following, row) => {
  const source = `#include <stdio.h>\nint f(int a){return a;}\nint main(void){int i=0,s=0;\n${first}\n${following}\n}`;
  expect(executeProgram('c', source)).toMatchObject({
    kind: 'compileError',
    diagnostics: [expect.objectContaining({ row: row + 1 })],
  });
});

test.each(['return 1;', 'int k=1;', 'if(1){}', 'f(2);', 's+=1;', '}'])(
  'a missing delimiter points at the next token: %s',
  (next) => {
    const source = `int f(int n){return n;}\nint main(void){int s=0;\ns=f(1\n${next}\n}`;
    expect(executeProgram('c', source)).toMatchObject({
      kind: 'compileError',
      diagnostics: [expect.objectContaining({ row: 3 })],
    });
  }
);

test.each([
  ['s=f(1', 3],
  ['s=a[1', 3],
  ['int b[2]={1', 3],
  ['s=f(1)', 2],
  ['do {s++;}', 3],
])('recovery location is independent of the following statement kind: %s', (first, row) => {
  for (const next of ['return 1;', 'int k=1;', 'if(1){}', 'f(2);', 's+=1;', '}']) {
    const source = `int f(int n){return n;}\nint main(void){int s=0,a[2];\n${first}\n${next}\n}`;
    expect(executeProgram('c', source)).toMatchObject({
      kind: 'compileError',
      diagnostics: [expect.objectContaining({ row })],
    });
  }
});

test.each(['typedef int T;T (*fp)(T);', 'typedef struct{int x;} S;S g(void);', 'int values[3]={1,2,3};'])(
  'valid ambiguous prefixes do not change a later syntax-error location: %s',
  (prefix) => {
    expect(executeProgram('c', `${prefix}int main(void){\nint 変数=0;\n変数=(変数+1\nreturn 0;\n}`)).toMatchObject({
      kind: 'compileError',
      diagnostics: [expect.objectContaining({ row: 3 })],
    });
  }
);

test.each([
  'int n=sizeof(arr)/sizeof(arr[0])\ns=5;',
  's=sizeof(arr)\nreturn 1;',
  's=(i)\ns=5;',
  's=(int)(i)\nint k=1;',
  's=(i)+(s)\ns=5;',
  's=i\n1;',
  'i++\n2.5;',
  's=(i)\nL:s=1;',
])('semicolon diagnostics are independent of cast ambiguity and recovery choice: %s', (body) => {
  const source = `int main(void){\nint i=0,s=0,arr[3];\n${body}\nreturn 0;\n}`;
  expect(executeProgram('c', source)).toMatchObject({
    kind: 'compileError',
    diagnostics: [expect.objectContaining({ row: 2 })],
  });
});

test('a bare return without its semicolon points at the unexpected closing brace', () => {
  expect(executeProgram('c', 'int main(void){\nreturn\n}')).toMatchObject({
    kind: 'compileError',
    diagnostics: [expect.objectContaining({ row: 2 })],
  });
});

test.each([
  ['s=i\n++s;', 3],
  ['i++\n++n;', 3],
  ['n=0\n--n;', 3],
  ['s=i\n(void)s;', 3],
  ['n=sizeof(arr)/sizeof(arr[0])\n++s;', 3],
  ['s=sizeof(int)\ns=2;', 2],
  ['char*msg="hi"\nprintf("%s",msg);', 2],
  ['char*msg="hi"\ns=5;', 2],
  ['int count=sizeof(arr)/sizeof(arr[0])\nL:s=1;', 2],
  ['s=i\n(s);', 3],
  ['s=i\n*p;', 3],
  ['s=(i)\n++s;', 3],
])('diagnostics use consumed tokens and scoped C names: %s', (body, row) => {
  const source = `#include <stdio.h>\nint main(void){int i=1,s=0,n=0,arr[3]={1,2,3};int*p=&i;\n${body}\nreturn 0;\n}`;
  expect(executeProgram('c', source)).toMatchObject({
    kind: 'compileError',
    diagnostics: [expect.objectContaining({ row })],
  });
});

test('scoped reparsing preserves ordinary values, array sizes and expression precedence', () => {
  expect(
    executeProgram(
      'c',
      `#include <stdio.h>
int main(void){int i=1,s=4,a[3]={2,3,4};int*p=a;printf("%d %zu %d",(i)+(s)*2,sizeof(a),*(p+(i)));}`
    )
  ).toMatchObject({ kind: 'executed', stdout: '9 12 3', uncaughtException: undefined });
});

test.each([
  ['typedef int T;', 's=sizeof(T)\n++s;', 2],
  ['typedef int T;', 's=sizeof(T)\n(s);', 2],
  ['typedef int T;', 'int T=1;s=sizeof(T)\n++s;', 3],
  ['', '++i\n++s;', 2],
  ['', 'p=&i\n++s;', 2],
  ['', 'char msg[4]="hi"\n(s);', 3],
  ['', 's=(i)+(s)\n*p;', 3],
])('C type names and non-lvalues keep their own diagnostic locations: %s %s', (prefix, body, row) => {
  const source = `#include <stdio.h>\n${prefix}int main(void){int i=1,s=0;int*p=&i;\n${body}\nreturn 0;\n}`;
  expect(executeProgram('c', source)).toMatchObject({
    kind: 'compileError',
    diagnostics: [expect.objectContaining({ row })],
  });
});

test.each([
  's=sizeof(int)\nT v=2;',
  's=sizeof(int)\nT a[2];',
  's=sizeof(T)\nenum E{A}e;',
  's=sizeof(struct P)\nT v=2;',
  'char*m="x"\nPT*w=&st;',
  's=sizeof(int)\nPT*w=&st;',
])('declarations after complete C types and strings preserve the separator location: %s', (body) => {
  const source = `#include <stdio.h>\ntypedef int T;typedef struct P{int x;}PT;\nint main(void){int s=0;PT st={1};\n${body}\nreturn 0;\n}`;
  expect(executeProgram('c', source)).toMatchObject({
    kind: 'compileError',
    diagnostics: [expect.objectContaining({ row: 3 })],
  });
});

test.each([
  's=sizeof(int)\nint a[2]={1,2};',
  's=sizeof(int)\nint v={2};',
  's=sizeof(int)\nPT w={2};',
  's=sizeof(T)\nint m[2][2]={{1,2},{3,4}};',
  's=(int)sizeof(int)\nstruct P q={1};',
  's=sizeof(int*)\nenum{A,B}e;',
  's=sizeof(struct P)\nint a[2]={1,2};',
])('lexical type boundaries survive following brace initializers: %s', (body) => {
  const source = `#include <stdio.h>\ntypedef int T;typedef struct P{int x;}PT;\nint main(void){int s=0;\n${body}\nreturn 0;\n}`;
  expect(executeProgram('c', source)).toMatchObject({
    kind: 'compileError',
    diagnostics: [expect.objectContaining({ row: 3 })],
  });
});

test.each([
  'struct P{int x;}',
  'union U{int x;float y;}',
  'enum E{A,B}',
  'struct P{int x;}v',
  'int *gp',
  'unsigned long gu',
  'int (*gfp)(int)',
  'int g(int b)',
])('file-scope declarations retain their terminator location: %s', (head) => {
  for (const tail of ['int main(void){return 0;}', 'int g;', 'const int g=1;', 'T g=1;', 'T*p;', 'typedef int T2;']) {
    expect(executeProgram('c', `typedef int T;\n${head}\n${tail}`)).toMatchObject({
      kind: 'compileError',
      diagnostics: [expect.objectContaining({ row: 1 })],
    });
  }
});

test('a tag definition can typedef its own type without a second base type', () => {
  expect(executeProgram('c', 'struct P{int x;} typedef P;int main(void){P p={1};return p.x-1;}')).toMatchObject({
    kind: 'executed',
    uncaughtException: undefined,
  });
});

test('typedef specifiers retain every type word across storage-class specifiers', () => {
  expect(
    executeProgram(
      'c',
      '#include <stdio.h>\nint typedef long T;int main(void){T x=4294967296L;printf("%zu %ld",sizeof(T),x);}'
    )
  ).toMatchObject({
    kind: 'executed',
    stdout: '8 4294967296',
    uncaughtException: undefined,
  });
  expect(executeProgram('c', 'int typedef\nfloat T;int main(void){return 0;}')).toMatchObject({
    kind: 'compileError',
    diagnostics: [expect.objectContaining({ row: 1 })],
  });
});

test.each([
  'unsigned long n',
  'long n',
  'unsigned n',
  'char *p',
  'int (*fp)(int)',
  'int local(int a)',
  'struct L{int x;}',
  'union L{int x;}',
  'enum L{A,B}',
])('local declarations keep their boundary before statements: %s', (head) => {
  for (const tail of ['if(s)s=2;', 'return 1;', 'struct M{int y;};', 'switch(s){case 1:break;}']) {
    expect(executeProgram('c', `#include <stdio.h>\nint main(void){int s=0;\n${head}\n${tail}\n}`)).toMatchObject({
      kind: 'compileError',
      diagnostics: [expect.objectContaining({ row: 2 })],
    });
  }
});

test('a multiline local tag definition reports its closing brace when its terminator is missing', () => {
  expect(executeProgram('c', 'int main(void){\nstruct L{\nint x;\n}\nstruct M{int y;};\n}')).toMatchObject({
    kind: 'compileError',
    diagnostics: [expect.objectContaining({ row: 3 })],
  });
});

test('a nested function definition points at its opening brace', () => {
  expect(executeProgram('c', 'int main(void){\nint local(int a)\n{return a;}\n}')).toMatchObject({
    kind: 'compileError',
    diagnostics: [expect.objectContaining({ row: 2 })],
  });
});

test('a function-pointer variable needs a semicolon before a following block', () => {
  expect(executeProgram('c', 'int main(void){\nint (*fp)(int)\n{}\n}')).toMatchObject({
    kind: 'compileError',
    diagnostics: [expect.objectContaining({ row: 1 })],
  });
});

test.each(['while(0){}', 'enum E{A}e;'])('a value call before %s keeps its expression boundary', (tail) => {
  expect(executeProgram('c', `int f(int n){return n;}int main(void){int i=1;\nf(i)\n${tail}\n}`)).toMatchObject({
    kind: 'compileError',
    diagnostics: [expect.objectContaining({ row: 1 })],
  });
});

test.each([
  'char *(*fp)(const char*)',
  'int *(*fp)(void)',
  'void *(*fp)(void*)',
  'T *(*fp)(T)',
  'int *(*fp[2])(void)',
  'int *local(void)',
  'struct P{int x;}*(*fp)(void)',
  'int *(*(*fp)(void))[3]',
])('pointer-returning declarators cannot consume the following statement: %s', (head) => {
  const source = (separator: string): string =>
    `#include <stdio.h>\ntypedef int T;\nint main(void){\n${head}${separator}\nputs("kept");\n}`;
  expect(executeProgram('c', source(''))).toMatchObject({
    kind: 'compileError',
    diagnostics: [expect.objectContaining({ row: 3 })],
  });
  expect(executeProgram('c', source(';'))).toMatchObject({
    kind: 'executed',
    stdout: 'kept\n',
    uncaughtException: undefined,
  });
});

test('parameter annotation calls are rejected instead of discarded', () => {
  expect(executeProgram('c', 'int f(int x\njunk(1)){return x;}int main(void){return 0;}')).toMatchObject({
    kind: 'compileError',
    diagnostics: [expect.objectContaining({ row: 1 })],
  });
});

test.each([
  '(b^k)^k',
  'k^(k^b)',
  'k+(b-k)',
  '(b+k)-k',
  '((b^k)+19-19)^k',
  '((b+k)^91^91)-k',
  '(b|k)+(b&k)-k',
  '(b^k)+2*(b&k)-k',
  '2*(b|k)-(b^k)-k',
  '((b|k)^(b&k))^k',
])('equal pointer representations retain the source byte origin: %s', (expression) => {
  for (const end of [false, true]) {
    const source = `#include <stdio.h>\n#include <string.h>\nunsigned char pass(unsigned char n){unsigned char copy;memcpy(&copy,&n,1);return copy;}\nint main(void){int a[2][2]={{1,2},{3,4}};int*p=${end ? 'a[0]+2' : 'a[1]'},*m=${end ? 'a[1]' : 'a[0]+2'},*q;for(int i=0;i<8;i++){unsigned char b=((unsigned char*)&p)[i],k=((unsigned char*)&m)[i];((unsigned char*)&q)[i]=pass(${expression});}printf("%d",*q);}`;
    expect(executeProgram('c', source)).toMatchObject({
      kind: 'executed',
      stdout: end ? '' : '3',
      uncaughtException: end ? expect.any(String) : undefined,
    });
  }
});

test.each(['(p^m)^m', 'm^(m^p)', 'm+(p-m)', '(p+m)-m', '~~((p^m)^m)'])(
  'equal pointer representations retain integer origins through copies: %s',
  (expression) => {
    for (const end of [false, true]) {
      const source = `#include <stdio.h>\n#include <stdint.h>\n#include <string.h>\nuintptr_t pass(uintptr_t n){uintptr_t copy;memcpy(&copy,&n,8);return copy;}\nint main(void){int a[2][2]={{1,2},{3,4}};uintptr_t p=(uintptr_t)(${end ? 'a[0]+2' : 'a[1]'}),m=(uintptr_t)(${end ? 'a[1]' : 'a[0]+2'}),n=pass(${expression});int*q;memcpy(&q,&n,8);printf("%d",*q);}`;
      expect(executeProgram('c', source)).toMatchObject({
        kind: 'executed',
        stdout: end ? '' : '3',
        uncaughtException: end ? expect.any(String) : undefined,
      });
    }
  }
);

test.each([
  '(p|m)+(p&m)-m',
  '(p^m)+2*(p&m)-m',
  '2*(p|m)-(p^m)-m',
  '((p|m)^(p&m))^m',
  '(p|m)-m+(p&m)',
  '(p^m)+(p&m)+(m&p)-m',
])('linear Boolean reconstruction preserves pointer bounds: %s', (expression) => {
  for (const end of [false, true])
    for (const aux of ['a[0]', 'a[1]', 'a[0]+2'])
      for (const copy of [false, true]) {
        const source = `#include <stdio.h>\n#include <stdint.h>\n#include <string.h>\nint main(void){int a[2][2]={{1,2},{3,4}};uintptr_t p=(uintptr_t)(${end ? 'a[0]+2' : 'a[1]'}),m=(uintptr_t)(${aux});int*q;${copy ? `uintptr_t n=${expression};memcpy(&q,&n,8);` : `q=(int*)(${expression});`}printf("%d",*q);}`;
        expect(executeProgram('c', source)).toMatchObject({
          kind: 'executed',
          stdout: end ? '' : '3',
          uncaughtException: end ? expect.any(String) : undefined,
        });
      }
});
