/**
 * 1. `WB_ENV=production yarn db-restore`.
 * 2. Update `deadLines`.
 * 3. Update `header` via `CSVインポート` -> `雛形ダウンロード`.
 * 4. Put the `CSVエクスポート` result at `prisma/validStudentIds.csv`.
 * 5. Create `.env.restored` based on `.env.production`.
 * 6. `yarn calculate-score`.
 * */

import { readFileSync, writeFileSync } from 'node:fs';

import { PrismaClient } from '@prisma/client';
import SuperTokensNode from 'supertokens-node';

import { ensureSuperTokensInit } from '@/infrastructures/supertokens/backendConfig';
import { courseIdToLectureIndexToProblemIds } from '@/problems/problemData';

const prisma = new PrismaClient();
const defaultValidStudentIdsCsvPath = 'prisma/validStudentIds.csv';

const deadLines = {
  tuBeginner1: [
    new Date('2026-04-30T11:59:59+09:00'), // 1st: 4/30
    new Date('2026-05-01T11:59:59+09:00'), // 2nd: 5/1
    new Date('2026-05-07T11:59:59+09:00'), // 3rd: 5/7
    new Date('2026-05-07T11:59:59+09:00'), // 4th: 5/7
    new Date('2026-05-14T11:59:59+09:00'), // 5th: 5/14
    new Date('2026-05-21T11:59:59+09:00'), // 6th: 5/21
    new Date('2026-05-28T11:59:59+09:00'), // 7th: 5/28
    new Date('2026-06-05T11:59:59+09:00'), // 8th: 6/5
    new Date('2026-06-15T11:59:59+09:00'), // final deadline: 6/15
  ],
  tuBeginner2: [
    new Date('2026-07-23T11:59:59+09:00'), // 1st: 7/23
    new Date('2026-07-23T11:59:59+09:00'), // 2nd: 7/23
    new Date('2026-07-30T11:59:59+09:00'), // 3rd: 7/30
    new Date('2026-07-30T11:59:59+09:00'), // 4th: 7/30
    new Date('2026-08-06T11:59:59+09:00'), // 5th: 8/6
    new Date('2026-08-17T11:59:59+09:00'), // 6th: 8/17
    new Date('2026-08-20T11:59:59+09:00'), // 7th: 8/20
    new Date('2026-08-27T11:59:59+09:00'), // 8th: 8/27
    new Date('2026-09-07T11:59:59+09:00'), // final deadline: 9/7
  ],
};

async function main(): Promise<void> {
  ensureSuperTokensInit();

  const validStudentIdsCsvPath = process.argv[2] ?? defaultValidStudentIdsCsvPath;
  const validStudentIds = loadValidStudentIds(validStudentIdsCsvPath);
  console.info(`Loaded valid student IDs from ${validStudentIdsCsvPath}:`, validStudentIds.size);

  const courseId = Object.keys(deadLines)[0] as keyof typeof deadLines;
  const users = await prisma.user.findMany();
  console.info('Fetched users:', users.length);
  const finalDeadline = deadLines[courseId][8];

  // 「雛形ダウンロード」を押して、最新のヘッダーを反映させること。
  const header =
    '管理ID,単位認定試験_最終点,小テスト_最終点,ディスカッション_最終点,レポート_最終点,英語_最終点,相互評価_最終点,プログラミング_最終点,LTI_最終点,その他1_最終点,その他2_最終点,その他3_最終点,その他4_最終点,その他5_最終点,備考\n';
  console.log(header.trim());
  writeFileSync('grading.csv', header);

  const records: { shouldWarn: boolean; studentId: string; row: string; solvedProblems: number }[] = [];

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
    if (!validStudentIds.has(studentId)) continue;

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
            // eslint-disable-next-line unicorn/no-null
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

        if (!session?.completedAt) continue; // No completed session

        const completedAt = session.completedAt;

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
    const roundedScore = Math.round(totalScore);
    const row = `${studentId},${roundedScore},,,,,,,,,,,,,\n`;
    records.push({ shouldWarn: roundedScore < 60, studentId, row, solvedProblems });
    process.stdout.write('.');
  }

  // Sort records by studentId
  records.sort((a, b) => a.studentId.localeCompare(b.studentId));

  // Write sorted records to file
  for (const record of records) {
    console.log(
      `${record.shouldWarn ? '!!! ' : ''}${record.row.trim()}: ${record.solvedProblems} problems solved${record.shouldWarn ? ' !!!' : ''}`
    );
    writeFileSync('grading.csv', record.row, { flag: 'a' });
  }
}

function loadValidStudentIds(csvPath: string): Set<string> {
  const rows = parseCsv(readFileSync(csvPath, 'utf8'));
  if (rows.length === 0) {
    throw new Error(`No rows found in ${csvPath}`);
  }

  const header = rows[0] ?? [];
  const studentIdColumnIndex = findStudentIdColumnIndex(header);
  const dataRows = studentIdColumnIndex === undefined ? rows : rows.slice(1);
  const columnIndex = studentIdColumnIndex ?? 0;

  const studentIds = new Set<string>();
  for (const row of dataRows) {
    const studentId = normalizeStudentId(row[columnIndex]);
    if (studentId) {
      studentIds.add(studentId);
    }
  }

  if (studentIds.size === 0) {
    throw new Error(`No valid student IDs found in ${csvPath}`);
  }
  return studentIds;
}

function findStudentIdColumnIndex(header: string[]): number | undefined {
  const normalizedHeader = header.map((cell) =>
    cell
      .trim()
      .replace(/^\uFEFF/, '')
      .replaceAll(/\s+/g, '')
      .toLowerCase()
  );
  const exactMatchIndex = normalizedHeader.findIndex((cell) => ['管理id', 'studentid', 'student_id'].includes(cell));
  if (exactMatchIndex !== -1) {
    return exactMatchIndex;
  }

  const partialMatchIndex = normalizedHeader.findIndex((cell) => cell.includes('学籍番号'));
  return partialMatchIndex !== -1 ? partialMatchIndex : undefined;
}

function normalizeStudentId(value: string | undefined): string {
  return (
    value
      ?.trim()
      .replace(/^\uFEFF/, '')
      .toUpperCase() ?? ''
  );
}

function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentCell = '';
  let isQuoted = false;

  for (let index = 0; index < content.length; index++) {
    const character = content[index];

    if (character === '"') {
      if (isQuoted && content[index + 1] === '"') {
        currentCell += '"';
        index++;
      } else {
        isQuoted = !isQuoted;
      }
      continue;
    }

    if (character === ',' && !isQuoted) {
      currentRow.push(currentCell);
      currentCell = '';
      continue;
    }

    if ((character === '\n' || character === '\r') && !isQuoted) {
      currentRow.push(currentCell);
      rows.push(currentRow);
      currentRow = [];
      currentCell = '';
      if (character === '\r' && content[index + 1] === '\n') {
        index++;
      }
      continue;
    }

    currentCell += character;
  }

  if (currentCell || currentRow.length > 0) {
    currentRow.push(currentCell);
    rows.push(currentRow);
  }

  return rows.filter((row) => row.some((cell) => cell.trim()));
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
