import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { migrate } from 'drizzle-orm/node-sqlite/migrator';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { z } from 'zod';

import { problemSessions, problemSubmissions, users } from '../../db/schema';
import type { db as databaseClient } from '../../src/infrastructures/database';
import type { BackendRouter } from '../../src/infrastructures/trpcBackend/routers';
import type * as JavaExecutors from '../../src/problems/fillInBlank/javaExecutors';
import type { instantiateProblem as instantiateProblemType } from '../../src/problems/instantiateProblem';

const auth = vi.hoisted(() => ({ userId: 'student' }));
vi.mock('../../src/utils/sessionOnNode', () => ({
  getSessionOnNode: async () => ({ superTokensUserId: auth.userId }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('../../src/problems/fillInBlank/javaExecutors', async (importOriginal) => {
  const original = await importOriginal<typeof JavaExecutors>();
  return {
    ...original,
    createWandboxExecutor: () => unavailable('wandbox'),
    createJudgeExecutor: () => unavailable('judge'),
  };
});

type ChallengeMap = Record<string, string[][]>;
interface Location {
  courseId: string;
  lectureId: string;
}
type Submission = Location & { sessionId: number; answers: string[] };
const exerciseSchema = z
  .object({ sessionId: z.number(), problemId: z.string(), displayProgram: z.string(), completed: z.boolean() })
  .passthrough();
type Exercise = z.infer<typeof exerciseSchema>;
let directory: string;
let sqlite: DatabaseSync;
let db: typeof databaseClient;
let caller: ReturnType<BackendRouter['createCaller']>;
let instantiateProblem: typeof instantiateProblemType;
let challengeMap: ChallengeMap;
let originalChallengeTestLectures: string[][] | undefined;
let regularMap: ChallengeMap;
let originalRegularTestLectures: string[][] | undefined;

beforeAll(async () => {
  mkdirSync('.tmp', { recursive: true });
  directory = mkdtempSync(resolve('.tmp/exercises-'));
  const path = `${directory}/test.sqlite3`;
  sqlite = new DatabaseSync(path);
  vi.stubEnv('DATABASE_URL', `file:${path}`);
  vi.stubEnv('NEXT_PUBLIC_COURSE_ID_TO_LECTURE_IDS_JSON', JSON.stringify({ test: ['test', 'other'] }));
  ({ instantiateProblem } = await import('../../src/problems/instantiateProblem'));
  ({ db } = await import('../../src/infrastructures/database'));
  migrate(db, { migrationsFolder: 'drizzle' });
  const { backendRouter } = await import('../../src/infrastructures/trpcBackend/routers');
  caller = backendRouter.createCaller({
    req: new Request('http://localhost', { headers: { Cookie: 'sAccessToken=test' } }),
    resHeaders: new Headers(),
    info: {} as never,
  });
  const problemData = (await import('../../src/problems/problemData')) as unknown as {
    courseIdToLectureIndexToExerciseProblemIds?: ChallengeMap;
    courseIdToLectureIndexToProblemIds: ChallengeMap;
  };
  challengeMap = problemData.courseIdToLectureIndexToExerciseProblemIds ?? {};
  originalChallengeTestLectures = challengeMap.test;
  regularMap = problemData.courseIdToLectureIndexToProblemIds;
  originalRegularTestLectures = regularMap.test;
});

beforeEach(() => {
  // Learning-period visibility is evaluated per request, so a test must not straddle a period boundary.
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
  auth.userId = 'student';
  sqlite.exec(
    'DELETE FROM ExerciseSubmission; DELETE FROM ExerciseSession; DELETE FROM ProblemSubmission; DELETE FROM ProblemSession; DELETE FROM User'
  );
  db.insert(users)
    .values([
      { id: 'student', displayName: 'Student' },
      { id: 'other', displayName: 'Other' },
    ])
    .run();
  challengeMap.test = [['fillInBlank2'], ['fillInBlank1']];
  regularMap.test = [['test1'], ['test2']];
});

afterEach(() => {
  vi.useRealTimers();
  if (originalChallengeTestLectures) challengeMap.test = originalChallengeTestLectures;
  else delete challengeMap.test;
  if (originalRegularTestLectures) regularMap.test = originalRegularTestLectures;
  else delete regularMap.test;
});

afterAll(() => {
  db?.$client.close();
  sqlite?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

test('stores identity and seed without snapshots, then regenerates a safe DTO', async () => {
  const first = await start();
  const columns = z
    .array(z.object({ name: z.string() }).passthrough())
    .parse(sqlite.prepare("PRAGMA table_info('ExerciseSession')").all());
  const names = new Set(columns.map(({ name }) => name));
  expect(names.has('problemId')).toBe(true);
  expect(names.has('seed')).toBe(true);
  for (const forbidden of [
    'exerciseProblemId',
    'baseProblemId',
    'programTemplate',
    'displayProgram',
    'blankCount',
    'finalBoard',
    'finalTurtles',
    'finalVars',
  ]) {
    expect(names.has(forbidden)).toBe(false);
  }
  const stored = one(
    z
      .object({
        userId: z.string(),
        courseId: z.string(),
        lectureId: z.string(),
        problemId: z.string(),
        seed: z.string(),
      })
      .passthrough(),
    'SELECT * FROM ExerciseSession'
  );
  expect(stored).toMatchObject({
    userId: 'student',
    courseId: 'test',
    lectureId: 'test',
    problemId: 'fillInBlank2',
    seed: expect.any(String),
  });
  expect(Object.keys(first).toSorted()).toEqual(
    [
      'blankCount',
      'completed',
      'displayProgram',
      'finalBoard',
      'finalTurtles',
      'finalVars',
      'problemFormat',
      'problemId',
      'sessionId',
    ].toSorted()
  );
  expect(first.displayProgram).toContain('【1】');
  expect(await start()).toEqual(first);
});

test('uses explicit challenge membership and distinguishes empty and invalid configurations', async () => {
  const exercise = await start();
  expect(exercise.problemId).toBe('fillInBlank2');
  sqlite.exec('DELETE FROM ExerciseSession');
  challengeMap.test = [[]];
  await expect(caller.startExercise(locationOnly())).resolves.toEqual({ status: 'noProblems' });
  await expect(caller.startExercise({ courseId: 'missing', lectureId: 'test' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
  await expect(caller.startExercise({ courseId: 'test', lectureId: 'missing' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
  challengeMap.test = [['notRegistered']];
  await expect(caller.startExercise(locationOnly())).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  challengeMap.test = [['test1']];
  await expect(caller.startExercise(locationOnly())).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  expect(one(z.object({ count: z.number() }), 'SELECT COUNT(*) AS count FROM ExerciseSession').count).toBe(0);
  challengeMap.test = [['fillInBlank2']];
  expect(await start()).toMatchObject({ problemId: 'fillInBlank2', completed: false });
});

test('normal and challenge boundaries share variable-sensitive grading', async () => {
  challengeMap.test = [['fillInBlank3']];
  const exercise = await start();
  const seed = one(z.object({ seed: z.string() }), 'SELECT seed FROM ExerciseSession').seed;
  const normal = db
    .insert(problemSessions)
    .values({
      userId: 'student',
      courseId: 'test',
      lectureId: 'test',
      problemId: 'fillInBlank3',
      problemVariablesSeed: seed,
      problemType: 'fillInBlank',
      traceItemIndex: 0,
    })
    .returning()
    .get()!;
  const variableWrong = ['int b = 1; t.右を向く();'];
  const challengeWrong = await caller.submitExercise(submission(exercise.sessionId, variableWrong));
  const normalWrong = await caller.gradeFillInBlankAnswers({
    sessionId: normal.id,
    answers: variableWrong,
    elapsedMilliseconds: 0,
  });
  expect(challengeWrong).toMatchObject({ status: 'incorrect' });
  expect(normalWrong).toMatchObject({ status: 'incorrect' });
  const challengeCorrect = await caller.submitExercise(submission(exercise.sessionId, ['t.turnRight();']));
  const normalCorrect = await caller.gradeFillInBlankAnswers({
    sessionId: normal.id,
    answers: ['t.turnRight();'],
    elapsedMilliseconds: 0,
  });
  expect(challengeCorrect).toMatchObject({ status: 'correct' });
  expect(normalCorrect).toMatchObject({ status: 'correct' });
  expect(sqlite.prepare('SELECT status, gradingStage FROM ExerciseSubmission ORDER BY id').all()).toEqual([
    { status: 'incorrect', gradingStage: 2 },
    { status: 'correct', gradingStage: 2 },
  ]);
  expect(sqlite.prepare('SELECT isCorrect, gradingStage FROM ProblemSubmission ORDER BY id').all()).toEqual([
    { isCorrect: 0, gradingStage: 2 },
    { isCorrect: 1, gradingStage: 2 },
  ]);
});

test('keeps incorrect and unavailable-executor attempts retryable on the same problem', async () => {
  const exercise = await start();
  expect(await caller.submitExercise(submission(exercise.sessionId, ['x']))).toMatchObject({ status: 'incorrect' });
  expect(await caller.submitExercise(submission(exercise.sessionId, ['Integer.valueOf(x) + 1']))).toMatchObject({
    status: 'ungradable',
  });
  expect(sqlite.prepare('SELECT status, answers FROM ExerciseSubmission ORDER BY id').all()).toEqual([
    { status: 'incorrect', answers: '["x"]' },
    { status: 'ungradable', answers: '["Integer.valueOf(x) + 1"]' },
  ]);
  expect(await start()).toMatchObject({ sessionId: exercise.sessionId, completed: false });
});

test('rejects cross-user and location-mismatched access without mutation', async () => {
  const exercise = await start();
  const before = exerciseRows();
  auth.userId = 'other';
  await expect(caller.submitExercise(submission(exercise.sessionId, ['x + 1']))).rejects.toMatchObject({
    code: 'UNAUTHORIZED',
  });
  auth.userId = 'student';
  await expect(
    caller.nextExercise({ courseId: 'test', lectureId: 'other', sessionId: exercise.sessionId })
  ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  expect(exerciseRows()).toEqual(before);
});

test('resumes only the current user and location session', async () => {
  auth.userId = 'other';
  const otherUser = await start();
  auth.userId = 'student';
  const otherLectureValue = await caller.startExercise({ courseId: 'test', lectureId: 'other' });
  const otherLecture = asExercise(otherLectureValue);

  const own = await start();
  expect(own.sessionId).not.toBe(otherUser.sessionId);
  expect(own.sessionId).not.toBe(otherLecture.sessionId);
  expect(await start()).toEqual(own);
  expect(one(z.object({ count: z.number() }), 'SELECT COUNT(*) AS count FROM ExerciseSession').count).toBe(3);
});

test('rolls back both sides of correct submission atomicity', async () => {
  const exercise = await start();
  sqlite.exec(
    "CREATE TRIGGER reject_exercise_submission BEFORE INSERT ON ExerciseSubmission BEGIN SELECT RAISE(ABORT, 'rejected'); END"
  );
  try {
    await expect(caller.submitExercise(submission(exercise.sessionId, ['x + 1']))).rejects.toThrow();
    expect(exerciseRows()).toMatchObject({ submissions: [], sessions: [expect.any(Object)] });
    expect(completion(exercise.sessionId)).toBeNull();
  } finally {
    sqlite.exec('DROP TRIGGER reject_exercise_submission');
  }
  sqlite.exec(
    "CREATE TRIGGER reject_exercise_completion BEFORE UPDATE OF completedAt ON ExerciseSession BEGIN SELECT RAISE(ABORT, 'rejected'); END"
  );
  try {
    await expect(caller.submitExercise(submission(exercise.sessionId, ['x + 1']))).rejects.toThrow();
    expect(exerciseRows()).toMatchObject({ submissions: [], sessions: [expect.any(Object)] });
    expect(completion(exercise.sessionId)).toBeNull();
  } finally {
    sqlite.exec('DROP TRIGGER reject_exercise_completion');
  }
});

test('deduplicates concurrent start, correct replay, and Next while isolating ordinary records', async () => {
  const normal = db
    .insert(problemSessions)
    .values({
      userId: 'student',
      courseId: 'test',
      lectureId: 'test',
      problemId: 'test1',
      problemVariablesSeed: 'normal',
      problemType: 'executionResult',
      traceItemIndex: 0,
      elapsedMilliseconds: 321,
    })
    .returning()
    .get()!;
  db.insert(problemSubmissions)
    .values({
      sessionId: normal.id,
      problemType: normal.problemType,
      traceItemIndex: 0,
      elapsedMilliseconds: 321,
      isCorrect: false,
    })
    .run();
  const normalBefore = normalRows();
  const [exercise, duplicate] = await Promise.all([start(), start()]);
  expect(duplicate).toEqual(exercise);
  const answer = submission(exercise.sessionId, ['x + 1']);
  const results = await Promise.all([caller.submitExercise(answer), caller.submitExercise(answer)]);
  expect(results.map(({ status }) => status)).toEqual(['correct', 'correct']);
  expect(await caller.submitExercise(answer)).toMatchObject({ status: 'correct' });
  expect(await caller.submitExercise(submission(exercise.sessionId, ['x']))).toMatchObject({ status: 'incorrect' });
  expect(one(z.object({ count: z.number() }), 'SELECT COUNT(*) AS count FROM ExerciseSubmission').count).toBe(1);
  const nextInput = { ...locationOnly(), sessionId: exercise.sessionId };
  const [next, duplicateNext] = await Promise.all([caller.nextExercise(nextInput), caller.nextExercise(nextInput)]);
  expect(duplicateNext).toEqual(next);
  expect(one(z.object({ count: z.number() }), 'SELECT COUNT(*) AS count FROM ExerciseSession').count).toBe(2);
  expect(normalRows()).toEqual(normalBefore);
});

test('stores distinct concurrent incorrect submissions', async () => {
  const exercise = await start();
  const results = await Promise.all([
    caller.submitExercise(submission(exercise.sessionId, ['x'])),
    caller.submitExercise(submission(exercise.sessionId, ['x + 2'])),
  ]);
  expect(results.map(({ status }) => status)).toEqual(['incorrect', 'incorrect']);
  expect(sqlite.prepare('SELECT answers, status, gradingStage FROM ExerciseSubmission ORDER BY id').all()).toEqual([
    { answers: '["x"]', status: 'incorrect', gradingStage: 2 },
    { answers: '["x + 2"]', status: 'incorrect', gradingStage: 2 },
  ]);
  expect(await start()).toMatchObject({ sessionId: exercise.sessionId, completed: false });
});

test('keeps a completed session visible when Next configuration fails and creates one successor on retry', async () => {
  const exercise = await start();
  expect(await caller.submitExercise(submission(exercise.sessionId, modelAnswers(exercise.sessionId)))).toMatchObject({
    status: 'correct',
  });
  const completed = await start();
  expect(completed).toMatchObject({ sessionId: exercise.sessionId, completed: true });
  expect(one(z.object({ count: z.number() }), 'SELECT COUNT(*) AS count FROM ExerciseSession').count).toBe(1);

  challengeMap.test = [['notRegistered'], ['fillInBlank1']];
  await expect(caller.nextExercise({ ...locationOnly(), sessionId: exercise.sessionId })).rejects.toMatchObject({
    code: 'INTERNAL_SERVER_ERROR',
  });
  expect(await start()).toEqual(completed);
  expect(one(z.object({ count: z.number() }), 'SELECT COUNT(*) AS count FROM ExerciseSession').count).toBe(1);

  challengeMap.test = [['fillInBlank2'], ['fillInBlank1']];
  const successor = await caller.nextExercise({ ...locationOnly(), sessionId: exercise.sessionId });
  expect(successor).toMatchObject({ completed: false });
  expect(one(z.object({ count: z.number() }), 'SELECT COUNT(*) AS count FROM ExerciseSession').count).toBe(2);
});

test('avoids the immediately previous candidate but keeps completed candidates eligible', async () => {
  challengeMap.test = [['fillInBlank1', 'fillInBlank2']];
  const first = await start();
  expect(await caller.submitExercise(submission(first.sessionId, modelAnswers(first.sessionId)))).toMatchObject({
    status: 'correct',
  });
  const second = asExercise(await caller.nextExercise({ ...locationOnly(), sessionId: first.sessionId }));
  expect(second.problemId).not.toBe(first.problemId);
  expect(await caller.submitExercise(submission(second.sessionId, modelAnswers(second.sessionId)))).toMatchObject({
    status: 'correct',
  });
  const third = asExercise(await caller.nextExercise({ ...locationOnly(), sessionId: second.sessionId }));
  expect(third.problemId).toBe(first.problemId);

  const beforeReplay = exerciseRows();
  const replayedFirstNext = asExercise(await caller.nextExercise({ ...locationOnly(), sessionId: first.sessionId }));
  expect(replayedFirstNext).toMatchObject({
    sessionId: second.sessionId,
    problemId: second.problemId,
    completed: true,
  });
  expect(exerciseRows()).toEqual(beforeReplay);
});

test('normal fill-in-the-blank submissions never create exercise history', async () => {
  const normal = db
    .insert(problemSessions)
    .values({
      userId: 'student',
      courseId: 'test',
      lectureId: 'test',
      problemId: 'fillInBlank2',
      problemVariablesSeed: 'normal-only',
      problemType: 'fillInBlank',
      traceItemIndex: 0,
    })
    .returning()
    .get()!;
  expect(
    await caller.gradeFillInBlankAnswers({ sessionId: normal.id, answers: ['x + 1'], elapsedMilliseconds: 1 })
  ).toMatchObject({ status: 'correct' });
  expect(one(z.object({ count: z.number() }), 'SELECT COUNT(*) AS count FROM ExerciseSession').count).toBe(0);
  expect(one(z.object({ count: z.number() }), 'SELECT COUNT(*) AS count FROM ExerciseSubmission').count).toBe(0);
});

test('advances a regular session to a regular successor while a newer blank session exists', async () => {
  const regular = await startRegular();
  const blank = await start();
  await submitRegular(regular, 'cross-format-next', true);
  const next = await regularCaller().nextExercise({
    ...locationOnly(),
    sessionId: regular.sessionId,
    problemFormat: 'regular',
  });
  expect(next).toMatchObject({ problemFormat: 'regular', completed: false });
  expect(next.sessionId).toBeGreaterThan(blank.sessionId);
});

test('creates and resumes regular and blank sessions independently', async () => {
  const blank = await start();
  const regular = await startRegular();
  expect(await start()).toEqual(blank);
  expect(await startRegular()).toEqual(regular);
  expect(regular).toMatchObject({
    problemFormat: 'regular',
    problemId: 'test1',
    seed: expect.any(String),
    problemType: 'executionResult',
    traceItemIndex: 0,
    completed: false,
  });
  expect(
    one(
      z.object({ count: z.number() }),
      "SELECT COUNT(*) AS count FROM ExerciseSession WHERE problemFormat = 'regular'"
    ).count
  ).toBe(1);
  expect(one(z.object({ count: z.number() }), 'SELECT COUNT(*) AS count FROM ExerciseSession').count).toBe(2);
});

test('derives regular candidates from normal membership without blank fallback', async () => {
  regularMap.test = [['fillInBlank1']];
  await expect(regularCaller().startExercise({ ...locationOnly(), problemFormat: 'regular' })).resolves.toEqual({
    status: 'noProblems',
  });
  regularMap.test = [['notRegistered']];
  await expect(regularCaller().startExercise({ ...locationOnly(), problemFormat: 'regular' })).rejects.toMatchObject({
    code: 'INTERNAL_SERVER_ERROR',
  });
  expect(sqlite.prepare('SELECT * FROM ExerciseSession').all()).toEqual([]);
});

test('keeps regular incorrect verdicts in execution-result mode and derives completion from stored state', async () => {
  const regular = await startRegular();
  for (let index = 0; index < 4; index += 1) {
    const result = await submitRegular(regular, `wrong-${index}`, false);
    expect(result).toMatchObject({ problemType: 'executionResult', traceItemIndex: 0, completed: false });
  }
  sqlite.prepare("UPDATE ExerciseSession SET problemId = 'does-not-exist' WHERE id = ?").run(regular.sessionId);
  expect(await submitRegular(regular, 'correct', true)).toMatchObject({ completed: true });
  const submissions = z
    .array(
      z.object({
        problemType: z.literal('executionResult'),
        traceItemIndex: z.literal(0),
        status: z.enum(['correct', 'incorrect']),
        answers: z.null(),
        gradingStage: z.null(),
      })
    )
    .parse(
      sqlite
        .prepare(
          'SELECT problemType, traceItemIndex, status, answers, gradingStage FROM ExerciseSubmission ORDER BY id'
        )
        .all()
    );
  expect(submissions.map(({ status }) => status)).toEqual([...Array.from({ length: 4 }, () => 'incorrect'), 'correct']);
});

test('switches regular exercise one way, resumes step 1, then advances and completes at the final trace item', async () => {
  const regular = await startRegular();
  const switched = await regularCaller().switchRegularExerciseToStep({
    ...locationOnly(),
    sessionId: regular.sessionId,
  });
  expect(switched).toMatchObject({ sessionId: regular.sessionId, problemType: 'step', traceItemIndex: 1 });
  expect(
    await regularCaller().switchRegularExerciseToStep({ ...locationOnly(), sessionId: regular.sessionId })
  ).toEqual(switched);
  expect(await startRegular()).toEqual(switched);

  let current = switched;
  while (!current.completed) {
    current = await submitRegular(current, `step-${current.traceItemIndex}`, true);
  }
  const instantiated = instantiateProblem(regular.problemId, 'java', regular.seed as string);
  if (!instantiated) throw new Error('stored regular problem must instantiate');
  expect(current.traceItemIndex).toBe(instantiated.traceItems.length - 1);
  await expect(
    regularCaller().switchRegularExerciseToStep({ ...locationOnly(), sessionId: regular.sessionId })
  ).rejects.toMatchObject({ code: 'CONFLICT' });
});

test('deduplicates an exact regular replay and rejects changed or stale request payloads without mutation', async () => {
  const regular = await startRegular();
  const switched = await regularCaller().switchRegularExerciseToStep({
    ...locationOnly(),
    sessionId: regular.sessionId,
  });
  const input = regularSubmission(switched, 'same-request', true);
  const [first, replay] = await Promise.all([
    regularCaller().submitRegularExercise(input),
    regularCaller().submitRegularExercise(input),
  ]);
  expect(replay).toEqual(first);
  expect(one(z.object({ count: z.number() }), 'SELECT COUNT(*) AS count FROM ExerciseSubmission').count).toBe(1);
  const before = exerciseRows();
  await expect(regularCaller().submitRegularExercise({ ...input, isCorrect: false })).rejects.toMatchObject({
    code: 'CONFLICT',
  });
  await expect(
    regularCaller().submitRegularExercise({
      ...input,
      context: { problemType: 'step', traceItemIndex: input.context.traceItemIndex + 1 },
    })
  ).rejects.toMatchObject({ code: 'CONFLICT' });
  await expect(
    regularCaller().submitRegularExercise(regularSubmission(switched, 'stale-request', true))
  ).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(exerciseRows()).toEqual(before);
});

test('serializes different regular request IDs so a newly stale request is not inserted', async () => {
  const regular = await startRegular();
  const switched = await regularCaller().switchRegularExerciseToStep({
    ...locationOnly(),
    sessionId: regular.sessionId,
  });
  const results = await Promise.allSettled([
    submitRegular(switched, 'concurrent-a', true),
    submitRegular(switched, 'concurrent-b', true),
  ]);
  expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1);
  expect(one(z.object({ count: z.number() }), 'SELECT COUNT(*) AS count FROM ExerciseSubmission').count).toBe(1);
  expect(sqlite.prepare('SELECT traceItemIndex FROM ExerciseSession WHERE id = ?').get(regular.sessionId)).toEqual({
    traceItemIndex: 2,
  });
});

test.each([{ isCompleted: true }, { problemType: 'step' }, { traceItemIndex: 1 }, { nextTraceItemIndex: 1 }])(
  'rejects a client-selected regular transition field: %s',
  async (extra) => {
    const regular = await startRegular();
    await expect(
      regularCaller().submitRegularExercise({ ...regularSubmission(regular, 'strict', true), ...extra })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(sqlite.prepare('SELECT * FROM ExerciseSubmission').all()).toEqual([]);
    expect(completion(regular.sessionId)).toBeNull();
  }
);

test.each([{ problemType: 'step' }, { traceItemIndex: 1 }, { isCompleted: true }])(
  'rejects an unknown explicit-regular start field: %s',
  async (extra) => {
    await expect(
      regularCaller().startExercise({ ...locationOnly(), problemFormat: 'regular', ...extra })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(sqlite.prepare('SELECT * FROM ExerciseSession').all()).toEqual([]);
  }
);

test('keeps omitted-format blank start/Next compatible while explicit regular Next is strict', async () => {
  const blank = await start();
  expect(blank.problemId).toBe('fillInBlank2');
  await caller.submitExercise(submission(blank.sessionId, modelAnswers(blank.sessionId)));
  await expect(caller.nextExercise({ ...locationOnly(), sessionId: blank.sessionId })).resolves.toMatchObject({
    completed: false,
  });

  sqlite.exec('DELETE FROM ExerciseSubmission; DELETE FROM ExerciseSession');
  const regular = await startRegular();
  const completed = await submitRegular(regular, 'complete-before-strict-next', true);
  await expect(
    regularCaller().nextExercise({
      ...locationOnly(),
      sessionId: completed.sessionId,
      problemFormat: 'regular',
      nextTraceItemIndex: 1,
    })
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  expect(one(z.object({ count: z.number() }), 'SELECT COUNT(*) AS count FROM ExerciseSession').count).toBe(1);
});

test('rolls back regular submission and transition together', async () => {
  const regular = await startRegular();
  sqlite.exec(
    "CREATE TRIGGER reject_regular_completion BEFORE UPDATE OF completedAt ON ExerciseSession BEGIN SELECT RAISE(ABORT, 'rejected'); END"
  );
  try {
    await expect(submitRegular(regular, 'rollback', true)).rejects.toThrow();
    expect(sqlite.prepare('SELECT * FROM ExerciseSubmission').all()).toEqual([]);
    expect(completion(regular.sessionId)).toBeNull();
  } finally {
    sqlite.exec('DROP TRIGGER reject_regular_completion');
  }
});

test('authorizes regular format and location and keeps Next in regular execution-result mode', async () => {
  const regular = await startRegular();
  await expect(
    regularCaller().nextExercise({ ...locationOnly(), sessionId: regular.sessionId, problemFormat: 'regular' })
  ).rejects.toMatchObject({ code: 'CONFLICT' });
  const before = exerciseRows();
  auth.userId = 'other';
  await expect(submitRegular(regular, 'other-user', true)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  auth.userId = 'student';
  await expect(
    regularCaller().submitRegularExercise({
      ...regularSubmission(regular, 'other-location', true),
      lectureId: 'other',
    })
  ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  expect(exerciseRows()).toEqual(before);

  const completed = await submitRegular(regular, 'complete', true);
  regularMap.test = [['test1', 'test2']];
  const next = await regularCaller().nextExercise({
    ...locationOnly(),
    sessionId: completed.sessionId,
    problemFormat: 'regular',
  });
  expect(next).toMatchObject({ problemFormat: 'regular', problemType: 'executionResult', traceItemIndex: 0 });
  expect(next.problemId).not.toBe(regular.problemId);
});

test('rejects cross-format and expired regular access without mutation', async () => {
  const blank = await start();
  await expect(
    regularCaller().submitRegularExercise({
      ...locationOnly(),
      sessionId: blank.sessionId,
      requestId: 'wrong-format',
      context: { problemType: 'executionResult', traceItemIndex: 0 },
      isCorrect: true,
    })
  ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

  const regular = await startRegular();
  sqlite.prepare('UPDATE ExerciseSession SET createdAt = 0 WHERE id = ?').run(regular.sessionId);
  vi.setSystemTime(new Date('2026-07-15T12:00:00+09:00'));
  const before = exerciseRows();
  await expect(submitRegular(regular, 'expired', true)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect(exerciseRows()).toEqual(before);
});

test('completes a step session whose stored index is past the final trace item of the current definition', async () => {
  const regular = await startRegular();
  const instantiated = instantiateProblem(regular.problemId, 'java', regular.seed as string);
  if (!instantiated) throw new Error('stored regular problem must instantiate');
  // A definition edited to have fewer steps leaves an active session beyond the regenerated trace.
  sqlite
    .prepare("UPDATE ExerciseSession SET problemType = 'step', traceItemIndex = ? WHERE id = ?")
    .run(instantiated.traceItems.length + 1, regular.sessionId);
  const resumed = await startRegular();
  expect(await submitRegular(resumed, 'past-final', true)).toMatchObject({ completed: true });
});

test('refuses to resume a regular session whose problem definition no longer exists', async () => {
  const regular = await startRegular();
  sqlite.prepare("UPDATE ExerciseSession SET problemId = 'removedProblem' WHERE id = ?").run(regular.sessionId);
  await expect(startRegular()).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
});

test('rejects switching blank, later-step, and corrupt regular states', async () => {
  const blank = await start();
  await expect(
    regularCaller().switchRegularExerciseToStep({ ...locationOnly(), sessionId: blank.sessionId })
  ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

  const regular = await startRegular();
  sqlite
    .prepare("UPDATE ExerciseSession SET problemType = 'step', traceItemIndex = 2 WHERE id = ?")
    .run(regular.sessionId);
  await expect(
    regularCaller().switchRegularExerciseToStep({ ...locationOnly(), sessionId: regular.sessionId })
  ).rejects.toMatchObject({ code: 'CONFLICT' });
  sqlite
    .prepare("UPDATE ExerciseSession SET problemType = 'executionResult', traceItemIndex = 1 WHERE id = ?")
    .run(regular.sessionId);
  await expect(
    regularCaller().switchRegularExerciseToStep({ ...locationOnly(), sessionId: regular.sessionId })
  ).rejects.toMatchObject({ code: 'CONFLICT' });
});

test('leaves normal session and submission rows unchanged during regular challenge transitions', async () => {
  const normal = db
    .insert(problemSessions)
    .values({
      userId: 'student',
      courseId: 'test',
      lectureId: 'test',
      problemId: 'test1',
      problemVariablesSeed: 'normal-regular-invariant',
      problemType: 'executionResult',
      traceItemIndex: 0,
      elapsedMilliseconds: 10,
    })
    .returning()
    .get()!;
  db.insert(problemSubmissions)
    .values({
      sessionId: normal.id,
      problemType: 'executionResult',
      traceItemIndex: 0,
      elapsedMilliseconds: 10,
      isCorrect: false,
    })
    .run();
  const before = normalRows();
  const regular = await startRegular();
  await submitRegular(regular, 'normal-invariant-wrong', false);
  await regularCaller().switchRegularExerciseToStep({ ...locationOnly(), sessionId: regular.sessionId });
  expect(normalRows()).toEqual(before);
});

test('leaves a regular session unchanged when the step switch update fails', async () => {
  const regular = await startRegular();
  sqlite.exec(
    "CREATE TRIGGER reject_regular_switch BEFORE UPDATE OF problemType ON ExerciseSession BEGIN SELECT RAISE(ABORT, 'rejected'); END"
  );
  try {
    await expect(
      regularCaller().switchRegularExerciseToStep({ ...locationOnly(), sessionId: regular.sessionId })
    ).rejects.toThrow();
    expect(
      sqlite.prepare('SELECT problemType, traceItemIndex FROM ExerciseSession WHERE id = ?').get(regular.sessionId)
    ).toEqual({
      problemType: 'executionResult',
      traceItemIndex: 0,
    });
  } finally {
    sqlite.exec('DROP TRIGGER reject_regular_switch');
  }
});

const start = async (): Promise<Exercise> => {
  const value = await caller.startExercise(locationOnly());
  return asExercise(value);
};
type RegularExercise = Exercise & {
  problemFormat: 'regular';
  seed: string;
  problemType: 'executionResult' | 'step';
  traceItemIndex: number;
};
interface RegularSubmissionInput extends Location {
  [key: string]: unknown;
  sessionId: number;
  requestId: string;
  context: { problemType: RegularExercise['problemType']; traceItemIndex: number };
  isCorrect: boolean;
}
const regularCaller = (): Record<string, (input: Record<string, unknown>) => Promise<RegularExercise>> =>
  caller as never;
const startRegular = async (): Promise<RegularExercise> =>
  (await regularCaller().startExercise({ ...locationOnly(), problemFormat: 'regular' })) as RegularExercise;
const regularSubmission = (
  exercise: RegularExercise,
  requestId: string,
  isCorrect: boolean
): RegularSubmissionInput => ({
  ...locationOnly(),
  sessionId: exercise.sessionId,
  requestId,
  context: { problemType: exercise.problemType, traceItemIndex: exercise.traceItemIndex },
  isCorrect,
});
const submitRegular = async (
  exercise: RegularExercise,
  requestId: string,
  isCorrect: boolean
): Promise<RegularExercise> => regularCaller().submitRegularExercise(regularSubmission(exercise, requestId, isCorrect));
const asExercise = (value: unknown): Exercise => exerciseSchema.parse(value);
const unavailable = (name: string): JavaExecutors.JavaExecutor => ({
  name,
  execute: async (): Promise<JavaExecutors.JavaExecutionResult> => ({
    kind: 'unavailable',
    reason: 'controlled outage',
  }),
});
const locationOnly = (): Location => ({ courseId: 'test', lectureId: 'test' });
const submission = (sessionId: number, answers: string[]): Submission => ({ ...locationOnly(), sessionId, answers });
const one = <T>(schema: z.ZodType<T>, sql: string): T => schema.parse(sqlite.prepare(sql).get());
const completion = (sessionId: number): number | null =>
  z
    .object({ completedAt: z.number().nullable() })
    .parse(sqlite.prepare('SELECT completedAt FROM ExerciseSession WHERE id = ?').get(sessionId)).completedAt;
const modelAnswers = (sessionId: number): string[] => {
  const stored = z
    .object({ problemId: z.string(), seed: z.string() })
    .parse(sqlite.prepare('SELECT problemId, seed FROM ExerciseSession WHERE id = ?').get(sessionId));
  const problem = instantiateProblem(stored.problemId, 'java', stored.seed);
  if (!problem) throw new Error(`Unknown problem: ${stored.problemId}`);
  return problem.blankAnswers;
};
const exerciseRows = (): { sessions: unknown[]; submissions: unknown[] } => ({
  sessions: sqlite.prepare('SELECT * FROM ExerciseSession ORDER BY id').all(),
  submissions: sqlite.prepare('SELECT * FROM ExerciseSubmission ORDER BY id').all(),
});
const normalRows = (): { sessions: unknown[]; submissions: unknown[] } => ({
  sessions: sqlite.prepare('SELECT * FROM ProblemSession ORDER BY id').all(),
  submissions: sqlite.prepare('SELECT * FROM ProblemSubmission ORDER BY id').all(),
});
