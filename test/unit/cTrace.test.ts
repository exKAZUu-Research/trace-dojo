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
