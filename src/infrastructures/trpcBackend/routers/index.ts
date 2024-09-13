import { z } from 'zod';

import { prisma } from '../../prisma';
import { authorize } from '../middlewares';
import { procedure, router } from '../trpc';

export const backendRouter = router({
  getSession: procedure
    .use(authorize)
    .output(z.object({ userId: z.string().uuid() }))
    .query(({ ctx }) => ({ userId: ctx.session.superTokensUserId })),
  upsertUserProblemSession: procedure
    .use(authorize)
    .input(
      z.object({
        id: z.number(),
        userId: z.string(),
        courseId: z.string(),
        programId: z.string(),
        languageId: z.string(),
        problemVariablesSeed: z.string(),
        currentProblemType: z.string(),
        beforeTraceItemIndex: z.number().nonnegative(),
        currentTraceItemIndex: z.number().nonnegative(),
        timeSpent: z.number().nullable(),
        startedAt: z.date(),
        finishedAt: z.date().nullable(),
        isCompleted: z.boolean(),
      })
    )
    .mutation(async ({ input }) => {
      const {
        beforeTraceItemIndex,
        courseId,
        currentProblemType,
        currentTraceItemIndex,
        finishedAt,
        id,
        isCompleted,
        languageId,
        problemVariablesSeed,
        programId,
        startedAt,
        userId,
      } = input;
      const userProblemSession = await prisma.userProblemSession.upsert({
        where: {
          id,
        },
        update: {
          currentProblemType,
          beforeTraceItemIndex,
          currentTraceItemIndex,
          timeSpent: input.timeSpent ?? undefined,
          startedAt,
          finishedAt,
          isCompleted,
        },
        create: {
          userId,
          courseId,
          programId,
          languageId,
          problemVariablesSeed,
          currentProblemType,
          beforeTraceItemIndex,
          currentTraceItemIndex,
          timeSpent: input.timeSpent ?? undefined,
          startedAt,
          finishedAt,
          isCompleted,
        },
      });
      return userProblemSession;
    }),
  updateUserProblemSession: procedure
    .use(authorize)
    .input(
      z.object({
        id: z.number(),
        data: z.object({
          currentStep: z.number().optional(),
          timeSpent: z.number().optional(),
          finishedAt: z.date().optional(),
          isCompleted: z.boolean().optional(),
        }),
      })
    )
    .mutation(async ({ input }) => {
      const { data, id } = input;
      const userProblemSession = await prisma.userProblemSession.update({
        where: {
          id,
        },
        data,
      });
      return userProblemSession;
    }),
  createUserCompletedProblem: procedure
    .use(authorize)
    .input(
      z.object({
        userId: z.string(),
        courseId: z.string(),
        programId: z.string(),
        languageId: z.string(),
      })
    )
    .mutation(async ({ input }) => {
      await prisma.userCompletedProblem.create({
        data: {
          userId: input.userId,
          courseId: input.courseId,
          programId: input.programId,
          languageId: input.languageId,
        },
      });
    }),
  createUserAnswer: procedure
    .use(authorize)
    .input(
      z.object({
        programId: z.string(),
        problemType: z.string(),
        languageId: z.string(),
        userId: z.string(),
        userProblemSessionId: z.number(),
        step: z.number().nonnegative(),
        isPassed: z.boolean(),
        timeSpent: z.number().optional(),
        startedAt: z.date().optional(),
      })
    )
    .mutation(async ({ input }) => {
      await prisma.userAnswer.create({
        data: {
          programId: input.programId,
          problemType: input.problemType,
          languageId: input.languageId,
          userId: input.userId,
          userProblemSessionId: input.userProblemSessionId,
          step: input.step,
          isPassed: input.isPassed,
          timeSpent: input.timeSpent,
          startedAt: input.startedAt,
        },
      });
    }),
});

// export type definition of API
export type BackendRouter = typeof backendRouter;
