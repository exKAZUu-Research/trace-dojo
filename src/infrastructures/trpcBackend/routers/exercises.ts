import { randomUUID } from 'node:crypto';

import { TRPCError } from '@trpc/server';
import { and, asc, desc, eq, gt, gte } from 'drizzle-orm';
import { z } from 'zod';

import { exerciseSessions, exerciseSubmissions, type ExerciseSession } from '../../../../db/schema';
import { db } from '../../database';
import { logger } from '../../pino';
import { authorize } from '../middlewares';
import { procedure } from '../trpc';

import { getLearningPeriodFilter } from '@/learningPeriod';
import { gradeFillInBlankAnswers } from '@/problems/fillInBlank/grade';
import type { ExerciseDisplay } from '@/problems/fillInBlank/exerciseProblem';
import { instantiateProblem } from '@/problems/instantiateProblem';
import {
  courseIdToLectureIds,
  courseIdToLectureIndexToExerciseProblemIds,
  problemIdToLanguageIdToProgram,
  type CourseId,
  type ProblemId,
} from '@/problems/problemData';

const locationSchema = z.object({ courseId: z.string(), lectureId: z.string() });
const submissionSchema = locationSchema.extend({
  sessionId: z.number().int().positive(),
  answers: z.array(z.string().max(1000)).max(50),
});
const startLocks = new Map<string, Promise<unknown>>();
export interface SubmissionResult {
  status: 'correct' | 'incorrect' | 'ungradable';
  detail: string;
}
const gradingLocks = new Map<string, Promise<SubmissionResult>>();
const sessionQueues = new Map<number, Promise<unknown>>();

export const exerciseProcedures = {
  startExercise: procedure
    .use(authorize)
    .input(locationSchema)
    .mutation(async ({ ctx, input }) => {
      checkedLecture(input.courseId, input.lectureId);
      const userId = ctx.session.superTokensUserId;
      return await lockedStart(`${userId}:${input.courseId}:${input.lectureId}`, () =>
        startOrResume(userId, input.courseId, input.lectureId)
      );
    }),
  nextExercise: procedure
    .use(authorize)
    .input(locationSchema.extend({ sessionId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      checkedLecture(input.courseId, input.lectureId);
      const userId = ctx.session.superTokensUserId;
      return await lockedStart(`${userId}:${input.courseId}:${input.lectureId}`, () => {
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
          .orderBy(asc(exerciseSessions.id))
          .get();
        if (newer) return toDisplay(newer);
        return createFromCandidates(userId, input.courseId, input.lectureId, previous.problemId);
      });
    }),
  submitExercise: procedure
    .use(authorize)
    .input(submissionSchema)
    .mutation(async ({ ctx, input }) => {
      const receivedAt = new Date();
      checkedLecture(input.courseId, input.lectureId);
      const userId = ctx.session.superTokensUserId;
      ownedSession(input.sessionId, userId, input.courseId, input.lectureId, receivedAt);
      const key = `${input.sessionId}:${JSON.stringify(input.answers)}`;
      const existing = gradingLocks.get(key);
      if (existing) return await existing;
      const grading = (sessionQueues.get(input.sessionId) ?? Promise.resolve()).then(() =>
        gradeAndSave(input.sessionId, userId, input.courseId, input.lectureId, input.answers, receivedAt)
      );
      const queued = grading.then(
        () => true,
        () => false
      );
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
  if (!(courseId in courseIdToLectureIds) || !courseIdToLectureIds[courseId as CourseId]?.includes(lectureId))
    throw new TRPCError({ code: 'NOT_FOUND' });
};

const candidatesFor = (courseId: string, lectureId: string): string[] => {
  const lectureIndex = courseIdToLectureIds[courseId as CourseId].indexOf(lectureId);
  const candidates = courseIdToLectureIndexToExerciseProblemIds[courseId]?.[lectureIndex];
  if (!candidates) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Missing challenge configuration' });
  for (const id of candidates) {
    if (!problemIdToLanguageIdToProgram[id as ProblemId])
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: `Unknown challenge problem: ${id}` });
  }
  return candidates;
};

const lockedStart = async <T>(key: string, action: () => T): Promise<T> => {
  const pending = (startLocks.get(key) ?? Promise.resolve()).then(action);
  const queued = pending.then(
    () => true,
    () => false
  );
  startLocks.set(key, queued);
  try {
    return await pending;
  } finally {
    if (startLocks.get(key) === queued) startLocks.delete(key);
  }
};

const periodStart = (at = new Date()): Date | undefined => getLearningPeriodFilter(at).createdAt?.gte;
const ownedSession = (
  id: number,
  userId: string,
  courseId: string,
  lectureId: string,
  at = new Date()
): ExerciseSession => {
  const session = db.select().from(exerciseSessions).where(eq(exerciseSessions.id, id)).get();
  const start = periodStart(at);
  if (!session || (start && session.createdAt < start)) throw new TRPCError({ code: 'NOT_FOUND' });
  if (
    session.userId !== userId ||
    session.courseId !== courseId ||
    session.lectureId !== lectureId ||
    session.learningMode !== 'challenge' ||
    session.problemFormat !== 'fillInBlank'
  )
    throw new TRPCError({ code: 'UNAUTHORIZED' });
  return session;
};

const startOrResume = (
  userId: string,
  courseId: string,
  lectureId: string
): ExerciseDisplay | { status: 'noProblems' } => {
  const start = periodStart();
  const rows = db
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
    .all();
  const incomplete = rows.find((row) => row.completedAt === null);
  if (incomplete) return toDisplay(incomplete);
  if (rows[0]) return toDisplay(rows[0]);
  return createFromCandidates(userId, courseId, lectureId);
};

const createFromCandidates = (
  userId: string,
  courseId: string,
  lectureId: string,
  previousId?: string
): ExerciseDisplay | { status: 'noProblems' } => {
  const configured = candidatesFor(courseId, lectureId);
  if (configured.length === 0) return { status: 'noProblems' };
  const candidates = configured.length > 1 ? configured.filter((id) => id !== previousId) : configured;
  const problemId = candidates[Math.floor(Math.random() * candidates.length)];
  const row = db
    .insert(exerciseSessions)
    .values({
      userId,
      courseId,
      lectureId,
      learningMode: 'challenge',
      problemFormat: 'fillInBlank',
      problemId,
      seed: randomUUID(),
    })
    .returning()
    .get();
  return toDisplay(row);
};

const instantiate = (row: ExerciseSession): NonNullable<ReturnType<typeof instantiateProblem>> => {
  const problem = instantiateProblem(row.problemId, 'java', row.seed);
  if (!problem || problem.blankAnswers.length === 0)
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: `Invalid challenge problem: ${row.problemId}` });
  return problem;
};

const toDisplay = (row: ExerciseSession): ExerciseDisplay => {
  const problem = instantiate(row);
  return {
    sessionId: row.id,
    problemId: row.problemId,
    displayProgram: problem.displayProgram,
    blankCount: problem.blankAnswers.length,
    expectedBoard: problem.finalBoard,
    expectedTurtles: problem.finalTurtles,
    finalVars: problem.finalVars,
    completed: Boolean(row.completedAt),
  };
};

const gradeAndSave = async (
  id: number,
  userId: string,
  courseId: string,
  lectureId: string,
  answers: string[],
  receivedAt: Date
): Promise<SubmissionResult> => {
  const session = ownedSession(id, userId, courseId, lectureId, receivedAt);
  if (session.completedAt) return { status: 'correct', detail: '' };
  const result = await gradeFillInBlankAnswers(instantiate(session), answers);
  if (result.status === 'ungradable') logger.warn('Failed to grade exercise %d: %s', id, result.detail);
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
    if (result.status === 'correct')
      tx.update(exerciseSessions).set({ completedAt: receivedAt }).where(eq(exerciseSessions.id, id)).run();
  });
  return { status: result.status, detail: result.status === 'incorrect' ? result.detail : '' };
};
