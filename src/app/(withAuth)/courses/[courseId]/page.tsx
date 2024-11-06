import type { NextPage } from 'next';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';

import { CoursePageOnClient } from './pageOnClient';

import { logger } from '@/infrastructures/pino';
import { prisma } from '@/infrastructures/prisma';
import type { CourseId } from '@/problems/problemData';
import { courseIdToLectureIds } from '@/problems/problemData';
import { getNonNullableSessionOnServer } from '@/utils/session';

type Props = { params: Promise<{ courseId: CourseId }> };

const CoursePage: NextPage<Props> = async (props) => {
  const session = await getNonNullableSessionOnServer(await cookies());

  const params = await props.params;
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

export default CoursePage;
