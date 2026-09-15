import { TRPCError } from '@trpc/server';
import { and, desc, eq, gt, gte, isNull } from 'drizzle-orm';
import { z } from 'zod';

import { exerciseSessions, exerciseSubmissions, type ExerciseSession } from '../../../../db/schema';
import { db } from '../../database';
import { logger } from '../../pino';
import { authorize } from '../middlewares';
import { procedure } from '../trpc';

import { getLearningPeriodFilter } from '@/learningPeriod';
import { gradeByJavaExecution } from '@/problems/fillInBlank/grade';
import { instantiateExercise, type ExerciseDisplay } from '@/problems/fillInBlank/exerciseProblem';
import { getLectureExerciseIds } from '@/problems/fillInBlank/problemData';
import { courseIdToLectureIds, type CourseId } from '@/problems/problemData';

const turtlesSchema = z.array(z.object({ x: z.number(), y: z.number(), color: z.string(), dir: z.string() }));
const locationSchema = z.object({ courseId: z.string(), lectureId: z.string() });
const submissionSchema = locationSchema.extend({
  sessionId: z.number().int().positive(),
  answers: z.array(z.string().max(1000)).max(50),
});
const startLocks = new Map<string, Promise<void>>();
type SubmissionResult = { status: 'correct' | 'incorrect' | 'ungradable'; detail: string };
const gradingLocks = new Map<string, Promise<SubmissionResult>>();
const sessionQueues = new Map<number, Promise<void>>();

export const exerciseProcedures = {
  startExercise: procedure.use(authorize).input(locationSchema).mutation(async ({ ctx, input }) => {
    const userId = ctx.session.superTokensUserId;
    checkedLecture(input.courseId, input.lectureId);
    const key = `${userId}:${input.courseId}:${input.lectureId}`;
    return await lockedStart(key, () => startOrResume(userId, input.courseId, input.lectureId));
  }),
  nextExercise: procedure
    .use(authorize)
    .input(locationSchema.extend({ sessionId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
    const userId = ctx.session.superTokensUserId;
    checkedLecture(input.courseId, input.lectureId);
    const key = `${userId}:${input.courseId}:${input.lectureId}`;
    return await lockedStart(key, () => {
      const previous = ownedSession(input.sessionId, userId, input.courseId, input.lectureId);
      if (!previous.completedAt) throw new TRPCError({ code: 'BAD_REQUEST' });
      const newer = db
        .select()
        .from(exerciseSessions)
        .where(
          and(
            eq(exerciseSessions.userId, userId),
            eq(exerciseSessions.courseId, input.courseId),
            eq(exerciseSessions.lectureId, input.lectureId),
            eq(exerciseSessions.learningMode, 'challenge'),
            gt(exerciseSessions.id, previous.id)
          )
        )
        .orderBy(desc(exerciseSessions.id))
        .get();
      if (newer) return toDisplay(newer);
      const ids = getLectureExerciseIds(input.courseId as CourseId, input.lectureId);
      return ids.length
        ? createSession(userId, input.courseId, input.lectureId, ids, previous.exerciseProblemId)
        : undefined;
    });
  }),
  submitExercise: procedure.use(authorize).input(submissionSchema).mutation(async ({ ctx, input }) => {
    const receivedAt = new Date();
    checkedLecture(input.courseId, input.lectureId);
    const userId = ctx.session.superTokensUserId;
    ownedSession(input.sessionId, userId, input.courseId, input.lectureId, receivedAt);
    const key = `${input.sessionId}:${JSON.stringify(input.answers)}`;
    const existing = gradingLocks.get(key);
    if (existing) return await existing;
    const preceding = sessionQueues.get(input.sessionId) ?? Promise.resolve();
    const grading = preceding.then(() =>
      gradeAndSave(input.sessionId, userId, input.courseId, input.lectureId, input.answers, receivedAt)
    );
    const queued = grading.then(() => undefined, () => undefined);
    sessionQueues.set(input.sessionId, queued);
    gradingLocks.set(key, grading);
    try {
      return await grading;
    } finally {
      gradingLocks.delete(key);
      if (sessionQueues.get(input.sessionId) === queued) sessionQueues.delete(input.sessionId);
    }
  }),
};

const checkedLecture = (courseId: string, lectureId: string): void => {
  if (!(courseId in courseIdToLectureIds) || !courseIdToLectureIds[courseId as CourseId]?.includes(lectureId)) {
    throw new TRPCError({ code: 'NOT_FOUND' });
  }
};

const lockedStart = async (
  key: string,
  action: () => ExerciseDisplay | undefined
): Promise<ExerciseDisplay | undefined> => {
  const preceding = startLocks.get(key) ?? Promise.resolve();
  const pending = preceding.then(action);
  const queued = pending.then(() => undefined, () => undefined);
  startLocks.set(key, queued);
  try {
    return await pending;
  } finally {
    if (startLocks.get(key) === queued) startLocks.delete(key);
  }
};

const periodStart = (at = new Date()): Date | undefined => getLearningPeriodFilter(at).createdAt?.gte;

const ownedSession = (id: number, userId: string, courseId: string, lectureId: string, at = new Date()): ExerciseSession => {
  const session = db.select().from(exerciseSessions).where(eq(exerciseSessions.id, id)).get();
  const start = periodStart(at);
  if (!session || (start && session.createdAt < start)) throw new TRPCError({ code: 'NOT_FOUND' });
  if (
    session.userId !== userId ||
    session.courseId !== courseId ||
    session.lectureId !== lectureId ||
    session.learningMode !== 'challenge' ||
    session.problemFormat !== 'fillInBlank'
  ) {
    throw new TRPCError({ code: 'UNAUTHORIZED' });
  }
  return session;
};

const startOrResume = (userId: string, courseId: string, lectureId: string): ExerciseDisplay | undefined => {
  const start = periodStart();
  const current = db
    .select()
    .from(exerciseSessions)
    .where(
      and(
        eq(exerciseSessions.userId, userId),
        eq(exerciseSessions.courseId, courseId),
        eq(exerciseSessions.lectureId, lectureId),
        eq(exerciseSessions.learningMode, 'challenge'),
        isNull(exerciseSessions.completedAt),
        start ? gte(exerciseSessions.createdAt, start) : undefined
      )
    )
    .orderBy(desc(exerciseSessions.id))
    .get();
  if (current) return toDisplay(current);
  const latest = db
    .select()
    .from(exerciseSessions)
    .where(
      and(
        eq(exerciseSessions.userId, userId),
        eq(exerciseSessions.courseId, courseId),
        eq(exerciseSessions.lectureId, lectureId),
        eq(exerciseSessions.learningMode, 'challenge'),
        start ? gte(exerciseSessions.createdAt, start) : undefined
      )
    )
    .orderBy(desc(exerciseSessions.id))
    .get();
  if (latest) return toDisplay(latest);
  const ids = getLectureExerciseIds(courseId as CourseId, lectureId);
  return ids.length ? createSession(userId, courseId, lectureId, ids) : undefined;
};

const createSession = (
  userId: string,
  courseId: string,
  lectureId: string,
  ids: string[],
  previousId?: string
): ExerciseDisplay => {
  const candidates = ids.length > 1 ? ids.filter((id) => id !== previousId) : ids;
  const exerciseProblemId = candidates[Math.floor(Math.random() * candidates.length)];
  const snapshot = instantiateExercise(exerciseProblemId);
  const row = db.insert(exerciseSessions).values({
    userId, courseId, lectureId, learningMode: 'challenge', problemFormat: 'fillInBlank',
    exerciseProblemId, baseProblemId: snapshot.baseProblemId,
    programTemplate: snapshot.programTemplate, displayProgram: snapshot.displayProgram,
    blankCount: snapshot.blankCount, expectedBoard: snapshot.expectedBoard,
    expectedTurtles: JSON.stringify(snapshot.expectedTurtles),
  }).returning().get();
  return toDisplay(row);
};

const toDisplay = (row: ExerciseSession): ExerciseDisplay => ({
  sessionId: row.id,
  exerciseProblemId: row.exerciseProblemId,
  displayProgram: row.displayProgram,
  blankCount: row.blankCount,
  expectedBoard: row.expectedBoard,
  expectedTurtles: turtlesSchema.parse(JSON.parse(row.expectedTurtles)),
  completed: Boolean(row.completedAt),
});

const gradeAndSave = async (
  id: number,
  userId: string,
  courseId: string,
  lectureId: string,
  answers: string[],
  receivedAt: Date
): Promise<SubmissionResult> => {
  const session = ownedSession(id, userId, courseId, lectureId, receivedAt);
  if (session.completedAt) return { status: 'correct' as const, detail: '' };
  if (answers.length !== session.blankCount) throw new TRPCError({ code: 'BAD_REQUEST' });
  const turtles = turtlesSchema.parse(JSON.parse(session.expectedTurtles));
  const result = await gradeByJavaExecution(session.programTemplate, { board: session.expectedBoard, turtles }, answers);
  if (result.status === 'ungradable') {
    logger.warn('Failed to grade exercise %d: %s', id, result.detail);
  }
  db.transaction((tx) => {
    const current = tx.select().from(exerciseSessions).where(eq(exerciseSessions.id, id)).get();
    if (!current || current.completedAt) return;
    tx.insert(exerciseSubmissions)
      .values({
        createdAt: receivedAt,
        sessionId: id,
        answers: JSON.stringify(answers),
        status: result.status,
        gradingStage: result.status === 'ungradable' ? undefined : result.stage,
      })
      .run();
    if (result.status === 'correct') {
      tx.update(exerciseSessions).set({ completedAt: receivedAt }).where(eq(exerciseSessions.id, id)).run();
    }
  });
  return { status: result.status, detail: result.status === 'incorrect' ? result.detail : '' };
};
