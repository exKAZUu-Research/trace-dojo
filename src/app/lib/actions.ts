'use server';
import type { UserProblemSession } from '@prisma/client';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export async function upsertUserProblemSession(
  id: number,
  userId: string,
  courseId: string,
  programId: string,
  languageId: string,
  currentProblemType: string,
  beforeStep: number,
  currentStep: number,
  timeSpent: number,
  startedAt: Date,
  finishedAt: Date | undefined,
  isCompleted: boolean
): Promise<void> {
  try {
    await prisma.userProblemSession.upsert({
      where: {
        id,
      },
      update: {
        currentProblemType,
        currentStep,
        timeSpent,
        startedAt,
        finishedAt,
        isCompleted,
      },
      create: {
        userId,
        courseId,
        programId,
        languageId,
        currentProblemType,
        beforeStep,
        currentStep,
        timeSpent,
        startedAt,
        finishedAt,
        isCompleted,
      },
    });
  } catch (error) {
    console.error(error);
  }
}

export async function fetchUserProblemSessions({ userId }: { userId: string }): Promise<Array<UserProblemSession>> {
  try {
    const userProblemSessions = await prisma.userProblemSession.findMany({
      where: {
        userId,
      },
    });
    return userProblemSessions;
  } catch (error) {
    console.error(error);
    return [];
  }
}

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

export async function createUserAnswer(
  programId: string,
  problemType: string,
  languageId: string,
  userId: string,
  step: number,
  isPassed: boolean
): Promise<void> {
  try {
    await prisma.userAnswer.create({
      data: {
        programId,
        problemType,
        languageId,
        userId,
        step,
        isPassed,
      },
    });
  } catch (error) {
    console.error(error);
  }
}
