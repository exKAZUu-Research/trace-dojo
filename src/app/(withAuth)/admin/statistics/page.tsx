import { logger } from '../../../../infrastructures/pino';
import { db } from '../../../../infrastructures/database';
import {
  Box,
  Heading,
  Link,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
  VStack,
} from '../../../../infrastructures/useClient/chakra';
import type { CourseId } from '../../../../problems/problemData';
import { courseIdToLectureIndexToProblemIds } from '../../../../problems/problemData';
import { dayjs } from '../../../utils/dayjs';

import type { MyAuthorizedNextPageOrLayout } from '@/app/utils/withAuth';
import { withAuthorizationOnServer } from '@/app/utils/withAuth';
import { getLearningPeriodFilter } from '@/learningPeriod';

interface ProblemStatistics {
  courseId: string;
  lectureIndex: number;
  problemId: string;
  userCount: number;
  completedUserCount: number;
  avgElapsedMilliseconds: number;
  avgIncorrectCounts: number;
}

const StatisticsPage: MyAuthorizedNextPageOrLayout = async () => {
  const statistics = await calculateStatistics();

  return (
    <VStack align="stretch" spacing={6}>
      <Heading as="h1">各種統計値</Heading>
      <Box overflowX="auto">
        <Table size="sm">
          <Thead>
            <Tr>
              <Th>コース</Th>
              <Th>講義</Th>
              <Th>問題</Th>
              <Th>総ユーザー数</Th>
              <Th>完了ユーザー数</Th>
              <Th>平均所要時間</Th>
              <Th>平均不正解回数</Th>
            </Tr>
          </Thead>
          <Tbody>
            {statistics.map((stat) => (
              <Tr key={`${stat.courseId}-${stat.lectureIndex}-${stat.problemId}`}>
                <Td>{stat.courseId}</Td>
                <Td>{stat.lectureIndex + 1}</Td>
                <Td>
                  <Link href={`/admin/problems/${stat.problemId}`}>{stat.problemId}</Link>
                </Td>
                <Td>{stat.userCount}</Td>
                <Td>{stat.completedUserCount}</Td>
                <Td>{dayjs.duration(stat.avgElapsedMilliseconds).humanize()}</Td>
                <Td>{stat.avgIncorrectCounts.toFixed(1)}</Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      </Box>
    </VStack>
  );
};

async function calculateStatistics(): Promise<ProblemStatistics[]> {
  const statistics: ProblemStatistics[] = [];
  const periodFilter = getLearningPeriodFilter();
  for (const courseId of Object.keys(courseIdToLectureIndexToProblemIds) as CourseId[]) {
    for (const [lectureIndex, problemIds] of courseIdToLectureIndexToProblemIds[courseId].entries()) {
      for (const problemId of problemIds) {
        try {
          const sessions = await db.query.problemSessions.findMany({
            where: { ...periodFilter, problemId },
            orderBy: { completedAt: 'asc' },
            columns: { userId: true, completedAt: true, elapsedMilliseconds: true },
            with: { submissions: { where: { isCorrect: false }, columns: { id: true } } },
          });
          const userCount = new Set(sessions.map((session) => session.userId)).size;
          const completedSessions = sessions.filter((session) => session.completedAt);
          const completedUserCount = new Set(completedSessions.map((session) => session.userId)).size;
          const firstCompletedSessions = completedSessions.filter(
            (session, index) =>
              completedSessions.findIndex((candidate) => candidate.userId === session.userId) === index
          );

          const totalElapsed = firstCompletedSessions.reduce((acc, session) => acc + session.elapsedMilliseconds, 0);
          const avgElapsedMilliseconds =
            firstCompletedSessions.length > 0 ? totalElapsed / firstCompletedSessions.length : 0;

          const totalIncorrect = firstCompletedSessions.reduce((acc, session) => acc + session.submissions.length, 0);
          const avgIncorrectCounts =
            firstCompletedSessions.length > 0 ? totalIncorrect / firstCompletedSessions.length : 0;

          statistics.push({
            courseId,
            lectureIndex,
            problemId,
            userCount,
            completedUserCount,
            avgElapsedMilliseconds,
            avgIncorrectCounts,
          });
        } catch (error) {
          logger.error(`Failed to calculate statistics of ${problemId}: %o`, error as object);
        }
      }
    }
  }
  return statistics;
}

export default withAuthorizationOnServer(StatisticsPage, { admin: true });
