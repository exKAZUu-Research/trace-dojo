/** `yarn calculate-score` to run this script. */

import { writeFileSync } from 'node:fs';

import { PrismaClient } from '@prisma/client';
import SuperTokensNode from 'supertokens-node';

import { ensureSuperTokensInit } from '../src/infrastructures/supertokens/backendConfig';
import { courseIdToLectureIndexToProblemIds } from '../src/problems/problemData';

const prisma = new PrismaClient();

const deadLines = {
  tuBeginner1: [
    new Date('2024-10-17T11:59:59+09:00'), // 1st: 10/17
    new Date('2024-10-17T11:59:59+09:00'), // 2nd: 10/17
    new Date('2024-10-24T11:59:59+09:00'), // 3rd: 10/24
    new Date('2024-10-24T11:59:59+09:00'), // 4th: 10/24
    new Date('2024-10-31T11:59:59+09:00'), // 5th: 10/31
    new Date('2024-11-07T11:59:59+09:00'), // 6th: 11/07
    new Date('2024-11-14T11:59:59+09:00'), // 7th: 11/14
    new Date('2024-11-21T11:59:59+09:00'), // 8th: 11/21
    new Date('2024-12-02T11:59:59+09:00'), // final deadline: 12/02
  ],
};

async function main(): Promise<void> {
  ensureSuperTokensInit();

  const courseId = 'tuBeginner1';
  const users = await prisma.user.findMany();
  const finalDeadline = deadLines[courseId][8];

  // Print CSV header
  const header =
    '管理ID,単位認定試験_最終点,小テスト_最終点,ディスカッション_最終点,レポート_最終点,英語_最終点,相互評価_最終点,プログラミング_最終点,その他1_最終点,その他2_最終点,その他3_最終点,その他4_最終点,その他5_最終点,備考\n';
  console.log(header.trim());
  writeFileSync('grading.csv', header);

  for (const user of users) {
    let email = user.displayName;
    try {
      const superTokensUser = await SuperTokensNode.getUser(user.id);
      if (superTokensUser?.emails[0]) {
        email = superTokensUser.emails[0];
      }
    } catch (error) {
      console.error(`Failed to get email for user ${user.id}:`, error);
    }

    if (!email.toLowerCase().endsWith('@s.internet.ac.jp')) continue;

    let totalScore = 0;
    let solvedProblems = 0;
    for (const [lectureIndex, problemIds] of courseIdToLectureIndexToProblemIds[courseId].entries()) {
      const maxProblemScore = 10 / problemIds.length; // Each lesson has 10 points max
      const lectureDeadline = deadLines[courseId][lectureIndex];

      for (const problemId of problemIds) {
        const session = await prisma.problemSession.findFirst({
          where: {
            problemId,
            userId: user.id,
            completedAt: { not: null },
          },
          orderBy: { completedAt: 'asc' },
          select: {
            completedAt: true,
            submissions: {
              select: {
                isCorrect: true,
              },
            },
          },
        });

        if (!session) continue; // No completed session

        const completedAt = session.completedAt!;

        // Skip if completed after final deadline
        if (completedAt > finalDeadline) continue;

        let problemScore = maxProblemScore;
        const incorrectSubmissions = session.submissions.filter((s) => !s.isCorrect).length;

        let penaltyPercentage = 0;

        // Penalty for incorrect submissions
        penaltyPercentage += Math.min(30, incorrectSubmissions); // Max 30% reduction

        // Proportional penalty for late submission
        if (completedAt > lectureDeadline && completedAt <= finalDeadline) {
          const totalTimeWindow = finalDeadline.getTime() - lectureDeadline.getTime();
          const submissionDelay = completedAt.getTime() - lectureDeadline.getTime();
          const delayRatio = submissionDelay / totalTimeWindow;
          penaltyPercentage += Math.min(30, 30 * delayRatio); // Max 30% reduction, proportional to delay
        }

        problemScore *= (100 - penaltyPercentage) / 100;
        totalScore += problemScore;
        solvedProblems++;
      }
    }
    totalScore = (totalScore / 80) * 100;

    // Print CSV row, escape email if it contains commas
    const atIndex = email.indexOf('@');
    const studentId = atIndex > 0 ? email.slice(0, Math.max(0, email.indexOf('@'))) : email;
    const row = `${studentId.toUpperCase()},${Math.round(totalScore)},0,0,0,0,0,0,0,0,0,0,0,\n`;
    console.log(row.trim() + ': ' + solvedProblems);
    writeFileSync('grading.csv', row, { flag: 'a' });
  }
}

void (async () => {
  try {
    await main();
  } catch (error) {
    console.error(error);
  } finally {
    await prisma.$disconnect();
    process.exit(0);
  }
})();
