import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

test('aggregate ranges consume brace-elided members before copying each target', () => {
  expect(
    executeProgram(
      'c',
      `#include <stdio.h>
struct S { int x,y; };
int main(void) {
 struct S a[2]={[0 ... 1]=1,2};
 int b[][2]={[0 ... 1]=3,4};
 printf("%d %d %d %d %zu %d %d %d %d",a[0].x,a[0].y,a[1].x,a[1].y,sizeof b,b[0][0],b[0][1],b[1][0],b[1][1]);
}`
    )
  ).toMatchObject({ kind: 'executed', stdout: '1 2 1 2 16 3 4 3 4', uncaughtException: undefined });
});

test('bitfield overrides remove only fully replaced initializer effects', () => {
  expect(
    executeProgram(
      'c',
      `#include <stdio.h>
int calls; int mark(int x) { calls++; return x; }
struct S { unsigned x:4,y:4; };
int main(void) {
 struct S a[2]={[0].y=3,[0 ... 1].x=2};
 struct S b={.x=mark(1),.y=mark(2),.x=mark(3)};
 printf("%u %u %u %u %u %u %d",a[0].x,a[0].y,a[1].x,a[1].y,b.x,b.y,calls);
}`
    )
  ).toMatchObject({ kind: 'executed', stdout: '2 3 2 0 3 2 2', uncaughtException: undefined });
});

test('raw-only variadic arguments do not expand invalid macro invocations', () => {
  expect(
    executeProgram(
      'c',
      `#include <stdio.h>
#define BAD(a,b) a
#define TEXT(...) #__VA_ARGS__
#define PASTE(...) prefix ## __VA_ARGS__
int prefixBAD(int x) { return x+1; }
int main(void) { puts(TEXT(BAD(1))); printf("%d",PASTE(BAD(1))); }
`
    )
  ).toMatchObject({ kind: 'executed', stdout: 'BAD(1)\n2', uncaughtException: undefined });
});

test('ISO week formatting reads only year, weekday and year-day', () => {
  expect(
    executeProgram(
      'c',
      `#include <stdio.h>
#include <time.h>
int main(void) {
 struct tm t; t.tm_year=121; t.tm_yday=0; t.tm_wday=5;
 char b[100]; strftime(b,sizeof b,"%G %g %V",&t); puts(b);
}`
    )
  ).toMatchObject({ kind: 'executed', stdout: '2020 20 53\n', uncaughtException: undefined });
});

test('calendar formatting uses its own invalid-name placeholders and ctime updates localtime storage', () => {
  expect(
    executeProgram(
      'c',
      `#include <stdio.h>
#include <time.h>
int main(void) {
 struct tm t={0}; t.tm_year=124; t.tm_mon=12; t.tm_mday=5; t.tm_wday=2; t.tm_hour=13; t.tm_min=4; t.tm_sec=5;
 char text[100]; strftime(text,sizeof text,"%c",&t); puts(text); printf("%s",asctime(&t));
 time_t a=0,b=86400*365; struct tm *local=localtime(&a),*utc=gmtime(&a); char *p=ctime(&b);
 printf("%d %d %s",local->tm_year,utc->tm_year,p);
}`
    )
  ).toMatchObject({
    kind: 'executed',
    stdout: 'Tue ?  5 13:04:05 2024\nTue ???  5 13:04:05 2024\n71 70 Fri Jan  1 00:00:00 1971\n',
    uncaughtException: undefined,
  });
});

test('variably modified queries retain a single tagged type declaration', () => {
  expect(
    executeProgram(
      'c',
      `#include <stdio.h>
int main(void) {
 int n=3; __typeof__((struct S { int x; } (*)[n])0) p=0;
 printf("%zu %zu",sizeof *p,sizeof *(struct T { int x; } (*)[n])0);
}`
    )
  ).toMatchObject({ kind: 'executed', stdout: '12 12', uncaughtException: undefined });
});

test.each(['maybe_unused', 'gnu::unused'])('bracket attributes expand aliases: %s', (attribute) => {
  expect(
    executeProgram(
      'c',
      `#include <stdio.h>
#define ATTR ${attribute}
[[ATTR]] int x=3;
int main(void) { printf("%d",x); }
`
    )
  ).toMatchObject({ kind: 'executed', stdout: '3', uncaughtException: undefined });
});

test.each(['[[gnu::always_inline]]', '__attribute__((always_inline))'])(
  'forced-inlining attributes are explicitly unavailable: %s',
  (attribute) => {
    expect(
      executeProgram('c', `${attribute} inline int f(int x) { return x+1; } int main(void) { return f(2); }`)
    ).toMatchObject({ kind: 'compileError', diagnostics: [{ message: expect.stringContaining('使えません') }] });
  }
);

test.each([
  'int *p[]={(int[600000]){1}}; printf("%d",p[0][0]);',
  'struct H { int *p; }; struct H h[1]={(int[600000]){1}}; printf("%d",h[0].p[0]);',
  'printf("%zu %d",sizeof (int[600000]){1},((int[600000]){1})[0]);',
])('literal discovery does not duplicate or allocate unevaluated objects: %s', (body) => {
  expect(executeProgram('c', `#include <stdio.h>\nint main(void) { ${body} }`)).toMatchObject({
    kind: 'executed',
    stdout: body.includes('sizeof') ? '2400000 1' : '1',
    uncaughtException: undefined,
  });
});

test('array names enter scope before compound-literal initializer inference', () => {
  expect(
    executeProgram(
      'c',
      `#include <stdio.h>
void *a;
int main(void) { void *a[]={(void*[]){a}}; printf("%d",((void**)a[0])[0]==a); }
`
    )
  ).toMatchObject({ kind: 'executed', stdout: '1', uncaughtException: undefined });
});

test('literal discovery retains references for later evaluation without linking query-only references', () => {
  expect(
    executeProgram(
      'c',
      `int missing(void);
int main(void) { int *p[]={(int[]){missing()}}; return p[0][0]; }`
    )
  ).toMatchObject({ kind: 'compileError' });
  expect(
    executeProgram(
      'c',
      `#include <stdio.h>
int missing(void);
int main(void) { printf("%zu",sizeof (int[]){missing()}); }`
    )
  ).toMatchObject({ kind: 'executed', stdout: '4', uncaughtException: undefined });
});
