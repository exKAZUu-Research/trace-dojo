import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { upsertUserProblemSession } from '../../../utils/upsertUserProblemSession';
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
        lectureId: z.string(),
        programId: z.string(),
        problemVariablesSeed: z.string(),
        currentProblemType: z.string(),
        beforeTraceItemIndex: z.number().nonnegative(),
        currentTraceItemIndex: z.number().nonnegative(),
        timeSpent: z.number().optional(),
        startedAt: z.date(),
        finishedAt: z.date().optional(),
        isCompleted: z.boolean(),
      })
    )
    .mutation(async ({ input }) => {
      return await upsertUserProblemSession(
        input.id,
        input.userId,
        input.courseId,
        input.programId,
        input.lectureId,
        input.problemVariablesSeed,
        input.currentProblemType,
        input.beforeTraceItemIndex,
        input.currentTraceItemIndex,
        input.timeSpent,
        input.startedAt,
        input.finishedAt,
        input.isCompleted
      );
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
      revalidatePath('/courses/[courseId]/[lectureId]', 'page');
      console.log(`revalidatePath('/courses/[courseId]/[lectureId]', 'page');`);
      return userProblemSession;
    }),
  createUserCompletedProblem: procedure
    .use(authorize)
    .input(
      z.object({
        userId: z.string(),
        courseId: z.string(),
        lectureId: z.string(),
        programId: z.string(),
      })
    )
    .mutation(async ({ input }) => {
      await prisma.userCompletedProblem.create({
        data: {
          userId: input.userId,
          courseId: input.courseId,
          lectureId: input.lectureId,
          programId: input.programId,
        },
      });
      revalidatePath('/courses/[courseId]/[lectureId]', 'page');
      console.log(`revalidatePath('/courses/[courseId]/[lectureId]', 'page');`);
    }),
  createUserAnswer: procedure
    .use(authorize)
    .input(
      z.object({
        programId: z.string(),
        problemType: z.string(),
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
