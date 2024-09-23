import type { UserAnswer, UserProblemSession } from '@prisma/client';

import { prisma } from '../infrastructures/prisma';
import type { ProblemId } from '../problems/problemData';

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

export async function fetchUserCompletedProblems(
  userId: string,
  courseId: string
): Promise<{ problemId: ProblemId }[]> {
  try {
    const userCompletedProblems = await prisma.userCompletedProblem.findMany({
      where: {
        userId,
        courseId,
      },
      select: {
        problemId: true,
      },
    });
    return userCompletedProblems as { problemId: ProblemId }[];
  } catch (error) {
    console.error(error);
    return [];
  }
}

export async function fetchUserLectureCompletedProblems(
  userId: string,
  courseId: string,
  lectureId: string
): Promise<{ problemId: ProblemId }[]> {
  try {
    const userCompletedProblems = await prisma.userCompletedProblem.findMany({
      where: {
        userId,
        courseId,
        lectureId,
      },
      select: {
        problemId: true,
      },
    });
    return userCompletedProblems as { problemId: ProblemId }[];
  } catch (error) {
    console.error(error);
    return [];
  }
}
