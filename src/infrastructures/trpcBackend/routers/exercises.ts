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
import type { RegularExerciseDisplay } from '@/problems/regular/exerciseProblem';
import { gradeFillInBlankAnswers, type FillInBlankVerdict } from '@/problems/fillInBlank/grade';
import { instantiateProblem, isFillInBlankProblem, type InstantiatedProblem } from '@/problems/instantiateProblem';
import {
  courseIdToLectureIds,
  courseIdToLectureIndexToExerciseProblemIds,
  courseIdToLectureIndexToProblemIds,
  problemIdToLanguageIdToProgram,
  type CourseId,
} from '@/problems/problemData';

import { getPracticeProblemIds } from '@/problems/practice/definitions';
import { instantiatePracticeProblem } from '@/problems/practice/instantiatePracticeProblem';

type LearningMode = 'challenge' | 'practice';
const learningModeSchema = z.enum(['challenge', 'practice']).default('challenge');
type ProblemFormat = 'fillInBlank' | 'regular';
const locationSchema = z.object({ courseId: z.string(), lectureId: z.string() });
const startSchema = z.union([
  locationSchema.extend({ problemFormat: z.literal('regular'), learningMode: learningModeSchema }).strict(),
  locationSchema
    .extend({
      problemFormat: z.literal('fillInBlank').optional(),
      learningMode: z.literal('challenge').default('challenge'),
    })
    .strict(),
]);
const nextSchema = z.union([
  locationSchema
    .extend({
      sessionId: z.number().int().positive(),
      problemFormat: z.literal('regular'),
      learningMode: learningModeSchema,
    })
    .strict(),
  locationSchema
    .extend({
      sessionId: z.number().int().positive(),
      problemFormat: z.literal('fillInBlank').optional(),
      learningMode: z.literal('challenge').default('challenge'),
    })
    .strict(),
]);
const submissionSchema = locationSchema
  .extend({
    sessionId: z.number().int().positive(),
    answers: z.array(z.string().max(1000)).max(50),
    learningMode: z.literal('challenge').default('challenge'),
  })
  .strict();
const regularSubmissionSchema = locationSchema
  .extend({
    sessionId: z.number().int().positive(),
    learningMode: learningModeSchema,
    requestId: z.string().min(1).max(200),
    context: z
      .object({ problemType: z.enum(['executionResult', 'step']), traceItemIndex: z.number().int().nonnegative() })
      .strict(),
    isCorrect: z.boolean(),
  })
  .strict();
const switchSchema = locationSchema
  .extend({ sessionId: z.number().int().positive(), learningMode: learningModeSchema })
  .strict();
const queues = new Map<string, Promise<unknown>>();
const gradingLocks = new Map<string, Promise<FillInBlankVerdict>>();

export const exerciseProcedures = {
  startExercise: procedure
    .use(authorize)
    .input(startSchema)
    .mutation(async ({ ctx, input }) => {
      checkedLecture(input.courseId, input.lectureId);
      const format = input.problemFormat ?? 'fillInBlank';
      const userId = ctx.session.superTokensUserId;
      return await lockedStart(`${userId}:${input.courseId}:${input.lectureId}:${input.learningMode}:${format}`, () =>
        startOrResume(userId, input.courseId, input.lectureId, format, input.learningMode)
      );
    }),
  nextExercise: procedure
    .use(authorize)
    .input(nextSchema)
    .mutation(async ({ ctx, input }) => {
      checkedLecture(input.courseId, input.lectureId);
      const format = input.problemFormat ?? 'fillInBlank';
      const userId = ctx.session.superTokensUserId;
      return await lockedStart(`${userId}:${input.courseId}:${input.lectureId}:${input.learningMode}:${format}`, () => {
        const start = periodStart();
        const previous = ownedSession(
          input.sessionId,
          userId,
          input.courseId,
          input.lectureId,
          format,
          input.learningMode
        );
        if (!previous.completedAt) throw new TRPCError({ code: 'CONFLICT' });
        const newer = db
          .select()
          .from(exerciseSessions)
          .where(
            and(
              eq(exerciseSessions.userId, userId),
              eq(exerciseSessions.courseId, input.courseId),
              eq(exerciseSessions.lectureId, input.lectureId),
              eq(exerciseSessions.learningMode, input.learningMode),
              eq(exerciseSessions.problemFormat, format),
              gt(exerciseSessions.id, previous.id),
              start ? gte(exerciseSessions.createdAt, start) : undefined
            )
          )
          .orderBy(asc(exerciseSessions.id))
          .get();
        return newer
          ? toDisplay(newer, format)
          : createFromCandidates(
              userId,
              input.courseId,
              input.lectureId,
              format,
              input.learningMode,
              previous.problemId
            );
      });
    }),
  submitExercise: procedure
    .use(authorize)
    .input(submissionSchema)
    .mutation(async ({ ctx, input }) => {
      const receivedAt = new Date();
      checkedLecture(input.courseId, input.lectureId);
      const userId = ctx.session.superTokensUserId;
      ownedSession(input.sessionId, userId, input.courseId, input.lectureId, 'fillInBlank', 'challenge', receivedAt);
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
      ownedSession(input.sessionId, userId, input.courseId, input.lectureId, 'regular', input.learningMode);
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
          const session = ownedSession(
            input.sessionId,
            userId,
            input.courseId,
            input.lectureId,
            'regular',
            input.learningMode
          );
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

const enqueue = async <T>(sessionId: number, action: () => T | Promise<T>): Promise<T> =>
  await serialize(`session:${sessionId}`, action);
const lockedStart = async <T>(key: string, action: () => T | Promise<T>): Promise<T> =>
  await serialize(`start:${key}`, action);
const serialize = async <T>(key: string, action: () => T | Promise<T>): Promise<T> => {
  const pending = (queues.get(key) ?? Promise.resolve()).then(action);
  const queued = pending.then(
    () => false,
    () => false
  );
  queues.set(key, queued);
  try {
    return await pending;
  } finally {
    if (queues.get(key) === queued) queues.delete(key);
  }
};
const checkedLecture = (courseId: string, lectureId: string): void => {
  if (
    !Object.hasOwn(courseIdToLectureIds, courseId) ||
    !courseIdToLectureIds[courseId as CourseId]?.includes(lectureId)
  )
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
  mode: LearningMode,
  at = new Date()
): ExerciseSession => {
  const session = db.select().from(exerciseSessions).where(eq(exerciseSessions.id, id)).get();
  const start = periodStart(at);
  if (!session || (start && session.createdAt < start)) throw new TRPCError({ code: 'NOT_FOUND' });
  if (
    session.userId !== userId ||
    session.courseId !== courseId ||
    session.lectureId !== lectureId ||
    session.learningMode !== mode ||
    session.problemFormat !== format
  )
    throw new TRPCError({ code: 'UNAUTHORIZED' });
  validateMembership(session);
  if (format === 'regular') {
    validateRegularState(session);
    instantiateRegular(session.problemId, session.seed, mode);
  }
  return session;
};
const candidatesFor = (courseId: string, lectureId: string, format: ProblemFormat, mode: LearningMode): string[] => {
  if (mode === 'practice') return getPracticeProblemIds(courseId, lectureId);
  const lectureIndex = courseIdToLectureIds[courseId as CourseId].indexOf(lectureId);
  const configured =
    format === 'fillInBlank'
      ? courseIdToLectureIndexToExerciseProblemIds[courseId as CourseId]?.[lectureIndex]
      : courseIdToLectureIndexToProblemIds[courseId as CourseId]?.[lectureIndex];
  if (!configured) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Missing challenge configuration' });
  for (const id of configured) {
    if (!problemIdToLanguageIdToProgram[id])
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: `Unknown challenge problem: ${id}` });
    if (format === 'fillInBlank' && !isFillInBlankProblem(id))
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: `Challenge problem without blanks: ${id}` });
  }
  return format === 'regular' ? configured.filter((id) => !isFillInBlankProblem(id)) : configured;
};
type DisplayResult = ExerciseDisplay | RegularExerciseDisplay | { status: 'noProblems' };
const startOrResume = (
  userId: string,
  courseId: string,
  lectureId: string,
  format: ProblemFormat,
  mode: LearningMode
): DisplayResult => {
  const start = periodStart();
  const rows = db
    .select()
    .from(exerciseSessions)
    .where(
      and(
        eq(exerciseSessions.userId, userId),
        eq(exerciseSessions.courseId, courseId),
        eq(exerciseSessions.lectureId, lectureId),
        eq(exerciseSessions.learningMode, mode),
        eq(exerciseSessions.problemFormat, format),
        start ? gte(exerciseSessions.createdAt, start) : undefined
      )
    )
    .orderBy(desc(exerciseSessions.id))
    .all();
  const selected = rows.find((row) => row.completedAt === null) ?? rows[0];
  return selected ? toDisplay(selected, format) : createFromCandidates(userId, courseId, lectureId, format, mode);
};
const createFromCandidates = (
  userId: string,
  courseId: string,
  lectureId: string,
  format: ProblemFormat,
  mode: LearningMode,
  previousId?: string
): DisplayResult => {
  const configured = candidatesFor(courseId, lectureId, format, mode);
  if (configured.length === 0) return { status: 'noProblems' as const };
  const candidates = configured.length > 1 ? configured.filter((id) => id !== previousId) : configured;
  const problemId = candidates[Math.floor(Math.random() * candidates.length)];
  const seed = randomUUID();
  // Generate before inserting: a session whose problem cannot be generated would be resumed and fail forever.
  const problem = format === 'regular' ? instantiateRegular(problemId, seed, mode) : instantiateBlank(problemId, seed);
  if (format === 'regular' && problem.traceItems.length <= 1)
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: `Too few trace items: ${problemId}` });
  const row = db
    .insert(exerciseSessions)
    .values({
      userId,
      courseId,
      lectureId,
      learningMode: mode,
      problemFormat: format,
      problemId,
      seed,
      problemType: format === 'regular' ? 'executionResult' : 'fillInBlank',
      traceItemIndex: 0,
    })
    .returning()
    .get();
  return toDisplay(row, format, problem);
};
const instantiateRegular = (problemId: string, seed: string, mode: LearningMode): InstantiatedProblem => {
  const problem = (mode === 'practice' ? instantiatePracticeProblem : instantiateProblem)(problemId, 'java', seed);
  if (!problem || problem.blankAnswers.length > 0)
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: `Invalid regular problem: ${problemId}` });
  return problem;
};
const instantiateBlank = (problemId: string, seed: string): InstantiatedProblem => {
  const problem = instantiateProblem(problemId, 'java', seed);
  if (!problem || problem.blankAnswers.length === 0)
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: `Invalid challenge problem: ${problemId}` });
  return problem;
};
const validateMembership = (row: ExerciseSession): void => {
  const lectureIndex = courseIdToLectureIds[row.courseId as CourseId]?.indexOf(row.lectureId) ?? -1;
  const configured =
    row.learningMode === 'practice'
      ? getPracticeProblemIds(row.courseId, row.lectureId)
      : row.problemFormat === 'regular'
        ? courseIdToLectureIndexToProblemIds[row.courseId as CourseId]?.[lectureIndex]
        : courseIdToLectureIndexToExerciseProblemIds[row.courseId as CourseId]?.[lectureIndex];
  if (
    (row.learningMode !== 'practice' && row.learningMode !== 'challenge') ||
    (row.problemFormat !== 'regular' && row.problemFormat !== 'fillInBlank') ||
    (row.learningMode === 'practice' && row.problemFormat !== 'regular') ||
    !configured?.some((id) => id === row.problemId)
  )
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Session problem is outside its configured bank' });
};
const toRegularDisplay = (row: ExerciseSession): RegularExerciseDisplay => ({
  problemFormat: 'regular',
  sessionId: row.id,
  problemId: row.problemId,
  seed: row.seed,
  problemType: row.problemType as RegularExerciseDisplay['problemType'],
  traceItemIndex: row.traceItemIndex,
  completed: Boolean(row.completedAt),
});
const toDisplay = (
  row: ExerciseSession,
  format: ProblemFormat,
  problem?: InstantiatedProblem
): ExerciseDisplay | RegularExerciseDisplay => {
  validateMembership(row);
  if (format === 'regular') {
    validateRegularState(row);
    // The client regenerates the problem while rendering, so a resumed row whose definition no longer generates must fail here.
    if (!problem) instantiateRegular(row.problemId, row.seed, row.learningMode as LearningMode);
    return toRegularDisplay(row);
  }
  const { displayProgram, blankAnswers, finalBoard, finalTurtles, finalVars } =
    problem ?? instantiateBlank(row.problemId, row.seed);
  return {
    problemFormat: 'fillInBlank',
    sessionId: row.id,
    problemId: row.problemId,
    displayProgram,
    blankCount: blankAnswers.length,
    finalBoard,
    finalTurtles,
    finalVars,
    completed: Boolean(row.completedAt),
  };
};
const saveRegularVerdict = (userId: string, input: z.infer<typeof regularSubmissionSchema>): RegularExerciseDisplay =>
  db.transaction((tx) => {
    const current = ownedSession(
      input.sessionId,
      userId,
      input.courseId,
      input.lectureId,
      'regular',
      input.learningMode
    );
    const previous = tx
      .select()
      .from(exerciseSubmissions)
      .where(
        and(eq(exerciseSubmissions.sessionId, input.sessionId), eq(exerciseSubmissions.requestId, input.requestId))
      )
      .get();
    const status = input.isCorrect ? 'correct' : 'incorrect';
    if (previous) {
      if (
        previous.problemType !== input.context.problemType ||
        previous.traceItemIndex !== input.context.traceItemIndex ||
        previous.status !== status
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
        status,
        problemType: current.problemType,
        traceItemIndex: current.traceItemIndex,
        requestId: input.requestId,
      })
      .run();
    if (!input.isCorrect) return toRegularDisplay(current);
    // The trace comes from the current definition, as the client's does, so an edited definition moves the final step.
    const completed =
      current.problemType === 'executionResult' ||
      current.traceItemIndex >=
        instantiateRegular(current.problemId, current.seed, input.learningMode).traceItems.length - 1;
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
): Promise<FillInBlankVerdict> => {
  const session = ownedSession(id, userId, courseId, lectureId, 'fillInBlank', 'challenge', receivedAt);
  const result = await gradeFillInBlankAnswers(instantiateBlank(session.problemId, session.seed), answers);
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
  if (result.status === 'correct') return { status: 'correct' };
  if (result.status === 'ungradable') return { status: 'ungradable', detail: '' };
  return { status: 'incorrect', detail: result.detail };
};
