import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test, vi } from 'vitest';
import { z } from 'zod';

import { TraceViewer } from '../../src/app/(withAuth)/courses/[courseId]/lectures/[lectureId]/problems/[problemId]/TraceViewer';
import { instantiateProblem, type InstantiatedProblem } from '../../src/problems/instantiateProblem';

const problem = (id: string): InstantiatedProblem => {
  const instantiated = instantiateProblem(id, 'java', 'turtle-variables');
  if (!instantiated) throw new Error(`Missing problem: ${id}`);
  return instantiated;
};

const turtleVars = (item: unknown): Record<string, { x: number; y: number }> => {
  return z.object({ turtleVars: z.record(z.string(), z.object({ x: z.number(), y: z.number() })) }).parse(item)
    .turtleVars;
};

test('step snapshots show the Java turtle name beside distinct local coordinates without changing answer variables', () => {
  const instantiated = problem('variable3');
  expect(turtleVars(instantiated.traceItems[0])).toEqual({});
  const beforeCreation = instantiated.traceItems.find((item) => item.sid === 3);
  const afterCreation = instantiated.traceItems.find((item) => item.sid === 4);
  const afterMoving = instantiated.traceItems.find((item) => item.sid === 5);

  expect(beforeCreation).toBeDefined();
  expect(afterCreation).toBeDefined();
  expect(afterMoving).toBeDefined();
  expect(turtleVars(beforeCreation)).toEqual({});
  expect(turtleVars(afterCreation)).toEqual({ 亀: { x: afterCreation!.vars.x, y: afterCreation!.vars.y } });
  expect(turtleVars(afterMoving)).toEqual({ 亀: { x: afterMoving!.vars.x, y: Number(afterMoving!.vars.y) + 1 } });
  expect(Object.keys(afterMoving!.vars)).toEqual(['x', 'y']);
  expect(instantiated.finalVars).toEqual(afterMoving!.vars);
});

test('the trace viewer renders the selected step coordinates with the Java name', () => {
  const instantiated = problem('variable3');
  const viewingTraceItemIndex = instantiated.traceItems.findIndex((item) => item.sid === 4);
  const html = renderToStaticMarkup(
    createElement(TraceViewer, {
      currentTraceItemIndex: viewingTraceItemIndex + 1,
      previousTraceItemIndex: viewingTraceItemIndex,
      viewingTraceItemIndex,
      problem: instantiated,
      setViewingTraceItemIndex: vi.fn(),
    })
  );

  expect(html).toContain('亀.x');
  expect(html).toContain('亀.y');
  expect(html).toMatch(/<td[^>]*>亀\.x<\/td><td[^>]*>2<\/td>/);
  expect(html).toMatch(/<td[^>]*>亀\.y<\/td><td[^>]*>3<\/td>/);
  expect(html).toContain('変数/式');
  expect(html).toContain('>x<');
  expect(html).toContain('>y<');
  expect(html).not.toContain('t.x');
  expect(html).not.toContain('t.y');
});

test('multiple turtles and indexed arrays keep their Java reference paths', () => {
  const multiple = problem('multiObject1');
  expect(turtleVars(multiple.traceItems.find((item) => item.sid === 2))).toEqual({
    t1: { x: 1, y: 1 },
    t2: { x: 3, y: 3 },
  });

  const array = problem('multiObject6');
  const afterThreeCreations = array.traceItems.find((item) => item.turtles.length === 3);
  expect(turtleVars(afterThreeCreations)).toMatchObject({
    'turtles[0]': { x: 1, y: 0 },
    'turtles[1]': { x: 3, y: 0 },
    'turtles[2]': { x: 5, y: 0 },
  });
});

test('reassigned aliases show the current target at the Java assignment step', () => {
  const instantiated = problem('garbageCollection1');
  const afterAssignment = instantiated.traceItems.find((item) => item.sid === 6);
  const afterMovingAlias = instantiated.traceItems.find((item) => item.sid === 7);

  expect(turtleVars(afterAssignment)).toMatchObject({ t1: { x: 1, y: 2 }, t2: { x: 1, y: 2 } });
  expect(turtleVars(afterMovingAlias)).toMatchObject({ t1: { x: 2, y: 2 }, t2: { x: 2, y: 2 } });
});

test('removed array entries and finished loop variables do not remain visible', () => {
  const instantiated = problem('garbageCollection4');
  const firstRemoval = instantiated.traceItems.find((item) => item.sid === 4 && item.turtles.length === 4);
  const insideLoop = instantiated.traceItems.find((item) => item.sid === 5 && item.turtles.length === 4);
  const secondRemoval = instantiated.traceItems.find((item) => item.sid === 4 && item.turtles.length === 3);

  expect(turtleVars(firstRemoval)).not.toHaveProperty(['turtles[0]']);
  expect(turtleVars(insideLoop)).toHaveProperty(['t']);
  expect(turtleVars(secondRemoval)).not.toHaveProperty(['turtles[0]']);
  expect(turtleVars(secondRemoval)).not.toHaveProperty(['turtles[1]']);
  expect(turtleVars(secondRemoval)).not.toHaveProperty('t');
});

test('method argument references follow the active scope and disappear after return', () => {
  const instantiated = problem('method1');
  const insideMethod = instantiated.traceItems.find((item) => item.depth === 1);
  const afterReturn = instantiated.traceItems.find((item) => item.depth === 0 && item.sid === 2);

  expect(turtleVars(insideMethod)).toHaveProperty('t');
  expect(turtleVars(afterReturn)).toEqual({ t: { x: afterReturn!.turtles[0].x, y: afterReturn!.turtles[0].y } });
  expect(afterReturn!.callStack).toEqual([]);
});

test('class turtle fields use the Java this path', () => {
  const instantiated = problem('makeClass1');
  const insideConstructor = instantiated.traceItems.find((item) => item.sid === 2 && item.depth === 1);
  const insideMethod = instantiated.traceItems.find((item) => item.sid === 5 && item.depth === 1);
  const inMain = instantiated.traceItems.find((item) => item.sid === 1 && item.depth === 0);

  expect(turtleVars(insideConstructor)).toHaveProperty(['this.t']);
  expect(turtleVars(insideMethod)).toHaveProperty(['this.t']);
  expect(turtleVars(insideMethod)).not.toHaveProperty(['t.t']);
  expect(turtleVars(inMain)).toHaveProperty(['t.t']);
  expect(turtleVars(inMain)).not.toHaveProperty(['this.t']);
});

test('a field reference follows replacement and alias assignment', () => {
  const instantiated = problem('constructor4');
  const afterReplacement = instantiated.traceItems.find((item) => item.depth === 0 && item.sid === 3);
  const afterAlias = instantiated.traceItems.find((item) => item.depth === 0 && item.sid === 4);

  expect(turtleVars(afterReplacement)).toHaveProperty(['mover.t']);
  expect(turtleVars(afterReplacement)['mover.t']).not.toEqual(turtleVars(afterReplacement).t2);
  expect(turtleVars(afterAlias)['mover.t']).toEqual(turtleVars(afterAlias).t2);
});

test('fill in blank answers do not include turtle coordinates', () => {
  const instantiated = problem('fillInBlank1');

  expect(turtleVars(instantiated.traceItems.find((item) => item.sid === 1))).toEqual({ t: { x: 0, y: 0 } });
  expect(instantiated.finalVars).toEqual({});
  expect(instantiated.blankAnswers).toEqual(['i < 4']);
});
