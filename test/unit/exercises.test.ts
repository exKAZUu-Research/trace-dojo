/* oxlint-disable unicorn/no-null -- SQLite returns SQL NULL for absent legacy/source fields. */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { ChakraProvider } from '@chakra-ui/react';
import { createTRPCUntypedClient, httpLink, type TRPCUntypedClient } from '@trpc/client';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { migrate } from 'drizzle-orm/node-sqlite/migrator';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import superjson from 'superjson';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { z } from 'zod';

import { problemSessions, problemSubmissions, users } from '../../db/schema';
import type { db as databaseClient } from '../../src/infrastructures/database';
import type { BackendRouter } from '../../src/infrastructures/trpcBackend/routers';
import type { ChallengeMetadata } from '../../src/problems/challenge/metadata';
import { fillBlanks } from '../../src/problems/fillInBlank/blanks';
import type { instantiateProblem as instantiateProblemType } from '../../src/problems/instantiateProblem';

const auth = vi.hoisted(() => ({ userId: 'student' }));
vi.mock('../../src/utils/sessionOnNode', () => ({
  getSessionOnNode: async () => ({ superTokensUserId: auth.userId }),
}));
vi.mock('../../src/app/utils/withAuth', () => ({
  withAuthorizationOnServer:
    (page: (props: object) => Promise<ReactNode>) =>
    async ({ params }: { params: Promise<object> }) =>
      page({ params: await params, session: { superTokensUserId: auth.userId }, searchParams: {} }),
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  useParams: () => ({ courseId: 'test', lectureId: 'test' }),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('../../src/app/(withAuth)/courses/[courseId]/lectures/[lectureId]/problems/[problemId]/pageOnClient', () => ({
  ProblemPageOnClient: () => {},
}));
vi.mock('../../src/contexts/AuthContext', () => ({
  useAuthContextSelector: (selector: (value: { currentUserId: string }) => unknown) =>
    selector({ currentUserId: auth.userId }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
type ChallengeMap = Record<string, string[][]>;
interface Location {
  courseId: string;
  lectureId: string;
}
type Submission = Location & { sessionId: number; code: string };
const exerciseSchema = z
  .object({
    sessionId: z.number(),
    problemId: z.string(),
    displayProgram: z.string(),
    completed: z.boolean(),
  })
  .passthrough();
type Exercise = z.infer<typeof exerciseSchema>;
let directory: string;
let sqlite: DatabaseSync;
let db: typeof databaseClient;
let caller: ReturnType<BackendRouter['createCaller']>;
let runtimeCaller: TRPCUntypedClient<BackendRouter>;
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
  vi.stubEnv(
    'NEXT_PUBLIC_COURSE_ID_TO_LECTURE_IDS_JSON',
    JSON.stringify({ test: ['test', 'other'], other: ['test'], tuBeginner1: ['lecture1'], tuBeginner2: ['lecture1'] })
  );
  ({ instantiateProblem } = await import('../../src/problems/instantiateProblem'));
  ({ db } = await import('../../src/infrastructures/database'));
  migrate(db, { migrationsFolder: 'drizzle' });
  const { backendRouter } = await import('../../src/infrastructures/trpcBackend/routers');
  runtimeCaller = createTRPCUntypedClient<BackendRouter>({
    links: [
      httpLink({
        url: 'http://localhost/api/trpc',
        transformer: superjson,
        headers: { Cookie: 'sAccessToken=test' },
        fetch: async (url, options) =>
          fetchRequestHandler({
            endpoint: '/api/trpc',
            req: new Request(url, options),
            router: backendRouter,
            createContext: (context) => context,
          }),
      }),
    ],
  });
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
    ['completed', 'displayProgram', 'finalBoard', 'finalTurtles', 'problemFormat', 'problemId', 'sessionId'].toSorted()
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
  await expect(caller.startExercise(locationOnly())).rejects.toMatchObject({
    code: 'INTERNAL_SERVER_ERROR',
  });
  challengeMap.test = [['test1']];
  await expect(caller.startExercise(locationOnly())).rejects.toMatchObject({
    code: 'INTERNAL_SERVER_ERROR',
  });
  expect(one(z.object({ count: z.number() }), 'SELECT COUNT(*) AS count FROM ExerciseSession').count).toBe(0);
  challengeMap.test = [['fillInBlank2']];
  expect(await start()).toMatchObject({ problemId: 'fillInBlank2', completed: false });
});

test('normal and challenge grade the full source by drawing and preserve it verbatim', async () => {
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
  const code = `  \n${source(exercise.sessionId, ['int extra = 99; t.右を向く();'])}\n  `;
  const wrongCode = code.replace('new Turtle()', 'new Turtle(1, 0)');
  expect(
    await caller.submitExercise({
      ...locationOnly(),
      sessionId: exercise.sessionId,
      code: wrongCode,
    })
  ).toMatchObject({ status: 'incorrect' });
  expect(
    await caller.gradeFillInBlankAnswers({
      sessionId: normal.id,
      code: wrongCode,
      elapsedMilliseconds: 123,
    })
  ).toMatchObject({ status: 'incorrect' });
  expect(await caller.submitExercise({ ...locationOnly(), sessionId: exercise.sessionId, code })).toMatchObject({
    status: 'correct',
  });
  expect(
    await caller.gradeFillInBlankAnswers({
      sessionId: normal.id,
      code,
      elapsedMilliseconds: 456,
    })
  ).toMatchObject({ status: 'correct' });
  expect(sqlite.prepare('SELECT code, answers, status FROM ExerciseSubmission ORDER BY id').all()).toEqual([
    { code: wrongCode, answers: null, status: 'incorrect' },
    { code, answers: null, status: 'correct' },
  ]);
  expect(
    sqlite.prepare('SELECT code, answers, isCorrect, elapsedMilliseconds FROM ProblemSubmission ORDER BY id').all()
  ).toEqual([
    { code: wrongCode, answers: null, isCorrect: 0, elapsedMilliseconds: 123 },
    { code, answers: null, isCorrect: 1, elapsedMilliseconds: 456 },
  ]);
  expect(completion(exercise.sessionId)).not.toBeNull();
  expect(sqlite.prepare('SELECT completedAt FROM ProblemSession WHERE id = ?').get(normal.id)).toMatchObject({
    completedAt: expect.any(Number),
  });
  expect(
    await caller.gradeFillInBlankAnswers({
      sessionId: normal.id,
      code,
      elapsedMilliseconds: 456,
    })
  ).toMatchObject({ status: 'correct' });
  expect(sqlite.prepare('SELECT code, isCorrect FROM ProblemSubmission ORDER BY id').all()).toEqual([
    { code: wrongCode, isCorrect: 0 },
    { code, isCorrect: 1 },
    { code, isCorrect: 1 },
  ]);
});

test('keeps incorrect and time-limit attempts retryable on the same problem', async () => {
  const exercise = await start();
  const wrong = submission(exercise.sessionId, ['x']);
  expect(await caller.submitExercise(wrong)).toMatchObject({ status: 'incorrect' });
  const endless = {
    ...locationOnly(),
    sessionId: exercise.sessionId,
    code: 'public class Main { public static void main(String[] args) { while (true) {} } }',
  };
  expect(await caller.submitExercise(endless)).toEqual({ status: 'incorrect', detail: 'Time limit exceeded.' });
  expect(sqlite.prepare('SELECT status, code, answers FROM ExerciseSubmission ORDER BY id').all()).toEqual([
    { status: 'incorrect', code: wrong.code, answers: null },
    { status: 'incorrect', code: endless.code, answers: null },
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
  expect(await caller.submitExercise(submission(exercise.sessionId, ['x']))).toMatchObject({
    status: 'incorrect',
  });
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
  expect(sqlite.prepare('SELECT code, status FROM ExerciseSubmission ORDER BY id').all()).toEqual([
    { code: source(exercise.sessionId, ['x']), status: 'incorrect' },
    { code: source(exercise.sessionId, ['x + 2']), status: 'incorrect' },
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

  challengeMap.test = [['fillInBlank2', 'notRegistered'], ['fillInBlank1']];
  await expect(caller.nextExercise({ ...locationOnly(), sessionId: exercise.sessionId })).rejects.toMatchObject({
    code: 'INTERNAL_SERVER_ERROR',
  });
  expect(await start()).toEqual(completed);
  expect(one(z.object({ count: z.number() }), 'SELECT COUNT(*) AS count FROM ExerciseSession').count).toBe(1);

  challengeMap.test = [['fillInBlank2'], ['fillInBlank1']];
  const successor = await caller.nextExercise({
    ...locationOnly(),
    sessionId: exercise.sessionId,
  });
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
    await caller.gradeFillInBlankAnswers({
      sessionId: normal.id,
      code: fillBlanks(instantiateProblem('fillInBlank2', 'normal-only')!.displayProgramTemplate, ['x + 1']),
      elapsedMilliseconds: 1,
    })
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
    expect(result).toMatchObject({
      problemType: 'executionResult',
      traceItemIndex: 0,
      completed: false,
    });
  }
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

test('rejects a corrupted challenge identity without changing exercise rows', async () => {
  const regular = await startRegular();
  sqlite.prepare("UPDATE ExerciseSession SET problemId = 'does-not-exist' WHERE id = ?").run(regular.sessionId);
  const before = exerciseRows();
  await expect(submitRegular(regular, 'corrupt-challenge', true)).rejects.toMatchObject({
    code: 'INTERNAL_SERVER_ERROR',
  });
  expect(exerciseRows()).toEqual(before);
  await expect(startRegular()).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  expect(exerciseRows()).toEqual(before);
});

test('switches regular exercise one way, resumes step 1, then advances and completes at the final trace item', async () => {
  const regular = await startRegular();
  const switched = await regularCaller().switchRegularExerciseToStep({
    ...locationOnly(),
    sessionId: regular.sessionId,
  });
  expect(switched).toMatchObject({
    sessionId: regular.sessionId,
    problemType: 'step',
    traceItemIndex: 1,
  });
  expect(
    await regularCaller().switchRegularExerciseToStep({
      ...locationOnly(),
      sessionId: regular.sessionId,
    })
  ).toEqual(switched);
  expect(await startRegular()).toEqual({ ...switched, problem: expect.any(Object) });

  let current = switched;
  while (!current.completed) {
    current = await submitRegular(current, `step-${current.traceItemIndex}`, true);
  }
  const instantiated = instantiateProblem(regular.problemId, regular.seed as string);
  if (!instantiated) throw new Error('stored regular problem must instantiate');
  expect(current.traceItemIndex).toBe(instantiated.traceItems.length - 1);
  await expect(
    regularCaller().switchRegularExerciseToStep({
      ...locationOnly(),
      sessionId: regular.sessionId,
    })
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
      regularCaller().submitRegularExercise({
        ...regularSubmission(regular, 'strict', true),
        ...extra,
      })
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
    regularCaller().nextExercise({
      ...locationOnly(),
      sessionId: regular.sessionId,
      problemFormat: 'regular',
    })
  ).rejects.toMatchObject({ code: 'CONFLICT' });
  const before = exerciseRows();
  auth.userId = 'other';
  await expect(submitRegular(regular, 'other-user', true)).rejects.toMatchObject({
    code: 'UNAUTHORIZED',
  });
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
  expect(next).toMatchObject({
    problemFormat: 'regular',
    problemType: 'executionResult',
    traceItemIndex: 0,
  });
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
  await expect(submitRegular(regular, 'expired', true)).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
  expect(exerciseRows()).toEqual(before);
});

test('completes a step session whose stored index is past the final trace item of the current definition', async () => {
  const regular = await startRegular();
  const instantiated = instantiateProblem(regular.problemId, regular.seed as string);
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
    regularCaller().switchRegularExerciseToStep({
      ...locationOnly(),
      sessionId: regular.sessionId,
    })
  ).rejects.toMatchObject({ code: 'CONFLICT' });
  sqlite
    .prepare("UPDATE ExerciseSession SET problemType = 'executionResult', traceItemIndex = 1 WHERE id = ?")
    .run(regular.sessionId);
  await expect(
    regularCaller().switchRegularExerciseToStep({
      ...locationOnly(),
      sessionId: regular.sessionId,
    })
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
  await regularCaller().switchRegularExerciseToStep({
    ...locationOnly(),
    sessionId: regular.sessionId,
  });
  expect(normalRows()).toEqual(before);
});

test('leaves a regular session unchanged when the step switch update fails', async () => {
  const regular = await startRegular();
  sqlite.exec(
    "CREATE TRIGGER reject_regular_switch BEFORE UPDATE OF problemType ON ExerciseSession BEGIN SELECT RAISE(ABORT, 'rejected'); END"
  );
  try {
    await expect(
      regularCaller().switchRegularExerciseToStep({
        ...locationOnly(),
        sessionId: regular.sessionId,
      })
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

test('practice resumes independently, repeats through step mode, and leaves overlapping graded records unchanged', async () => {
  const practice = await startPractice();
  const normal = db
    .insert(problemSessions)
    .values({
      id: practice.sessionId,
      userId: 'student',
      courseId: 'test',
      lectureId: 'test',
      problemId: 'test1',
      problemVariablesSeed: 'graded-overlap',
      problemType: 'executionResult',
      traceItemIndex: 0,
      elapsedMilliseconds: 321,
    })
    .returning()
    .get()!;
  db.insert(problemSubmissions)
    .values({
      sessionId: normal.id,
      problemType: 'executionResult',
      traceItemIndex: 0,
      elapsedMilliseconds: 321,
      isCorrect: false,
    })
    .run();
  const gradedBefore = normalRows();
  const challenge = await startRegular();
  expect(challenge.sessionId).not.toBe(practice.sessionId);
  expect(instantiateProblem(practice.problemId, practice.seed)).toBeUndefined();
  expect(await startPractice()).toEqual(practice);
  expect(await startRegular()).toEqual(challenge);

  const wrongInput = practiceSubmission(practice, 'shared-request', false);
  const [wrong, replay] = await Promise.all([
    runtimeCaller.mutation('submitRegularExercise', wrongInput),
    runtimeCaller.mutation('submitRegularExercise', wrongInput),
  ]);
  expect(replay).toEqual(wrong);
  expect(wrong).toMatchObject({ completed: false, problemType: 'executionResult', traceItemIndex: 0 });
  await submitRegular(challenge, 'shared-request', false);
  const challengeBefore = sqlite.prepare('SELECT * FROM ExerciseSession WHERE id = ?').get(challenge.sessionId);
  const challengeAttemptsBefore = sqlite
    .prepare('SELECT * FROM ExerciseSubmission WHERE sessionId = ?')
    .all(challenge.sessionId);
  const switched = regularDisplaySchema.parse(
    await runtimeCaller.mutation('switchRegularExerciseToStep', practiceSession(practice.sessionId))
  );
  expect(switched).toMatchObject({
    sessionId: practice.sessionId,
    seed: practice.seed,
    problemType: 'step',
    traceItemIndex: 1,
  });
  expect(await startPractice()).toEqual(switched);
  let current = switched;
  while (!current.completed) {
    expect(current.traceItemIndex).toBeLessThan(500);
    const previousIndex = current.traceItemIndex;
    current = regularDisplaySchema.parse(
      await runtimeCaller.mutation('submitRegularExercise', practiceSubmission(current, `step-${previousIndex}`, true))
    );
    if (!current.completed) expect(current.traceItemIndex).toBe(previousIndex + 1);
  }
  expect(await startPractice()).toEqual(current);
  const nextInput = { ...practiceSession(practice.sessionId), problemFormat: 'regular' as const };
  const [nextValue, duplicate] = await Promise.all([
    runtimeCaller.mutation('nextExercise', nextInput),
    runtimeCaller.mutation('nextExercise', nextInput),
  ]);
  expect(duplicate).toEqual(nextValue);
  const next = regularDisplaySchema.parse(nextValue);
  expect(next).toMatchObject({ completed: false, problemType: 'executionResult', traceItemIndex: 0 });
  expect(next.sessionId).not.toBe(practice.sessionId);
  expect(next.seed).not.toBe(practice.seed);
  expect(next.problemId).not.toBe(practice.problemId);
  expect(await startPractice()).toEqual(next);
  expect(sqlite.prepare('SELECT * FROM ExerciseSession WHERE id = ?').get(challenge.sessionId)).toEqual(
    challengeBefore
  );
  expect(sqlite.prepare('SELECT * FROM ExerciseSubmission WHERE sessionId = ?').all(challenge.sessionId)).toEqual(
    challengeAttemptsBefore
  );
  expect(
    sqlite.prepare('SELECT status FROM ExerciseSubmission WHERE sessionId = ? ORDER BY id').all(practice.sessionId)
  ).toEqual([
    { status: 'incorrect' },
    ...Array.from({ length: current.traceItemIndex }, () => ({ status: 'correct' })),
  ]);
  expect(normalRows()).toEqual(gradedBefore);
});

test('normal URLs reject practice and foreign membership before inserting, and rendered graded progress survives practice completion', async () => {
  const { default: problemPage } =
    await import('../../src/app/(withAuth)/courses/[courseId]/lectures/[lectureId]/problems/[problemId]/page');
  const { default: lecturePage } =
    await import('../../src/app/(withAuth)/courses/[courseId]/lectures/[lectureId]/page');
  const route = problemPage as unknown as (props: {
    params: Promise<Location & { problemId: string }>;
  }) => Promise<ReactNode>;
  const lecture = lecturePage as unknown as (props: { params: Promise<Location> }) => Promise<ReactNode>;
  const renderLecture = async (): Promise<string> =>
    renderToStaticMarkup(createElement(ChakraProvider, {}, await lecture({ params: Promise.resolve(locationOnly()) })));
  const beforeInvalid = normalRows();
  for (const problemId of ['practiceEasyV1TestL1ScalarUpdateV1', 'practiceTestL1A', 'test2', 'missing', 'toString']) {
    await expect(route({ params: Promise.resolve({ ...locationOnly(), problemId }) })).rejects.toThrow(
      'NEXT_NOT_FOUND'
    );
    expect(normalRows()).toEqual(beforeInvalid);
  }
  await route({ params: Promise.resolve({ ...locationOnly(), problemId: 'test1' }) });
  const graded = await db.query.problemSessions.findFirst({ where: { problemId: 'test1' } });
  expect(graded).toBeDefined();
  if (!graded) throw new Error('Valid normal URL must create a graded session');
  db.insert(problemSubmissions)
    .values({
      sessionId: graded.id,
      problemType: 'executionResult',
      traceItemIndex: 0,
      elapsedMilliseconds: 71,
      isCorrect: false,
    })
    .run();
  const gradedBefore = normalRows();
  const progressBefore = await renderLecture();
  expect(progressBefore).toContain('aria-valuenow="0"');
  expect(progressBefore).toContain('初回の不正解');
  expect(progressBefore).toContain('未完了');
  const practice = await startPractice();
  await runtimeCaller.mutation(
    'submitRegularExercise',
    practiceSubmission(practice, 'practice-wrong-for-progress', false)
  );
  const completed = regularDisplaySchema.parse(
    await runtimeCaller.mutation(
      'submitRegularExercise',
      practiceSubmission(practice, 'practice-complete-for-progress', true)
    )
  );
  expect(completed.completed).toBe(true);
  await runtimeCaller.mutation('nextExercise', { ...practiceSession(practice.sessionId), problemFormat: 'regular' });
  expect(normalRows()).toEqual(gradedBefore);
  expect(await renderLecture()).toBe(progressBefore);
});

test('practice and challenge reject each other’s session IDs on submit, switch, and Next', async () => {
  const challenge = await startRegular();
  const practice = await startPractice();
  const before = exerciseRows();
  for (const [session, learningMode] of [
    [challenge, 'practice'],
    [practice, 'challenge'],
  ] as const) {
    const location = { ...locationOnly(), sessionId: session.sessionId, learningMode };
    const submit = { ...practiceSubmission(session, 'wrong-mode', true), learningMode };
    await expect(runtimeCaller.mutation('submitRegularExercise', submit)).rejects.toMatchObject({
      data: { code: 'UNAUTHORIZED' },
    });
    await expect(runtimeCaller.mutation('switchRegularExerciseToStep', location)).rejects.toMatchObject({
      data: { code: 'UNAUTHORIZED' },
    });
    await expect(
      runtimeCaller.mutation('nextExercise', { ...location, problemFormat: 'regular' })
    ).rejects.toMatchObject({
      data: { code: 'UNAUTHORIZED' },
    });
  }
  expect(exerciseRows()).toEqual(before);
});

test('practice rejects blank format and client-authored selectors without creating sessions', async () => {
  const before = exerciseRows();
  for (const extra of [{}, { problemFormat: 'fillInBlank' as const }]) {
    const input = { ...locationOnly(), learningMode: 'practice' as const, ...extra };
    await expect(runtimeCaller.mutation('startExercise', input)).rejects.toMatchObject({
      data: { code: 'BAD_REQUEST' },
    });
  }
  for (const extra of [{ problemId: 'test1' }, { seed: 'client-seed' }, { source: 'class Main {}' }]) {
    const input = { ...locationOnly(), learningMode: 'practice' as const, problemFormat: 'regular' as const, ...extra };
    await expect(runtimeCaller.mutation('startExercise', input)).rejects.toMatchObject({
      data: { code: 'BAD_REQUEST' },
    });
  }
  expect(exerciseRows()).toEqual(before);
});

test('practice rejects unknown and inherited course or lecture names without creating sessions', async () => {
  const before = exerciseRows();
  for (const location of [
    { courseId: 'missing', lectureId: 'test' },
    { courseId: '__proto__', lectureId: 'test' },
    { courseId: 'constructor', lectureId: 'test' },
    { courseId: 'test', lectureId: 'missing' },
    { courseId: 'test', lectureId: '__proto__' },
  ]) {
    const input = { ...location, learningMode: 'practice' as const, problemFormat: 'regular' as const };
    await expect(runtimeCaller.mutation('startExercise', input)).rejects.toMatchObject({ data: { code: 'NOT_FOUND' } });
  }
  expect(exerciseRows()).toEqual(before);
});

test('practice rejects blank submission and Next even when given a valid challenge session', async () => {
  const blank = await start();
  await runtimeCaller.mutation('submitExercise', submission(blank.sessionId, modelAnswers(blank.sessionId)));
  const before = exerciseRows();
  const submit = { ...submission(blank.sessionId, modelAnswers(blank.sessionId)), learningMode: 'practice' as const };
  await expect(runtimeCaller.mutation('submitExercise', submit)).rejects.toMatchObject({
    data: { code: 'BAD_REQUEST' },
  });
  const next = { ...practiceSession(blank.sessionId), problemFormat: 'fillInBlank' as const };
  await expect(runtimeCaller.mutation('nextExercise', next)).rejects.toMatchObject({ data: { code: 'BAD_REQUEST' } });
  expect(exerciseRows()).toEqual(before);
});

test('practice Next skips a newer session whose problem left the bank and continues with a current problem', async () => {
  const first = await startPractice();
  await runtimeCaller.mutation('submitRegularExercise', practiceSubmission(first, 'complete-first', true));
  const second = regularDisplaySchema.parse(
    await runtimeCaller.mutation('nextExercise', { ...practiceSession(first.sessionId), problemFormat: 'regular' })
  );
  sqlite.prepare("UPDATE ExerciseSession SET problemId = 'practiceTestL1Removed' WHERE id = ?").run(second.sessionId);
  const corrupted = exerciseRows();
  const next = regularDisplaySchema.parse(
    await runtimeCaller.mutation('nextExercise', { ...practiceSession(first.sessionId), problemFormat: 'regular' })
  );
  expect(next.sessionId).not.toBe(second.sessionId);
  expect(next.problemId).toMatch(/^practiceEasyV1TestL1/);
  const after = exerciseRows();
  expect(after.sessions.slice(0, corrupted.sessions.length)).toEqual(corrupted.sessions);
  expect(after.sessions).toHaveLength(corrupted.sessions.length + 1);
});

test('practice fails closed when its stored identity is replaced by a graded template', async () => {
  const practice = await startPractice();
  sqlite.prepare("UPDATE ExerciseSession SET problemId = 'test1' WHERE id = ?").run(practice.sessionId);
  const corrupted = exerciseRows();
  expectStartSkipsCorruptedRow(await startPractice(), practice.sessionId, corrupted);
  const before = exerciseRows();
  await expect(
    runtimeCaller.mutation('submitRegularExercise', practiceSubmission(practice, 'corrupt', true))
  ).rejects.toMatchObject({
    data: { code: 'INTERNAL_SERVER_ERROR' },
  });
  await expect(
    runtimeCaller.mutation('switchRegularExerciseToStep', practiceSession(practice.sessionId))
  ).rejects.toMatchObject({
    data: { code: 'INTERNAL_SERVER_ERROR' },
  });
  expect(exerciseRows()).toEqual(before);
});

test.each(['practiceTestL1Unknown', 'test1', 'practiceEasyV1Beginner1L1TerminalTurnV1'])(
  'practice rejects unknown, graded, or wrong-location identity %s without writes',
  async (problemId) => {
    const initial = await startPractice();
    sqlite.prepare('UPDATE ExerciseSession SET problemId = ? WHERE id = ?').run(problemId, initial.sessionId);
    const corrupted = exerciseRows();
    expectStartSkipsCorruptedRow(await startPractice(), initial.sessionId, corrupted);
    const before = exerciseRows();
    await expect(
      runtimeCaller.mutation('submitRegularExercise', practiceSubmission(initial, 'invalid-identity', false))
    ).rejects.toMatchObject({ data: { code: 'INTERNAL_SERVER_ERROR' } });
    expect(exerciseRows()).toEqual(before);
    await expect(
      runtimeCaller.mutation('switchRegularExerciseToStep', practiceSession(initial.sessionId))
    ).rejects.toMatchObject({ data: { code: 'INTERNAL_SERVER_ERROR' } });
    expect(exerciseRows()).toEqual(before);
    await expect(
      runtimeCaller.mutation('nextExercise', { ...practiceSession(initial.sessionId), problemFormat: 'regular' })
    ).rejects.toMatchObject({ data: { code: 'INTERNAL_SERVER_ERROR' } });
    expect(exerciseRows()).toEqual(before);
  }
);

test.each([
  { problemType: 'executionResult', traceItemIndex: 1 },
  { problemType: 'step', traceItemIndex: 0 },
  { problemType: 'step', traceItemIndex: -1 },
  { problemType: 'unknown', traceItemIndex: 0 },
])('practice rejects invalid regular state $problemType/$traceItemIndex without writes', async (state) => {
  const initial = await startPractice();
  sqlite
    .prepare('UPDATE ExerciseSession SET problemId = ?, problemType = ?, traceItemIndex = ? WHERE id = ?')
    .run(initial.problemId, state.problemType, state.traceItemIndex, initial.sessionId);
  const before = exerciseRows();
  await expect(startPractice()).rejects.toMatchObject({ data: { code: 'CONFLICT' } });
  expect(exerciseRows()).toEqual(before);
});

test('practice rejects another user, lecture, and expired learning period without mutation', async () => {
  const practice = await startPractice();
  const before = exerciseRows();
  auth.userId = 'other';
  await expect(
    runtimeCaller.mutation('submitRegularExercise', practiceSubmission(practice, 'other-user', true))
  ).rejects.toMatchObject({
    data: { code: 'UNAUTHORIZED' },
  });
  auth.userId = 'student';
  await expect(
    runtimeCaller.mutation('switchRegularExerciseToStep', {
      ...practiceSession(practice.sessionId),
      lectureId: 'other',
    })
  ).rejects.toMatchObject({ data: { code: 'UNAUTHORIZED' } });
  expect(exerciseRows()).toEqual(before);
  sqlite.prepare('UPDATE ExerciseSession SET createdAt = 0 WHERE id = ?').run(practice.sessionId);
  vi.setSystemTime(new Date('2026-07-15T12:00:00+09:00'));
  const expiredBefore = exerciseRows();
  await expect(
    runtimeCaller.mutation('submitRegularExercise', practiceSubmission(practice, 'expired', true))
  ).rejects.toMatchObject({
    data: { code: 'NOT_FOUND' },
  });
  expect(exerciseRows()).toEqual(expiredBefore);
});

const regularDisplaySchema = z.object({
  problemFormat: z.literal('regular'),
  sessionId: z.number(),
  problemId: z.string(),
  seed: z.string(),
  problemType: z.enum(['executionResult', 'step']),
  traceItemIndex: z.number(),
  completed: z.boolean(),
});
const startPractice = async (): Promise<z.infer<typeof regularDisplaySchema>> => {
  const input = { ...locationOnly(), learningMode: 'practice' as const, problemFormat: 'regular' as const };
  return regularDisplaySchema.parse(await runtimeCaller.mutation('startExercise', input));
};
const practiceSession = (sessionId: number): Location & { sessionId: number; learningMode: 'practice' } => ({
  ...locationOnly(),
  sessionId,
  learningMode: 'practice' as const,
});
const practiceSubmission = (
  exercise: z.infer<typeof regularDisplaySchema>,
  requestId: string,
  isCorrect: boolean
): RegularSubmissionInput & { learningMode: 'practice' } => ({
  ...practiceSession(exercise.sessionId),
  requestId,
  context: { problemType: exercise.problemType, traceItemIndex: exercise.traceItemIndex },
  isCorrect,
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
  (await regularCaller().startExercise({
    ...locationOnly(),
    problemFormat: 'regular',
  })) as RegularExercise;
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
const locationOnly = (): Location => ({ courseId: 'test', lectureId: 'test' });
const submission = (sessionId: number, answers: string[]): Submission => ({
  ...locationOnly(),
  sessionId,
  code: source(sessionId, answers),
});
const source = (sessionId: number, answers: string[]): string => {
  const stored = z
    .object({ problemId: z.string(), seed: z.string() })
    .parse(sqlite.prepare('SELECT problemId, seed FROM ExerciseSession WHERE id = ?').get(sessionId));
  const problem = instantiateProblem(stored.problemId, stored.seed);
  if (!problem) throw new Error(`Unknown problem: ${stored.problemId}`);
  return fillBlanks(problem.displayProgramTemplate, answers);
};
const one = <T>(schema: z.ZodType<T>, sql: string): T => schema.parse(sqlite.prepare(sql).get());
const completion = (sessionId: number): number | null =>
  z
    .object({ completedAt: z.number().nullable() })
    .parse(sqlite.prepare('SELECT completedAt FROM ExerciseSession WHERE id = ?').get(sessionId)).completedAt;
const modelAnswers = (sessionId: number): string[] => {
  const stored = z
    .object({ problemId: z.string(), seed: z.string() })
    .parse(sqlite.prepare('SELECT problemId, seed FROM ExerciseSession WHERE id = ?').get(sessionId));
  const problem = instantiateProblem(stored.problemId, stored.seed);
  if (!problem) throw new Error(`Unknown problem: ${stored.problemId}`);
  return problem.blankAnswers;
};
const expectStartSkipsCorruptedRow = (
  started: { sessionId: number },
  corruptedId: number,
  before: ReturnType<typeof exerciseRows>
): void => {
  expect(started.sessionId).not.toBe(corruptedId);
  const after = exerciseRows();
  expect(after.sessions.slice(0, before.sessions.length)).toEqual(before.sessions);
  expect(after.sessions).toHaveLength(before.sessions.length + 1);
  expect(after.submissions).toEqual(before.submissions);
};
const exerciseRows = (): { sessions: unknown[]; submissions: unknown[] } => ({
  sessions: sqlite.prepare('SELECT * FROM ExerciseSession ORDER BY id').all(),
  submissions: sqlite.prepare('SELECT * FROM ExerciseSubmission ORDER BY id').all(),
});
const normalRows = (): { sessions: unknown[]; submissions: unknown[] } => ({
  sessions: sqlite.prepare('SELECT * FROM ProblemSession ORDER BY id').all(),
  submissions: sqlite.prepare('SELECT * FROM ProblemSubmission ORDER BY id').all(),
});

test('merges only identical in-flight source and grades settled retries again', async () => {
  const exercise = await start();
  const input = submission(exercise.sessionId, ['x']);
  const different = submission(exercise.sessionId, ['x + 2']);
  const results = await Promise.all([
    caller.submitExercise(input),
    caller.submitExercise(input),
    caller.submitExercise(different),
  ]);
  expect(results.map(({ status }) => status)).toEqual(['incorrect', 'incorrect', 'incorrect']);
  expect(sqlite.prepare('SELECT code FROM ExerciseSubmission ORDER BY id').all()).toEqual([
    { code: input.code },
    { code: different.code },
  ]);
  expect(await caller.submitExercise(input)).toMatchObject({ status: 'incorrect' });
  expect(sqlite.prepare('SELECT code FROM ExerciseSubmission ORDER BY id').all()).toEqual([
    { code: input.code },
    { code: different.code },
    { code: input.code },
  ]);
});

test.each(['ordinary', 'challenge'] as const)(
  '%s API returns compiler diagnostics and preserves retry history',
  async (context) => {
    const code = 'class Main {\n public static void main(String[] args) {\n  missing();\n }\n}';
    const exercise = context === 'challenge' ? await start() : undefined;
    const normal =
      context === 'ordinary'
        ? db
            .insert(problemSessions)
            .values({
              userId: 'student',
              courseId: 'test',
              lectureId: 'test',
              problemId: 'fillInBlank1',
              problemVariablesSeed: 'diagnostics',
              problemType: 'fillInBlank',
              traceItemIndex: 0,
            })
            .returning()
            .get()
        : undefined;
    const submit = async (): Promise<unknown> =>
      exercise
        ? caller.submitExercise({ ...locationOnly(), sessionId: exercise.sessionId, code })
        : caller.gradeFillInBlankAnswers({ sessionId: normal!.id, code, elapsedMilliseconds: 12 });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(await submit()).toEqual({
        status: 'incorrect',
        detail: 'Compile error.',
        diagnostics: [{ line: 3, message: expect.stringMatching(/[ぁ-ん]/) }],
      });
    }
    expect(sqlite.prepare(`SELECT code FROM ${exercise ? 'ExerciseSubmission' : 'ProblemSubmission'}`).all()).toEqual([
      { code },
      { code },
    ]);
    const table = exercise ? 'ExerciseSession' : 'ProblemSession';
    const id = exercise?.sessionId ?? normal!.id;
    expect(sqlite.prepare(`SELECT completedAt FROM ${table} WHERE id = ?`).get(id)).toEqual({ completedAt: null });
  }
);

type EndFormat = 'regular' | 'fillInBlank';
interface EndExercise {
  sessionId: number;
  problemId: string;
  completed: boolean;
}
const endExerciseDisplay = z
  .object({ sessionId: z.number(), problemId: z.string(), completed: z.boolean() })
  .passthrough();
const endInput = (sessionId: number, problemFormat: EndFormat): Record<string, unknown> => ({
  ...locationOnly(),
  sessionId,
  problemFormat,
});
const endExercise = (sessionId: number, format: EndFormat): Promise<unknown> =>
  regularCaller().endExercise(endInput(sessionId, format));
const startFormat = async (format: EndFormat): Promise<EndExercise> =>
  endExerciseDisplay.parse(await regularCaller().startExercise({ ...locationOnly(), problemFormat: format }));
const completeFormat = async (exercise: EndExercise, format: EndFormat): Promise<void> => {
  await (format === 'regular'
    ? expect(
        regularCaller().submitRegularExercise({
          ...locationOnly(),
          sessionId: exercise.sessionId,
          requestId: `complete-${exercise.sessionId}`,
          context: { problemType: 'executionResult', traceItemIndex: 0 },
          isCorrect: true,
        })
      ).resolves.toMatchObject({ completed: true })
    : expect(
        caller.submitExercise(submission(exercise.sessionId, modelAnswers(exercise.sessionId)))
      ).resolves.toMatchObject({ status: 'correct' }));
};
const nextFormat = async (exercise: EndExercise, format: EndFormat): Promise<EndExercise> =>
  endExerciseDisplay.parse(await regularCaller().nextExercise(endInput(exercise.sessionId, format)));
const endedRecord = (id: number): unknown => sqlite.prepare('SELECT * FROM ExerciseSession WHERE id = ?').get(id);

test.each<EndFormat>(['regular', 'fillInBlank'])(
  'explicit End %s preserves refresh and history but starts fresh once dismissed',
  async (format) => {
    const normal = db
      .insert(problemSessions)
      .values({
        userId: 'student',
        courseId: 'test',
        lectureId: 'test',
        problemId: 'fillInBlank2',
        problemVariablesSeed: 'ordinary-end-isolation',
        problemType: 'fillInBlank',
        traceItemIndex: 0,
      })
      .returning()
      .get()!;
    const ordinaryProblem = instantiateProblem('fillInBlank2', 'ordinary-end-isolation');
    if (!ordinaryProblem) throw new Error('Unknown problem: fillInBlank2');
    const code = fillBlanks(ordinaryProblem.displayProgramTemplate, ['x + 1']);
    await caller.gradeFillInBlankAnswers({ sessionId: normal.id, code, elapsedMilliseconds: 7 });
    const ordinaryBefore = normalRows();
    const first = await startFormat(format);
    const otherFormat = format === 'regular' ? 'fillInBlank' : 'regular';
    const other = await startFormat(otherFormat);
    await completeFormat(first, format);
    expect(await startFormat(format)).toMatchObject({
      sessionId: first.sessionId,
      completed: true,
    });
    const completedAt = completion(first.sessionId);
    const submissionsBefore = exerciseRows().submissions;
    await expect(endExercise(first.sessionId, format)).resolves.toEqual({ status: 'ended' });
    const dismissed = endedRecord(first.sessionId);
    expect(dismissed).toMatchObject({ completedAt, endedAt: expect.any(Number) });
    vi.setSystemTime(Date.now() + 100);
    await Promise.all([endExercise(first.sessionId, format), endExercise(first.sessionId, format)]);
    expect(endedRecord(first.sessionId)).toEqual(dismissed);
    const [fresh, duplicate] = await Promise.all([startFormat(format), startFormat(format)]);
    expect(fresh).toEqual(duplicate);
    expect(fresh.sessionId).not.toBe(first.sessionId);
    expect(fresh).toMatchObject({ completed: false, problemId: first.problemId });
    expect(await startFormat(otherFormat)).toEqual(other);
    expect(exerciseRows().sessions).toHaveLength(3);
    expect(exerciseRows().submissions).toEqual(submissionsBefore);
    expect(normalRows()).toEqual(ordinaryBefore);
  }
);

test.each<EndFormat>(['regular', 'fillInBlank'])(
  'explicit End %s establishes a boundary and rejects stale Next and submissions',
  async (format) => {
    const a = await startFormat(format);
    await completeFormat(a, format);
    const b = await nextFormat(a, format);
    await completeFormat(b, format);
    await endExercise(b.sessionId, format);
    const before = exerciseRows();
    for (const old of [a, b]) {
      await expect(nextFormat(old, format)).rejects.toMatchObject({ code: 'CONFLICT' });
    }
    if (format === 'regular') {
      await expect(
        regularCaller().submitRegularExercise({
          ...locationOnly(),
          sessionId: b.sessionId,
          requestId: 'after-end',
          context: { problemType: 'executionResult', traceItemIndex: 0 },
          isCorrect: true,
        })
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(
        regularCaller().switchRegularExerciseToStep({ ...locationOnly(), sessionId: b.sessionId })
      ).rejects.toMatchObject({ code: 'CONFLICT' });
    } else {
      await expect(caller.submitExercise(submission(b.sessionId, modelAnswers(b.sessionId)))).rejects.toMatchObject({
        code: 'CONFLICT',
      });
    }
    expect(exerciseRows()).toEqual(before);
    const fresh = await startFormat(format);
    expect([a.sessionId, b.sessionId]).not.toContain(fresh.sessionId);
    expect(fresh.completed).toBe(false);
  }
);

test.each<EndFormat>(['regular', 'fillInBlank'])(
  'explicit End %s arriving after Next never closes its successor',
  async (format) => {
    const a = await startFormat(format);
    await completeFormat(a, format);
    const b = await nextFormat(a, format);
    const successorBefore = endedRecord(b.sessionId);
    await endExercise(a.sessionId, format);
    await endExercise(a.sessionId, format);
    expect(await startFormat(format)).toEqual(b);
    expect(endedRecord(b.sessionId)).toEqual(successorBefore);
    expect(exerciseRows().sessions).toHaveLength(2);
  }
);

test('explicit End validates ownership and unfinished state without changing history', async () => {
  const pending = await startRegular();
  const beforePending = exerciseRows();
  await expect(endExercise(pending.sessionId, 'regular')).rejects.toMatchObject({
    code: 'CONFLICT',
  });
  expect(exerciseRows()).toEqual(beforePending);
  expect(await startRegular()).toEqual(pending);
  await submitRegular(pending, 'complete-end-auth', true);
  const before = exerciseRows();
  auth.userId = 'other';
  await expect(endExercise(pending.sessionId, 'regular')).rejects.toMatchObject({
    code: 'UNAUTHORIZED',
  });
  auth.userId = 'student';
  await expect(endExercise(pending.sessionId, 'fillInBlank')).rejects.toMatchObject({
    code: 'UNAUTHORIZED',
  });
  await expect(
    regularCaller().endExercise({ ...endInput(pending.sessionId, 'regular'), lectureId: 'other' })
  ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  await expect(
    regularCaller().endExercise({ ...endInput(pending.sessionId, 'regular'), courseId: 'missing' })
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(endExercise(999_999, 'regular')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect(exerciseRows()).toEqual(before);
  await endExercise(pending.sessionId, 'regular');
  const ended = exerciseRows();
  auth.userId = 'other';
  await expect(endExercise(pending.sessionId, 'regular')).rejects.toMatchObject({
    code: 'UNAUTHORIZED',
  });
  expect(exerciseRows()).toEqual(ended);
});

test('explicit End succeeds without candidate generation after failed Next and refresh recovery', async () => {
  const first = await start();
  await completeFormat(first, 'fillInBlank');
  challengeMap.test = [['notRegistered']];
  await expect(nextFormat(first, 'fillInBlank')).rejects.toMatchObject({
    code: 'INTERNAL_SERVER_ERROR',
  });
  expect(await start()).toMatchObject({ sessionId: first.sessionId, completed: true });
  await endExercise(first.sessionId, 'fillInBlank');
  const ended = exerciseRows();
  await expect(start()).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  expect(exerciseRows()).toEqual(ended);
  challengeMap.test = [['fillInBlank2']];
  const fresh = await start();
  expect(fresh.sessionId).not.toBe(first.sessionId);
});

test.each([
  { verdict: 'correct', answers: ['1 + x'] },
  { verdict: 'incorrect', answers: ['x'] },
] as const)(
  'explicit End sent right after a submission waits for its $verdict verdict',
  async ({ verdict, answers }) => {
    const first = await start();
    const [result, outcome] = await Promise.all([
      caller.submitExercise(submission(first.sessionId, [...answers])),
      endExercise(first.sessionId, 'fillInBlank').then(
        (value) => ({ value }),
        (error: unknown) => ({ error })
      ),
    ]);
    expect(result).toMatchObject({ status: verdict });
    if (verdict === 'correct') {
      expect(outcome).toEqual({ value: { status: 'ended' } });
      expect(endedRecord(first.sessionId)).toMatchObject({
        completedAt: expect.any(Number),
        endedAt: expect.any(Number),
      });
      const fresh = await start();
      expect(fresh.sessionId).not.toBe(first.sessionId);
    } else {
      expect(outcome).toMatchObject({ error: { code: 'CONFLICT' } });
      expect(await start()).toMatchObject({ sessionId: first.sessionId, completed: false });
    }
    expect(exerciseRows().submissions).toHaveLength(1);
  }
);

test('explicit End refuses expired sessions and preserves unfinished step resume', async () => {
  const regular = await startRegular();
  const stepped = await regularCaller().switchRegularExerciseToStep({
    ...locationOnly(),
    sessionId: regular.sessionId,
  });
  await expect(endExercise(regular.sessionId, 'regular')).rejects.toMatchObject({
    code: 'CONFLICT',
  });
  expect(await startRegular()).toEqual({ ...stepped, problem: expect.any(Object) });
  sqlite.prepare('UPDATE ExerciseSession SET createdAt = 0 WHERE id = ?').run(regular.sessionId);
  vi.setSystemTime(new Date('2026-07-15T12:00:00+09:00'));
  const expired = exerciseRows();
  await expect(endExercise(regular.sessionId, 'regular')).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
  expect(exerciseRows()).toEqual(expired);
});

test('explicit End reentry avoids the preceding candidate when alternatives exist', async () => {
  challengeMap.test = [['fillInBlank1', 'fillInBlank2']];
  const first = await start();
  await completeFormat(first, 'fillInBlank');
  await endExercise(first.sessionId, 'fillInBlank');
  const second = await start();
  expect(second.problemId).not.toBe(first.problemId);
  expect(second.completed).toBe(false);
});

test('legacy multi-hole source and seeded targets survive session resume exactly', async () => {
  challengeMap.test = [['fillInBlank4']];
  const multi = await start();
  expect(multi.displayProgram).toBe(`public class Main {
  public static void main(String[] args) {
    Turtle t = new Turtle();
    for (int i = 0; i < 【1】; i++) {
      t.前に進む();
      【2】
    }
  }
}`);
  expect(multi).toMatchObject({
    finalBoard: '##.....\n##.....\n.......\n.......\n.......\n.......\n.......',
    finalTurtles: [{ x: 1, y: 0, color: '#', dir: 'W' }],
  });
  expect(await start()).toEqual(multi);
  for (const fixture of [
    {
      seed: 'compat-a',
      x: 3,
      y: 5,
      board: '.......\n.......\n.......\n.......\n...#...\n...#...\n.......',
    },
    {
      seed: 'compat-b',
      x: 2,
      y: 4,
      board: '.......\n.......\n.......\n..#....\n..#....\n.......\n.......',
    },
  ]) {
    sqlite
      .prepare("UPDATE ExerciseSession SET problemId = 'fillInBlank2', seed = ? WHERE id = ?")
      .run(fixture.seed, multi.sessionId);
    const resumed = await start();
    expect(resumed.displayProgram).toBe(`public class Main {
  public static void main(String[] args) {
    int x = ${fixture.x};
    int y = 【1】;
    Turtle t = new Turtle(x, y);
    t.前に進む();
  }
}`);
    expect(resumed).toMatchObject({
      sessionId: multi.sessionId,
      finalBoard: fixture.board,
      finalTurtles: [{ x: fixture.x, y: fixture.y, color: '#', dir: 'N' }],
    });
  }
});

test('bugFix API accepts the format and reports an empty configuration', async () => {
  challengeMap.test = [[]];
  await expect(regularCaller().startExercise({ ...locationOnly(), problemFormat: 'bugFix' })).resolves.toEqual({
    status: 'noProblems',
  });
  expect(exerciseRows()).toEqual({ sessions: [], submissions: [] });
});

const catalogEntrySchema = z.object({
  problemFormat: z.enum(['fillInBlank', 'bugFix']),
  bugKind: z.enum(['logical', 'syntax']).optional(),
  correctProgram: z.string(),
  starterProgram: z.string(),
  finalBoard: z.string(),
  finalTurtles: z.array(z.object({ x: z.number(), y: z.number(), color: z.string(), dir: z.string() })),
});

const selectBugFixture = async (
  kind: 'logical' | 'syntax'
): Promise<z.infer<typeof catalogEntrySchema> & { id: string }> => {
  const path = '../../src/problems/javaChallenges/definitions.ts';
  const module = z
    .object({ javaChallengeDefinitions: z.record(z.string(), catalogEntrySchema) })
    .parse(await import(path));
  const entry = Object.entries(module.javaChallengeDefinitions).find(
    ([, definition]) => definition.problemFormat === 'bugFix' && definition.bugKind === kind
  );
  expect(entry, `a playable ${kind} bug fixture`).toBeDefined();
  const [id, definition] = entry!;
  challengeMap.test = [[id, 'fillInBlank2'], ['fillInBlank1']];
  return { id, ...definition };
};

const startBug = async (): Promise<Exercise> =>
  asExercise(await regularCaller().startExercise({ ...locationOnly(), problemFormat: 'bugFix' }));
const submitBug = async (sessionId: number, code: string, extra: Record<string, unknown> = {}): Promise<unknown> =>
  regularCaller().submitExercise({
    ...locationOnly(),
    sessionId,
    code,
    problemFormat: 'bugFix',
    ...extra,
  });

test.each(['logical', 'syntax'] as const)(
  'bugFix %s starter is retryable and exact full-source repair completes only its own session',

  async (kind) => {
    const fixture = await selectBugFixture(kind);
    const normal = db
      .insert(problemSessions)
      .values({
        userId: 'student',
        courseId: 'test',
        lectureId: 'test',
        problemId: 'test1',
        problemVariablesSeed: 'bug-isolation',
        problemType: 'executionResult',
        traceItemIndex: 0,
      })
      .returning()
      .get()!;
    db.insert(problemSubmissions)
      .values({
        sessionId: normal.id,
        problemType: 'executionResult',
        traceItemIndex: 0,
        elapsedMilliseconds: 19,
        isCorrect: false,
      })
      .run();
    const ordinaryBefore = normalRows();
    const blank = await start();
    const regular = await startRegular();
    const [bug, duplicate] = await Promise.all([startBug(), startBug()]);
    expect(duplicate).toEqual(bug);
    expect(new Set([blank.sessionId, regular.sessionId, bug.sessionId]).size).toBe(3);
    expect(bug).toMatchObject({
      problemFormat: 'bugFix',
      problemId: fixture.id,
      displayProgram: fixture.starterProgram,
      finalBoard: fixture.finalBoard,
      finalTurtles: fixture.finalTurtles,
    });
    expect(Object.keys(bug).toSorted()).toEqual(
      [
        'completed',
        'displayProgram',
        'finalBoard',
        'finalTurtles',
        'problemFormat',
        'problemId',
        'sessionId',
      ].toSorted()
    );
    const wrong = await submitBug(bug.sessionId, bug.displayProgram);
    expect(wrong).toMatchObject({ status: 'incorrect' });
    if (kind === 'syntax') {
      expect(
        z
          .object({
            diagnostics: z.array(z.object({ line: z.number().positive(), message: z.string().min(1) })).min(1),
          })
          .parse(wrong).diagnostics.length
      ).toBeGreaterThan(0);
    }
    expect(completion(bug.sessionId)).toBeNull();
    expect(await startBug()).toEqual(bug);
    const code = `  \n${fixture.correctProgram}\n  `;
    expect(await submitBug(bug.sessionId, code)).toMatchObject({ status: 'correct' });
    const history = sqlite.prepare('SELECT code, status, answers FROM ExerciseSubmission ORDER BY id').all();
    expect(history).toEqual([
      { code: bug.displayProgram, status: 'incorrect', answers: null },
      { code, status: 'correct', answers: null },
    ]);
    expect(await startBug()).toMatchObject({ sessionId: bug.sessionId, completed: true });
    await submitBug(bug.sessionId, code);
    expect(sqlite.prepare('SELECT code, status, answers FROM ExerciseSubmission ORDER BY id').all()).toEqual(history);
    const nextInput = { ...locationOnly(), sessionId: bug.sessionId, problemFormat: 'bugFix' };
    const [next, replay] = await Promise.all([
      regularCaller().nextExercise(nextInput),
      regularCaller().nextExercise(nextInput),
    ]);
    expect(replay).toEqual(next);
    expect(next).toMatchObject({ problemFormat: 'bugFix', completed: false });
    expect(next.sessionId).not.toBe(bug.sessionId);
    expect(await startBug()).toEqual(next);
    expect(await start()).toEqual(blank);
    expect(await startRegular()).toEqual(regular);
    expect(normalRows()).toEqual(ordinaryBefore);
  }
);

test('bugFix rejects wrong ownership, location, format and expired attempts without changing history', async () => {
  const fixture = await selectBugFixture('logical');
  const bug = await startBug();
  const blank = await start();
  const before = exerciseRows();
  auth.userId = 'other';
  await expect(submitBug(bug.sessionId, fixture.correctProgram)).rejects.toMatchObject({
    code: 'UNAUTHORIZED',
  });
  auth.userId = 'student';
  for (const extra of [{ lectureId: 'other' }, { courseId: 'other' }, { problemFormat: 'fillInBlank' }]) {
    await expect(submitBug(bug.sessionId, fixture.correctProgram, extra)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  }
  await expect(
    caller.submitExercise({
      ...locationOnly(),
      sessionId: bug.sessionId,
      code: fixture.correctProgram,
    })
  ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  await expect(submitBug(blank.sessionId, fixture.correctProgram)).rejects.toMatchObject({
    code: 'UNAUTHORIZED',
  });
  for (const extra of [{ courseId: 'missing' }, { lectureId: 'missing' }]) {
    await expect(submitBug(bug.sessionId, fixture.correctProgram, extra)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  }
  await expect(
    regularCaller().submitRegularExercise({
      ...locationOnly(),
      sessionId: bug.sessionId,
      requestId: 'cross-format',
      context: { problemType: 'executionResult', traceItemIndex: 0 },
      isCorrect: true,
    })
  ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  await expect(
    regularCaller().nextExercise({
      ...locationOnly(),
      sessionId: bug.sessionId,
      problemFormat: 'fillInBlank',
    })
  ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  expect(exerciseRows()).toEqual(before);
  sqlite.prepare('UPDATE ExerciseSession SET createdAt = 0 WHERE id = ?').run(bug.sessionId);
  vi.setSystemTime(new Date('2026-07-15T12:00:00+09:00'));
  const expired = exerciseRows();
  await expect(submitBug(bug.sessionId, fixture.correctProgram)).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
  expect(exerciseRows()).toEqual(expired);
});

test.each(['regular', 'fillInBlank', 'bugFix'] as const)(
  'curriculum %s starts and advances only independent IDs while retaining legacy history',
  async (problemFormat) => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const { challengeMetadata } = await import('../../src/problems/challenge/metadata');
      const challengeMetadataOf = (id: string): ChallengeMetadata | undefined =>
        (challengeMetadata as Partial<Record<string, ChallengeMetadata>>)[id];
      const location = { courseId: 'tuBeginner1', lectureId: 'lecture1', problemFormat };
      const legacyId =
        problemFormat === 'regular'
          ? 'straight'
          : problemFormat === 'fillInBlank'
            ? 'straightBlank'
            : 'javaI1CornerTurnBug';
      const insertLegacy = sqlite.prepare(`INSERT INTO ExerciseSession
      (userId, courseId, lectureId, learningMode, problemFormat, problemId, seed, problemType, traceItemIndex, createdAt)
      VALUES ('student', 'tuBeginner1', 'lecture1', 'challenge', ?, ?, 'legacy-seed', ?, 0, ?)`);
      insertLegacy.run(
        problemFormat,
        legacyId,
        problemFormat === 'regular' ? 'executionResult' : problemFormat,
        Date.now()
      );
      const first = z
        .object({ sessionId: z.number(), problemId: z.string() })
        .passthrough()
        .parse(await caller.startExercise(location));
      expect(challengeMetadataOf(first.problemId)).toMatchObject({
        courseId: 'tuBeginner1',
        lectureIndex: 0,
        problemFormat,
      });
      expect(first.problemId).not.toBe(legacyId);
      if (problemFormat !== 'regular')
        expect(z.string().parse(first.displayProgram)).not.toMatch(/\/\/\s*(?:step|caller)\b/);
      expect(sqlite.prepare('SELECT * FROM ExerciseSession WHERE problemId = ?').all(legacyId)).toHaveLength(1);
      expect(await caller.startExercise(location)).toMatchObject({ sessionId: first.sessionId });
      sqlite.prepare('UPDATE ExerciseSession SET completedAt = ? WHERE id = ?').run(Date.now(), first.sessionId);
      insertLegacy.run(
        problemFormat,
        legacyId,
        problemFormat === 'regular' ? 'executionResult' : problemFormat,
        Date.now()
      );
      const next = z
        .object({ problemId: z.string() })
        .passthrough()
        .parse(await caller.nextExercise({ ...location, sessionId: first.sessionId }));
      expect(challengeMetadataOf(next.problemId)).toMatchObject({
        courseId: 'tuBeginner1',
        lectureIndex: 0,
        problemFormat,
      });
      expect(next.problemId).not.toBe(first.problemId);
      if (problemFormat !== 'regular')
        expect(z.string().parse(next.displayProgram)).not.toMatch(/\/\/\s*(?:step|caller)\b/);
      expect(await caller.nextExercise({ ...location, sessionId: first.sessionId })).toMatchObject(next);
      expect(regularMap.tuBeginner1.flat()).not.toContain(first.problemId);
      expect(sqlite.prepare('SELECT * FROM ExerciseSession WHERE problemId = ?').all(legacyId)).toHaveLength(2);
    } finally {
      random.mockRestore();
    }
  }
);
