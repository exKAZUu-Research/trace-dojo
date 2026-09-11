import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { PrismaClient, ProblemSession } from '@prisma/client';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';

import type { BackendRouter } from '../../src/infrastructures/trpcBackend/routers';

// Authentication and Next's request cache require their running services; persistence uses real SQLite.
vi.mock('../../src/utils/sessionOnNode', () => ({
  getSessionOnNode: async () => ({ superTokensUserId: 'student' }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

let directory: string;
let database: DatabaseSync;
let prisma: PrismaClient;
let caller: ReturnType<BackendRouter['createCaller']>;

beforeAll(async () => {
  mkdirSync('.tmp', { recursive: true });
  directory = mkdtempSync(resolve('.tmp/problem-submission-'));
  const path = `${directory}/test.sqlite3`;
  database = new DatabaseSync(path);
  for (const migration of readdirSync('prisma/migrations').toSorted()) {
    if (migration === 'migration_lock.toml') continue;
    database.exec(readFileSync(`prisma/migrations/${migration}/migration.sql`, 'utf8'));
  }
  vi.stubEnv('DATABASE_URL', `file:${path}`);
  ({ prisma } = await import('../../src/infrastructures/prisma'));
  const { backendRouter } = await import('../../src/infrastructures/trpcBackend/routers');
  caller = backendRouter.createCaller({
    req: new Request('http://localhost/api/trpc', { headers: { Cookie: 'sAccessToken=test' } }),
    resHeaders: new Headers(),
    info: {} as never,
  });
  await prisma.user.create({ data: { id: 'student', displayName: 'Student' } });
});

afterAll(async () => {
  await prisma?.$disconnect();
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
  const session = await createSession();
  await caller.createProblemSubmission(submissionFor(session.id));
  const completed = await prisma.problemSession.findUniqueOrThrow({
    where: { id: session.id },
    include: { submissions: true },
  });
  expect(completed.completedAt).toEqual(new Date());
  expect(completed.elapsedMilliseconds).toBe(100);
  expect(completed.submissions).toHaveLength(1);
  expect(completed.submissions[0]).toMatchObject({ isCorrect: true, elapsedMilliseconds: 100 });

  vi.setSystemTime(new Date('2026-07-03T00:00:00+09:00'));
  await expect(caller.createProblemSubmission(submissionFor(session.id))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(
    caller.updateProblemSession({ id: session.id, incrementalElapsedMilliseconds: 100 })
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect(
    await prisma.problemSession.findUniqueOrThrow({ where: { id: session.id }, include: { submissions: true } })
  ).toEqual(completed);
});

test('rolls back completion and elapsed time when saving the submission fails', async () => {
  const session = await createSession();
  database.exec(
    "CREATE TRIGGER reject_submission BEFORE INSERT ON ProblemSubmission BEGIN SELECT RAISE(ABORT, 'submission rejected'); END"
  );
  try {
    await expect(caller.createProblemSubmission(submissionFor(session.id))).rejects.toThrow();
    expect(await prisma.problemSession.findUniqueOrThrow({ where: { id: session.id } })).toEqual(session);
    expect(await prisma.problemSubmission.count({ where: { sessionId: session.id } })).toBe(0);
  } finally {
    database.exec('DROP TRIGGER reject_submission');
  }
});

async function createSession(): Promise<ProblemSession> {
  return await prisma.problemSession.create({
    data: {
      userId: 'student',
      courseId: 'test',
      lectureId: 'test',
      problemId: 'test',
      createdAt: new Date(),
      problemVariablesSeed: '1',
      problemType: 'executionResult',
      traceItemIndex: 0,
    },
  });
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
