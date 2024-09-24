import type { NextPage } from 'next';
import { notFound, redirect } from 'next/navigation';

import { prisma } from '../../../../infrastructures/prisma';
import type { CourseId } from '../../../../problems/problemData';
import { courseIdToLectureIds } from '../../../../problems/problemData';
import { getNullableSessionOnServer } from '../../../../utils/session';

import { CoursePageOnClient } from './pageOnClient';

type Props = { params: { courseId: CourseId } };

const CoursePage: NextPage<Props> = async (props) => {
  const { session } = await getNullableSessionOnServer();
  if (!session) redirect('/auth');

  if (!(props.params.courseId in courseIdToLectureIds)) notFound();

  const currentUserCompletedProblemSessions = await prisma.problemSession.findMany({
    distinct: ['problemId'],
    // eslint-disable-next-line unicorn/no-null
    where: { userId: session.superTokensUserId, courseId: props.params.courseId, completedAt: { not: null } },
    select: { problemId: true },
  });
  const currentUserCompletedProblemIdSet = new Set(currentUserCompletedProblemSessions.map((s) => s.problemId));

  const currentUserProblemSessions = await prisma.problemSession.findMany({
    orderBy: { createdAt: 'asc' },
    select: { answers: true },
    where: { userId: session.superTokensUserId },
  });

  console.trace('currentUserCompletedProblemIdSet:', currentUserCompletedProblemIdSet.values());
  console.trace('currentUserProblemSessions:', currentUserProblemSessions);

  return (
    <CoursePageOnClient
      currentUserCompletedProblemIdSet={currentUserCompletedProblemIdSet}
      currentUserProblemSessions={currentUserProblemSessions}
      params={props.params}
    />
  );
};

export default CoursePage;
