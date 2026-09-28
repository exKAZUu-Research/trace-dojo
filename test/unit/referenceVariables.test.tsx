import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test, vi } from 'vitest';
import { z } from 'zod';

import { TraceViewer } from '../../src/app/(withAuth)/courses/[courseId]/lectures/[lectureId]/problems/[problemId]/TraceViewer';
import { Variables } from '../../src/app/(withAuth)/courses/[courseId]/lectures/[lectureId]/problems/[problemId]/Variables';
import { instantiateProblem, type InstantiatedProblem } from '../../src/problems/instantiateProblem';
import { traceProgram } from '../../src/problems/traceProgram';

const problem = (id: string): InstantiatedProblem => {
  const instantiated = instantiateProblem(id, 'java', 'turtle-variables');
  if (!instantiated) throw new Error(`Missing problem: ${id}`);
  return instantiated;
};

const referenceVars = (item: unknown): Record<string, unknown> =>
  z.object({ referenceVars: z.record(z.string(), z.unknown()) }).parse(item).referenceVars;

const scalar = (value: number | string | boolean | null): { kind: 'value'; value: typeof value } => ({
  kind: 'value',
  value,
});
const object = (entries: Record<string, unknown>): { kind: 'object'; entries: typeof entries } => ({
  kind: 'object',
  entries,
});
const array = (entries: Record<string, unknown>): { kind: 'array'; entries: typeof entries } => ({
  kind: 'array',
  entries,
});

const renderViewer = (
  instantiated: InstantiatedProblem,
  viewingTraceItemIndex: number,
  currentTraceItemIndex: number
): string =>
  renderToStaticMarkup(
    createElement(TraceViewer, {
      currentTraceItemIndex,
      previousTraceItemIndex: viewingTraceItemIndex,
      viewingTraceItemIndex,
      problem: instantiated,
      setViewingTraceItemIndex: vi.fn(),
    })
  );

test('Java turtle names show their selected-step coordinates apart from answer variables', () => {
  const instantiated = problem('variable3');
  const beforeCreation = instantiated.traceItems.find((item) => item.sid === 3);
  const afterCreation = instantiated.traceItems.find((item) => item.sid === 4);
  const afterMoving = instantiated.traceItems.find((item) => item.sid === 5);

  expect(referenceVars(instantiated.traceItems[0])).toEqual({});
  expect(referenceVars(beforeCreation)).toEqual({});
  expect(referenceVars(afterCreation)).toMatchObject({ 亀: object({ x: scalar(2), y: scalar(3) }) });
  expect(referenceVars(afterMoving)).toMatchObject({ 亀: object({ x: scalar(2), y: scalar(4) }) });
  expect(afterMoving!.vars).toEqual({ x: 2, y: 3 });
  expect(instantiated.finalVars).toEqual(afterMoving!.vars);

  const viewingTraceItemIndex = instantiated.traceItems.indexOf(afterCreation!);
  const html = renderViewer(instantiated, viewingTraceItemIndex, viewingTraceItemIndex + 1);
  expect(html).toContain('亀.x');
  expect(html).toContain('亀.y');
  expect(html).toMatch(/亀\.y<\/span><\/td><td[^>]*>3<\/td>/);
  expect(html).not.toContain('t.x');
  expect(html).toContain('>x<');
  expect(html).toContain('>y<');
});

test('multiple turtles and arrays retain Java reference paths', () => {
  const multiple = problem('multiObject1');
  expect(referenceVars(multiple.traceItems.find((item) => item.sid === 2))).toMatchObject({
    t1: object({ x: scalar(1), y: scalar(1) }),
    t2: object({ x: scalar(3), y: scalar(3) }),
  });

  const indexed = problem('multiObject6');
  const afterThreeCreations = indexed.traceItems.find((item) => item.turtles.length === 3);
  expect(referenceVars(afterThreeCreations)).toMatchObject({
    turtles: array({
      '0': object({ x: scalar(1), y: scalar(0) }),
      '1': object({ x: scalar(3), y: scalar(0) }),
      '2': object({ x: scalar(5), y: scalar(0) }),
    }),
  });
});

test('alias assignment and removal update reference values at their Java steps', () => {
  const assigned = problem('garbageCollection1');
  expect(referenceVars(assigned.traceItems.find((item) => item.sid === 6))).toMatchObject({
    t1: object({ x: scalar(1), y: scalar(2) }),
    t2: object({ x: scalar(1), y: scalar(2) }),
  });
  expect(referenceVars(assigned.traceItems.find((item) => item.sid === 7))).toMatchObject({
    t1: object({ x: scalar(2), y: scalar(2) }),
    t2: object({ x: scalar(2), y: scalar(2) }),
  });

  const removed = problem('garbageCollection4');
  const firstRemoval = removed.traceItems.find((item) => item.sid === 4 && item.turtles.length === 4);
  const insideLoop = removed.traceItems.find((item) => item.sid === 5 && item.turtles.length === 4);
  const secondRemoval = removed.traceItems.find((item) => item.sid === 4 && item.turtles.length === 3);
  // oxlint-disable-next-line unicorn/no-null -- Java null is an observable array entry.
  expect(referenceVars(firstRemoval)).toMatchObject({ turtles: array({ '0': scalar(null) }) });
  expect(referenceVars(insideLoop)).toHaveProperty('t');
  // oxlint-disable-next-line unicorn/no-null -- Java null is an observable array entry.
  expect(referenceVars(secondRemoval)).toMatchObject({ turtles: array({ '0': scalar(null), '1': scalar(null) }) });
  expect(referenceVars(secondRemoval)).not.toHaveProperty('t');
});

test('method argument references follow the active call scope and leave no stale reference', () => {
  const instantiated = problem('method1');
  const insideMethod = instantiated.traceItems.find((item) => item.depth === 1);
  const afterReturn = instantiated.traceItems.find((item) => item.depth === 0 && item.sid === 2);

  expect(referenceVars(insideMethod)).toMatchObject({ t: object({ x: scalar(0), y: scalar(1) }) });
  expect(insideMethod!.callStack).toEqual([1]);
  expect(referenceVars(afterReturn)).toMatchObject({ t: object({ x: scalar(0), y: scalar(2) }) });
  expect(afterReturn!.callStack).toEqual([]);
});

test('class fields are captured in the active scope with immutable past values', () => {
  const instantiated = problem('makeClass1');
  const insideConstructor = instantiated.traceItems.find((item) => item.sid === 3 && item.depth === 1);
  const insideMethod = instantiated.traceItems.find((item) => item.sid === 5 && item.depth === 1);
  const inMain = instantiated.traceItems.find((item) => item.sid === 1 && item.depth === 0);

  expect(referenceVars(insideConstructor)).toMatchObject({
    this: object({ speed: scalar(2), t: object({ x: scalar(0), y: scalar(0) }) }),
  });
  expect(referenceVars(insideMethod)).toMatchObject({
    this: object({ speed: scalar(2), t: object({ x: scalar(0), y: scalar(1) }) }),
  });
  expect(referenceVars(insideMethod)).not.toHaveProperty('t');
  expect(referenceVars(inMain)).toMatchObject({
    t: object({ speed: scalar(1), t: object({ x: scalar(0), y: scalar(2) }) }),
  });
  expect(referenceVars(inMain)).not.toHaveProperty('this');
  expect(insideMethod!.vars['this.speed']).toBe(2);
  expect(inMain!.vars).toEqual({});
});

test('replacement and alias assignment update fields inside a wrapper instance', () => {
  const instantiated = problem('constructor4');
  const afterReplacement = instantiated.traceItems.find((item) => item.depth === 0 && item.sid === 3);
  const afterAlias = instantiated.traceItems.find((item) => item.depth === 0 && item.sid === 4);
  expect(referenceVars(afterReplacement)).toMatchObject({
    mover: object({ t: object({ x: scalar(3), y: scalar(1) }) }),
  });
  expect(referenceVars(afterAlias)).toMatchObject({
    mover: object({ t: object({ x: scalar(0), y: scalar(0) }) }),
    t2: object({ x: scalar(0), y: scalar(0) }),
  });
});

test('viewer opens this, folds other instances, and keeps all direct fields in a readable summary', () => {
  const instantiated = problem('makeClass1');
  const inMethodIndex = instantiated.traceItems.findIndex((item) => item.sid === 5 && item.depth === 1);
  const inMainIndex = instantiated.traceItems.findIndex((item) => item.sid === 1 && item.depth === 0);
  const methodHtml = renderViewer(instantiated, inMethodIndex, inMethodIndex + 1);
  const mainHtml = renderViewer(instantiated, inMainIndex, inMainIndex);

  expect(methodHtml).toMatch(/<details[^>]*\bopen(?:="")?[^>]*>/);
  expect(methodHtml).toMatch(/<summary[^>]*>[\s\S]*?speed=2[\s\S]*?<\/summary>/);
  expect(methodHtml).toContain('this.speed');
  expect(methodHtml).toContain('this.t.x');
  expect(mainHtml).toMatch(/<details(?![^>]*\bopen)[^>]*>/);
  expect(mainHtml).toMatch(/<summary[^>]*>[\s\S]*?speed=1[\s\S]*?<\/summary>/);
  expect(mainHtml).toContain('t.t.x');
});

test('nested turtle instances have their own closed disclosure inside the open this instance', () => {
  const instantiated = problem('makeClass1');
  const inMethodIndex = instantiated.traceItems.findIndex((item) => item.sid === 5 && item.depth === 1);
  const html = renderViewer(instantiated, inMethodIndex, inMethodIndex + 1);
  const details = [...html.matchAll(/<details([^>]*)>/g)];

  expect(details).toHaveLength(2);
  expect(details[0][1]).toMatch(/\bopen(?:="")?/);
  expect(details[1][1]).not.toMatch(/\bopen(?:="")?/);
  expect(html).toMatch(/<details[^>]*>[\s\S]*?<summary[^>]*>[\s\S]*?this\.t[\s\S]*?<\/summary>/);
});

test('a class field appears once inside its instance without answer annotations', () => {
  const instantiated = problem('makeClass1');
  const viewingTraceItemIndex = instantiated.traceItems.findIndex((item) => item.sid === 5 && item.depth === 1);
  const html = renderViewer(instantiated, viewingTraceItemIndex, viewingTraceItemIndex + 1);

  expect(html.match(/>this\.speed</g)).toHaveLength(1);
  expect(html).toMatch(/<summary[^>]*>[\s\S]*?speed=2[\s\S]*?<\/summary>/);
});

test('the viewed past instance remains unchanged when the current step is elsewhere', () => {
  const instantiated = problem('makeClass1');
  const pastMethodIndex = instantiated.traceItems.findIndex((item) => item.sid === 5 && item.depth === 1);
  const currentMainIndex = instantiated.traceItems.findIndex((item) => item.sid === 1 && item.depth === 0);
  const pastHtml = renderViewer(instantiated, pastMethodIndex, currentMainIndex);
  const mainHtml = renderViewer(instantiated, currentMainIndex, currentMainIndex);

  expect(pastHtml).toContain('this.speed');
  expect(pastHtml).toMatch(/<summary[^>]*>[\s\S]*?speed=2[\s\S]*?<\/summary>/);
  expect(mainHtml).toContain('t.speed');
  expect(mainHtml).toMatch(/<summary[^>]*>[\s\S]*?speed=1[\s\S]*?<\/summary>/);
});

test('fill in blank grading variables remain separate from references', () => {
  const instantiated = problem('fillInBlank1');
  expect(referenceVars(instantiated.traceItems.find((item) => item.sid === 1))).toMatchObject({
    t: object({ x: scalar(0), y: scalar(0) }),
  });
  expect(instantiated.finalVars).toEqual({});
  expect(instantiated.blankAnswers).toEqual(['i < 4']);
});

test('a registered class without turtles captures own data while skipping cycles and getters', () => {
  const instrumented = `
class Counter {
  constructor() {
    this.count = 1;
    this.label = 'a full label with all of its text';
    this.numericString = '2';
    this.active = true;
    this.missing = null;
    this.values = [1, undefined, 'last'];
    this.empty = {};
    this.emptyValues = [];
    this.self = this;
    Object.defineProperty(this, 'computed', { enumerable: true, get() { throw new Error('Getter was called'); } });
  }
}
const counter = new Counter(); registerDisplayRef('counter', () => counter); // step
counter.count = 2; // step
`;
  const displayProgram = `
public class Main {
  public static void main(String[] args) {
    Counter counter = new Counter(); // step
    counter.count = 2; // step
  }
}
`;
  const traced = traceProgram(instrumented, displayProgram, 'java');
  const first = referenceVars(traced.traceItems.find((item) => item.sid === 1));
  const second = referenceVars(traced.traceItems.find((item) => item.sid === 2));

  expect(first).toMatchObject({
    counter: object({
      count: scalar(1),
      label: scalar('a full label with all of its text'),
      numericString: scalar('2'),
      active: scalar(true),
      // oxlint-disable-next-line unicorn/no-null -- Java null is displayed as a scalar field.
      missing: scalar(null),
      values: array({ '0': scalar(1), '2': scalar('last') }),
      empty: object({}),
      emptyValues: array({}),
    }),
  });
  expect(second).toMatchObject({ counter: object({ count: scalar(2) }) });
  expect(first).not.toHaveProperty(['counter', 'entries', 'self']);
  expect(first).not.toHaveProperty(['counter', 'entries', 'computed']);
  expect(traced.traceItems[1].vars).toEqual({});
  expect(traced.finalVars).toEqual({});

  const html = renderToStaticMarkup(
    createElement(Variables, { traceItemVars: {}, referenceVars: traced.traceItems[1].referenceVars })
  );
  const summaries = [...html.matchAll(/<summary[^>]*>([\s\S]*?)<\/summary>/g)];
  expect(summaries.some((match) => match[1].includes('a full label with all of its text'))).toBe(true);
  expect(
    summaries.some((match) => /label=(?:&quot;|")a full label with all of its text(?:&quot;|")/.test(match[1]))
  ).toBe(true);
  expect(summaries.some((match) => /numericString=(?:&quot;|")2(?:&quot;|")/.test(match[1]))).toBe(true);
  expect(summaries.some((match) => match[1].includes('count=1'))).toBe(true);
  expect(summaries.some((match) => match[1].includes('missing=null'))).toBe(true);
  expect(html).toContain('counter.values');
  expect(html).toContain('counter.empty');
  expect(html).toContain('counter.emptyValues');
  const disclosures = [...html.matchAll(/<details([^>]*)><summary[^>]*>([\s\S]*?)<\/summary>/g)];
  const emptyObject = disclosures.find((match) => match[2].includes('counter.empty'));
  const emptyArray = disclosures.find((match) => match[2].includes('counter.emptyValues'));
  expect(emptyObject).toBeDefined();
  expect(emptyArray).toBeDefined();
  expect(emptyObject?.[1]).not.toMatch(/\bopen(?:="")?/);
  expect(emptyArray?.[1]).not.toMatch(/\bopen(?:="")?/);
  expect(emptyObject?.[2]).toContain('{}');
  expect(emptyArray?.[2]).toContain('[]');
});

test('nested class objects render once when the legacy answer snapshot has an object value', () => {
  const instrumented = `
class Counter {
  constructor() { this.inner = { label: 'nested' }; this.count = 1; }
  tick() { this.count++; // step
  }
}
const counter = new Counter(); registerDisplayRef('counter', () => counter);
call(counter.tick.bind(counter))(); // caller
`;
  const displayProgram = `
public class Main {
  public static void main(String[] args) {
    Counter counter = new Counter();
    counter.tick(); // caller
  }
}
class Counter {
  void tick() {
    this.count++; // step
  }
}
`;
  const traced = traceProgram(instrumented, displayProgram, 'java');
  const snapshot = traced.traceItems.find((item) => item.sid === 1);
  expect(snapshot).toBeDefined();
  expect(snapshot!.vars).toHaveProperty(['this.inner']);
  const html = renderToStaticMarkup(
    createElement(Variables, { traceItemVars: snapshot!.vars, referenceVars: snapshot!.referenceVars })
  );
  expect(html).toContain('this.inner.label');
  expect(html).not.toMatch(/<td[^>]*>(?:<span[^>]*>)?this\.inner(?:<\/span>)?<\/td>/);
  expect(html.match(/>this\.count</g)).toHaveLength(1);
  expect(html).not.toContain('変数/式');
});

test('unregistered numeric-only programs still reject native assignments', () => {
  expect(() => traceProgram('const count = 1; // step', 'int count = 1; // step', 'java')).toThrow(
    'Instrumented program MUST NOT contain assignment operators (=).'
  );
});
