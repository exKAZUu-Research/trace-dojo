'use server';

import type { UserProblemSession } from '@prisma/client';
import { PrismaClient } from '@prisma/client';

import type { ProgramId, VisibleLanguageId } from '../../problems/problemData';

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
        beforeStep,
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
    return userProblemSession;
  } catch (error) {
    console.error(error);
    return undefined;
  }
}

export async function fetchUserProblemSessions(userId: string): Promise<UserProblemSession[]> {
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

export async function getSuspendedUserProblemSession(
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

export async function updateUserProblemSession(
  id: number,
  data: {
    currentStep?: number;
    timeSpent?: number;
    finishedAt?: Date;
    isCompleted?: boolean;
  }
): Promise<UserProblemSession | undefined> {
  try {
    const userProblemSession = await prisma.userProblemSession.update({
      where: {
        id,
      },
      data,
    });

    return userProblemSession;
  } catch (error) {
    console.error(error);
    return undefined;
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

export async function createUserAnswer(
  programId: string,
  problemType: string,
  languageId: string,
  userId: string,
  step: number,
  isPassed: boolean,
  timeSpent?: number
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
        timeSpent,
      },
    });
  } catch (error) {
    console.error(error);
  }
}
