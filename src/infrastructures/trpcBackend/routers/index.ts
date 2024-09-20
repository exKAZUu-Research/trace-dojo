import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { prisma } from '../../prisma';
import { authorize } from '../middlewares';
import { procedure, router } from '../trpc';

export const backendRouter = router({
  getSession: procedure
    .use(authorize)
    .output(z.object({ userId: z.string().uuid() }))
    .query(({ ctx }) => ({ userId: ctx.session.superTokensUserId })),

  updateProblemSession: procedure
    .use(authorize)
    .input(
      z.object({
        id: z.number().int().nonnegative(),
        currentProblemType: z.string().min(1).optional(),
        currentTraceItemIndex: z.number().int().nonnegative().optional(),
        previousTraceItemIndex: z.number().int().nonnegative().optional(),
        elapsedMilliseconds: z.number().nonnegative().optional(),
        completedAt: z.date().optional(),
      })
    )
    .mutation(async ({ input: { id, ...data } }) => {
      const problemSession = await prisma.problemSession.update({ where: { id }, data });
      revalidatePath('/courses/[courseId]/[languageId]', 'page');
      console.log(`revalidatePath('/courses/[courseId]/[languageId]', 'page');`);
      return problemSession;
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
