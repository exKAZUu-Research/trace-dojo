import { randomUUID } from 'node:crypto';

import { TRPCError } from '@trpc/server';
import { and, asc, desc, eq, gt, gte, isNotNull } from 'drizzle-orm';
import { z } from 'zod';

import { getLearningPeriodFilter } from '@/learningPeriod';
import { challengeBases } from '@/problems/catalog/java/definitions';
import type { ExerciseDisplay } from '@/problems/fillInBlank/exerciseProblem';
import { MAX_JAVA_PROGRAM_LENGTH } from '@/problems/fillInBlank/javaProgram';
import { instantiateGeneratedChallenge } from '@/problems/generation/instantiate';
import { generatedProblemSchema, snapshotOf } from '@/problems/generation/snapshot';
import type { ChallengeFormat as JavaChallengeFormat, ChallengeTarget } from '@/problems/generation/types';
import { type FillInBlankVerdict, gradeFillInBlankCode, GRADING_STAGE } from '@/problems/grading/turtleState';
import { type InstantiatedProblem, instantiateProblem } from '@/problems/instantiateProblem';
import { instantiateRegularChallenge } from '@/problems/regular/instantiateChallenge';
type InstantiatedJavaChallenge = ChallengeTarget & { displayProgram: string };
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
const locationSchema = z.object({ courseId: z.string(), lectureId: z.string() });
const startSchema = z.union([
  locationSchema.extend({ problemFormat: z.literal('regular') }).strict(),
  locationSchema.extend({ problemFormat: z.enum(['fillInBlank', 'bugFix']).optional() }),
]);
const nextSchema = z.union([
  locationSchema.extend({ sessionId: z.number().int().positive(), problemFormat: z.literal('regular') }).strict(),
  locationSchema.extend({
    sessionId: z.number().int().positive(),
    problemFormat: z.enum(['fillInBlank', 'bugFix']).optional(),
  }),
]);
const submissionSchema = locationSchema.extend({
  problemFormat: z.enum(['fillInBlank', 'bugFix']).optional(),
  sessionId: z.number().int().positive(),
  code: z.string().min(1).max(MAX_JAVA_PROGRAM_LENGTH),
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
const endSchema = locationSchema
  .extend({ sessionId: z.number().int().positive(), problemFormat: z.enum(['regular', 'fillInBlank', 'bugFix']) })
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
      return await lockedStart(`${userId}:${input.courseId}:${input.lectureId}:${format}`, () =>
        startOrResume(userId, input.courseId, input.lectureId, format)
      );
    }),
  endExercise: procedure
    .use(authorize)
    .input(endSchema)
    .mutation(async ({ ctx, input }) => {
      checkedLecture(input.courseId, input.lectureId);
      const userId = ctx.session.superTokensUserId;
      ownedSession(input.sessionId, userId, input.courseId, input.lectureId, input.problemFormat);
      return await lockedStart(`${userId}:${input.courseId}:${input.lectureId}:${input.problemFormat}`, () =>
        enqueue(input.sessionId, () => {
          const session = ownedSession(input.sessionId, userId, input.courseId, input.lectureId, input.problemFormat);
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
      return await lockedStart(`${userId}:${input.courseId}:${input.lectureId}:${format}`, () => {
        const previous = ownedSession(input.sessionId, userId, input.courseId, input.lectureId, format);
        assertNotEnded(previous);
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
          .all()
          .find((row) => format === 'regular' || row.generatedProblem !== null);
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
      const format = input.problemFormat ?? 'fillInBlank';
      assertNotEnded(
        ownedSession(input.sessionId, userId, input.courseId, input.lectureId, format, receivedAt),
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
      assertNotEnded(ownedSession(input.sessionId, userId, input.courseId, input.lectureId, 'regular'));
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
  if (format === 'regular' && (courseId === 'tuBeginner1' || courseId === 'tuBeginner2'))
    return challengeBases
      .filter((base) => base.courseId === courseId && base.lectureIndex === lectureIndex)
      .map((base) => base.id);
  const configured = (
    format === 'regular' ? courseIdToLectureIndexToProblemIds : courseIdToLectureIndexToExerciseProblemIds
  )[courseId as CourseId]?.[lectureIndex];
  if (!configured) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Missing challenge configuration' });
  for (const id of configured)
    if (!getProblemProgram(id) && !challengeBases.some((base) => base.id === id))
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: `Unknown challenge source: ${id}` });
  return configured;
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
  const endedIndex = rows.findIndex((row) => row.endedAt !== null);
  const resumable = endedIndex === -1 ? rows : rows.slice(0, endedIndex);
  const eligible = resumable.filter((row) => format === 'regular' || row.generatedProblem !== null);
  const selected = eligible.find((row) => row.completedAt === null) ?? eligible[0];
  return selected
    ? toDisplay(selected, format)
    : createFromCandidates(userId, courseId, lectureId, format, rows[0]?.problemId);
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
  const shuffled = [...candidates];
  // Draw without replacement so an unusable source cannot starve another configured source.
  while (shuffled.length > 0) {
    const index = Math.floor(Math.random() * shuffled.length);
    const problemId = shuffled.splice(index, 1)[0];
    const seed = randomUUID();
    const problem =
      format === 'regular'
        ? instantiateRegular(problemId, seed)
        : instantiateGeneratedChallenge(
            problemId,
            seed,
            format,
            courseId,
            courseIdToLectureIds[courseId as CourseId].indexOf(lectureId)
          );
    if (!problem) continue;
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
        generatedProblem: format === 'regular' ? undefined : JSON.stringify(snapshotOf(problem)),
        problemType: format === 'regular' ? 'executionResult' : format,
        traceItemIndex: 0,
      })
      .returning()
      .get();
    return toDisplay(row, format, problem);
  }
  return { status: 'noProblems' };
};
const instantiateRegular = (problemId: string, seed: string): InstantiatedProblem => {
  const problem = instantiateRegularChallenge(problemId) ?? instantiateProblem(problemId, seed);
  if (!problem || problem.blankAnswers.length > 0 || problem.traceItems.length <= 1)
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: `Invalid regular problem: ${problemId}` });
  return problem;
};
const savedChallenge = (session: ExerciseSession): InstantiatedJavaChallenge => {
  if (!session.generatedProblem)
    throw new TRPCError({ code: 'CONFLICT', message: 'This exercise has been retired. Start a new exercise.' });
  return generatedProblemSchema.parse(JSON.parse(session.generatedProblem));
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
  problem: problem ?? instantiateRegular(row.problemId, row.seed),
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
  const { displayProgram, finalBoard, finalTurtles } = problem ?? savedChallenge(row);
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
// code-gauge-allow functionCognitiveComplexity 18 -- Replay validation and trace advancement share one atomic transaction.
const saveRegularVerdict = (userId: string, input: z.infer<typeof regularSubmissionSchema>): RegularExerciseState =>
  db.transaction((tx) => {
    const current = ownedSession(input.sessionId, userId, input.courseId, input.lectureId, 'regular');
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
      current.traceItemIndex >= instantiateRegular(current.problemId, current.seed).traceItems.length - 1;
    const updated = tx
      .update(exerciseSessions)
      .set(completed ? { completedAt: new Date() } : { traceItemIndex: current.traceItemIndex + 1 })
      .where(eq(exerciseSessions.id, current.id))
      .returning()
      .get();
    if (!updated) throw new TRPCError({ code: 'CONFLICT' });
    return toRegularState(updated);
  });
// code-gauge-allow functionParameterCount 7 -- Grading binds the submitted code and receipt time to the full authenticated session context.
const gradeAndSave = (
  id: number,
  userId: string,
  courseId: string,
  lectureId: string,
  code: string,
  receivedAt: Date,
  format: JavaChallengeFormat
): FillInBlankVerdict => {
  const session = ownedSession(id, userId, courseId, lectureId, format, receivedAt);
  assertNotEnded(session, receivedAt);
  const result = gradeFillInBlankCode(savedChallenge(session), code);
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
        eq(exerciseSessions.userId, session.userId),
        eq(exerciseSessions.courseId, session.courseId),
        eq(exerciseSessions.lectureId, session.lectureId),
        eq(exerciseSessions.learningMode, 'challenge'),
        eq(exerciseSessions.problemFormat, session.problemFormat),
        gte(exerciseSessions.id, session.id),
        isNotNull(exerciseSessions.endedAt),
        start ? gte(exerciseSessions.createdAt, start) : undefined
      )
    )
    .get();
  if (ended) throw new TRPCError({ code: 'CONFLICT' });
};
