import type { NextPage } from 'next';
import { redirect } from 'next/navigation';

import { prisma } from '../../../../infrastructures/prisma';
import type { CourseId } from '../../../../problems/problemData';
import { fetchUserCompletedProblems, fetchUserProblemSessionsWithUserAnswer } from '../../../../utils/fetch';
import { getNullableSessionOnServer } from '../../../../utils/session';

import { Course } from './Course';

const CoursePage: NextPage<{ params: { courseId: CourseId } }> = async ({ params }) => {
  const { session } = await getNullableSessionOnServer();
  if (!session) return redirect('/auth');

  const user = await prisma.user.findUnique({
    where: {
      id: session.superTokensUserId,
    },
  });
  if (!user) return redirect('/auth');

  const courseId = params.courseId;
  const userCompletedProblems = await fetchUserCompletedProblems(user.id, courseId);
  const userProblemSessions = await fetchUserProblemSessionsWithUserAnswer(user.id);
  console.log('userCompletedProblems:', userCompletedProblems);
  console.log('userProblemSessions:', userProblemSessions);

  return (
    <Course
      courseId={params.courseId}
      userCompletedProblems={userCompletedProblems}
      userProblemSessions={userProblemSessions}
    />
  );
};

export default CoursePage;
