import { expect, test } from 'vitest';

import { executeProgram, traceProgram } from '../../src/interpreter/program';

test.each([String.raw`'\u00e9'`, String.raw`'\U0001F600'`, "'é'"])(
  'non-ASCII characters cannot be represented by ordinary character constants: %s',
  (literal) => {
    expect(executeProgram('c', `int main(void) { int c=${literal}; return c; }`)).toMatchObject({
      kind: 'compileError',
    });
  }
);

test('ASCII multicharacter constants and byte escapes retain their values', () => {
  expect(
    executeProgram(
      'c',
      String.raw`#include <stdio.h>
int main(void) { printf("%d %d %s",'ab','\xE9',"\u00e9"); }`
    )
  ).toMatchObject({ kind: 'executed', stdout: '24930 -23 é', uncaughtException: undefined });
});

test('typeof declarations do not require definitions for unevaluated references', () => {
  expect(
    executeProgram(
      'c',
      `#include <stdio.h>
int f(void); extern int value;
__typeof__(f()) x=0; __typeof__(value) y=0;
int main(void) { printf("%d %d",x,y); }`
    )
  ).toMatchObject({ kind: 'executed', stdout: '0 0', uncaughtException: undefined });
});

test('alignment queries discard array-bound effects and sizeof evaluates only VLA operands', () => {
  expect(
    executeProgram(
      'c',
      `#include <stdio.h>
int calls;
int count(void) { calls++; return 3; }
int main(void) {
 int n=3;
 unsigned long alignment=_Alignof(int[n++]);
 unsigned long other=_Alignof(int[count()]);
 int x=1;
 int a[2][n]; int (*p)[n]=a;
 unsigned long bytes=sizeof *p++;
 int fixed[2][3]; int (*q)[3]=fixed;
 unsigned long fixedBytes=sizeof *q++;
 printf("%lu %lu %d %d %lu %ld %lu %ld",alignment,other,n,calls,bytes,p-a,fixedBytes,q-fixed);
}`
    )
  ).toMatchObject({ kind: 'executed', stdout: '4 4 3 0 12 1 12 0', uncaughtException: undefined });
});

test('multiple alignment specifiers retain the strictest request for objects and members', () => {
  expect(
    executeProgram(
      'c',
      `#include <stdio.h>
#include <stdint.h>
struct S { _Alignas(64) _Alignas(8) int x; };
_Alignas(64) _Alignas(0) _Alignas(8) int global;
int main(void) {
 _Alignas(64) _Alignas(8) int local;
 printf("%zu %zu %d %d",_Alignof(struct S),sizeof(struct S),(int)((uintptr_t)&global%64),(int)((uintptr_t)&local%64));
}`
    )
  ).toMatchObject({ kind: 'executed', stdout: '64 64 0 0', uncaughtException: undefined });
});

test('leading attributes on declarations and definitions are accepted', () => {
  expect(
    executeProgram(
      'c',
      `#include <stdio.h>
[[maybe_unused]] int x=3;
[[nodiscard]] static int f(void) { return x; }
int main(void) { [[maybe_unused]] int y=f(); printf("%d",y); }`
    )
  ).toMatchObject({ kind: 'executed', stdout: '3', uncaughtException: undefined });
});

test.each([
  'inline int x=3; int main(void) { return x; }',
  'int main(void) { inline int x=3; return x; }',
  'inline int main(void) { return 0; }',
  'inline typedef int F(void); int main(void) {}',
  'int f(inline int x) { return x; } int main(void) {}',
  'struct S { inline int x; }; int main(void) {}',
])('inline is rejected outside its valid function declarations: %s', (source) => {
  expect(executeProgram('c', source)).toMatchObject({ kind: 'compileError' });
});

test('inline definitions retain linkage from an earlier static declaration', () => {
  expect(
    executeProgram(
      'c',
      `#include <stdio.h>
static inline int f(void); inline int f(void) { return 3; }
int main(void) { printf("%d",f()); }`
    )
  ).toMatchObject({ kind: 'executed', stdout: '3', uncaughtException: undefined });
});

test.each([
  ['long long', '1L'],
  ['double *', '&value'],
])('va_arg rejects incompatible types of the same size: %s', (type, argument) => {
  const result = executeProgram(
    'c',
    `#include <stdarg.h>
int value;
void f(int n,...) { va_list ap; va_start(ap,n); ${type} x=va_arg(ap,${type}); va_end(ap); }
int main(void) { f(1,${argument}); }`
  );
  expect(result.kind).toBe('executed');
  expect(result.kind === 'executed' && result.uncaughtException).toContain('合いません');
});

test('variadic pointer reads preserve evaluated VLA extents and return provenance', () => {
  expect(
    executeProgram(
      'c',
      `#include <stdio.h>
#include <stdarg.h>
int *first(int n,...) { va_list ap; va_start(ap,n); int *p=va_arg(ap,int*); va_end(ap); return p; }
int main(void) { int n=3; int a[n]; a[0]=9; int m[2][n]; m[1][0]=7;
 printf("%d %d",first(1,a)[0],first(1,m[1])[0]); }`
    )
  ).toMatchObject({ kind: 'executed', stdout: '9 7', uncaughtException: undefined });
  const result = executeProgram(
    'c',
    `#include <stdio.h>
#include <stdarg.h>
int *first(int n,...) { va_list ap; va_start(ap,n); int *p=va_arg(ap,int*); va_end(ap); return p; }
int main(void) { int n=2; int a[2][n]; a[1][0]=7; printf("%d",first(1,a[0]+n)[0]); }`
  );
  expect(result).toMatchObject({ kind: 'executed', stdout: '', uncaughtException: expect.any(String) });
});

test('flexible character members display the text within the allocation', () => {
  const source = `#include <stdlib.h>
#include <string.h>
struct S { int n; char text[]; };
int main(void) { struct S*s=malloc(sizeof(struct S)+4); strcpy(s->text,"abc"); return 0; }`;
  const trace = traceProgram('c', source, source);
  expect(trace.uncaughtException).toBeUndefined();
  expect(trace.traceItems.at(-1)?.referenceVars.s).toMatchObject({
    kind: 'object',
    entries: { text: { kind: 'value', value: 'abc' } },
  });
});

test('time conversions read only their inputs and keep UTC/local result buffers separate', () => {
  expect(
    executeProgram(
      'c',
      `#include <stdio.h>
#include <time.h>
int main(void) {
 struct tm t; t.tm_year=126;t.tm_mon=0;t.tm_mday=1;t.tm_hour=0;t.tm_min=0;t.tm_sec=0;t.tm_isdst=0;
 time_t stamp=mktime(&t); printf("%lld %d %d\\n",(long long)stamp,t.tm_wday,t.tm_yday);
 struct tm year; year.tm_year=126; char text[20]; strftime(text,sizeof text,"%Y",&year); puts(text);
 time_t a=0,b=86400*365; struct tm*ga=gmtime(&a); struct tm*lb=localtime(&b);
 printf("%d %d %d",ga->tm_year,lb->tm_year,ga==lb);
}`
    )
  ).toMatchObject({ kind: 'executed', stdout: '1767225600 4 0\n2026\n70 71 0', uncaughtException: undefined });
});

test.each([
  '#pragma pack(1)',
  '_Pragma("pack(push,2)")',
  '#define P "pack(1)"\n_Pragma(P)',
  '#pragma clang fp reassociate(on)',
  '#pragma STDC FENV_ACCESS ON',
])('pragmas with unimplemented semantics are rejected: %s', (pragma) => {
  const result = executeProgram(
    'c',
    `${pragma}\nstruct S { char c; int n; }; int main(void) { return sizeof(struct S); }`
  );
  expect(result.kind).toBe('compileError');
  expect(result.kind === 'compileError' && result.diagnostics[0].message).toContain('この採点環境では使えません');
});

test('diagnostic pragmas and annotation attributes preserve ordinary execution', () => {
  expect(
    executeProgram(
      'c',
      `#include <stdio.h>
#pragma once
#pragma clang diagnostic ignored "-Wunused-variable"
_Pragma("GCC diagnostic ignored \\"-Wunused-variable\\"")
int main(void) { int n __attribute__((annotate("constructor packed"),unused))=3; printf("%d",n); }`
    )
  ).toMatchObject({ kind: 'executed', stdout: '3', uncaughtException: undefined });
});

test.each([
  '__attribute__((constructor)) void f(void) {}',
  '__attribute__((__constructor__)) void f(void) {}',
  '[[gnu::constructor]] void f(void) {}',
  'void f(int*p) {} void g(void) { int x __attribute__((cleanup(f)))=1; }',
])('attributes with unimplemented execution semantics are rejected: %s', (declaration) => {
  const result = executeProgram('c', `${declaration}\nint main(void) {}`);
  expect(result.kind).toBe('compileError');
  expect(result.kind === 'compileError' && result.diagnostics[0].message).toContain('この採点環境では使えません');
});
