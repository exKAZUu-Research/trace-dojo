/* oxlint-disable unicorn/no-null -- SQLite returns SQL NULL for absent legacy/source fields. */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

test('adds full-source history while retaining both legacy answer arrays and completion timestamps', () => {
  mkdirSync('.tmp', { recursive: true });
  const directory = mkdtempSync(resolve('.tmp/full-source-migration-'));
  const sqlite = new DatabaseSync(`${directory}/legacy.sqlite3`);
  try {
    const previousMigrations = `${directory}/previous`;
    mkdirSync(previousMigrations);
    for (const name of [
      '20260911164043_init',
      '20260911181410_submission_session_index',
      '20261001042726_exercise_sessions',
    ]) {
      cpSync(`drizzle/${name}`, `${previousMigrations}/${name}`, { recursive: true });
    }
    const db = drizzle({ client: sqlite });
    migrate(db, { migrationsFolder: previousMigrations });
    sqlite.exec(`
      INSERT INTO User (id, updatedAt, displayName) VALUES ('legacy', 1, 'Legacy');
      INSERT INTO ProblemSession (id, updatedAt, userId, courseId, lectureId, problemId, problemVariablesSeed, problemType, traceItemIndex, completedAt)
      VALUES (1, 1, 'legacy', 'test', 'test', 'fillInBlank1', 'seed', 'fillInBlank', 0, 1234);
      INSERT INTO ProblemSubmission (sessionId, problemType, traceItemIndex, elapsedMilliseconds, isCorrect, answers, gradingStage)
      VALUES (1, 'fillInBlank', 0, 50, 1, '["i < 4"]', 1);
      INSERT INTO ExerciseSession (id, userId, courseId, lectureId, learningMode, problemFormat, problemId, seed, problemType, traceItemIndex, completedAt)
      VALUES (1, 'legacy', 'test', 'test', 'challenge', 'fillInBlank', 'fillInBlank1', 'seed', 'fillInBlank', 0, 2345);
      INSERT INTO ExerciseSubmission (sessionId, answers, status, gradingStage)
      VALUES (1, '["i <= 3"]', 'correct', 2);
    `);
    const ordinary = sqlite.prepare('SELECT * FROM ProblemSubmission').all();
    const challenge = sqlite.prepare('SELECT * FROM ExerciseSubmission').all();
    migrate(db, { migrationsFolder: 'drizzle' });
    migrate(db, { migrationsFolder: 'drizzle' });
    for (const table of ['ProblemSubmission', 'ExerciseSubmission']) {
      expect(sqlite.prepare(`PRAGMA table_info('${table}')`).all()).toContainEqual(
        expect.objectContaining({ name: 'code', type: 'TEXT', notnull: 0 })
      );
    }
    expect(sqlite.prepare('SELECT * FROM ProblemSubmission').all()).toEqual(
      ordinary.map((row) => ({ ...row, code: null }))
    );
    expect(sqlite.prepare('SELECT * FROM ExerciseSubmission').all()).toEqual(
      challenge.map((row) => ({ ...row, code: null }))
    );
    expect(sqlite.prepare('SELECT completedAt FROM ProblemSession').get()).toEqual({ completedAt: 1234 });
    expect(sqlite.prepare('SELECT completedAt FROM ExerciseSession').get()).toEqual({ completedAt: 2345 });
    const code = '  public class Main {\n  public static void main(String[] args) {}\n}\n';
    sqlite
      .prepare(
        "INSERT INTO ProblemSubmission (sessionId, problemType, traceItemIndex, elapsedMilliseconds, isCorrect, code, gradingStage) VALUES (1, 'fillInBlank', 0, 5, 0, ?, 4)"
      )
      .run(code);
    sqlite
      .prepare("INSERT INTO ExerciseSubmission (sessionId, status, code, gradingStage) VALUES (1, 'incorrect', ?, 4)")
      .run(code);
    for (const table of ['ProblemSubmission', 'ExerciseSubmission']) {
      expect(sqlite.prepare(`SELECT code, answers FROM ${table} ORDER BY id DESC LIMIT 1`).get()).toEqual({
        code,
        answers: null,
      });
    }
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
