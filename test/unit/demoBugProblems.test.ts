import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-sqlite/migrator';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { z } from 'zod';

import { problemSessions, users, type ProblemSession, type ProblemSubmission } from '../../db/schema';
import type { db as databaseClient } from '../../src/infrastructures/database';
import type { BackendRouter } from '../../src/infrastructures/trpcBackend/routers';
import type * as JavaExecutors from '../../src/problems/fillInBlank/javaExecutors';
import type * as ProblemData from '../../src/problems/problemData';
import { localJavaExecutor } from '../helpers/localJavaExecutor';

const auth = vi.hoisted(() => ({ userId: 'demo-student' }));
const execution = vi.hoisted(() => ({ unavailable: false, requests: vi.fn() }));
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
vi.mock('../../src/problems/fillInBlank/javaExecutors', async (importOriginal) => {
  const original = await importOriginal<typeof JavaExecutors>();
  return {
    ...original,
    createWandboxExecutor: () => ({
      name: 'wandbox',
      execute: async () => ({ kind: 'unavailable', reason: 'local transport' }),
    }),
    createJudgeExecutor: () => ({
      name: 'judge',
      execute: async (program: string, entry: string) => {
        execution.requests(program, entry);
        return execution.unavailable
          ? { kind: 'unavailable', reason: 'controlled outage' }
          : localJavaExecutor.execute(program, entry);
      },
    }),
  };
});

const examples = [
  {
    id: 'testTurnBug',
    correct: `public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(3, 3);
        亀.前に進む();
        亀.右を向く();
        亀.前に進む();
    }
}`,
    board: '.......\n.......\n.......\n...#...\n...##..\n.......\n.......',
    turtles: [{ x: 4, y: 4, color: '#', dir: 'E' }],
    defect: 'logical',
  },
  {
    id: 'testForConditionBug',
    correct: `public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(2, 1);
        for (int i = 0; i < 3; i++) {
            亀.前に進む();
        }
    }
}`,
    board: '.......\n..#....\n..#....\n..#....\n..#....\n.......\n.......',
    turtles: [{ x: 2, y: 4, color: '#', dir: 'N' }],
    defect: 'syntax',
  },
];
const javaSchema = z
  .object({
    problemId: z.string(),
    problemFormat: z.literal('bugFix'),
    displayProgram: z.string(),
    finalBoard: z.string(),
    finalTurtles: z.array(z.object({ x: z.number(), y: z.number(), color: z.string(), dir: z.string() })),
  })
  .strict();
const pageSchema = z.object({
  props: z.object({
    userId: z.string(),
    initialProblemSession: z
      .object({ id: z.number(), problemType: z.string(), traceItemIndex: z.number() })
      .passthrough(),
    javaProblem: javaSchema,
  }),
});
const challengeSchema = javaSchema.omit({ problemId: true }).extend({
  problemId: z.enum(['testTurnBug', 'testForConditionBug']),
  sessionId: z.number(),
  completed: z.boolean(),
});
let directory: string;
let sqlite: DatabaseSync;
let db: typeof databaseClient;
let caller: ReturnType<BackendRouter['createCaller']>;
let data: typeof ProblemData;
let openPage: (params: { courseId: string; lectureId: string; problemId: string }) => Promise<unknown>;
let location: { courseId: string; lectureId: string };

beforeAll(async () => {
  mkdirSync('.tmp', { recursive: true });
  directory = mkdtempSync(resolve('.tmp/demo-bugs-'));
  const path = `${directory}/test.sqlite3`;
  sqlite = new DatabaseSync(path);
  vi.stubEnv('DATABASE_URL', `file:${path}`);
  ({ db } = await import('../../src/infrastructures/database'));
  migrate(db, { migrationsFolder: 'drizzle' });
  data = await import('../../src/problems/problemData');
  location = { courseId: 'test', lectureId: z.string().min(1).parse(data.courseIdToLectureIds.test?.[0]) };
  const { backendRouter } = await import('../../src/infrastructures/trpcBackend/routers');
  caller = backendRouter.createCaller({
    req: new Request('http://localhost/api/trpc', { headers: { Cookie: 'sAccessToken=test' } }),
    resHeaders: new Headers(),
    info: {} as never,
  });
  const pageModule =
    await import('../../src/app/(withAuth)/courses/[courseId]/lectures/[lectureId]/problems/[problemId]/page');
  openPage = pageModule.default as unknown as typeof openPage;
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
  auth.userId = 'demo-student';
  execution.unavailable = false;
  execution.requests.mockClear();
  sqlite.exec(
    'DELETE FROM ExerciseSubmission; DELETE FROM ExerciseSession; DELETE FROM ProblemSubmission; DELETE FROM ProblemSession; DELETE FROM User'
  );
  db.insert(users)
    .values([
      { id: auth.userId, displayName: 'Demo' },
      { id: 'other', displayName: 'Other' },
    ])
    .run();
});
afterEach(() => vi.useRealTimers());
afterAll(() => {
  db?.$client.close();
  sqlite?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

test('actual checking lists register both dedicated bugs without losing regular or blank entries', () => {
  const ids = examples.map(({ id }) => id);
  expect(data.courseIdToLectureIndexToProblemIds.test[0]).toEqual(
    expect.arrayContaining([...ids, 'test1', 'fillInBlank1'])
  );
  expect(data.courseIdToLectureIndexToExerciseProblemIds.test[0]).toEqual(
    expect.arrayContaining([...ids, 'test1Blank'])
  );
});

test(
  'actual checking challenge starts, grades both real Java starters and repairs, then advances to the other bug',
  { timeout: 90_000 },
  async () => {
    let challenge = challengeSchema.parse(await caller.startExercise({ ...location, problemFormat: 'bugFix' }));
    const seen = new Set<string>();
    for (let i = 0; i < 2; i++) {
      const example = examples.find(({ id }) => id === challenge.problemId)!;
      expect(seen.has(example.id)).toBe(false);
      seen.add(example.id);
      expect(challenge).toMatchObject({ finalBoard: example.board, finalTurtles: example.turtles });
      const wrong = await caller.submitExercise({
        ...location,
        problemFormat: 'bugFix',
        sessionId: challenge.sessionId,
        code: challenge.displayProgram,
      });
      assertWrong(wrong, example.defect);
      expect(
        await caller.submitExercise({
          ...location,
          problemFormat: 'bugFix',
          sessionId: challenge.sessionId,
          code: example.correct,
        })
      ).toMatchObject({ status: 'correct' });
      if (i === 0)
        challenge = challengeSchema.parse(
          await caller.nextExercise({ ...location, problemFormat: 'bugFix', sessionId: challenge.sessionId })
        );
    }
    expect(seen).toEqual(new Set(examples.map(({ id }) => id)));
    expect(sqlite.prepare('SELECT status FROM ExerciseSubmission ORDER BY id').all()).toEqual([
      { status: 'incorrect' },
      { status: 'correct' },
      { status: 'incorrect' },
      { status: 'correct' },
    ]);
  }
);

test.each(['regular', 'fillInBlank'] as const)(
  'actual checking membership still starts %s challenges',
  async (problemFormat) => {
    expect(await caller.startExercise({ ...location, problemFormat })).toMatchObject({
      problemFormat,
      sessionId: expect.any(Number),
    });
  }
);

test.each(examples)(
  'direct page $id resumes safely and grades through ordinary persistence using real Java',
  { timeout: 60_000 },
  async (example) => {
    const props = pageSchema.parse(await openPage({ ...location, problemId: example.id })).props;
    const id = props.initialProblemSession.id;
    expect(props.initialProblemSession).toMatchObject({ problemType: 'bugFix', traceItemIndex: 0 });
    expect(props.javaProblem).toMatchObject({
      problemId: example.id,
      finalBoard: example.board,
      finalTurtles: example.turtles,
    });
    expect(props.javaProblem.displayProgram).toBe(starter(example));
    expect(pageSchema.parse(await openPage({ ...location, problemId: example.id })).props).toEqual(props);
    expect(execution.requests).not.toHaveBeenCalled();
    const wrong = await caller.gradeFillInBlankAnswers({
      sessionId: id,
      code: props.javaProblem.displayProgram,
      elapsedMilliseconds: 21,
    });
    assertWrong(wrong, example.defect);
    const afterWrong = await stored(id);
    expect(afterWrong?.completedAt).toBeNull();
    execution.unavailable = true;
    expect(
      await caller.gradeFillInBlankAnswers({ sessionId: id, code: example.correct, elapsedMilliseconds: 30 })
    ).toMatchObject({ status: 'ungradable' });
    const afterOutage = await stored(id);
    expect(afterOutage?.submissions).toHaveLength(1);
    expect(afterOutage?.completedAt).toBeNull();
    execution.unavailable = false;
    expect(
      await caller.gradeFillInBlankAnswers({ sessionId: id, code: example.correct, elapsedMilliseconds: 42 })
    ).toMatchObject({ status: 'correct', stage: 4 });
    const saved = await stored(id);
    expect(saved?.completedAt).toEqual(new Date());
    expect(saved?.problemType).toBe('bugFix');
    expect(saved?.submissions).toEqual([
      expect.objectContaining({
        code: props.javaProblem.displayProgram,
        isCorrect: false,
        gradingStage: 4,
        elapsedMilliseconds: 21,
      }),
      expect.objectContaining({ code: example.correct, isCorrect: true, gradingStage: 4, elapsedMilliseconds: 42 }),
    ]);
  }
);

test('direct page rejects wrong location before insertion', async () => {
  await expect(
    openPage({ ...location, lectureId: `${location.lectureId}-missing`, problemId: examples[0].id })
  ).rejects.toThrow();
  expect(db.select().from(problemSessions).all()).toHaveLength(0);
});

test('direct page does not resume an incompatible stored format', async () => {
  const id = await pageSession();
  db.update(problemSessions).set({ problemType: 'executionResult' }).where(eq(problemSessions.id, id)).run();
  const before = await stored(id);
  await expect(openPage({ ...location, problemId: examples[0].id })).rejects.toThrow();
  expect(await stored(id)).toEqual(before);
});

test.each([
  { name: 'format', patch: { problemType: 'executionResult' } },
  { name: 'course', patch: { courseId: 'missing' } },
  { name: 'lecture', patch: { lectureId: 'missing' } },
])('ordinary grading rejects persisted wrong $name with no history or Java execution', async ({ patch }) => {
  const id = await pageSession();
  db.update(problemSessions).set(patch).where(eq(problemSessions.id, id)).run();
  const before = await stored(id);
  await expect(
    caller.gradeFillInBlankAnswers({ sessionId: id, code: examples[0].correct, elapsedMilliseconds: 1 })
  ).rejects.toThrow();
  expect(await stored(id)).toEqual(before);
  expect(execution.requests).not.toHaveBeenCalled();
});

test('ordinary bug sessions permit elapsed time updates', async () => {
  const id = await pageSession();
  expect(await caller.updateProblemSession({ id, incrementalElapsedMilliseconds: 17 })).toMatchObject({
    problemType: 'bugFix',
    traceItemIndex: 0,
    elapsedMilliseconds: 17,
  });
});

test.each([{ problemType: 'executionResult' }, { problemType: 'step', traceItemIndex: 1 }, { traceItemIndex: 1 }])(
  'ordinary bug session rejects trace conversion %j',
  async (patch) => {
    const id = await pageSession();
    const before = await stored(id);
    await expect(caller.updateProblemSession({ id, ...patch })).rejects.toThrow();
    expect(await stored(id)).toEqual(before);
  }
);

test.each([
  { problemType: 'bugFix', legacy: false },
  { problemType: 'executionResult', legacy: false },
  { problemType: 'bugFix', legacy: true },
  { problemType: 'executionResult', legacy: true },
])('ordinary bug session rejects client correctness %j', async ({ problemType, legacy }) => {
  const id = await pageSession();
  const before = await stored(id);
  const input = { sessionId: id, problemType, traceItemIndex: 0, isCorrect: true };
  await expect(
    caller.createProblemSubmission(
      legacy
        ? { ...input, elapsedMilliseconds: 100 }
        : { ...input, incrementalElapsedMilliseconds: 100, isCompleted: true }
    )
  ).rejects.toThrow();
  expect(await stored(id)).toEqual(before);
});

test.each(['executionResult', 'fillInBlank'])(
  'registered bug identity cannot bypass grading with stored %s format',
  async (problemType) => {
    const id = await pageSession();
    db.update(problemSessions).set({ problemType }).where(eq(problemSessions.id, id)).run();
    const before = await stored(id);
    await expect(
      caller.createProblemSubmission({
        sessionId: id,
        problemType,
        traceItemIndex: 0,
        isCorrect: true,
        isCompleted: true,
        incrementalElapsedMilliseconds: 7,
      })
    ).rejects.toThrow();
    await expect(caller.updateProblemSession({ id, problemType: 'step', traceItemIndex: 1 })).rejects.toThrow();
    expect(await stored(id)).toEqual(before);
  }
);

test('challenge rejects foreign user, wrong location and wrong format without history or Java execution', async () => {
  const challenge = challengeSchema.parse(await caller.startExercise({ ...location, problemFormat: 'bugFix' }));
  const input = {
    ...location,
    problemFormat: 'bugFix' as const,
    sessionId: challenge.sessionId,
    code: examples[0].correct,
  };
  const before = sqlite.prepare('SELECT * FROM ExerciseSession').all();
  await expect(caller.submitExercise({ ...input, problemFormat: 'fillInBlank' })).rejects.toThrow();
  await expect(caller.submitExercise({ ...input, lectureId: `${location.lectureId}-missing` })).rejects.toThrow();
  auth.userId = 'other';
  await expect(caller.submitExercise(input)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  expect(sqlite.prepare('SELECT * FROM ExerciseSession').all()).toEqual(before);
  expect(sqlite.prepare('SELECT * FROM ExerciseSubmission').all()).toHaveLength(0);
  expect(execution.requests).not.toHaveBeenCalled();
});

test('foreign users cannot grade, update, or submit a bug session; their direct page creates a separate session', async () => {
  const id = await pageSession();
  const before = await stored(id);
  auth.userId = 'other';
  await expect(
    caller.gradeFillInBlankAnswers({ sessionId: id, code: examples[0].correct, elapsedMilliseconds: 1 })
  ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  await expect(caller.updateProblemSession({ id, incrementalElapsedMilliseconds: 1 })).rejects.toThrow();
  await expect(
    caller.createProblemSubmission({
      sessionId: id,
      problemType: 'executionResult',
      traceItemIndex: 0,
      isCorrect: true,
      isCompleted: true,
      incrementalElapsedMilliseconds: 1,
    })
  ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  expect(await stored(id)).toEqual(before);
  expect(await pageSession()).not.toBe(id);
  expect(execution.requests).not.toHaveBeenCalled();
});

async function pageSession(): Promise<number> {
  const page = await openPage({ ...location, problemId: examples[0].id });
  return z.object({ props: z.object({ initialProblemSession: z.object({ id: z.number() }) }) }).parse(page).props
    .initialProblemSession.id;
}
async function stored(id: number): Promise<(ProblemSession & { submissions: ProblemSubmission[] }) | undefined> {
  return db.query.problemSessions.findFirst({ where: { id }, with: { submissions: true } });
}
function starter(example: (typeof examples)[number]): string {
  return example.defect === 'logical'
    ? example.correct.replace('亀.右を向く();', '亀.左を向く();')
    : example.correct.replace('i < 3', 'i + 3');
}
function assertWrong(result: unknown, defect: string): void {
  expect(result).toMatchObject({
    status: 'incorrect',
    detail: defect === 'logical' ? 'The final state differs from the expected one.' : 'Compile error.',
  });
  if (defect === 'syntax')
    expect(
      z
        .object({ diagnostics: z.array(z.object({ line: z.number().positive(), message: z.string().min(1) })).min(1) })
        .parse(result).diagnostics.length
    ).toBeGreaterThan(0);
}
