import { TRPCError } from '@trpc/server';
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
        id: z.number().int().positive(),
        currentProblemType: z.string().min(1).optional(),
        currentTraceItemIndex: z.number().int().nonnegative().optional(),
        previousTraceItemIndex: z.number().int().nonnegative().optional(),
        incrementalElapsedMilliseconds: z.number().nonnegative().optional(),
        completedAt: z.date().optional(),
      })
    )
    .mutation(async ({ input: { id, incrementalElapsedMilliseconds, ...data } }) => {
      const problemSession = await prisma.problemSession.update({
        where: { id },
        data: {
          elapsedMilliseconds: { increment: incrementalElapsedMilliseconds },
          ...data,
        },
      });
      // 開発環境ではページが更新されないので注意すること。
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
        elapsedMilliseconds: z.number().nonnegative(),
        isCorrect: z.boolean(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const session = await prisma.problemSession.findUnique({ where: { id: input.sessionId } });
      if (!session) throw new TRPCError({ code: 'NOT_FOUND' });
      if (session.userId !== ctx.session.superTokensUserId) throw new TRPCError({ code: 'UNAUTHORIZED' });

      await prisma.problemSubmission.create({ data: input });
    }),
});

// export type definition of API
export type BackendRouter = typeof backendRouter;
