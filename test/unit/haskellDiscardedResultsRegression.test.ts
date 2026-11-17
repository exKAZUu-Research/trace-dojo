import { expect, test } from 'vitest';

import { executeProgram, traceProgram } from '../../src/interpreter/program';

const makeTurtle = `make :: Int -> IO Turtle
make y=do
 newTurtleAt 0 y`;
const makeAtomicTurtle = makeTurtle.replace('make y=do', 'make y=do -- atomic');

test.each([
  ['_<-newTurtleAt 0 1', '前に進めるか'],
  ['newTurtleAt 0 1', '前に進めるか'],
  ['_<-newTurtleAt 0 1', 'canMoveForward'],
  ['newTurtleAt 0 1', 'canMoveForward'],
])('discarded turtle results are collected before their statement is recorded: %s %s', (statement, query) => {
  const source = `main=do
 t<-newTurtle
 ${statement}
 b<-${query} t
 print b`;
  const result = traceProgram('haskell', source, source);
  expect(result.stdout).toBe('True\n');
  expect(result.traceItems.find((item) => item.line === 3)?.turtles).toHaveLength(1);
  expect(result.finalTurtles).toHaveLength(1);
  expect(executeProgram('haskell', source)).toMatchObject({
    kind: 'executed',
    stdout: 'True\n',
    finalTurtles: [expect.objectContaining({ x: 0, y: 0 })],
    uncaughtException: undefined,
  });
});

test.each([
  { name: 'named result', statement: 'u<-newTurtleAt 0 1', declarations: '', retained: true },
  {
    name: 'discarded tuple',
    statement: '(_,_)<-do {v<-newTurtleAt 0 1;pure(v,1::Int)}',
    declarations: '',
    retained: false,
  },
  {
    name: 'tuple projection',
    statement: '(_,u)<-do {v<-newTurtleAt 0 1;pure(1::Int,v)}',
    declarations: '',
    retained: true,
  },
  { name: 'discarded helper result', statement: '_<-make 1', declarations: makeTurtle, retained: false },
  { name: 'bare helper call', statement: 'make 1', declarations: makeTurtle, retained: false },
  { name: 'bound helper result', statement: 'u<-make 1', declarations: makeTurtle, retained: true },
  {
    name: 'nested returned result',
    statement: 'u<-do {v<-make 1;pure v}',
    declarations: makeTurtle,
    retained: true,
  },
  {
    name: 'discarded constructor result',
    statement: '_<-do {v<-make 1;pure(Just v)}',
    declarations: makeTurtle,
    retained: false,
  },
  { name: 'discarded atomic result', statement: '_<-make 1', declarations: makeAtomicTurtle, retained: false },
  { name: 'bound atomic result', statement: 'u<-make 1', declarations: makeAtomicTurtle, retained: true },
  {
    name: 'unevaluated discarded result',
    statement: '_<-pure(error "unused"::Turtle)',
    declarations: '',
    retained: false,
  },
])('IO result lifetimes preserve $name', ({ statement, declarations, retained }) => {
  const source = `${declarations}
main=do
 t<-newTurtle
 ${statement}
 b<-前に進めるか t
 print b`;
  const result = traceProgram('haskell', source, source);
  expect(result.stdout).toBe(retained ? 'False\n' : 'True\n');
  expect(result.finalTurtles).toHaveLength(retained ? 2 : 1);
  const execution = executeProgram('haskell', source);
  expect(execution).toMatchObject({
    kind: 'executed',
    stdout: retained ? 'False\n' : 'True\n',
    uncaughtException: undefined,
  });
  if (execution.kind === 'executed') expect(execution.finalTurtles).toHaveLength(retained ? 2 : 1);
});
