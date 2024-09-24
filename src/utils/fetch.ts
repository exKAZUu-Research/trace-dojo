import type { UserAnswer, UserProblemSession } from '@prisma/client';

import { prisma } from '../infrastructures/prisma';
import type { ProblemId } from '../problems/problemData';

export type UserProblemSessionWithUserAnswers = UserProblemSession & { userAnswers: UserAnswer[] };

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
