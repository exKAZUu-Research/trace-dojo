import { notFound } from 'next/navigation';

import { CoursePageOnClient } from './pageOnClient';

import { withAuthorizationOnServer } from '@/app/utils/withAuth';
import type { MyAuthorizedNextPageOrLayout } from '@/app/utils/withAuth';
import { logger } from '@/infrastructures/pino';
import { prisma } from '@/infrastructures/prisma';
import type { CourseId } from '@/problems/problemData';
import { courseIdToLectureIds } from '@/problems/problemData';

const CoursePage: MyAuthorizedNextPageOrLayout<{ courseId: CourseId }> = async ({ params, session }) => {
  if (!(params.courseId in courseIdToLectureIds)) notFound();

  const currentUserProblemSessions = await prisma.problemSession.findMany({
    distinct: ['problemId'],
    orderBy: { completedAt: 'desc' },
    select: { problemId: true, completedAt: true },
    where: { userId: session.superTokensUserId, courseId: params.courseId },
  });
  logger.trace('currentUserProblemSessions: %o', currentUserProblemSessions);

  return (
    <CoursePageOnClient
      currentUserCompletedProblemIdSet={
        new Set(currentUserProblemSessions.filter((s) => s.completedAt).map((s) => s.problemId))
      }
      currentUserStartedProblemIdSet={new Set(currentUserProblemSessions.map((s) => s.problemId))}
    />
  );
};

export default withAuthorizationOnServer(CoursePage);
