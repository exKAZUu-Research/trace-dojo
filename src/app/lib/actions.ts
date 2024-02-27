'use server';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export async function createUserSolvedProblem(
  userId: string,
  courseId: string,
  programId: string,
  languageId: string
): Promise<void> {
  try {
    await prisma.userSolvedProblem.create({
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

export async function fetchUserSolvedProblems(
  userId: string,
  courseId: string
): Promise<Array<{ programId: string; languageId: string }>> {
  try {
    const userSolvedProblems = await prisma.userSolvedProblem.findMany({
      where: {
        userId,
        courseId,
      },
      select: {
        programId: true,
        languageId: true,
      },
    });
    return userSolvedProblems;
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
