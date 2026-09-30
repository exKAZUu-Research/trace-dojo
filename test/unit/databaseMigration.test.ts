import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { migrate } from 'drizzle-orm/node-sqlite/migrator';
import { expect, test } from 'vitest';

import { problemSessions, relations } from '../../db/schema';

test.each([
  { format: 'text', createdAt: '2026-09-01 00:00:00.123 +00:00', completedAt: '2026-09-01 00:00:00.456 +00:00' },
  { format: 'milliseconds', createdAt: 1_788_220_800_123, completedAt: 1_788_220_800_456 },
])(
  'upgrades $format learning activity without losing timestamps, answers, or generated IDs',
  async ({ createdAt, completedAt }) => {
    mkdirSync('.tmp', { recursive: true });
    const directory = mkdtempSync(resolve('.tmp/database-migration-'));
    const sqlite = new DatabaseSync(`${directory}/existing.sqlite3`);
    try {
      sqlite.exec(readFileSync('test/fixtures/prismaSchema.sql', 'utf8'));
      sqlite.prepare("INSERT INTO User VALUES ('student', '2026-09-01 00:00:00', ?, 'Student')").run(createdAt);
      sqlite
        .prepare(`
      INSERT INTO ProblemSession (id, createdAt, updatedAt, userId, courseId, lectureId, problemId,
        problemVariablesSeed, problemType, traceItemIndex, elapsedMilliseconds, completedAt)
      VALUES (42, ?, ?, 'student', 'course', 'lecture', 'test1', '1', 'fillInBlank', 0, 250, ?)
    `)
        .run(createdAt, createdAt, completedAt);
      sqlite
        .prepare(`
      INSERT INTO ProblemSubmission (id, createdAt, sessionId, problemType, traceItemIndex,
        elapsedMilliseconds, isCorrect, answers, gradingStage)
      VALUES (12, ?, 42, 'fillInBlank', 0, 250, 1, '["answer"]', 2)
    `)
        .run(completedAt);
      const db = drizzle({ client: sqlite, relations });
      migrate(db, { migrationsFolder: 'drizzle' });
      migrate(db, { migrationsFolder: 'drizzle' });
      const user = await db.query.users.findFirst({
        where: { id: 'student' },
        with: { problemSessions: { with: { submissions: true } } },
      });
      expect(user).toMatchObject({
        displayName: 'Student',
        createdAt: new Date('2026-09-01T00:00:00Z'),
        updatedAt: new Date(1_788_220_800_123),
        problemSessions: [
          {
            id: 42,
            createdAt: new Date(1_788_220_800_123),
            updatedAt: new Date(1_788_220_800_123),
            completedAt: new Date(1_788_220_800_456),
            elapsedMilliseconds: 250,
            submissions: [
              {
                id: 12,
                createdAt: new Date(1_788_220_800_456),
                isCorrect: true,
                answers: '["answer"]',
                gradingStage: 2,
              },
            ],
          },
        ],
      });
      const session = db
        .insert(problemSessions)
        .values({
          userId: 'student',
          courseId: 'course',
          lectureId: 'lecture',
          problemId: 'test1',
          problemVariablesSeed: '2',
          problemType: 'executionResult',
          traceItemIndex: 0,
        })
        .returning()
        .get()!;
      expect(session.id).toBeGreaterThan(42);
      expect(session.createdAt).toBeInstanceOf(Date);
      const updated = db
        .update(problemSessions)
        .set({ elapsedMilliseconds: 500 })
        .where(eq(problemSessions.id, 42))
        .returning()
        .get()!;
      expect(updated.updatedAt.getTime()).toBeGreaterThan(1_788_220_800_123);
      expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(() => db.delete(problemSessions).where(eq(problemSessions.id, 42)).run()).toThrow();
    } finally {
      sqlite.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
);

test('requires a user ID in a freshly migrated database', () => {
  const sqlite = new DatabaseSync(':memory:');
  try {
    migrate(drizzle({ client: sqlite }), { migrationsFolder: 'drizzle' });
    expect(() => sqlite.exec("INSERT INTO User (updatedAt, displayName) VALUES (0, 'Missing ID')")).toThrow(/NOT NULL/);
    expect(() => sqlite.exec("INSERT INTO User (id, updatedAt, displayName) VALUES (NULL, 0, 'Null ID')")).toThrow(
      /NOT NULL/
    );
    sqlite.exec("INSERT INTO User (id, updatedAt, displayName) VALUES ('student', 0, 'Student')");
    expect(sqlite.prepare('SELECT id, displayName FROM User').all()).toEqual([
      { id: 'student', displayName: 'Student' },
    ]);
  } finally {
    sqlite.close();
  }
});
