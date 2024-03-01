import type { NextPage } from 'next';
import { redirect } from 'next/navigation';

import { prisma } from '../../../../infrastructures/prisma';
import { getNullableSessionOnServer } from '../../../../utils/session';
import { fetchUserCompletedProblems } from '../../../lib/actions';

import { Course } from './Course';

const CoursePage: NextPage<{ params: { courseId: string } }> = async ({ params }) => {
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

  return <Course courseId={params.courseId} userCompletedProblems={userCompletedProblems} />;
};

export default CoursePage;
