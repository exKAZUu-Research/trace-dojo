import { defineRelations, sql } from 'drizzle-orm';
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

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

export const users = sqliteTable(
  'User',
  {
    id: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    displayName: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.id] })]
);

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

export const problemSubmissions = sqliteTable(
  'ProblemSubmission',
  {
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
  },
  (table) => [index('ProblemSubmission_sessionId_idx').on(table.sessionId)]
);

export const exerciseSessions = sqliteTable(
  'ExerciseSession',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    createdAt: createdAt(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    courseId: text().notNull(),
    lectureId: text().notNull(),
    learningMode: text().notNull(),
    problemFormat: text().notNull(),
    problemId: text().notNull(),
    seed: text().notNull(),
    problemType: text().notNull().default('executionResult'),
    traceItemIndex: integer().notNull().default(0),
    traceItemCount: integer(),
    completedAt: integer({ mode: 'timestamp_ms' }),
  },
  (table) => [
    index('ExerciseSession_user_lecture_mode_created_idx').on(
      table.userId,
      table.courseId,
      table.lectureId,
      table.learningMode,
      table.createdAt
    ),
  ]
);

export const exerciseSubmissions = sqliteTable(
  'ExerciseSubmission',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    createdAt: createdAt(),
    sessionId: integer()
      .notNull()
      .references(() => exerciseSessions.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    answers: text().notNull(),
    status: text().notNull(),
    gradingStage: integer(),
    problemType: text(),
    traceItemIndex: integer(),
    requestId: text(),
  },
  (table) => [
    index('ExerciseSubmission_sessionId_idx').on(table.sessionId),
    uniqueIndex('ExerciseSubmission_sessionId_requestId_unique')
      .on(table.sessionId, table.requestId)
      .where(sql`${table.requestId} IS NOT NULL`),
  ]
);

export const relations = defineRelations(
  { users, problemSessions, problemSubmissions, exerciseSessions, exerciseSubmissions },
  (r) => ({
    users: {
      problemSessions: r.many.problemSessions({ from: r.users.id, to: r.problemSessions.userId }),
      exerciseSessions: r.many.exerciseSessions({ from: r.users.id, to: r.exerciseSessions.userId }),
    },
    problemSessions: {
      user: r.one.users({ from: r.problemSessions.userId, to: r.users.id, optional: false }),
      submissions: r.many.problemSubmissions({ from: r.problemSessions.id, to: r.problemSubmissions.sessionId }),
    },
    problemSubmissions: {
      session: r.one.problemSessions({
        from: r.problemSubmissions.sessionId,
        to: r.problemSessions.id,
        optional: false,
      }),
    },
    exerciseSessions: {
      user: r.one.users({ from: r.exerciseSessions.userId, to: r.users.id, optional: false }),
      submissions: r.many.exerciseSubmissions({ from: r.exerciseSessions.id, to: r.exerciseSubmissions.sessionId }),
    },
    exerciseSubmissions: {
      session: r.one.exerciseSessions({
        from: r.exerciseSubmissions.sessionId,
        to: r.exerciseSessions.id,
        optional: false,
      }),
    },
  })
);

export type ProblemSession = typeof problemSessions.$inferSelect;

export type ProblemSubmission = typeof problemSubmissions.$inferSelect;
export type ExerciseSession = typeof exerciseSessions.$inferSelect;
