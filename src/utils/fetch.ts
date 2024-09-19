import type { UserAnswer, UserProblemSession } from '@prisma/client';

import { prisma } from '../infrastructures/prisma';
import type { ProgramId, VisibleLanguageId } from '../problems/problemData';

export type UserProblemSessionWithUserAnswers = UserProblemSession & { userAnswers: UserAnswer[] };

export async function fetchUserProblemSessionsWithUserAnswer(
  userId: string
): Promise<UserProblemSessionWithUserAnswers[]> {
  try {
    const userProblemSessions = await prisma.userProblemSession.findMany({
      where: {
        userId,
      },
      include: {
        userAnswers: true,
      },
      orderBy: {
        createdAt: 'asc',
      },
    });
    return userProblemSessions;
  } catch (error) {
    console.error(error);
    return [];
  }
}

export async function findSuspendedUserProblemSession(
  userId: string,
  courseId: string,
  programId: string,
  languageId: string
): Promise<UserProblemSession | undefined> {
  try {
    const suspendedUserProblemSession = await prisma.userProblemSession.findFirst({
      where: {
        userId,
        courseId,
        programId,
        languageId,
        finishedAt: undefined,
        isCompleted: false,
      },
    });
    return suspendedUserProblemSession || undefined;
  } catch (error) {
    console.error(error);
    return undefined;
  }
}

export async function fetchUserCompletedProblems(
  userId: string,
  courseId: string
): Promise<{ programId: ProgramId; languageId: VisibleLanguageId }[]> {
  try {
    const userCompletedProblems = await prisma.userCompletedProblem.findMany({
      where: {
        userId,
        courseId,
      },
      select: {
        programId: true,
        languageId: true,
      },
    });
    return userCompletedProblems as { programId: ProgramId; languageId: VisibleLanguageId }[];
  } catch (error) {
    console.error(error);
    return [];
  }
}
