'use server';

import type { UserAnswer, UserProblemSession } from '@prisma/client';

import { prisma } from '../../infrastructures/prisma';

export type UserProblemSessionWithUserAnswers = UserProblemSession & { userAnswers: UserAnswer[] };

export async function upsertUserProblemSession(
  id: number,
  userId: string,
  courseId: string,
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

export async function createUserAnswer(
  programId: string,
  problemType: string,
  languageId: string,
  userId: string,
  userProblemSessionId: number,
  step: number,
  isPassed: boolean,
  timeSpent?: number,
  startedAt?: Date | undefined
): Promise<void> {
  try {
    await prisma.userAnswer.create({
      data: {
        programId,
        problemType,
        languageId,
        userId,
        userProblemSessionId,
        step,
        isPassed,
        timeSpent,
        startedAt,
      },
    });
  } catch (error) {
    console.error(error);
  }
}
