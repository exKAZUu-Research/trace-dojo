import { TRPCError } from '@trpc/server';
import { and, eq, gte, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { getLearningPeriodFilter } from '@/learningPeriod';
import { GRADING_STAGE } from '@/problems/fillInBlank/gradingStage';
import { MAX_JAVA_PROGRAM_LENGTH } from '@/problems/fillInBlank/javaProgram';
import { getOrdinaryJavaProblem, isOrdinaryBugProblem } from '@/problems/javaChallenges/ordinaryProblem';
import { isFillInBlankProblem } from '@/problems/problemData';

import { type ProblemSession, problemSessions, problemSubmissions } from '../../../../db/schema';
import { db } from '../../database';
import { authorize } from '../middlewares';
import { procedure, router } from '../trpc';
import { exerciseProcedures } from './exercises';

export const backendRouter = router({
  ...exerciseProcedures,
  getSession: procedure
    .use(authorize)
    .output(z.object({ userId: z.string() }))
    .query(({ ctx }) => ({ userId: ctx.session.superTokensUserId })),

  updateProblemSession: procedure
    .use(authorize)
    .input(
      z.object({
        id: z.number().int().positive(),
        problemType: z.string().min(1).optional(),
        traceItemIndex: z.number().int().nonnegative().optional(),
        incrementalElapsedMilliseconds: z.number().nonnegative().optional(),
      })
    )
    .mutation(async ({ ctx, input: { id, incrementalElapsedMilliseconds, ...data } }) => {
      if (data.problemType === 'step' && data.traceItemIndex === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST' });
      }

      const ownedSession = await db.query.problemSessions.findFirst({
        where: { id, userId: ctx.session.superTokensUserId, ...getLearningPeriodFilter() },
      });
      if (!ownedSession) throw new TRPCError({ code: 'NOT_FOUND' });
      if (isOrdinaryBugProblem(ownedSession.problemId) || ownedSession.problemType === 'bugFix') {
        validateOrdinaryBugSession(ownedSession);
        if (
          (data.problemType !== undefined && data.problemType !== 'bugFix') ||
          (data.traceItemIndex !== undefined && data.traceItemIndex !== 0)
        )
          throw new TRPCError({ code: 'BAD_REQUEST' });
      }
      const start = getLearningPeriodFilter().createdAt?.gte;
      const problemSession = db
        .update(problemSessions)
        .set({
          ...data,
          updatedAt: new Date(),
          elapsedMilliseconds: incrementalElapsedMilliseconds
            ? sql`${problemSessions.elapsedMilliseconds} + ${incrementalElapsedMilliseconds}`
            : undefined,
        })
        .where(
          and(
            eq(problemSessions.id, id),
            eq(problemSessions.userId, ctx.session.superTokensUserId),
            start ? gte(problemSessions.createdAt, start) : undefined
          )
        )
        .returning()
        .get();
      if (!problemSession) throw new TRPCError({ code: 'NOT_FOUND' });
      revalidatePath('/courses/[courseId]/lectures/[lectureId]', 'page');
      console.log(`revalidatePath('/courses/[courseId]/lectures/[lectureId]', 'page');`);
      return problemSession;
    }),

  createProblemSubmission: procedure
    .use(authorize)
    .input(
      z.object({
        sessionId: z.number().int().positive(),
        problemType: z.string(),
        traceItemIndex: z.number().int().nonnegative(),
        isCorrect: z.boolean(),
        incrementalElapsedMilliseconds: z.number().nonnegative(),
        isCompleted: z.boolean(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const receivedAt = new Date();
      db.transaction((tx) => {
        const session = tx.query.problemSessions
          .findFirst({
            where: { id: input.sessionId, ...getLearningPeriodFilter(receivedAt) },
          })
          .sync();
        if (!session) throw new TRPCError({ code: 'NOT_FOUND' });
        if (session.userId !== ctx.session.superTokensUserId) throw new TRPCError({ code: 'UNAUTHORIZED' });

        if (isOrdinaryBugProblem(session.problemId) || session.problemType === 'bugFix')
          throw new TRPCError({ code: 'BAD_REQUEST' });

        const updatedSession = tx
          .update(problemSessions)
          .set({
            updatedAt: receivedAt,
            elapsedMilliseconds: sql`${problemSessions.elapsedMilliseconds} + ${input.incrementalElapsedMilliseconds}`,
            completedAt: input.isCompleted ? receivedAt : undefined,
          })
          .where(eq(problemSessions.id, session.id))
          .returning()
          .get()!;
        tx.insert(problemSubmissions)
          .values({
            sessionId: session.id,
            problemType: input.problemType,
            traceItemIndex: input.traceItemIndex,
            isCorrect: input.isCorrect,
            elapsedMilliseconds: updatedSession.elapsedMilliseconds,
          })
          .run();
      });
      revalidatePath('/courses/[courseId]/lectures/[lectureId]', 'page');
    }),

  createFillInBlankSubmission: procedure
    .use(authorize)
    .input(
      z.object({
        sessionId: z.number().int().positive(),
        code: z.string().min(1).max(MAX_JAVA_PROGRAM_LENGTH),
        elapsedMilliseconds: z.number().nonnegative(),
        isCorrect: z.boolean(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const receivedAt = new Date();
      const session = await db.query.problemSessions.findFirst({
        where: { id: input.sessionId, ...getLearningPeriodFilter(receivedAt) },
      });
      if (!session) throw new TRPCError({ code: 'NOT_FOUND' });
      if (session.userId !== ctx.session.superTokensUserId) throw new TRPCError({ code: 'UNAUTHORIZED' });
      if (isOrdinaryBugProblem(session.problemId) || session.problemType === 'bugFix')
        validateOrdinaryBugSession(session);
      else if (!isFillInBlankProblem(session.problemId)) throw new TRPCError({ code: 'BAD_REQUEST' });

      db.transaction((tx) => {
        tx.insert(problemSubmissions)
          .values({
            sessionId: session.id,
            problemType: session.problemType,
            traceItemIndex: session.traceItemIndex,
            elapsedMilliseconds: input.elapsedMilliseconds,
            isCorrect: input.isCorrect,
            code: input.code,
            gradingStage: GRADING_STAGE,
          })
          .run();
        if (input.isCorrect) {
          tx.update(problemSessions).set({ completedAt: receivedAt }).where(eq(problemSessions.id, session.id)).run();
        }
      });
      if (input.isCorrect) revalidatePath('/courses/[courseId]/lectures/[lectureId]', 'page');
    }),

  countIncorrectSubmissions: procedure
    .use(authorize)
    .input(
      z.object({
        sessionId: z.number().int().positive(),
      })
    )
    .query(async ({ ctx, input }) => {
      const submissions = await db.query.problemSubmissions.findMany({
        columns: { id: true },
        where: {
          sessionId: input.sessionId,
          session: { userId: ctx.session.superTokensUserId, ...getLearningPeriodFilter() },
          isCorrect: false,
        },
      });
      return submissions.length;
    }),
});

export type BackendRouter = typeof backendRouter;

const validateOrdinaryBugSession = (session: ProblemSession): void => {
  if (session.problemType !== 'bugFix' || session.traceItemIndex !== 0) throw new TRPCError({ code: 'BAD_REQUEST' });
  try {
    getOrdinaryJavaProblem(session.problemId, session.courseId, session.lectureId);
  } catch {
    throw new TRPCError({ code: 'BAD_REQUEST' });
  }
};
