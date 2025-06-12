/** `yarn calculate-score` to run this script. */

import { writeFileSync } from 'node:fs';

import { PrismaClient } from '@prisma/client';
import SuperTokensNode from 'supertokens-node';

import { ensureSuperTokensInit } from '@/infrastructures/supertokens/backendConfig';
import { courseIdToLectureIndexToProblemIds } from '@/problems/problemData';

const prisma = new PrismaClient();

// 1/3 9:30まで一発正解の採点考慮

const deadLines = {
  tuBeginner1: [
    new Date('2025-04-29T11:59:59+09:00'), // 1st: 4/29
    new Date('2025-04-30T11:59:59+09:00'), // 2nd: 4/30
    new Date('2025-05-08T11:59:59+09:00'), // 3rd: 5/8
    new Date('2025-05-08T11:59:59+09:00'), // 4th: 5/8
    new Date('2025-05-15T11:59:59+09:00'), // 5th: 5/15
    new Date('2025-05-15T11:59:59+09:00'), // 6th: 5/15
    new Date('2025-05-18T11:59:59+09:00'), // 7th: 5/18
    new Date('2025-05-29T11:59:59+09:00'), // 8th: 5/29
    new Date('2025-06-09T11:59:59+09:00'), // final deadline: 6/9
  ],
  // tuBeginner2: [
  //   new Date('2025-01-14T11:59:59+09:00'), // 1st: 1/14
  //   new Date('2025-01-14T11:59:59+09:00'), // 2nd: 1/14
  //   new Date('2025-01-16T11:59:59+09:00'), // 3rd: 1/16
  //   new Date('2025-01-16T11:59:59+09:00'), // 4th: 1/16
  //   new Date('2025-01-27T11:59:59+09:00'), // 5th: 1/27
  //   new Date('2025-01-30T11:59:59+09:00'), // 6th: 1/30
  //   new Date('2025-02-06T11:59:59+09:00'), // 7th: 2/6
  //   new Date('2025-02-13T11:59:59+09:00'), // 8th: 2/13
  //   new Date('2025-02-25T11:59:59+09:00'), // final deadline: 2/25
  // ],
};

const validStudentIds = `
<ここに改行区切りで学籍番号の一覧を記載する。>
`.split(/\s+/);

async function main(): Promise<void> {
  ensureSuperTokensInit();

  const courseId = 'tuBeginner1';
  const users = await prisma.user.findMany();
  const finalDeadline = deadLines[courseId][8];

  // 「雛形ダウンロード」を押して、最新のヘッダーを反映させること。
  const header =
    '管理ID,単位認定試験_最終点,小テスト_最終点,ディスカッション_最終点,レポート_最終点,英語_最終点,相互評価_最終点,プログラミング_最終点,LTI_最終点,その他1_最終点,その他2_最終点,その他3_最終点,その他4_最終点,その他5_最終点,備考\n';
  console.log(header.trim());
  writeFileSync('grading.csv', header);

  const records: { studentId: string; row: string; solvedProblems: number }[] = [];

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

    const atIndex = email.indexOf('@');
    const studentId = (atIndex > 0 ? email.slice(0, Math.max(0, email.indexOf('@'))) : email).toUpperCase();
    if (!validStudentIds.includes(studentId)) continue;

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
    const row = `${studentId},,,,,,,${Math.round(totalScore)},,,,,,,\n`;
    records.push({ studentId, row, solvedProblems });
  }

  // Sort records by studentId
  records.sort((a, b) => a.studentId.localeCompare(b.studentId));

  // Write sorted records to file
  for (const record of records) {
    console.log(record.row.trim() + ': ' + record.solvedProblems);
    writeFileSync('grading.csv', record.row, { flag: 'a' });
  }
}

// eslint-disable-next-line unicorn/prefer-top-level-await
void (async () => {
  try {
    await main();
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
})();
