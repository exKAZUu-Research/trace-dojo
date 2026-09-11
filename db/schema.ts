import { defineRelations, sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

const createdAt = () =>
  integer({ mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch('subsec') * 1000)`)
    .$defaultFn(() => new Date());
const updatedAt = () =>
  integer({ mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdate(() => new Date());

export const users = sqliteTable('User', {
  id: text().primaryKey().notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  displayName: text().notNull(),
});

export const problemSessions = sqliteTable(
  'ProblemSession',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    courseId: text().notNull(),
    lectureId: text().notNull(),
    problemId: text().notNull(),
    problemVariablesSeed: text().notNull(),
    problemType: text().notNull(),
    traceItemIndex: integer().notNull(),
    elapsedMilliseconds: integer().notNull().default(0),
    completedAt: integer({ mode: 'timestamp_ms' }),
  },
  (table) => [
    index('ProblemSession_userId_courseId_lectureId_problemId_completedAt_idx').on(
      table.userId,
      table.courseId,
      table.lectureId,
      table.problemId,
      table.completedAt
    ),
  ]
);

export const problemSubmissions = sqliteTable('ProblemSubmission', {
  id: integer().primaryKey({ autoIncrement: true }),
  createdAt: createdAt(),
  sessionId: integer()
    .notNull()
    .references(() => problemSessions.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
  problemType: text().notNull(),
  traceItemIndex: integer().notNull(),
  elapsedMilliseconds: integer().notNull(),
  isCorrect: integer({ mode: 'boolean' }).notNull(),
  answers: text(),
  gradingStage: integer(),
});

export const relations = defineRelations({ users, problemSessions, problemSubmissions }, (r) => ({
  users: { problemSessions: r.many.problemSessions({ from: r.users.id, to: r.problemSessions.userId }) },
  problemSessions: {
    user: r.one.users({ from: r.problemSessions.userId, to: r.users.id, optional: false }),
    submissions: r.many.problemSubmissions({ from: r.problemSessions.id, to: r.problemSubmissions.sessionId }),
  },
  problemSubmissions: {
    session: r.one.problemSessions({ from: r.problemSubmissions.sessionId, to: r.problemSessions.id, optional: false }),
  },
}));

export type ProblemSession = typeof problemSessions.$inferSelect;

export type ProblemSubmission = typeof problemSubmissions.$inferSelect;
