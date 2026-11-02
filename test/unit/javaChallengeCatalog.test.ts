import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

import { expect, test } from 'vitest';

import { type ChallengeMetadata, challengeMetadata } from '../../src/problems/challenge/metadata';
import { extractBlanks, fillBlanks } from '../../src/problems/fillInBlank/blanks';
import { gradeFillInBlankCode } from '../../src/problems/fillInBlank/grade';
import type { JavaExecutionResult } from '../../src/problems/fillInBlank/javaExecutors';
import {
  buildJavaJudgeProgram,
  JAVA_JUDGE_CLASS_NAME,
  type JavaTurtleState,
  parseJavaJudgeOutput,
} from '../../src/problems/fillInBlank/javaProgram';
import { stripJavaTraceAnnotations } from '../../src/problems/fillInBlank/javaSource';
import { instantiateProblem, isFillInBlankProblem } from '../../src/problems/instantiateProblem';
import { javaChallengeDefinitions } from '../../src/problems/javaChallenges/definitions';
import { instantiateJavaChallenge } from '../../src/problems/javaChallenges/instantiate';
import type { JavaChallengeDefinition } from '../../src/problems/javaChallenges/types';
import { courseIdToLectureIndexToExerciseProblemIds } from '../../src/problems/problemData';
import { createLocalJavaExecutor, localJavaExecutor } from '../helpers/localJavaExecutor';

const catalog = javaChallengeDefinitions;
const definitionOf = (id: string): JavaChallengeDefinition | undefined => catalog[id];
const courses = ['tuBeginner1', 'tuBeginner2'] as const;
const lectures = courses.flatMap((courseId) =>
  Array.from({ length: 8 }, (_, lectureIndex) => ({ courseId, lectureIndex }))
);
const challengeMetadataOf = (id: string): ChallengeMetadata | undefined =>
  (challengeMetadata as Partial<Record<string, ChallengeMetadata>>)[id];
const marker = '__TRACE_DOJO_RESULT_catalog__';

const independentCases = [
  {
    name: 'movement and clockwise turn',
    body: 'Turtle t = new Turtle(); t.forward(); t.turnRight(); t.forward();',
    board: '#......\n##.....\n.......\n.......\n.......\n.......\n.......',
    turtles: [{ x: 1, y: 1, color: '#', dir: 'E' }],
  },
  {
    name: 'bounded for loop',
    body: 'Turtle t = new Turtle(); for (int i = 0; i < 3; i++) t.forward();',
    board: '#......\n#......\n#......\n#......\n.......\n.......\n.......',
    turtles: [{ x: 0, y: 3, color: '#', dir: 'N' }],
  },
  {
    name: 'branch selects backward movement',
    body: 'Turtle t = new Turtle(2, 2); int n = 2; if (n > 3) t.forward(); else t.backward();',
    board: '.......\n..#....\n..#....\n.......\n.......\n.......\n.......',
    turtles: [{ x: 2, y: 1, color: '#', dir: 'N' }],
  },
  {
    name: 'independent objects and reference alias',
    body: 'Turtle a = new Turtle(); Turtle b = new Turtle(2, 0, "R"); Turtle alias = a; alias.forward(); b.turnRight(); b.forward();',
    board: '#.RR...\n#......\n.......\n.......\n.......\n.......\n.......',
    turtles: [
      { x: 0, y: 1, color: '#', dir: 'N' },
      { x: 3, y: 0, color: 'R', dir: 'E' },
    ],
  },
  {
    name: 'custom class constructor and instance method',
    body: 'Walker w = new Walker(); w.walk();',
    classes: 'class Walker { Turtle t = new Turtle(1, 1); void walk() { t.forward(); t.turnRight(); } }',
    board: '.......\n.#.....\n.#.....\n.......\n.......\n.......\n.......',
    turtles: [{ x: 1, y: 2, color: '#', dir: 'E' }],
  },
];

test.each(lectures)(
  '$courseId lecture $lectureIndex offers at least 12 distinct playable challenges of each kind',
  ({ courseId, lectureIndex }) => {
    const ids = courseIdToLectureIndexToExerciseProblemIds[courseId][lectureIndex];
    expect(new Set(ids).size).toBe(ids.length);
    for (const format of ['fillInBlank', 'bugFix'] as const) {
      const matching = ids.filter(
        (id) =>
          (definitionOf(id)?.problemFormat === format &&
            definitionOf(id)?.courseId === courseId &&
            definitionOf(id)?.lectureIndex === lectureIndex) ||
          (!definitionOf(id) && format === 'fillInBlank' && isFillInBlankProblem(id))
      );
      expect
        .soft(matching.length, `${courseId}/${lectureIndex + 1}: ${format} availability`)
        .toBeGreaterThanOrEqual(12);
    }
  }
);

test('every fixed catalog definition is registered and has a distinct visible starter within its lecture and format', () => {
  for (const [courseId, configuredLectures] of Object.entries(courseIdToLectureIndexToExerciseProblemIds)) {
    for (const [lectureIndex, ids] of configuredLectures.entries()) {
      for (const id of ids) {
        const definition = definitionOf(id);
        if (definition)
          expect(
            { courseId: definition.courseId, lectureIndex: definition.lectureIndex },
            `${id}: foreign membership`
          ).toEqual({ courseId, lectureIndex });
      }
    }
  }
  const starters = new Set<string>();
  for (const [id, definition] of Object.entries(catalog)) {
    const selectable = courseIdToLectureIndexToExerciseProblemIds[definition.courseId][definition.lectureIndex];
    if (definition.courseId === 'test' || challengeMetadataOf(id)) expect(selectable, id).toContain(id);
    else expect(selectable, id).not.toContain(id);
    const visible = instantiateJavaChallenge(id, definition.problemFormat).displayProgram;
    const key = `${definition.courseId}/${definition.lectureIndex}/${definition.problemFormat}/${visible.trim()}`;
    expect(starters.has(key), `Duplicate playable starter: ${id}`).toBe(false);
    starters.add(key);
  }
});

const gradingResults = new Map<string, ReturnType<typeof gradeFillInBlankCode>>();
const solutions = new Map<string, Promise<JavaTurtleState>>();
const catalogLectures = [...lectures, { courseId: 'test' as const, lectureIndex: 0 }];

test.each(catalogLectures)(
  '$courseId lecture $lectureIndex: all fixed solutions and starters satisfy real Java grading',
  async ({ courseId, lectureIndex }) => {
    for (const [id, definition] of Object.entries(catalog).filter(
      ([, item]) => item.courseId === courseId && item.lectureIndex === lectureIndex
    )) {
      const admitted = instantiateJavaChallenge(id, definition.problemFormat);
      expect(admitted, `${id}: public admission`).toEqual({
        displayProgram: stripJavaTraceAnnotations(extractBlanks(definition.starterProgram).programWithPlaceholders),
        finalBoard: definition.finalBoard,
        finalTurtles: definition.finalTurtles,
      });
      let solution = solutions.get(definition.correctProgram);
      if (!solution) {
        solution = executeState(definition.correctProgram, id);
        solutions.set(definition.correctProgram, solution);
      }
      const expected = { board: definition.finalBoard.trim(), turtles: definition.finalTurtles };
      expect(await solution, `${id}: correct source must match stored target`).toEqual(expected);
      expect(
        await gradeOnce(definition, definition.correctProgram),
        `${id}: intended repair must pass real grading admission`
      ).toMatchObject({ status: 'correct' });
      if (definition.problemFormat === 'fillInBlank') {
        const extracted = extractBlanks(definition.starterProgram);
        expect(extracted.answers.length, `${id}: missing holes`).toBeGreaterThan(0);
        expect(extracted.programWithPlaceholders).not.toContain('@[');
        for (let i = 1; i <= extracted.answers.length; i++)
          expect(extracted.programWithPlaceholders, id).toContain(`【${i}】`);
        expect(fillBlanks(definition.starterProgram, extracted.answers).trim(), `${id}: blank repair`).toBe(
          definition.correctProgram.trim()
        );
      } else {
        expect(definition.bugKind, `${id}: missing defect classification`).toBeDefined();
        const result = await executeSource(definition.starterProgram);
        if (definition.bugKind === 'syntax') {
          expect(result.kind, `${id}: syntax starter must fail compilation`).toBe('compileError');
          const verdict = await gradeOnce(definition, definition.starterProgram);
          expect(verdict, `${id}: syntax starter must reach compiler diagnostics`).toMatchObject({
            status: 'incorrect',
            stage: 4,
            detail: 'Compile error.',
            diagnostics: expect.any(Array),
          });
          if (verdict.status === 'incorrect') expect(verdict.diagnostics?.length, id).toBeGreaterThan(0);
        } else {
          expect(result.kind, `${id}: logical starter must run`).toBe('executed');
          if (result.kind !== 'executed') throw new Error(`${id}: ${JSON.stringify(result)}`);
          const actual = parseJavaJudgeOutput(result.stderr, marker);
          expect(actual, `${id}: missing state`).toBeDefined();
          expect(actual?.exception, `${id}: logical starter must terminate normally`).toBeUndefined();
          expect(actual, `${id}: logical defect has no observable effect`).not.toEqual(expected);
          expect(
            await gradeOnce(definition, definition.starterProgram),
            `${id}: logical starter must reach final-state grading`
          ).toMatchObject({
            status: 'incorrect',
            stage: 4,
            detail: 'The final state differs from the expected one.',
          });
        }
      }
    }
  },
  1_200_000
);

test.each(['fillInBlank', 'bugFix'] as const)(
  'annotation-free %s public source remains repairable through real Java grading',
  async (format) => {
    const id = `challengeI7ValueSnapshot${format === 'fillInBlank' ? 'Blank' : 'Bug'}Condition4`;
    const definition = catalog[id];
    const problem = instantiateJavaChallenge(id, format);
    expect(problem.displayProgram).not.toMatch(/\/\/\s*(?:step|caller)\b/);
    const answers = extractBlanks(definition.starterProgram).answers;
    const repaired =
      format === 'fillInBlank'
        ? problem.displayProgram.replaceAll(/【(\d+)】/g, (_, index: string) => answers[Number(index) - 1])
        : stripJavaTraceAnnotations(definition.correctProgram);
    expect(await gradeFillInBlankCode(problem, repaired, { javaExecutors: [localJavaExecutor] })).toMatchObject({
      status: 'correct',
    });
  },
  60_000
);

test.each(independentCases)(
  'real Java agrees with hand-derived state: $name',
  async ({ body, classes, board, turtles }) => {
    const source = `class Main { public static void main(String[] args) { ${body} } } ${classes ?? ''}`;
    expect(await executeState(source, body)).toEqual({ board, turtles });
  },
  30_000
);

test('legacy multiple holes all display and their repaired Java matches the existing target', async () => {
  const problem = instantiateProblem('fillInBlank4', 'java', 'catalog-compatibility');
  expect(problem).toBeDefined();
  if (!problem) throw new Error('Legacy blank problem unavailable');
  expect(
    await gradeFillInBlankCode(problem, fillBlanks(problem.displayProgramTemplate, problem.blankAnswers), {
      javaExecutors: [localJavaExecutor],
    })
  ).toMatchObject({ status: 'correct' });
  expect(
    await gradeFillInBlankCode(problem, 'class Main { public static void main(String[] args) { if (1) {} } }', {
      javaExecutors: [localJavaExecutor],
    })
  ).toMatchObject({
    status: 'incorrect',
    stage: 4,
    detail: 'Compile error.',
    diagnostics: expect.arrayContaining([expect.objectContaining({ message: expect.any(String) })]),
  });
  expect(problem.blankAnswers.length).toBeGreaterThan(1);
  for (let i = 1; i <= problem.blankAnswers.length; i++) expect(problem.displayProgram).toContain(`【${i}】`);
  expect(
    await executeState(fillBlanks(problem.displayProgramTemplate, problem.blankAnswers), 'legacy multiple holes')
  ).toEqual({
    board: problem.finalBoard.trim(),
    turtles: problem.finalTurtles.map(({ x, y, color, dir }) => ({ x, y, color, dir })),
  });
}, 30_000);

test('local execution bounds nontermination and excessive output and cleans every temporary compilation', async () => {
  await mkdir('.tmp', { recursive: true });
  const root = await mkdtemp(resolve('.tmp/catalog-cleanup-'));
  const executor = createLocalJavaExecutor(root);
  const run = (source: string): Promise<JavaExecutionResult> =>
    executor.execute(buildJavaJudgeProgram(source, marker).program, JAVA_JUDGE_CLASS_NAME);
  try {
    const success = await run('class Main { public static void main(String[] args) { new Turtle(); } }');
    expect(success.kind).toBe('executed');
    expect(await readdir(root)).toEqual([]);
    const infinite = await run('class Main { public static void main(String[] args) { while (true) {} } }');
    expect(infinite.kind).toBe('timeout');
    expect(await readdir(root)).toEqual([]);
    const verbose = await run(
      'class Main { public static void main(String[] args) { while (true) System.out.println("excessive output"); } }'
    );
    expect(verbose.kind).toBe('outputLimitExceeded');
    expect(await readdir(root)).toEqual([]);
    const invalid = await run('class Main { public static void main(String[] args) { if (1) {} } }');
    expect(invalid.kind).toBe('compileError');
    expect(await readdir(root)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

async function executeState(source: string, label: string): Promise<JavaTurtleState> {
  const result = await executeSource(source);
  expect(result.kind, `${label}: ${JSON.stringify(result)}`).toBe('executed');
  if (result.kind !== 'executed') throw new Error(`${label}: ${JSON.stringify(result)}`);
  const state = parseJavaJudgeOutput(result.stderr, marker);
  expect(state, `${label}: missing result`).toBeDefined();
  if (!state) throw new Error(`${label}: missing result`);
  expect(state.exception, `${label}: program exception`).toBeUndefined();
  return state;
}

function executeSource(source: string): Promise<JavaExecutionResult> {
  return localJavaExecutor.execute(buildJavaJudgeProgram(source, marker).program, JAVA_JUDGE_CLASS_NAME);
}

function gradeOnce(
  target: { finalBoard: string; finalTurtles: JavaTurtleState['turtles'] },
  source: string
): ReturnType<typeof gradeFillInBlankCode> {
  const key = JSON.stringify({ source, finalBoard: target.finalBoard, finalTurtles: target.finalTurtles });
  let result = gradingResults.get(key);
  if (!result) {
    result = gradeFillInBlankCode(target, source, { javaExecutors: [localJavaExecutor] });
    gradingResults.set(key, result);
  }
  return result;
}
