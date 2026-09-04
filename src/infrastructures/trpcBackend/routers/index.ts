import { TRPCError } from '@trpc/server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { logger } from '../../pino';
import { prisma } from '../../prisma';
import { authorize } from '../middlewares';
import { procedure, router } from '../trpc';

import { DEFAULT_LANGUAGE_ID } from '@/constants';
import { gradeFillInBlankAnswers } from '@/problems/fillInBlank/grade';
import { instantiateProblem } from '@/problems/instantiateProblem';

export const backendRouter = router({
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
        completedAt: z.date().optional(),
      })
    )
    .mutation(async ({ input: { id, incrementalElapsedMilliseconds, ...data } }) => {
      if (data.problemType === 'step' && data.traceItemIndex === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST' });
      }

      const problemSession = await prisma.problemSession.update({
        where: { id },
        data: {
          ...(incrementalElapsedMilliseconds
            ? { elapsedMilliseconds: { increment: incrementalElapsedMilliseconds } }
            : {}),
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

  gradeFillInBlankAnswers: procedure
    .use(authorize)
    .input(
      z.object({
        sessionId: z.number().int().positive(),
        answers: z.array(z.string().max(1000)).max(50),
        elapsedMilliseconds: z.number().nonnegative(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Grading may take tens of seconds, so the completion time is the time the answer arrived.
      const receivedAt = new Date();
      const session = await prisma.problemSession.findUnique({ where: { id: input.sessionId } });
      if (!session) throw new TRPCError({ code: 'NOT_FOUND' });
      if (session.userId !== ctx.session.superTokensUserId) throw new TRPCError({ code: 'UNAUTHORIZED' });
      const problem = instantiateProblem(session.problemId, DEFAULT_LANGUAGE_ID, session.problemVariablesSeed);
      if (!problem || problem.blankAnswers.length === 0) throw new TRPCError({ code: 'BAD_REQUEST' });

      const result = await gradeFillInBlankAnswers(problem, input.answers);
      if (result.status === 'ungradable') {
        logger.warn('Failed to grade fill-in-the-blank answers of session %d: %s', session.id, result.detail);
        // The detail describes server infrastructure, so it stays in the log.
        return { status: result.status, detail: '' };
      }
      await prisma.problemSubmission.create({
        data: {
          sessionId: session.id,
          problemType: session.problemType,
          traceItemIndex: session.traceItemIndex,
          elapsedMilliseconds: input.elapsedMilliseconds,
          isCorrect: result.status === 'correct',
          answers: JSON.stringify(input.answers),
          gradingStage: result.stage,
        },
      });
      if (result.status === 'correct') {
        await prisma.problemSession.update({ where: { id: session.id }, data: { completedAt: receivedAt } });
        revalidatePath('/courses/[courseId]/lectures/[lectureId]', 'page');
      }
      return result;
    }),

  countIncorrectSubmissions: procedure
    .use(authorize)
    .input(
      z.object({
        sessionId: z.number().int().positive(),
      })
    )
    .query(async ({ input }) => {
      return await prisma.problemSubmission.count({
        where: {
          sessionId: input.sessionId,
          isCorrect: false,
        },
      });
    }),
});

// export type definition of API
export type BackendRouter = typeof backendRouter;
