import { logger } from '../../../../../infrastructures/pino';
import { db } from '../../../../../infrastructures/database';
import { Box, Heading, Table, Tbody, Td, Th, Thead, Tr, VStack } from '../../../../../infrastructures/useClient/chakra';
import type { CourseId, ProblemId } from '../../../../../problems/problemData';
import { courseIdToLectureIds } from '../../../../../problems/problemData';
import { getEmailFromSession } from '../../../../../utils/session';
import { dayjs } from '../../../../utils/dayjs';

import type { MyAuthorizedNextPageOrLayout } from '@/app/utils/withAuth';
import { withAuthorizationOnServer } from '@/app/utils/withAuth';
import { getLearningPeriodFilter } from '@/learningPeriod';

interface UserProblemInfo {
  userId: string;
  email?: string;
  courseId: string;
  lectureIndex: number;
  problemId: string;
  completedAt: Date | null;
  elapsedMilliseconds: number;
  incorrectSubmissionCount: number;
}

const StatisticsPage: MyAuthorizedNextPageOrLayout<{ problemId: ProblemId }> = async ({ params }) => {
  const userInfos = await fetchUserProblemInfo(params.problemId);

  return (
    <VStack align="stretch" spacing={6}>
      <Heading as="h1">問題: {params.problemId}</Heading>
      <Box overflowX="auto">
        <Table size="sm">
          <Thead>
            <Tr>
              <Th>ユーザーID</Th>
              <Th>Email</Th>
              <Th>コース</Th>
              <Th>講義</Th>
              <Th>完了日時</Th>
              <Th>所要時間</Th>
              <Th>不正解回数</Th>
            </Tr>
          </Thead>
          <Tbody>
            {userInfos.map((info) => (
              <Tr key={info.userId}>
                <Td>{info.userId}</Td>
                <Td>{info.email || 'N/A'}</Td>
                <Td>{info.courseId}</Td>
                <Td>{info.lectureIndex + 1}</Td>
                <Td>{info.completedAt ? dayjs(info.completedAt).format('YYYY-MM-DD HH:mm:ss') : '未完了'}</Td>
                <Td>{info.elapsedMilliseconds ? dayjs.duration(info.elapsedMilliseconds).humanize() : 'N/A'}</Td>
                <Td>{info.incorrectSubmissionCount}</Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      </Box>
    </VStack>
  );
};

async function fetchUserProblemInfo(problemId: ProblemId): Promise<UserProblemInfo[]> {
  try {
    const sessions = await db.query.problemSessions.findMany({
      where: {
        ...getLearningPeriodFilter(),
        problemId,
        completedAt: { isNotNull: true },
        submissions: { isCorrect: true },
      },
      orderBy: {
        completedAt: 'asc',
      },
      with: {
        submissions: { where: { isCorrect: false }, columns: { id: true } },
      },
    });

    return await Promise.all(
      sessions
        .filter((session, index) => sessions.findIndex((candidate) => candidate.userId === session.userId) === index)
        .map(async (session) => ({
          userId: session.userId,
          email: await getEmailFromSession(session.userId),
          courseId: session.courseId,
          lectureIndex: getLectureIndex(session.courseId, session.lectureId),
          problemId: session.problemId,
          completedAt: session.completedAt,
          elapsedMilliseconds: session.elapsedMilliseconds,
          incorrectSubmissionCount: session.submissions.length,
        }))
    );
  } catch (error) {
    logger.error(`Failed to fetch user problem info for ${problemId}: %o`, error as object);
    return [];
  }
}

function getLectureIndex(courseId: string, lectureId: string): number {
  const lectureIds = courseIdToLectureIds[courseId as CourseId];
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (lectureIds?.length === 0) {
    logger.warn(`Course (${courseId}) not found.`);
    return -1;
  }
  for (const [index, lectureId_] of lectureIds.entries()) {
    if (lectureId_.includes(lectureId)) {
      return index;
    }
  }
  logger.warn(`Lecture (${lectureId}) not found in course (${courseId}).`);
  return -1;
}

export default withAuthorizationOnServer(StatisticsPage, { admin: true });
