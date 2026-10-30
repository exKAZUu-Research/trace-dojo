import { expect, test } from 'vitest';

import { TURTLE_GRAPHICS_BOARD_COLUMNS, TURTLE_GRAPHICS_BOARD_ROWS } from '../../src/constants';
import { instantiateProblem } from '../../src/problems/instantiateProblem';
import { courseIdToLectureIds } from '../../src/problems/problemData';
import { getPracticeProblemIds, practiceDefinitions } from '../../src/problems/practice/definitions';
import { instantiatePracticeProblem } from '../../src/problems/practice/instantiatePracticeProblem';

for (const [courseId, lectureIds] of Object.entries(courseIdToLectureIds)) {
  test.each(lectureIds)(`${courseId} / %s offers independently executable practice choices`, (lectureId) => {
    const ids = getPracticeProblemIds(courseId, lectureId);
    expect(new Set(ids).size).toBeGreaterThan(1);
    for (const id of ids) {
      for (const seed of ['practice-regression-alpha', 'practice-regression-omega']) {
        const problem = instantiatePracticeProblem(id, 'java', seed);
        expect(problem, id).toBeDefined();
        if (!problem) throw new Error(`Missing practice program: ${id}`);
        expect(instantiateProblem(id, 'java', seed)).toBeUndefined();
        expect(problem.displayProgram).toContain('public static void main');
        expect(problem.displayProgram).not.toMatch(/<\d+-\d+>|【|\/\/\s*step/);
        expect(problem.blankAnswers).toEqual([]);
        expect(problem.traceItems.length).toBeGreaterThan(1);
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
    }
  });
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

test('continue consumes cooldown rounds while only two rounds move north', () => {
  const problem = instantiatePracticeProblem('practiceBeginner1L6B', 'java', 'cooldown');
  expect(problem?.finalVars).toMatchObject({ cooldown: 0, moved: 2 });
  expect(problem?.finalTurtles).toEqual([{ x: 2, y: 3, dir: 'E', color: '#' }]);
});

test('returned lengths drive successive helper calls and preserve the second turn', () => {
  const problem = instantiatePracticeProblem('practiceBeginner1L7B', 'java', 'return-values');
  expect(problem?.finalVars).toMatchObject({ next: 1 });
  expect(problem?.finalTurtles).toEqual([{ x: 2, y: 2, dir: 'S', color: '#' }]);
});

test('reverse traversal reads the updated array element on its next iteration', () => {
  const problem = instantiatePracticeProblem('practiceBeginner1L8A', 'java', 'array-dependency');
  expect(problem?.finalVars).toMatchObject({ distances: [4, 3, 1] });
  expect(problem?.finalTurtles).toEqual([{ x: 4, y: 2, dir: 'S', color: '#' }]);
});

test('reassigning aliases leaves the abandoned turtle in place and all live references target the first turtle', () => {
  const problem = instantiatePracticeProblem('practiceTestL1B', 'java', 'alias-lifetime');
  expect(problem?.finalTurtles).toEqual([
    { x: 2, y: 1, dir: 'W', color: '#' },
    { x: 3, y: 1, dir: 'E', color: '#' },
  ]);
  const references = problem?.traceItems.at(-1)?.referenceVars;
  expect(references?.first).toBeDefined();
  expect(references?.second).toEqual(references?.first);
  expect(references?.cursor).toEqual(references?.first);
});

test('declared argument types select overloads while virtual calls still dispatch to the override', () => {
  const problem = instantiatePracticeProblem('practiceBeginner2L6C', 'java', 'overload-override');
  expect(problem?.finalTurtles).toEqual([{ x: 4, y: 0, dir: 'S', color: '#' }]);
});

test('custom exception state reaches the caller and skips the remaining try statements', () => {
  const problem = instantiatePracticeProblem('practiceBeginner2L7B', 'java', 'exception-state');
  expect(problem?.finalTurtles).toEqual([{ x: 2, y: 2, dir: 'E', color: '#' }]);
});

test('three-dimensional updates are read through the reverse layer traversal', () => {
  const problem = instantiatePracticeProblem('practiceBeginner2L8B', 'java', 'nested-array');
  expect(problem?.finalTurtles).toEqual([{ x: 3, y: 3, dir: 'S', color: '#' }]);
});
