'use server';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export async function createUserSolvedProblem(
  userId: string,
  courseId: string,
  programId: string,
  languageId: string
): Promise<void> {
  prisma.userSolvedProblem.create({
    data: {
      userId,
      courseId,
      programId,
      languageId,
    },
  });
}
