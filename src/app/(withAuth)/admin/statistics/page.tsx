import { logger } from '../../../../infrastructures/pino';
import { prisma } from '../../../../infrastructures/prisma';
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
  for (const courseId of Object.keys(courseIdToLectureIndexToProblemIds) as CourseId[]) {
    for (const [lectureIndex, problemIds] of courseIdToLectureIndexToProblemIds[courseId].entries()) {
      for (const problemId of problemIds) {
        try {
          const userCount = (
            await prisma.problemSession.groupBy({
              by: ['userId'],
              where: { problemId },
            })
          ).length; // eslint-disable-line unicorn/no-await-expression-member
          const completedUserCount = (
            await prisma.problemSession.groupBy({
              by: ['userId'],
              // eslint-disable-next-line unicorn/no-null
              where: { problemId, completedAt: { not: null } },
            })
          ).length; // eslint-disable-line unicorn/no-await-expression-member

          const firstCompletedSessions = await prisma.problemSession.findMany({
            // eslint-disable-next-line unicorn/no-null
            where: { problemId, completedAt: { not: null } },
            orderBy: { completedAt: 'asc' },
            distinct: ['userId'] as const,
            select: {
              elapsedMilliseconds: true,
              submissions: {
                where: { isCorrect: false },
                select: { id: true },
              },
            },
          });

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
          logger.error(`Failed to calculate statistics of ${problemId}: %o`, error);
        }
      }
    }
  }
  return statistics;
}

export default withAuthorizationOnServer(StatisticsPage, { admin: true });
