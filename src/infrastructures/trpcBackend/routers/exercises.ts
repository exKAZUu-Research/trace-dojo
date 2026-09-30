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
import type { ExerciseDisplay } from '@/problems/fillInBlank/exerciseProblem';
import { gradeFillInBlankAnswers } from '@/problems/fillInBlank/grade';
import { instantiateProblem, isFillInBlankProblem, type InstantiatedProblem } from '@/problems/instantiateProblem';
import {
  courseIdToLectureIds,
  courseIdToLectureIndexToExerciseProblemIds,
  courseIdToLectureIndexToProblemIds,
  problemIdToLanguageIdToProgram,
  type CourseId,
  type ProblemId,
} from '@/problems/problemData';

type ProblemFormat = 'fillInBlank' | 'regular';
type RegularProblemType = 'executionResult' | 'step';
export interface RegularExerciseDisplay {
  problemFormat: 'regular';
  sessionId: number;
  problemId: string;
  seed: string;
  problemType: RegularProblemType;
  traceItemIndex: number;
  completed: boolean;
}
export interface SubmissionResult {
  status: 'correct' | 'incorrect' | 'ungradable';
  detail: string;
}
const locationSchema = z.object({ courseId: z.string(), lectureId: z.string() });
const startSchema = z.union([
  locationSchema.extend({ problemFormat: z.literal('regular') }).strict(),
  locationSchema.extend({ problemFormat: z.literal('fillInBlank').optional() }),
]);
const nextSchema = z.union([
  locationSchema.extend({ sessionId: z.number().int().positive(), problemFormat: z.literal('regular') }).strict(),
  locationSchema.extend({
    sessionId: z.number().int().positive(),
    problemFormat: z.literal('fillInBlank').optional(),
  }),
]);
const submissionSchema = locationSchema.extend({
  sessionId: z.number().int().positive(),
  answers: z.array(z.string().max(1000)).max(50),
});
const regularSubmissionSchema = locationSchema
  .extend({
    sessionId: z.number().int().positive(),
    requestId: z.string().min(1).max(200),
    context: z
      .object({ problemType: z.enum(['executionResult', 'step']), traceItemIndex: z.number().int().nonnegative() })
      .strict(),
    isCorrect: z.boolean(),
  })
  .strict();
const switchSchema = locationSchema.extend({ sessionId: z.number().int().positive() }).strict();
const startLocks = new Map<string, Promise<unknown>>();
const sessionQueues = new Map<number, Promise<unknown>>();
const gradingLocks = new Map<string, Promise<SubmissionResult>>();

export const exerciseProcedures = {
  startExercise: procedure
    .use(authorize)
    .input(startSchema)
    .mutation(async ({ ctx, input }) => {
      checkedLecture(input.courseId, input.lectureId);
      const format = input.problemFormat ?? 'fillInBlank';
      const userId = ctx.session.superTokensUserId;
      return await lockedStart(`${userId}:${input.courseId}:${input.lectureId}:${format}`, () =>
        startOrResume(userId, input.courseId, input.lectureId, format)
      );
    }),
  nextExercise: procedure
    .use(authorize)
    .input(nextSchema)
    .mutation(async ({ ctx, input }) => {
      checkedLecture(input.courseId, input.lectureId);
      const format = input.problemFormat ?? 'fillInBlank';
      const userId = ctx.session.superTokensUserId;
      return await lockedStart(`${userId}:${input.courseId}:${input.lectureId}:${format}`, () => {
        const previous = ownedSession(input.sessionId, userId, input.courseId, input.lectureId, format);
        if (!previous.completedAt) throw new TRPCError({ code: 'CONFLICT' });
        const newer = db
          .select()
          .from(exerciseSessions)
          .where(
            and(
              eq(exerciseSessions.userId, userId),
              eq(exerciseSessions.courseId, input.courseId),
              eq(exerciseSessions.lectureId, input.lectureId),
              eq(exerciseSessions.learningMode, 'challenge'),
              eq(exerciseSessions.problemFormat, format),
              gt(exerciseSessions.id, previous.id)
            )
          )
          .orderBy(asc(exerciseSessions.id))
          .get();
        return newer
          ? toDisplay(newer, format)
          : createFromCandidates(userId, input.courseId, input.lectureId, format, previous.problemId);
      });
    }),
  submitExercise: procedure
    .use(authorize)
    .input(submissionSchema)
    .mutation(async ({ ctx, input }) => {
      const receivedAt = new Date();
      checkedLecture(input.courseId, input.lectureId);
      const userId = ctx.session.superTokensUserId;
      ownedSession(input.sessionId, userId, input.courseId, input.lectureId, 'fillInBlank', receivedAt);
      const key = `${input.sessionId}:${JSON.stringify(input.answers)}`;
      const existing = gradingLocks.get(key);
      if (existing) return await existing;
      const grading = enqueue(input.sessionId, () =>
        gradeAndSave(input.sessionId, userId, input.courseId, input.lectureId, input.answers, receivedAt)
      );
      gradingLocks.set(key, grading);
      try {
        return await grading;
      } finally {
        gradingLocks.delete(key);
      }
    }),
  submitRegularExercise: procedure
    .use(authorize)
    .input(regularSubmissionSchema)
    .mutation(async ({ ctx, input }) => {
      checkedLecture(input.courseId, input.lectureId);
      const userId = ctx.session.superTokensUserId;
      ownedSession(input.sessionId, userId, input.courseId, input.lectureId, 'regular');
      return await enqueue(input.sessionId, () => saveRegularVerdict(userId, input));
    }),
  switchRegularExerciseToStep: procedure
    .use(authorize)
    .input(switchSchema)
    .mutation(async ({ ctx, input }) => {
      checkedLecture(input.courseId, input.lectureId);
      const userId = ctx.session.superTokensUserId;
      return await enqueue(input.sessionId, () =>
        db.transaction((tx) => {
          const session = ownedSession(input.sessionId, userId, input.courseId, input.lectureId, 'regular');
          if (session.completedAt) throw new TRPCError({ code: 'CONFLICT' });
          if (session.problemType === 'step' && session.traceItemIndex === 1) return toRegularDisplay(session);
          if (session.problemType !== 'executionResult' || session.traceItemIndex !== 0)
            throw new TRPCError({ code: 'CONFLICT' });
          const updated = tx
            .update(exerciseSessions)
            .set({ problemType: 'step', traceItemIndex: 1 })
            .where(eq(exerciseSessions.id, session.id))
            .returning()
            .get();
          if (!updated) throw new TRPCError({ code: 'CONFLICT' });
          return toRegularDisplay(updated);
        })
      );
    }),
};

const enqueue = async <T>(id: number, action: () => T | Promise<T>): Promise<T> => {
  const pending = (sessionQueues.get(id) ?? Promise.resolve()).then(action);
  const queued = pending.then(
    () => false,
    () => false
  );
  sessionQueues.set(id, queued);
  try {
    return await pending;
  } finally {
    if (sessionQueues.get(id) === queued) sessionQueues.delete(id);
  }
};
const lockedStart = async <T>(key: string, action: () => T | Promise<T>): Promise<T> => {
  const pending = (startLocks.get(key) ?? Promise.resolve()).then(action);
  const queued = pending.then(
    () => false,
    () => false
  );
  startLocks.set(key, queued);
  try {
    return await pending;
  } finally {
    if (startLocks.get(key) === queued) startLocks.delete(key);
  }
};
const checkedLecture = (courseId: string, lectureId: string): void => {
  if (!(courseId in courseIdToLectureIds) || !courseIdToLectureIds[courseId as CourseId]?.includes(lectureId))
    throw new TRPCError({ code: 'NOT_FOUND' });
};
const periodStart = (at = new Date()): Date | undefined => getLearningPeriodFilter(at).createdAt?.gte;
const validateRegularState = (session: ExerciseSession): void => {
  if (
    !(
      (session.problemType === 'executionResult' && session.traceItemIndex === 0) ||
      (session.problemType === 'step' && session.traceItemIndex >= 1)
    )
  )
    throw new TRPCError({ code: 'CONFLICT' });
};
const ownedSession = (
  id: number,
  userId: string,
  courseId: string,
  lectureId: string,
  format: ProblemFormat,
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
    session.problemFormat !== format
  )
    throw new TRPCError({ code: 'UNAUTHORIZED' });
  if (format === 'regular') validateRegularState(session);
  return session;
};
const candidatesFor = (courseId: string, lectureId: string, format: ProblemFormat): string[] => {
  const lectureIndex = courseIdToLectureIds[courseId as CourseId].indexOf(lectureId);
  const configured =
    format === 'fillInBlank'
      ? courseIdToLectureIndexToExerciseProblemIds[courseId]?.[lectureIndex]
      : courseIdToLectureIndexToProblemIds[courseId as CourseId]?.[lectureIndex];
  if (!configured) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Missing challenge configuration' });
  for (const id of configured)
    if (!problemIdToLanguageIdToProgram[id as ProblemId])
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: `Unknown challenge problem: ${id}` });
  return format === 'regular' ? configured.filter((id) => !isFillInBlankProblem(id)) : configured;
};
type DisplayResult = ExerciseDisplay | RegularExerciseDisplay | { status: 'noProblems' };
const startOrResume = (userId: string, courseId: string, lectureId: string, format: ProblemFormat): DisplayResult => {
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
        eq(exerciseSessions.problemFormat, format),
        start ? gte(exerciseSessions.createdAt, start) : undefined
      )
    )
    .orderBy(desc(exerciseSessions.id))
    .all();
  const selected = rows.find((row) => row.completedAt === null) ?? rows[0];
  return selected ? toDisplay(selected, format) : createFromCandidates(userId, courseId, lectureId, format);
};
const createFromCandidates = (
  userId: string,
  courseId: string,
  lectureId: string,
  format: ProblemFormat,
  previousId?: string
): DisplayResult => {
  const configured = candidatesFor(courseId, lectureId, format);
  if (configured.length === 0) return { status: 'noProblems' as const };
  const candidates = configured.length > 1 ? configured.filter((id) => id !== previousId) : configured;
  const problemId = candidates[Math.floor(Math.random() * candidates.length)];
  const seed = randomUUID();
  if (format === 'regular' && instantiateRegular(problemId, seed).traceItems.length <= 1)
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR' });
  const row = db
    .insert(exerciseSessions)
    .values({
      userId,
      courseId,
      lectureId,
      learningMode: 'challenge',
      problemFormat: format,
      problemId,
      seed,
      problemType: 'executionResult',
      traceItemIndex: 0,
    })
    .returning()
    .get();
  return toDisplay(row, format);
};
const instantiateRegular = (problemId: string, seed: string): InstantiatedProblem => {
  const problem = instantiateProblem(problemId, 'java', seed);
  if (!problem || problem.blankAnswers.length > 0)
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: `Invalid regular problem: ${problemId}` });
  return problem;
};
const instantiateBlank = (row: ExerciseSession): InstantiatedProblem => {
  const problem = instantiateProblem(row.problemId, 'java', row.seed);
  if (!problem || problem.blankAnswers.length === 0)
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: `Invalid challenge problem: ${row.problemId}` });
  return problem;
};
const toRegularDisplay = (row: ExerciseSession): RegularExerciseDisplay => ({
  problemFormat: 'regular',
  sessionId: row.id,
  problemId: row.problemId,
  seed: row.seed,
  problemType: row.problemType as RegularProblemType,
  traceItemIndex: row.traceItemIndex,
  completed: Boolean(row.completedAt),
});
const toDisplay = (row: ExerciseSession, format: ProblemFormat): ExerciseDisplay | RegularExerciseDisplay => {
  if (format === 'regular') {
    validateRegularState(row);
    return toRegularDisplay(row);
  }
  const problem = instantiateBlank(row);
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
const saveRegularVerdict = (userId: string, input: z.infer<typeof regularSubmissionSchema>): RegularExerciseDisplay =>
  db.transaction((tx) => {
    const current = ownedSession(input.sessionId, userId, input.courseId, input.lectureId, 'regular');
    const previous = tx
      .select()
      .from(exerciseSubmissions)
      .where(
        and(eq(exerciseSubmissions.sessionId, input.sessionId), eq(exerciseSubmissions.requestId, input.requestId))
      )
      .get();
    if (previous) {
      const event = z
        .object({ kind: z.literal('regularVerdict'), isCorrect: z.boolean() })
        .strict()
        .parse(JSON.parse(previous.answers));
      if (
        previous.problemType !== input.context.problemType ||
        previous.traceItemIndex !== input.context.traceItemIndex ||
        event.isCorrect !== input.isCorrect
      )
        throw new TRPCError({ code: 'CONFLICT' });
      return toRegularDisplay(current);
    }
    if (
      current.completedAt ||
      current.problemType !== input.context.problemType ||
      current.traceItemIndex !== input.context.traceItemIndex
    )
      throw new TRPCError({ code: 'CONFLICT' });
    tx.insert(exerciseSubmissions)
      .values({
        sessionId: current.id,
        answers: JSON.stringify({ kind: 'regularVerdict', isCorrect: input.isCorrect }),
        status: input.isCorrect ? 'correct' : 'incorrect',
        gradingStage: undefined,
        problemType: current.problemType,
        traceItemIndex: current.traceItemIndex,
        requestId: input.requestId,
      })
      .run();
    if (!input.isCorrect) return toRegularDisplay(current);
    // The trace comes from the current definition, as the client's does, so an edited definition moves the final step.
    const completed =
      current.problemType === 'executionResult' ||
      current.traceItemIndex >= instantiateRegular(current.problemId, current.seed).traceItems.length - 1;
    const updated = tx
      .update(exerciseSessions)
      .set(completed ? { completedAt: new Date() } : { traceItemIndex: current.traceItemIndex + 1 })
      .where(eq(exerciseSessions.id, current.id))
      .returning()
      .get();
    if (!updated) throw new TRPCError({ code: 'CONFLICT' });
    return toRegularDisplay(updated);
  });
const gradeAndSave = async (
  id: number,
  userId: string,
  courseId: string,
  lectureId: string,
  answers: string[],
  receivedAt: Date
): Promise<SubmissionResult> => {
  const session = ownedSession(id, userId, courseId, lectureId, 'fillInBlank', receivedAt);
  if (session.completedAt) return { status: 'correct', detail: '' };
  const result = await gradeFillInBlankAnswers(instantiateBlank(session), answers);
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
