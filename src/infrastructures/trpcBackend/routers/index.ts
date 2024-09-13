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
});

// export type definition of API
export type BackendRouter = typeof backendRouter;
