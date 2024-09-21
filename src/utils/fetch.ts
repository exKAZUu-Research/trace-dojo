import type { UserAnswer, UserProblemSession } from '@prisma/client';

import { prisma } from '../infrastructures/prisma';
import type { ProgramId } from '../problems/problemData';

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

export async function fetchUserLectureProblemSessionWithAnswer(
  userId: string,
  lectureId: string
): Promise<UserProblemSessionWithUserAnswers[]> {
  try {
    const userProblemSessions = await prisma.userProblemSession.findMany({
      where: {
        userId,
        lectureId,
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
  programId: string
): Promise<UserProblemSession | undefined> {
  try {
    const suspendedUserProblemSession = await prisma.userProblemSession.findFirst({
      where: {
        userId,
        courseId,
        programId,
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
): Promise<{ programId: ProgramId }[]> {
  try {
    const userCompletedProblems = await prisma.userCompletedProblem.findMany({
      where: {
        userId,
        courseId,
      },
      select: {
        programId: true,
      },
    });
    return userCompletedProblems as { programId: ProgramId }[];
  } catch (error) {
    console.error(error);
    return [];
  }
}

export async function fetchUserLectureCompletedProblems(
  userId: string,
  courseId: string,
  lectureId: string
): Promise<{ programId: ProgramId }[]> {
  try {
    const userCompletedProblems = await prisma.userCompletedProblem.findMany({
      where: {
        userId,
        courseId,
        lectureId,
      },
      select: {
        programId: true,
      },
    });
    return userCompletedProblems as { programId: ProgramId }[];
  } catch (error) {
    console.error(error);
    return [];
  }
}
