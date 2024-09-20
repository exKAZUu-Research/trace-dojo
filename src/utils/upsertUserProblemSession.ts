import type { UserProblemSession } from '@prisma/client';

import { prisma } from '../infrastructures/prisma';

export async function upsertUserProblemSession(
  id: number,
  userId: string,
  courseId: string,
  lectureId: string,
  programId: string,
  languageId: string,
  problemVariablesSeed: string,
  currentProblemType: string,
  beforeTraceItemIndex: number,
  currentTraceItemIndex: number,
  timeSpent: number | undefined,
  startedAt: Date,
  finishedAt: Date | undefined,
  isCompleted: boolean
): Promise<UserProblemSession | undefined> {
  try {
    const userProblemSession = await prisma.userProblemSession.upsert({
      where: {
        id,
      },
      update: {
        currentProblemType,
        beforeTraceItemIndex,
        currentTraceItemIndex,
        timeSpent,
        startedAt,
        finishedAt,
        isCompleted,
      },
      create: {
        userId,
        courseId,
        lectureId,
        programId,
        languageId,
        problemVariablesSeed,
        currentProblemType,
        beforeTraceItemIndex,
        currentTraceItemIndex,
        timeSpent,
        startedAt,
        finishedAt,
        isCompleted,
      },
    });
    return userProblemSession;
  } catch (error) {
    console.error(error);
    return undefined;
  }
}
