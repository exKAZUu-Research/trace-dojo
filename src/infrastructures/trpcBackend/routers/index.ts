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

  upsertProblemSession: procedure
    .use(authorize)
    .input(
      z.object({
        id: z.number().int().nonnegative().optional(),
        userId: z.string().min(1),
        courseId: z.string().min(1),
        programId: z.string().min(1),
        languageId: z.string().min(1),
        problemVariablesSeed: z.string().min(1),
        currentProblemType: z.string().min(1),
        currentTraceItemIndex: z.number().int().nonnegative(),
        previousTraceItemIndex: z.number().int().nonnegative(),
        elapsedMilliseconds: z.number().nonnegative().optional(),
        completedAt: z.date().optional(),
      })
    )
    .mutation(async ({ input: { id, ...data } }) => {
      return await prisma.problemSession.upsert({
        // Since no record has `id: 0`, `create` will always be executed.
        where: { id: id ?? 0 },
        update: data,
        create: data,
      });
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
      revalidatePath('/courses/[courseId]/[languageId]', 'page');
      console.log(`revalidatePath('/courses/[courseId]/[languageId]', 'page');`);
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
      revalidatePath('/courses/[courseId]/[languageId]', 'page');
      console.log(`revalidatePath('/courses/[courseId]/[languageId]', 'page');`);
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
