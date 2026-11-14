import { expect, test } from 'vitest';

import { executeProgram, traceProgram } from '../../src/interpreter/program';

test('compound literals initialize through every access path and remain distinct on the same line', () => {
  const source = `#include <stdio.h>
struct P { int x,y; };
int next;
void show(struct P *p) { printf("%d %d ", p->x, p->y); }
int main(void) {
  show(&(struct P){3,4});
  int *a=(int[]){++next}; int *b=(int[]){++next};
  int x=(int){++next}+1;
  int y=(int){++next}++;
  char *s=(char *){"hi"};
  printf("%d %d %d %d %d %s\\n",*a,*b,x,y,next,s);
}`;
  expect(executeProgram('c', source)).toMatchObject({
    kind: 'executed',
    stdout: '3 4 1 2 4 4 4 hi\n',
    uncaughtException: undefined,
  });
  const trace = traceProgram('c', source, source);
  expect(trace.uncaughtException).toBeUndefined();
  for (const item of trace.traceItems) {
    expect([...Object.keys(item.vars), ...Object.keys(item.referenceVars)].every((name) => !name.includes('\0'))).toBe(
      true
    );
  }
});

test('designated aggregate replacements clear omitted values and nested ranges select every target', () => {
  const source = `#include <stdio.h>
int calls;
int mark(int n) { calls++; return n; }
struct S { int a[3]; char text[5]; };
struct P { int x,y; };
struct B { unsigned x:3, y:2; };
int main(void) {
  struct S s = {.a={mark(1),mark(2)},.a={mark(3)},.text="abcd",.text="x"};
  struct S e = {.a={1,2,3},.a={}};
  printf("%d %d %d %s %d %d\\n",s.a[0],s.a[1],s.a[2],s.text,e.a[1],calls);
  struct P p[3] = {[0 ... 2].x=7,9};
  int m[2][3] = {[0 ... 1][1 ... 2]=4};
  struct B b[3] = {[0 ... 2].x=5,[1].y=3};
  int a[3] = {[0 ... 2]=4,[0]=9};
  printf("%d %d %d %d %d %d %d %d %u %u %u %d %d %d\\n",p[0].x,p[1].x,p[2].x,p[2].y,m[0][0],m[0][1],m[1][1],m[1][2],b[0].x,b[1].x,b[1].y,a[0],a[1],calls);
}`;
  expect(executeProgram('c', source)).toMatchObject({
    kind: 'executed',
    stdout: '3 0 0 x 0 1\n7 7 7 9 0 4 4 4 5 5 3 9 4 1\n',
    uncaughtException: undefined,
  });
});

test.each(['packed', 'aligned(16)'])('attribute wrapper macros cannot hide unsupported layouts: %s', (attribute) => {
  const source = `#define ATTR ${attribute}
#define WRAPPED __attribute__((ATTR))
struct S { char a; int b; } WRAPPED;
int main(void) { return sizeof(struct S); }`;
  const result = executeProgram('c', source);
  expect(result.kind).toBe('compileError');
  expect(result.kind === 'compileError' && result.diagnostics[0].message).toContain('この採点環境では使えません');
});

test('variadic optional tokens use expanded argument emptiness while stringification uses original tokens', () => {
  const source = `#include <stdio.h>
#define EMPTY
#define ALIAS EMPTY
#define F(...) printf("a" __VA_OPT__("b") "\\n")
#define S(...) printf(#__VA_ARGS__ __VA_OPT__("b") "\\n")
int main(void) { F(); F(EMPTY); F(ALIAS); F(x); S(EMPTY); }`;
  expect(executeProgram('c', source)).toMatchObject({
    kind: 'executed',
    stdout: 'a\na\na\nab\nEMPTY\n',
    uncaughtException: undefined,
  });
});

test('empty switch ranges do not match and valid ranges include their endpoints', () => {
  expect(
    executeProgram(
      'c',
      `#include <stdio.h>
int main(void) {
  for(int i=1;i<=5;i++) switch(i) {
    case 5 ... 3: puts("wrong"); break;
    case 1 ... 2: printf("r"); break;
    default: printf("d");
  }
}`
    )
  ).toMatchObject({ kind: 'executed', stdout: 'rrddd', uncaughtException: undefined });
});

test.each([
  'case 3: break; case 1 ... 5: break;',
  'case 1: break; case 1 ... 5: break;',
  'case 5: break; case 1 ... 5: break;',
  'case 1 ... 5: break; case 3: break;',
])('overlapping single cases and ranges are compile errors: %s', (labels) => {
  expect(executeProgram('c', `int main(void) { switch(3) { ${labels} } }`)).toMatchObject({ kind: 'compileError' });
});

test.each(['int a[n];', 'int a[2][n];', 'int (*p)[n];'])('record fields cannot have variable bounds: %s', (field) => {
  expect(executeProgram('c', `int main(void) { int n=3; struct S { ${field} } s; return sizeof s; }`)).toMatchObject({
    kind: 'compileError',
  });
});

test.each([
  'goto L; int a[n]; L: return 0;',
  'goto L; int (*p)[n]; L: return 0;',
  'goto L; typedef int A[n]; L: return 0;',
  'goto L; { int a[n]; L: return 0; }',
  'switch(n) { int a[n]; case 3: break; }',
  'switch(n) { int a[n]; default: break; }',
])('jumps cannot enter the scope of variably modified declarations: %s', (body) => {
  expect(executeProgram('c', `int main(void) { int n=3; ${body} }`)).toMatchObject({ kind: 'compileError' });
});

test('jumps within a VLA scope and jumps out of it remain valid', () => {
  expect(
    executeProgram(
      'c',
      `#include <stdio.h>
int main(void) { int n=2; { int a[n]; a[0]=0;
L: a[0]++; if (a[0]<3) goto L;
printf("%d",a[0]); goto OUT; } OUT: puts(" ok"); }`
    )
  ).toMatchObject({ kind: 'executed', stdout: '3 ok\n', uncaughtException: undefined });
});

test('caller-built time fields outside name tables use Apple libc placeholders', () => {
  expect(
    executeProgram(
      'c',
      `#include <stdio.h>
#include <time.h>
int main(void) {
  struct tm t={0}; t.tm_year=124; t.tm_mon=13; t.tm_mday=5; t.tm_wday=9;
  char b[100]; strftime(b,sizeof b,"%A %B %b %a|",&t); puts(b); printf("%s",asctime(&t));
  t.tm_mon=-1; t.tm_wday=-1; strftime(b,sizeof b,"%a %h",&t); puts(b);
}`
    )
  ).toMatchObject({
    kind: 'executed',
    stdout: '? ? ? ?|\n??? ???  5 00:00:00 2024\n? ?\n',
    uncaughtException: undefined,
  });
});

test('cyclic stack records stop at the first pointer back to the displayed object', () => {
  const source = `struct N { int v; struct N *next; };
int main(void) {
 struct N a={1,0}, b={2,0}; a.next=&b; b.next=&a;
 int done=1;
 return 0;
}`;
  const trace = traceProgram('c', source, source);
  expect(trace.uncaughtException).toBeUndefined();
  expect(trace.traceItems.at(-1)?.referenceVars.a).toEqual({
    kind: 'object',
    entries: {
      v: { kind: 'value', value: 1 },
      next: {
        kind: 'object',
        entries: {
          v: { kind: 'value', value: 2 },
          next: { kind: 'value', value: expect.stringMatching(/^0x[\da-f]+$/) },
        },
      },
    },
  });
});
