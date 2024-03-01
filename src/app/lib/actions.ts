'use server';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export async function createUserCompletedProblem(
  userId: string,
  courseId: string,
  programId: string,
  languageId: string
): Promise<void> {
  try {
    await prisma.userCompletedProblem.create({
      data: {
        userId,
        courseId,
        programId,
        languageId,
      },
    });
  } catch (error) {
    console.error(error);
  }
}

export async function fetchUserCompletedProblems(
  userId: string,
  courseId: string
): Promise<Array<{ programId: string; languageId: string }>> {
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
    return userCompletedProblems;
  } catch (error) {
    console.error(error);
    return [];
  }
}

export async function createProblemAnswerLog(
  programId: string,
  problemType: string,
  languageId: string,
  userId: string,
  startedAt: Date,
  answeredAt: Date,
  isPassed: boolean
): Promise<void> {
  try {
    await prisma.problemAnswerLog.create({
      data: {
        programId,
        problemType,
        languageId,
        userId,
        startedAt,
        answeredAt,
        isPassed,
      },
    });
  } catch (error) {
    console.error(error);
  }
}
