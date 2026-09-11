import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-sqlite/migrator';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';

import { problemSessions, problemSubmissions, users, type ProblemSession } from '../../db/schema';
import type { db as databaseClient } from '../../src/infrastructures/database';
import type { BackendRouter } from '../../src/infrastructures/trpcBackend/routers';

// Authentication and Next's request cache require their running services; persistence uses real SQLite.
vi.mock('../../src/utils/sessionOnNode', () => ({
  getSessionOnNode: async () => ({ superTokensUserId: 'student' }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

let directory: string;
let database: DatabaseSync;
let db: typeof databaseClient;
let caller: ReturnType<BackendRouter['createCaller']>;

beforeAll(async () => {
  mkdirSync('.tmp', { recursive: true });
  directory = mkdtempSync(resolve('.tmp/problem-submission-'));
  const path = `${directory}/test.sqlite3`;
  database = new DatabaseSync(path);
  vi.stubEnv('DATABASE_URL', `file:${path}`);
  ({ db } = await import('../../src/infrastructures/database'));
  migrate(db, { migrationsFolder: 'drizzle' });
  const { backendRouter } = await import('../../src/infrastructures/trpcBackend/routers');
  caller = backendRouter.createCaller({
    req: new Request('http://localhost/api/trpc', { headers: { Cookie: 'sAccessToken=test' } }),
    resHeaders: new Headers(),
    info: {} as never,
  });
  db.insert(users).values({ id: 'student', displayName: 'Student' }).run();
});

afterAll(() => {
  db?.$client.close();
  database?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.useRealTimers();
});

test('saves completion and its submission together, and rejects the previous period without mutation', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-07-02T23:59:59.999+09:00'));
  const session = createSession();
  await caller.createProblemSubmission(submissionFor(session.id));
  const completed = await db.query.problemSessions.findFirst({
    where: { id: session.id },
    with: { submissions: true },
  });
  expect(completed!.completedAt).toEqual(new Date());
  expect(completed!.elapsedMilliseconds).toBe(100);
  expect(completed!.submissions).toHaveLength(1);
  expect(completed!.submissions[0]).toMatchObject({ isCorrect: true, elapsedMilliseconds: 100 });

  vi.setSystemTime(new Date('2026-07-03T00:00:00+09:00'));
  await expect(caller.createProblemSubmission(submissionFor(session.id))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(
    caller.updateProblemSession({ id: session.id, incrementalElapsedMilliseconds: 100 })
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect(await db.query.problemSessions.findFirst({ where: { id: session.id }, with: { submissions: true } })).toEqual(
    completed
  );
});

test('rolls back completion and elapsed time when saving the submission fails', async () => {
  const session = createSession();
  database.exec(
    "CREATE TRIGGER reject_submission BEFORE INSERT ON ProblemSubmission BEGIN SELECT RAISE(ABORT, 'submission rejected'); END"
  );
  try {
    await expect(caller.createProblemSubmission(submissionFor(session.id))).rejects.toThrow();
    expect(await db.query.problemSessions.findFirst({ where: { id: session.id } })).toEqual(session);
    expect(db.select().from(problemSubmissions).where(eq(problemSubmissions.sessionId, session.id)).all()).toHaveLength(
      0
    );
  } finally {
    database.exec('DROP TRIGGER reject_submission');
  }
});

test.each(['executionResult', 'step'])(
  'accepts the pre-deployment %s submission flow without double-counting time',
  async (problemType) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-11T12:00:00+09:00'));
    const session = createSession(problemType);
    const legacyUpdate = {
      id: session.id,
      incrementalElapsedMilliseconds: 100,
      completedAt: new Date('2000-01-01T00:00:00Z'),
    };
    const updated = await caller.updateProblemSession(legacyUpdate);
    expect(updated.completedAt).toBeNull();
    const submission = {
      sessionId: session.id,
      problemType,
      traceItemIndex: 0,
      elapsedMilliseconds: updated.elapsedMilliseconds,
      isCorrect: true,
    };
    if (problemType === 'step') {
      await caller.createProblemSubmission({ ...submission, traceItemIndex: 1 });
      const inProgress = await db.query.problemSessions.findFirst({ where: { id: session.id } });
      expect(inProgress!.completedAt).toBeNull();
    }
    await caller.createProblemSubmission({ ...submission, traceItemIndex: problemType === 'step' ? 4 : 0 });
    const completed = await db.query.problemSessions.findFirst({
      where: { id: session.id },
      with: { submissions: true },
    });
    expect(completed!.completedAt).toEqual(new Date());
    expect(completed!.elapsedMilliseconds).toBe(100);
    expect(completed!.submissions).toHaveLength(problemType === 'step' ? 2 : 1);
    expect(completed!.submissions.every((answer) => answer.elapsedMilliseconds === 100)).toBe(true);
  }
);

function createSession(problemType = 'executionResult'): ProblemSession {
  return db
    .insert(problemSessions)
    .values({
      userId: 'student',
      courseId: 'test',
      lectureId: 'test',
      problemId: 'test1',
      createdAt: new Date(),
      problemVariablesSeed: '1',
      problemType,
      traceItemIndex: 0,
    })
    .returning()
    .get()!;
}

function submissionFor(sessionId: number): Parameters<typeof caller.createProblemSubmission>[0] {
  return {
    sessionId,
    problemType: 'executionResult',
    traceItemIndex: 0,
    incrementalElapsedMilliseconds: 100,
    isCorrect: true,
    isCompleted: true,
  };
}
