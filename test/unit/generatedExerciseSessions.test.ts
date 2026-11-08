/* oxlint-disable unicorn/no-null -- SQLite returns NULL for legacy snapshot columns. */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { migrate } from 'drizzle-orm/node-sqlite/migrator';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { z } from 'zod';

import { problemSessions, users } from '../../db/schema';
import type { db as databaseClient } from '../../src/infrastructures/database';
import type { BackendRouter } from '../../src/infrastructures/trpcBackend/routers';
import type { instantiateProblem as InstantiateProblem } from '../../src/problems/instantiateProblem';
let instantiateProblem: typeof InstantiateProblem;

const auth = vi.hoisted(() => ({ userId: 'generated-student' }));
vi.mock('../../src/utils/sessionOnNode', () => ({
  getSessionOnNode: async () => ({ superTokensUserId: auth.userId }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/app/utils/withAuth', () => ({
  withAuthorizationOnServer:
    (
      page: (props: {
        params: { courseId: string; lectureId: string; problemId: string };
        searchParams: Record<string, never>;
        session: { superTokensUserId: string };
      }) => unknown
    ) =>
    (params: { courseId: string; lectureId: string; problemId: string }) =>
      page({ params, searchParams: {}, session: { superTokensUserId: auth.userId } }),
}));
vi.mock('../../src/app/(withAuth)/courses/[courseId]/lectures/[lectureId]/problems/[problemId]/pageOnClient', () => ({
  ProblemPageOnClient: () => {},
}));

const displaySchema = z
  .object({ sessionId: z.number(), problemId: z.string(), displayProgram: z.string(), completed: z.boolean() })
  .passthrough();
const location = { courseId: 'tuBeginner1', lectureId: 'lecture1' };
let directory: string;
let db: typeof databaseClient;
let caller: ReturnType<BackendRouter['createCaller']>;
let configured: Record<string, string[][]>;
let saved: string[][];
let sources: Record<string, string>;
let originalSource: string;

beforeAll(async () => {
  mkdirSync('.tmp', { recursive: true });
  directory = mkdtempSync(resolve('.tmp/generated-sessions-'));
  vi.stubEnv('DATABASE_URL', `file:${directory}/test.sqlite3`);
  vi.stubEnv(
    'NEXT_PUBLIC_COURSE_ID_TO_LECTURE_IDS_JSON',
    JSON.stringify({ test: ['test'], tuBeginner1: ['lecture1'] })
  );
  ({ instantiateProblem } = await import('../../src/problems/instantiateProblem'));
  ({ db } = await import('../../src/infrastructures/database'));
  migrate(db, { migrationsFolder: 'drizzle' });
  const { backendRouter } = await import('../../src/infrastructures/trpcBackend/routers');
  caller = backendRouter.createCaller({
    req: new Request('http://localhost', { headers: { Cookie: 'sAccessToken=test' } }),
    resHeaders: new Headers(),
    info: {} as never,
  });
  const data = await import('../../src/problems/problemData');
  configured = data.courseIdToLectureIndexToExerciseProblemIds;
  saved = configured.tuBeginner1;
  sources = data.problemIdToProgram;
  originalSource = sources.test1;
});
beforeEach(() => {
  db.$client.exec(
    'DELETE FROM ExerciseSubmission; DELETE FROM ExerciseSession; DELETE FROM ProblemSubmission; DELETE FROM ProblemSession; DELETE FROM User'
  );
  db.insert(users)
    .values([
      { id: 'generated-student', displayName: 'Student' },
      { id: 'other', displayName: 'Other' },
    ])
    .run();
  auth.userId = 'generated-student';
  configured.tuBeginner1 = [['test1']];
});
afterEach(() => {
  sources.test1 = originalSource;
});
afterAll(() => {
  configured.tuBeginner1 = saved;
  db?.$client.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

test.each(['fillInBlank', 'bugFix'] as const)(
  '%s persists a snapshot and resumes and grades after catalog removal',
  async (problemFormat) => {
    const exercise = displaySchema.parse(await caller.startExercise({ ...location, problemFormat }));
    expect(exercise.problemId).toBe('test1');
    for (const key of ['correctProgram', 'answer', 'range', 'starterProgram']) expect(exercise).not.toHaveProperty(key);
    const row = z
      .object({ seed: z.string(), generatedProblem: z.string() })
      .parse(db.$client.prepare('SELECT seed, generatedProblem FROM ExerciseSession').get());
    const model = instantiateProblem('test1', row.seed)!;
    const source = model.displayProgramTemplate;
    db.$client.close();
    vi.resetModules();
    ({ db } = await import('../../src/infrastructures/database'));
    ({ instantiateProblem } = await import('../../src/problems/instantiateProblem'));
    const catalog = await import('../../src/problems/problemData');
    configured = catalog.courseIdToLectureIndexToExerciseProblemIds;
    sources = catalog.problemIdToProgram;
    configured.tuBeginner1 = [[]];
    delete sources.test1;
    const { backendRouter } = await import('../../src/infrastructures/trpcBackend/routers');
    caller = backendRouter.createCaller({
      req: new Request('http://localhost', { headers: { Cookie: 'sAccessToken=test' } }),
      resHeaders: new Headers(),
      info: {} as never,
    });
    const reopened = new DatabaseSync(`${directory}/test.sqlite3`);
    expect(reopened.prepare('SELECT generatedProblem FROM ExerciseSession').get()).toEqual({
      generatedProblem: row.generatedProblem,
    });
    reopened.close();
    expect(await caller.startExercise({ ...location, problemFormat })).toEqual(exercise);
    expect(
      await caller.submitExercise({ ...location, problemFormat, sessionId: exercise.sessionId, code: source })
    ).toMatchObject({ status: 'correct' });
    expect(await caller.startExercise({ ...location, problemFormat })).toMatchObject({
      sessionId: exercise.sessionId,
      completed: true,
    });
    auth.userId = 'other';
    await expect(
      caller.submitExercise({ ...location, problemFormat, sessionId: exercise.sessionId, code: source })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  }
);

test('retired fixed sessions are retained as history but never regenerated or submitted', async () => {
  db.$client
    .prepare(
      `INSERT INTO ExerciseSession (userId, courseId, lectureId, learningMode, problemFormat, problemId, seed, problemType, traceItemIndex) VALUES (?, 'tuBeginner1', 'lecture1', 'challenge', 'bugFix', 'testTurnBug', 'old', 'bugFix', 0)`
    )
    .run(auth.userId);
  const old = z.object({ id: z.number() }).parse(db.$client.prepare('SELECT id FROM ExerciseSession').get());
  const current = displaySchema.parse(await caller.startExercise({ ...location, problemFormat: 'bugFix' }));
  expect(current.sessionId).not.toBe(old.id);
  await expect(
    caller.submitExercise({ ...location, problemFormat: 'bugFix', sessionId: old.id, code: 'class Main {}' })
  ).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(db.$client.prepare('SELECT id FROM ExerciseSession WHERE id = ?').get(old.id)).toEqual({ id: old.id });
  expect(db.$client.prepare('SELECT * FROM ExerciseSubmission').all()).toHaveLength(0);
});

test('unsuccessful source is skipped and complete exhaustion inserts no session', async () => {
  configured.tuBeginner1 = [['exception2']];
  expect(await caller.startExercise({ ...location, problemFormat: 'fillInBlank' })).toEqual({ status: 'noProblems' });
  expect(db.$client.prepare('SELECT * FROM ExerciseSession').all()).toHaveLength(0);
  configured.tuBeginner1 = [['exception2', 'test1']];
  expect(await caller.startExercise({ ...location, problemFormat: 'fillInBlank' })).toMatchObject({
    problemId: 'test1',
  });
});

test.each(['bugFix', 'executionResult', 'fillInBlank'])(
  'retired ordinary identity rejects writes even with stored %s format',
  async (problemType) => {
    const row = db
      .insert(problemSessions)
      .values({
        userId: auth.userId,
        ...location,
        problemId: 'testTurnBug',
        problemVariablesSeed: 'old',
        problemType,
        traceItemIndex: 0,
      })
      .returning()
      .get()!;
    const before = db.$client.prepare('SELECT * FROM ProblemSession').all();
    await expect(
      caller.gradeFillInBlankAnswers({ sessionId: row.id, code: 'class Main {}', elapsedMilliseconds: 1 })
    ).rejects.toThrow();
    await expect(caller.updateProblemSession({ id: row.id, problemType: 'step', traceItemIndex: 1 })).rejects.toThrow();
    await expect(
      caller.createProblemSubmission({
        sessionId: row.id,
        problemType: 'executionResult',
        traceItemIndex: 0,
        isCorrect: true,
        isCompleted: true,
        incrementalElapsedMilliseconds: 1,
      })
    ).rejects.toThrow();
    expect(db.$client.prepare('SELECT * FROM ProblemSession').all()).toEqual(before);
    expect(db.$client.prepare('SELECT * FROM ProblemSubmission').all()).toHaveLength(0);
  }
);

test('Next replays a saved successor after its source is no longer selectable', async () => {
  const format = { ...location, problemFormat: 'fillInBlank' as const };
  const first = displaySchema.parse(await caller.startExercise(format));
  const row = z
    .object({ seed: z.string() })
    .parse(db.$client.prepare('SELECT seed FROM ExerciseSession WHERE id = ?').get(first.sessionId));
  await caller.submitExercise({
    ...format,
    sessionId: first.sessionId,
    code: instantiateProblem('test1', row.seed)!.displayProgramTemplate,
  });
  const second = displaySchema.parse(await caller.nextExercise({ ...format, sessionId: first.sessionId }));
  configured.tuBeginner1 = [[]];
  delete sources.test1;
  expect(await caller.nextExercise({ ...format, sessionId: first.sessionId })).toEqual(second);
});

test('retired ordinary page rejects before creating a session', async () => {
  const module =
    await import('../../src/app/(withAuth)/courses/[courseId]/lectures/[lectureId]/problems/[problemId]/page');
  const openPage = module.default as unknown as (params: {
    courseId: string;
    lectureId: string;
    problemId: string;
  }) => Promise<unknown>;
  await expect(openPage({ ...location, problemId: 'testTurnBug' })).rejects.toThrow();
  expect(db.$client.prepare('SELECT * FROM ProblemSession').all()).toHaveLength(0);
});
