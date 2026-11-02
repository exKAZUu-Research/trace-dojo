import { notFound } from 'next/navigation';

import { withAuthorizationOnServer } from '@/app/utils/withAuth';
import type { MyAuthorizedNextPageOrLayout } from '@/app/utils/withAuth';
import { db } from '@/infrastructures/database';
import { logger } from '@/infrastructures/pino';
import { getLearningPeriodFilter } from '@/learningPeriod';
import type { CourseId } from '@/problems/problemData';
import { courseIdToLectureIds } from '@/problems/problemData';

import { CoursePageOnClient } from './pageOnClient';

const CoursePage: MyAuthorizedNextPageOrLayout<{ courseId: CourseId }> = async ({ params, session }) => {
  if (!(params.courseId in courseIdToLectureIds)) notFound();

  const periodFilter = getLearningPeriodFilter();
  const currentUserProblemSessions = await db.query.problemSessions.findMany({
    orderBy: { completedAt: 'desc' },
    columns: { problemId: true, completedAt: true },
    where: { ...periodFilter, userId: session.superTokensUserId, courseId: params.courseId },
  });
  logger.trace('currentUserProblemSessions: %o', currentUserProblemSessions);

  return (
    <CoursePageOnClient
      learningPeriodStart={periodFilter.createdAt?.gte.toISOString()}
      currentUserCompletedProblemIdSet={
        new Set(currentUserProblemSessions.filter((s) => s.completedAt).map((s) => s.problemId))
      }
      currentUserStartedProblemIdSet={new Set(currentUserProblemSessions.map((s) => s.problemId))}
    />
  );
};

export default withAuthorizationOnServer(CoursePage);
