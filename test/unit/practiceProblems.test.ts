import { expect, test } from 'vitest';

import { TURTLE_GRAPHICS_BOARD_COLUMNS, TURTLE_GRAPHICS_BOARD_ROWS } from '../../src/constants';
import { instantiateProblem } from '../../src/problems/instantiateProblem';
import { getPracticeProblemIds, practiceDefinitions } from '../../src/problems/practice/definitions';
import { instantiatePracticeProblem } from '../../src/problems/practice/instantiatePracticeProblem';
import { courseIdToLectureIds } from '../../src/problems/problemData';

for (const [courseId, lectureIds] of Object.entries(courseIdToLectureIds)) {
  test.each(lectureIds)(
    `${courseId} / %s offers nine distinct, deterministic, independently executable practice choices`,
    (lectureId) => {
      const ids = getPracticeProblemIds(courseId, lectureId);
      expect(new Set(ids).size).toBe(ids.length);
      for (const seed of ['practice-regression-alpha', 'practice-regression-omega']) {
        const sources = new Set<string>();
        for (const id of ids) {
          const problem = instantiatePracticeProblem(id, 'java', seed);
          expect(problem, id).toBeDefined();
          if (!problem) throw new Error(`Missing practice program: ${id}`);
          sources.add(problem.displayProgram);
          expect(instantiatePracticeProblem(id, 'java', seed)).toEqual(problem);
          expect(instantiateProblem(id, 'java', seed)).toBeUndefined();
          expect(problem.displayProgram).toContain('public static void main');
          expect(problem.displayProgram).not.toMatch(/<\d+-\d+>|【|\/\/\s*step/);
          expect(problem.blankAnswers).toEqual([]);
          expect(problem.traceItems.length).toBeGreaterThan(1);
          expect(problem.traceItems.length).toBeLessThanOrEqual(30);
          const lines = problem.displayProgram.split('\n');
          for (const item of problem.traceItems) {
            if (item.sid !== 0) {
              const line = problem.sidToLineIndex.get(item.sid);
              expect(line, `${id}: step ${item.sid}`).toBeDefined();
              expect(lines[(line ?? 0) - 1]?.trim()).toBeTruthy();
            }
            for (const callerId of item.callStack) expect(problem.callerIdToLineIndex.has(callerId)).toBe(true);
            const rows = item.board.split('\n');
            expect(rows).toHaveLength(TURTLE_GRAPHICS_BOARD_ROWS);
            for (const row of rows) expect(row).toHaveLength(TURTLE_GRAPHICS_BOARD_COLUMNS);
            for (const turtle of item.turtles) {
              expect(Number.isFinite(turtle.x) && Number.isFinite(turtle.y)).toBe(true);
              expect(turtle.x).toBeGreaterThanOrEqual(0);
              expect(turtle.x).toBeLessThan(TURTLE_GRAPHICS_BOARD_COLUMNS);
              expect(turtle.y).toBeGreaterThanOrEqual(0);
              expect(turtle.y).toBeLessThan(TURTLE_GRAPHICS_BOARD_ROWS);
            }
          }
        }
        expect(sources.size, seed).toBe(9);
      }
      expect(ids).toHaveLength(9);
    }
  );
}

test('all authored templates remain reachable through configured lecture pools', () => {
  const reachable = new Set(
    Object.entries(courseIdToLectureIds).flatMap(([courseId, lectures]) =>
      lectures.flatMap((lectureId) => getPracticeProblemIds(courseId, lectureId))
    )
  );
  for (const definition of practiceDefinitions) expect(reachable.has(definition.id), definition.id).toBe(true);
});

test('practice lookup rejects foreign and prototype IDs', () => {
  for (const id of ['test1', 'toString', '__proto__', 'missing']) {
    expect(instantiatePracticeProblem(id, 'java', 'foreign-bank')).toBeUndefined();
  }
  expect(getPracticeProblemIds('toString', 'test')).toEqual([]);
  expect(getPracticeProblemIds('test', 'toString')).toEqual([]);
});

test('helper locals and parameters remain scoped to their call while the turtle survives the return', () => {
  const local = instantiatePracticeProblem('practiceEasyV1Beginner1L7LocalHelperV2', 'java', 'local-scope');
  expect(local?.finalTurtles).toEqual([{ x: 2, y: 1, dir: 'E', color: '#' }]);
  expect(local?.traceItems.some((item) => item.callStack.length === 1 && item.referenceVars.t !== undefined)).toBe(
    true
  );
  const parameter = instantiatePracticeProblem(
    'practiceEasyV1Beginner1L7CoordinateParameterV3',
    'java',
    'parameter-scope'
  );
  expect(parameter?.traceItems.some((item) => item.callStack.length === 1 && item.vars.x === 3)).toBe(true);
  expect(parameter?.finalVars).not.toHaveProperty('x');
  expect(parameter?.finalTurtles).toEqual([{ x: 3, y: 1, dir: 'W', color: '#' }]);
});

test('a returned expression becomes the caller variable without leaking the parameter', () => {
  const problem = instantiatePracticeProblem('practiceEasyV1Beginner1L7SimpleReturnV2', 'java', 'return-scope');
  expect(problem?.finalVars).toEqual({ result: 3 });
  expect(problem?.finalTurtles).toEqual([{ x: 2, y: 2, dir: 'N', color: '#' }]);
});

test('an indexed replacement is visible in the subsequent scalar read', () => {
  const problem = instantiatePracticeProblem('practiceEasyV1Beginner1L8ReplaceCellV3', 'java', 'array-read');
  expect(problem?.finalVars).toEqual({ values: [0, 3, 0], selected: 3 });
});

test('reassigning an alias moves only its current target and preserves the other turtle', () => {
  const problem = instantiatePracticeProblem('practiceEasyV1Beginner2L1ReferenceTargetV2', 'java', 'alias-target');
  expect(problem?.finalTurtles).toEqual([
    { x: 2, y: 1, dir: 'N', color: '#' },
    { x: 2, y: 2, dir: 'N', color: '#' },
  ]);
  const references = problem?.traceItems.at(-1)?.referenceVars;
  expect(references?.b).toBeDefined();
  expect(references?.active).toEqual(references?.b);
  expect(references?.active).not.toEqual(references?.a);
});

test('an integer argument selects the overload and a parent reference dispatches to the child override', () => {
  const problem = instantiatePracticeProblem('practiceEasyV1Beginner2L6OverloadDispatchV2', 'java', 'dispatch');
  expect(problem?.finalVars).toMatchObject({ x: 3 });
  expect(problem?.finalVars).not.toHaveProperty('value');
  expect(problem?.finalTurtles).toEqual([{ x: 3, y: 0, dir: 'N', color: '#' }]);
});

test('an exception skips forward movement and executes the matching handler turn', () => {
  const problem = instantiatePracticeProblem('practiceEasyV1Beginner2L7ExceptionSkipV2', 'java', 'exception');
  expect(problem?.finalTurtles).toEqual([{ x: 2, y: 1, dir: 'E', color: '#' }]);
  expect(problem?.traceItems.every((item) => item.turtles.every((turtle) => turtle.y === 1))).toBe(true);
});

test('a two-dimensional update reaches the indexed constructor argument', () => {
  const problem = instantiatePracticeProblem('practiceEasyV1Beginner2L8CellUpdateV3', 'java', 'nested-array');
  expect(problem?.finalVars).toEqual({ x: 3 });
  expect(problem?.traceItems.at(-1)?.referenceVars.values).toMatchObject({
    kind: 'array',
    entries: {
      0: { kind: 'array', entries: { 0: { kind: 'value', value: 0 }, 1: { kind: 'value', value: 3 } } },
      1: { kind: 'array', entries: { 0: { kind: 'value', value: 0 }, 1: { kind: 'value', value: 0 } } },
    },
  });
  expect(problem?.finalTurtles).toEqual([{ x: 3, y: 0, dir: 'N', color: '#' }]);
});

test.each([1, 2, 3])('direct expression variant %i reads the unchanged scalar at the expression step', (initial) => {
  const problem = instantiatePracticeProblem(
    `practiceEasyV1Beginner1L2ReadExpressionV${initial}`,
    'java',
    'expression'
  );
  expect(problem).toBeDefined();
  if (!problem) throw new Error('Missing direct expression practice program');
  const scalarSteps = problem.traceItems.filter((item) => item.vars.value !== undefined);
  expect(scalarSteps.length).toBeGreaterThan(0);
  expect(scalarSteps.every((item) => item.vars.value === initial)).toBe(true);
  expect(scalarSteps.some((item) => item.vars.next === undefined)).toBe(true);
  expect(problem.finalVars).toEqual({ value: initial, next: initial + 1 });
  expect(problem.finalTurtles).toEqual([{ x: initial, y: 1, dir: 'N', color: '#' }]);
  const lines = problem.displayProgram.split('\n');
  const expressionStep = problem.traceItems.find((item) => {
    const line = problem.sidToLineIndex.get(item.sid);
    return line !== undefined && lines[line - 1]?.includes('int next = value + 1;');
  });
  expect(expressionStep?.vars.value).toBe(initial);
  expect(problem.displayProgram).not.toContain('value++');
});
