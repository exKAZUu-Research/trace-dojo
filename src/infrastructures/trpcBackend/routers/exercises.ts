import { randomUUID } from 'node:crypto';

import { TRPCError } from '@trpc/server';
import { and, asc, desc, eq, gt, gte, isNotNull, type SQL } from 'drizzle-orm';
import { z } from 'zod';

import { getLearningPeriodFilter } from '@/learningPeriod';
import { challengeMetadata } from '@/problems/challenge/metadata';
import { instantiateRegularChallenge } from '@/problems/challenge/regular';
import type { ExerciseDisplay } from '@/problems/fillInBlank/exerciseProblem';
import { type FillInBlankVerdict, gradeFillInBlankCode, GRADING_STAGE } from '@/problems/fillInBlank/grade';
import { MAX_JAVA_PROGRAM_LENGTH } from '@/problems/fillInBlank/javaProgram';
import { type InstantiatedProblem, instantiateProblem, isFillInBlankProblem } from '@/problems/instantiateProblem';
import { javaChallengeDefinitions } from '@/problems/javaChallenges/definitions';
import { type InstantiatedJavaChallenge, instantiateJavaChallenge } from '@/problems/javaChallenges/instantiate';
import type { JavaChallengeFormat } from '@/problems/javaChallenges/types';
import { getPracticeProblemIds } from '@/problems/practice/definitions';
import { instantiatePracticeProblem } from '@/problems/practice/instantiatePracticeProblem';
import {
  type CourseId,
  courseIdToLectureIds,
  courseIdToLectureIndexToExerciseProblemIds,
  courseIdToLectureIndexToProblemIds,
  getProblemProgram,
} from '@/problems/problemData';
import type { RegularExerciseDisplay, RegularExerciseState } from '@/problems/regular/exerciseProblem';

import { type ExerciseSession, exerciseSessions, exerciseSubmissions } from '../../../../db/schema';
import { db } from '../../database';
import { authorize } from '../middlewares';
import { procedure } from '../trpc';

type ProblemFormat = JavaChallengeFormat | 'regular';
type LearningMode = 'challenge' | 'practice';
const learningModeSchema = z.enum(['challenge', 'practice']).default('challenge');
const challengeModeSchema = z.literal('challenge').default('challenge');
const locationSchema = z.object({ courseId: z.string(), lectureId: z.string() });
const startSchema = z.union([
  locationSchema.extend({ problemFormat: z.literal('regular'), learningMode: learningModeSchema }).strict(),
  locationSchema.extend({
    problemFormat: z.enum(['fillInBlank', 'bugFix']).optional(),
    learningMode: challengeModeSchema,
  }),
]);
const nextSchema = z.union([
  locationSchema
    .extend({
      sessionId: z.number().int().positive(),
      problemFormat: z.literal('regular'),
      learningMode: learningModeSchema,
    })
    .strict(),
  locationSchema.extend({
    sessionId: z.number().int().positive(),
    problemFormat: z.enum(['fillInBlank', 'bugFix']).optional(),
    learningMode: challengeModeSchema,
  }),
]);
const submissionSchema = locationSchema.extend({
  problemFormat: z.enum(['fillInBlank', 'bugFix']).optional(),
  learningMode: challengeModeSchema,
  sessionId: z.number().int().positive(),
  code: z.string().min(1).max(MAX_JAVA_PROGRAM_LENGTH),
});
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
const endSchema = z.union([
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
      problemFormat: z.enum(['fillInBlank', 'bugFix']),
      learningMode: challengeModeSchema,
    })
    .strict(),
]);
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
  endExercise: procedure
    .use(authorize)
    .input(endSchema)
    .mutation(async ({ ctx, input }) => {
      checkedLecture(input.courseId, input.lectureId);
      const userId = ctx.session.superTokensUserId;
      const { learningMode, problemFormat } = input;
      ownedSession(input.sessionId, userId, input.courseId, input.lectureId, problemFormat, learningMode);
      return await lockedStart(`${userId}:${input.courseId}:${input.lectureId}:${learningMode}:${problemFormat}`, () =>
        enqueue(input.sessionId, () => {
          const session = ownedSession(
            input.sessionId,
            userId,
            input.courseId,
            input.lectureId,
            problemFormat,
            learningMode
          );
          if (session.completedAt === null) throw new TRPCError({ code: 'CONFLICT' });
          if (session.endedAt === null)
            db.update(exerciseSessions).set({ endedAt: new Date() }).where(eq(exerciseSessions.id, session.id)).run();
          return { status: 'ended' as const };
        })
      );
    }),
  nextExercise: procedure
    .use(authorize)
    .input(nextSchema)
    .mutation(async ({ ctx, input }) => {
      checkedLecture(input.courseId, input.lectureId);
      const format = input.problemFormat ?? 'fillInBlank';
      const userId = ctx.session.superTokensUserId;
      const mode = input.learningMode;
      return await lockedStart(`${userId}:${input.courseId}:${input.lectureId}:${mode}:${format}`, () => {
        const start = periodStart();
        const previous = ownedSession(input.sessionId, userId, input.courseId, input.lectureId, format, mode);
        assertNotEnded(previous);
        if (!previous.completedAt) throw new TRPCError({ code: 'CONFLICT' });
        const newer = db
          .select()
          .from(exerciseSessions)
          .where(
            and(
              ...scopeConditions({ userId, courseId: input.courseId, lectureId: input.lectureId, mode, format }, start),
              gt(exerciseSessions.id, previous.id)
            )
          )
          .orderBy(asc(exerciseSessions.id))
          .all()
          .find(resumableProblem(input.courseId, input.lectureId, format, mode));
        return newer
          ? toDisplay(newer, format)
          : createFromCandidates(userId, input.courseId, input.lectureId, format, mode, previous.problemId);
      });
    }),
  submitExercise: procedure
    .use(authorize)
    .input(submissionSchema)
    .mutation(async ({ ctx, input }) => {
      const receivedAt = new Date();
      checkedLecture(input.courseId, input.lectureId);
      const userId = ctx.session.superTokensUserId;
      const format = input.problemFormat ?? 'fillInBlank';
      assertNotEnded(
        ownedSession(input.sessionId, userId, input.courseId, input.lectureId, format, 'challenge', receivedAt),
        receivedAt
      );
      const key = `${input.sessionId}:${input.code}`;
      const existing = gradingLocks.get(key);
      if (existing) return await existing;
      const grading = enqueue(input.sessionId, () =>
        gradeAndSave(input.sessionId, userId, input.courseId, input.lectureId, input.code, receivedAt, format)
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
      assertNotEnded(
        ownedSession(input.sessionId, userId, input.courseId, input.lectureId, 'regular', input.learningMode)
      );
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
          assertNotEnded(session);
          if (session.completedAt) throw new TRPCError({ code: 'CONFLICT' });
          if (session.problemType === 'step' && session.traceItemIndex === 1) return toRegularState(session);
          if (session.problemType !== 'executionResult' || session.traceItemIndex !== 0)
            throw new TRPCError({ code: 'CONFLICT' });
          const updated = tx
            .update(exerciseSessions)
            .set({ problemType: 'step', traceItemIndex: 1 })
            .where(eq(exerciseSessions.id, session.id))
            .returning()
            .get();
          if (!updated) throw new TRPCError({ code: 'CONFLICT' });
          return toRegularState(updated);
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
// code-gauge-allow functionParameterCount 7 -- Each parameter is part of the session identity checked on every call.
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
  // CONFLICT makes an open page reload, and Start then replaces the session with a current problem.
  if (mode === 'practice' && !getPracticeProblemIds(courseId, lectureId).includes(session.problemId))
    throw new TRPCError({ code: 'CONFLICT', message: 'Session problem is outside its practice bank' });
  if (format === 'regular') {
    validateRegularState(session);
    // Fails closed when the stored problem does not belong to the session's mode, e.g. a practice ID in a challenge.
    instantiateRegular(session.problemId, session.seed, mode);
  }
  return session;
};
// code-gauge-allow functionCognitiveComplexity 24 -- The practice bank adds one branch to the existing validation of the configured challenge lists.
const candidatesFor = (courseId: string, lectureId: string, format: ProblemFormat, mode: LearningMode): string[] => {
  if (mode === 'practice') return getPracticeProblemIds(courseId, lectureId);
  const lectureIndex = courseIdToLectureIds[courseId as CourseId].indexOf(lectureId);
  // Curriculum regular challenges come from the independent bank, not the ordinary lecture problem lists.
  if (format === 'regular' && (courseId === 'tuBeginner1' || courseId === 'tuBeginner2')) {
    return Object.entries(challengeMetadata)
      .filter(
        ([, item]) => item.courseId === courseId && item.lectureIndex === lectureIndex && item.problemFormat === format
      )
      .map(([id]) => id);
  }
  const configured =
    format === 'regular'
      ? courseIdToLectureIndexToProblemIds[courseId as CourseId]?.[lectureIndex]
      : courseIdToLectureIndexToExerciseProblemIds[courseId as CourseId]?.[lectureIndex];
  if (!configured) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Missing challenge configuration' });
  return configured.filter((id) => {
    const fixed = javaChallengeDefinitions[id];
    if (fixed) {
      if (format === 'regular') {
        if (fixed.courseId !== courseId || fixed.lectureIndex !== lectureIndex)
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: `Wrong Java problem location: ${id}` });
        return false;
      }
      return fixed.problemFormat === format;
    }
    if (!getProblemProgram(id))
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: `Unknown challenge problem: ${id}` });
    const blank = isFillInBlankProblem(id);
    if (format !== 'regular' && !blank)
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: `Challenge problem without blanks: ${id}` });
    return format === 'regular' ? !blank : format === 'fillInBlank';
  });
};
const resumableProblem = (
  courseId: string,
  lectureId: string,
  format: ProblemFormat,
  mode: LearningMode
): ((row: ExerciseSession) => boolean) => {
  // Checking-course challenges resume any stored problem; every other bank resumes only its current problems.
  if (courseId === 'test' && mode === 'challenge') return () => true;
  const candidates = new Set(candidatesFor(courseId, lectureId, format, mode));
  return (row) => candidates.has(row.problemId);
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
    .where(and(...scopeConditions({ userId, courseId, lectureId, mode, format }, start)))
    .orderBy(desc(exerciseSessions.id))
    .all();
  const endedIndex = rows.findIndex((row) => row.endedAt !== null);
  const resumable = endedIndex === -1 ? rows : rows.slice(0, endedIndex);
  const eligible = resumable.filter(resumableProblem(courseId, lectureId, format, mode));
  const selected = eligible.find((row) => row.completedAt === null) ?? eligible[0];
  return selected
    ? toDisplay(selected, format)
    : createFromCandidates(userId, courseId, lectureId, format, mode, rows[0]?.problemId);
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
  const problem =
    format === 'regular' ? instantiateRegular(problemId, seed, mode) : instantiateChallenge(problemId, seed, format);
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
      problemType: format === 'regular' ? 'executionResult' : format,
      traceItemIndex: 0,
    })
    .returning()
    .get();
  return toDisplay(row, format, problem);
};
const instantiateRegular = (problemId: string, seed: string, mode: LearningMode): InstantiatedProblem => {
  const problem =
    mode === 'practice'
      ? instantiatePracticeProblem(problemId, seed)
      : (instantiateRegularChallenge(problemId) ?? instantiateProblem(problemId, seed));
  if (!problem || problem.blankAnswers.length > 0 || problem.traceItems.length <= 1)
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: `Invalid regular problem: ${problemId}` });
  return problem;
};
const instantiateChallenge = (
  problemId: string,
  seed: string,
  format: JavaChallengeFormat
): InstantiatedJavaChallenge => {
  try {
    if (javaChallengeDefinitions[problemId]) return instantiateJavaChallenge(problemId, format);
    const problem = instantiateProblem(problemId, seed);
    if (format !== 'fillInBlank' || !problem || problem.blankAnswers.length === 0)
      throw new Error(`Invalid challenge problem: ${problemId}`);
    return problem;
  } catch (error) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: `Invalid challenge problem: ${problemId}`,
      cause: error,
    });
  }
};
const toRegularState = (row: ExerciseSession): RegularExerciseState => ({
  problemFormat: 'regular',
  sessionId: row.id,
  problemId: row.problemId,
  seed: row.seed,
  problemType: row.problemType as RegularExerciseState['problemType'],
  traceItemIndex: row.traceItemIndex,
  completed: Boolean(row.completedAt),
});
const toRegularDisplay = (row: ExerciseSession, problem?: InstantiatedProblem): RegularExerciseDisplay => ({
  ...toRegularState(row),
  problem: problem ?? instantiateRegular(row.problemId, row.seed, row.learningMode as LearningMode),
});
const toDisplay = (
  row: ExerciseSession,
  format: ProblemFormat,
  problem?: InstantiatedJavaChallenge | InstantiatedProblem
): ExerciseDisplay | RegularExerciseDisplay => {
  if (format === 'regular') {
    validateRegularState(row);
    return toRegularDisplay(row, problem && 'traceItems' in problem ? problem : undefined);
  }
  const { displayProgram, finalBoard, finalTurtles } = problem ?? instantiateChallenge(row.problemId, row.seed, format);
  return {
    problemFormat: format,
    sessionId: row.id,
    problemId: row.problemId,
    displayProgram,
    finalBoard,
    finalTurtles,
    completed: Boolean(row.completedAt),
  };
};
// code-gauge-allow functionCognitiveComplexity 18 -- The function predates this change, which only renames the value it returns.
const saveRegularVerdict = (userId: string, input: z.infer<typeof regularSubmissionSchema>): RegularExerciseState =>
  db.transaction((tx) => {
    const current = ownedSession(
      input.sessionId,
      userId,
      input.courseId,
      input.lectureId,
      'regular',
      input.learningMode
    );
    assertNotEnded(current);
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
      return toRegularState(current);
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
    if (!input.isCorrect) return toRegularState(current);
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
    return toRegularState(updated);
  });
// code-gauge-allow functionParameterCount 7 -- The function predates this change, which only makes it synchronous.
const gradeAndSave = (
  id: number,
  userId: string,
  courseId: string,
  lectureId: string,
  code: string,
  receivedAt: Date,
  format: JavaChallengeFormat
): FillInBlankVerdict => {
  const session = ownedSession(id, userId, courseId, lectureId, format, 'challenge', receivedAt);
  assertNotEnded(session, receivedAt);
  const result = gradeFillInBlankCode(instantiateChallenge(session.problemId, session.seed, format), code);
  db.transaction((tx) => {
    const current = tx.select().from(exerciseSessions).where(eq(exerciseSessions.id, id)).get();
    if (!current) throw new TRPCError({ code: 'NOT_FOUND' });
    assertNotEnded(current, receivedAt);
    if (current.completedAt) return;
    tx.insert(exerciseSubmissions)
      .values({
        createdAt: receivedAt,
        sessionId: id,
        code,
        status: result.status,
        gradingStage: GRADING_STAGE,
      })
      .run();
    if (result.status === 'correct')
      tx.update(exerciseSessions).set({ completedAt: receivedAt }).where(eq(exerciseSessions.id, id)).run();
  });
  return result;
};

const assertNotEnded = (session: ExerciseSession, at = new Date()): void => {
  const start = periodStart(at);
  const ended = db
    .select({ id: exerciseSessions.id })
    .from(exerciseSessions)
    .where(
      and(
        ...scopeConditions(
          {
            userId: session.userId,
            courseId: session.courseId,
            lectureId: session.lectureId,
            mode: session.learningMode,
            format: session.problemFormat,
          },
          start
        ),
        gte(exerciseSessions.id, session.id),
        isNotNull(exerciseSessions.endedAt)
      )
    )
    .get();
  if (ended) throw new TRPCError({ code: 'CONFLICT' });
};
interface SessionScope {
  userId: string;
  courseId: string;
  lectureId: string;
  mode: string;
  format: string;
}
const scopeConditions = (scope: SessionScope, start: Date | undefined): (SQL | undefined)[] => [
  eq(exerciseSessions.userId, scope.userId),
  eq(exerciseSessions.courseId, scope.courseId),
  eq(exerciseSessions.lectureId, scope.lectureId),
  eq(exerciseSessions.learningMode, scope.mode),
  eq(exerciseSessions.problemFormat, scope.format),
  start ? gte(exerciseSessions.createdAt, start) : undefined,
];
