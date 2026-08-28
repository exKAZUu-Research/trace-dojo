/**
 * 1. `WB_ENV=production yarn db-restore`.
 * 2. Update `deadLines`.
 * 3. Update `header` via `CSVインポート` -> `雛形ダウンロード`.
 * 4. Put the `CSVエクスポート` result at `students.csv`, or set `STUDENTS_CSV_PATH` to another path.
 * 5. Create `.env.restored` based on `.env.production`.
 * 6. `yarn calculate-score`.
 * */

import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

import { PrismaClient } from '@prisma/client';
import { parse } from 'csv-parse/sync';
import SuperTokensNode from 'supertokens-node';

import { ensureSuperTokensInit } from '@/infrastructures/supertokens/backendConfig';
import { courseIdToLectureIndexToProblemIds } from '@/problems/problemData';

const prisma = new PrismaClient();
const defaultValidStudentIdsCsvPath = 'students.csv';
const gradingCsvPath = 'grading.csv';
const previousGradingCsvPath = 'grading.previous.csv';
const temporaryGradingCsvPath = 'grading.tmp.csv';

// 「雛形ダウンロード」を押して、最新のヘッダーを反映させること。
const header =
  '管理ID,単位認定試験_最終点,小テスト_最終点,ディスカッション_最終点,レポート_最終点,英語_最終点,相互評価_最終点,プログラミング_最終点,LTI_最終点,その他1_最終点,その他2_最終点,その他3_最終点,その他4_最終点,その他5_最終点,備考\n';

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

interface ScoreRecord {
  shouldWarn: boolean;
  studentId: string;
  row: string;
  solvedProblems: number;
}

async function main(): Promise<void> {
  ensureSuperTokensInit();

  const validStudentIdsCsvPath = process.env.STUDENTS_CSV_PATH ?? defaultValidStudentIdsCsvPath;
  const validStudentIds = loadValidStudentIds(validStudentIdsCsvPath);
  console.info(`Loaded valid student IDs from ${validStudentIdsCsvPath}:`, validStudentIds.size);

  const courseId = Object.keys(deadLines)[0] as keyof typeof deadLines;
  const users = await prisma.user.findMany({
    where: { problemSessions: { some: { courseId } } },
  });
  console.info('Fetched users with course activity:', users.length);
  const finalDeadline = deadLines[courseId][8];

  const records: ScoreRecord[] = [];
  const ambiguousStudentIds = new Set<string>();
  const unexpectedActiveStudentIds = new Set<string>();

  for (const user of users) {
    const email = await resolveUserEmail(user.id);
    const atIndex = email.indexOf('@');
    const studentId = (atIndex > 0 ? email.slice(0, Math.max(0, email.indexOf('@'))) : email).toUpperCase();
    if (!email.toLowerCase().endsWith('@s.internet.ac.jp')) {
      if (validStudentIds.has(studentId)) {
        ambiguousStudentIds.add(studentId);
      }
      console.warn(`Skipping course-active user ${user.id} with unsupported email domain: ${email}`);
      continue;
    }
    if (!validStudentIds.has(studentId)) {
      unexpectedActiveStudentIds.add(studentId);
      console.warn(`Skipping course-active student ID not found in the roster: ${studentId}`);
      continue;
    }

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

    const roundedScore = Math.round(totalScore);
    const row = createScoreRow(studentId, roundedScore);
    records.push({ shouldWarn: roundedScore < 60, studentId, row, solvedProblems });
    process.stdout.write('.');
  }

  const matchedStudentIds = new Set(records.map(({ studentId }) => studentId));
  const unmatchedStudentIds = [...validStudentIds].filter((studentId) => !matchedStudentIds.has(studentId));
  const ambiguousUnmatchedStudentIds = [...ambiguousStudentIds].filter(
    (studentId) => !matchedStudentIds.has(studentId)
  );
  if (ambiguousUnmatchedStudentIds.length > 0) {
    throw new Error(
      `Cannot safely score roster IDs with course activity under unsupported email domains: ${ambiguousUnmatchedStudentIds.join(', ')}`
    );
  }

  if (unexpectedActiveStudentIds.size > 0 && unmatchedStudentIds.length > 0) {
    throw new Error(
      `Cannot safely match course-active student IDs outside the roster (${[...unexpectedActiveStudentIds].join(', ')}) while roster IDs lack activity (${unmatchedStudentIds.join(', ')})`
    );
  }

  if (records.length === 0) {
    throw new Error(`No users with course activity matched student IDs from ${validStudentIdsCsvPath}`);
  }

  for (const studentId of unmatchedStudentIds) {
    console.warn(`No user matched ${studentId}; writing a zero score`);
    records.push({ shouldWarn: true, studentId, row: createScoreRow(studentId, 0), solvedProblems: 0 });
  }

  console.log(header.trim());

  // Sort records by studentId
  records.sort((a, b) => a.studentId.localeCompare(b.studentId));

  for (const record of records) {
    console.log(
      `${record.shouldWarn ? '!!! ' : ''}${record.row.trim()}: ${record.solvedProblems} problems solved${record.shouldWarn ? ' !!!' : ''}`
    );
  }

  writeGradingCsv(records);
}

async function resolveUserEmail(userId: string): Promise<string> {
  let superTokensUser;
  try {
    superTokensUser = await SuperTokensNode.getUser(userId);
  } catch (error) {
    throw new Error(`Failed to get email for user ${userId}`, { cause: error });
  }

  const email = superTokensUser?.emails[0];
  if (!email) {
    throw new Error(`No email found for user ${userId}`);
  }
  return email;
}

function createScoreRow(studentId: string, score: number): string {
  return `${studentId},${score},,,,,,,,,,,,,\n`;
}

function preservePreviousGradingCsv(): void {
  if (existsSync(gradingCsvPath)) {
    copyFileSync(gradingCsvPath, previousGradingCsvPath);
  }
}

function writeGradingCsv(records: ScoreRecord[]): void {
  try {
    writeFileSync(temporaryGradingCsvPath, `${header}${records.map(({ row }) => row).join('')}`);
    preservePreviousGradingCsv();
    renameSync(temporaryGradingCsvPath, gradingCsvPath);
  } finally {
    rmSync(temporaryGradingCsvPath, { force: true });
  }
}

function loadValidStudentIds(csvPath: string): Set<string> {
  const rows = parseCsvRows(readFileSync(csvPath, 'utf8'));
  const studentIdColumnIndex = rows[0]?.findIndex((value) => normalizeStudentId(value) === '管理ID') ?? -1;
  if (studentIdColumnIndex < 0) {
    throw new Error(`No 管理ID column found in ${csvPath}`);
  }

  const studentIds = new Set<string>();
  for (const row of rows.slice(1)) {
    const studentId = normalizeStudentId(row[studentIdColumnIndex]);
    if (studentId) {
      studentIds.add(studentId);
    }
  }

  if (studentIds.size === 0) {
    throw new Error(`No valid student IDs found in ${csvPath}`);
  }
  return studentIds;
}

function normalizeStudentId(value: string | undefined): string {
  return (
    value
      ?.trim()
      .replace(/^\uFEFF/, '')
      .toUpperCase() ?? ''
  );
}

function parseCsvRows(content: string): string[][] {
  return parse(content, {
    bom: true,
    skip_empty_lines: true,
  }) as string[][];
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
