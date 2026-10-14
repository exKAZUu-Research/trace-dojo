import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { migrate } from 'drizzle-orm/node-sqlite/migrator';
import { expect, test } from 'vitest';

test('explicit End migration upgrades populated history and can be reapplied without losing dismissal', () => {
  mkdirSync('.tmp', { recursive: true });
  const directory = mkdtempSync(resolve('.tmp/end-migration-'));
  const sqlite = new DatabaseSync(`${directory}/history.sqlite3`);
  const db = drizzle({ client: sqlite });
  try {
    const legacyFolder = `${directory}/legacy`;
    mkdirSync(legacyFolder);
    for (const name of [
      '20260911164043_init',
      '20260911181410_submission_session_index',
      '20261001042726_exercise_sessions',
    ])
      cpSync(resolve('drizzle', name), `${legacyFolder}/${name}`, { recursive: true });
    migrate(db, { migrationsFolder: legacyFolder });
    sqlite.exec(`
      INSERT INTO User (id, updatedAt, displayName) VALUES ('migration-student', 1000, 'Migration student');
      INSERT INTO ProblemSession
        (id, updatedAt, userId, courseId, lectureId, problemId, problemVariablesSeed, problemType, traceItemIndex, completedAt)
        VALUES (1, 1000, 'migration-student', 'test', 'test', 'fillInBlank2', 'ordinary', 'fillInBlank', 0, 2000);
      INSERT INTO ProblemSubmission
        (sessionId, problemType, traceItemIndex, elapsedMilliseconds, isCorrect, answers)
        VALUES (1, 'fillInBlank', 0, 50, 1, '["x + 1"]');
      INSERT INTO ExerciseSession
        (id, userId, courseId, lectureId, learningMode, problemFormat, problemId, seed, problemType, traceItemIndex, completedAt)
        VALUES (1, 'migration-student', 'test', 'test', 'challenge', 'fillInBlank', 'fillInBlank2', 'finished', 'fillInBlank', 0, 2000),
               (2, 'migration-student', 'test', 'test', 'challenge', 'regular', 'test1', 'unfinished', 'step', 1, NULL);
      INSERT INTO ExerciseSubmission (sessionId, status, answers, gradingStage)
        VALUES (1, 'correct', '["x + 1"]', 1);
    `);
    const before = legacyHistory(sqlite);
    migrate(db, { migrationsFolder: resolve('drizzle') });
    expect(legacyHistory(sqlite)).toEqual(before);
    expect(sqlite.prepare('SELECT id, completedAt, endedAt FROM ExerciseSession ORDER BY id').all()).toEqual([
      // oxlint-disable-next-line unicorn/no-null -- SQLite represents SQL NULL as JavaScript null.
      { id: 1, completedAt: 2000, endedAt: null },
      // oxlint-disable-next-line unicorn/no-null -- SQLite represents SQL NULL as JavaScript null.
      { id: 2, completedAt: null, endedAt: null },
    ]);
    sqlite.prepare('UPDATE ExerciseSession SET endedAt = ? WHERE id = ?').run(3000, 1);
    const dismissed = sqlite.prepare('SELECT * FROM ExerciseSession ORDER BY id').all();
    migrate(db, { migrationsFolder: resolve('drizzle') });
    expect(sqlite.prepare('SELECT * FROM ExerciseSession ORDER BY id').all()).toEqual(dismissed);
    expect(legacyHistory(sqlite)).toEqual(before);
  } finally {
    sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

const legacyHistory = (sqlite: DatabaseSync): unknown => ({
  users: sqlite.prepare('SELECT * FROM User ORDER BY id').all(),
  ordinarySessions: sqlite.prepare('SELECT * FROM ProblemSession ORDER BY id').all(),
  ordinarySubmissions: sqlite.prepare('SELECT * FROM ProblemSubmission ORDER BY id').all(),
  sessions: sqlite
    .prepare(`SELECT id, createdAt, userId, courseId, lectureId, learningMode, problemFormat,
    problemId, seed, problemType, traceItemIndex, completedAt FROM ExerciseSession ORDER BY id`)
    .all(),
  submissions: sqlite.prepare('SELECT * FROM ExerciseSubmission ORDER BY id').all(),
});
