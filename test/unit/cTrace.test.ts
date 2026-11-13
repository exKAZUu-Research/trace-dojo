import { expect, test } from 'vitest';

import { traceProgram } from '../../src/interpreter/program';

function steps(program: string): { line: number; vars: Record<string, unknown> }[] {
  return traceProgram('c', program, program).traceItems.map(({ line, vars }) => ({ line, vars }));
}

test('a C program records the steps that the Java version of it records', () => {
  const program = `void 二歩前に進める(Turtle *t) { // atomic
  前に進む(t);
  前に進む(t);
}

int main(void) {
  Turtle *亀 = new_turtle();
  int x = 1;
  for (int i = 0; i < 2; i++) {
    x = x * 2;
  }
  二歩前に進める(亀);
  char s[] = "fr";
  char c = s[1];
  return 0;
}`;
  expect(steps(program)).toEqual([
    { line: 0, vars: {} },
    { line: 7, vars: {} },
    { line: 8, vars: { x: 1 } },
    { line: 9, vars: { x: 1, i: 0 } },
    { line: 10, vars: { x: 2, i: 0 } },
    { line: 9, vars: { x: 2, i: 1 } },
    { line: 10, vars: { x: 4, i: 1 } },
    { line: 9, vars: { x: 4, i: 2 } },
    { line: 12, vars: { x: 4 } },
    { line: 13, vars: { x: 4, s: 'fr' } },
    { line: 14, vars: { x: 4, s: 'fr', c: 'r' } },
  ]);
});

test('a function taking a struct pointer first shows its members, as a Java method shows the fields of this', () => {
  const program = `#include <stdlib.h>
typedef struct { Turtle *t; int speed; } MyTurtle;
void speedUp(MyTurtle *m) {
  m->speed++;
}
int main(void) {
  MyTurtle *m1 = malloc(sizeof(MyTurtle));
  m1->t = new_turtle();
  m1->speed = 1;
  speedUp(m1);
  return 0;
}`;
  const trace = traceProgram('c', program, program);
  expect(trace.traceItems.find((item) => item.line === 4)?.vars).toEqual({ 'm->speed': 2 });
  expect(trace.traceItems.find((item) => item.line === 9)?.referenceVars.m1).toEqual({
    kind: 'object',
    entries: {
      t: { kind: 'object', entries: { x: { kind: 'value', value: 0 }, y: { kind: 'value', value: 0 } } },
      speed: { kind: 'value', value: 1 },
    },
  });
});

test('a pointer to rows of a variable-length array shows the rows it reaches', () => {
  const program = `void fill(int rows, int cols, int m[rows][cols]) {
  m[1][0] = 7;
}
int main(void) {
  int rows = 2, cols = 2;
  int m[rows][cols];
  fill(rows, cols, m);
  return 0;
}`;
  const trace = traceProgram('c', program, program);
  // oxlint-disable-next-line unicorn/no-null -- The trace format shows values never written as null.
  const unset = { kind: 'value', value: null };
  expect(trace.traceItems.find((item) => item.line === 2)?.referenceVars.m).toEqual({
    kind: 'array',
    entries: {
      0: { kind: 'array', entries: { 0: unset, 1: unset } },
      1: { kind: 'array', entries: { 0: { kind: 'value', value: 7 }, 1: unset } },
    },
  });
});

test('the references show nested structs, flexible array members, and function pointers, and leave out a va_list', () => {
  const program = `#include <stdarg.h>
#include <stdlib.h>
struct animal { const char *name; };
struct dog { struct animal base; int (*speak)(int); };
struct list { int count; int items[]; };
int twice(int x) { return x * 2; }
int sum(int count, ...) {
  va_list ap;
  va_start(ap, count);
  int total = va_arg(ap, int);
  va_end(ap);
  return total;
}
int main(void) {
  struct dog d = { { "Pochi" }, twice };
  struct list *l = malloc(sizeof(struct list) + 2 * sizeof(int));
  l->count = 2;
  l->items[0] = 5;
  int s = sum(1, 7);
  free(l);
  return 0;
}`;
  const trace = traceProgram('c', program, program);
  // oxlint-disable-next-line unicorn/no-null -- The trace format shows values never written as null.
  const unset = { kind: 'value', value: null };
  const atList = trace.traceItems.find((item) => item.line === 19);
  expect(atList?.referenceVars.d).toEqual({
    kind: 'object',
    entries: {
      base: { kind: 'object', entries: { name: { kind: 'value', value: 'Pochi' } } },
      speak: { kind: 'value', value: 'twice' },
    },
  });
  expect(atList?.referenceVars.l).toEqual({
    kind: 'object',
    entries: {
      count: { kind: 'value', value: 2 },
      items: { kind: 'array', entries: { 0: { kind: 'value', value: 5 }, 1: unset } },
    },
  });
  const inSum = trace.traceItems.filter((item) => item.callLines.length === 1);
  expect(inSum.length).toBeGreaterThan(0);
  for (const item of inSum) expect(Object.keys(item.vars)).not.toContain('ap');
});
