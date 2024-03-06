import type { NextPage } from 'next';
import { redirect } from 'next/navigation';

import { prisma } from '../../../../infrastructures/prisma';
import type { CourseId } from '../../../../problems/problemData';
import { getNullableSessionOnServer } from '../../../../utils/session';
import { fetchUserCompletedProblems, fetchUserProblemSessions } from '../../../lib/actions';

import { Course } from './Course';

const CoursePage: NextPage<{ params: { courseId: CourseId } }> = async ({ params }) => {
  const { session } = await getNullableSessionOnServer();
  const user =
    session &&
    (await prisma.user.findUnique({
      where: {
        id: session.getUserId(),
      },
    }));

  if (!user) {
    return redirect('/auth');
  }

  const courseId = params.courseId;
  const userCompletedProblems = await fetchUserCompletedProblems(user.id, courseId);
  const userProblemSessions = await fetchUserProblemSessions({ userId: user.id });

  return (
    <Course
      courseId={params.courseId}
      userCompletedProblems={userCompletedProblems}
      userProblemSessions={userProblemSessions}
    />
  );
};

export default CoursePage;
