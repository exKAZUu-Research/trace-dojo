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

  const currentUserProblemSessions = await prisma.problemSession.findMany({
    distinct: ['problemId'],
    orderBy: { completedAt: 'desc' },
    select: { problemId: true, completedAt: true },
    where: { userId: session.superTokensUserId, courseId: props.params.courseId },
  });
  console.trace('currentUserProblemSessions:', currentUserProblemSessions);

  return (
    <CoursePageOnClient
      currentUserCompletedProblemIdSet={
        new Set(currentUserProblemSessions.filter((s) => s.completedAt).map((s) => s.problemId))
      }
      currentUserStartedProblemIdSet={new Set(currentUserProblemSessions.map((s) => s.problemId))}
      params={props.params}
    />
  );
};

export default CoursePage;
