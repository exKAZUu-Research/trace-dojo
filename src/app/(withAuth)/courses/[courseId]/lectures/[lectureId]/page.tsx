import type { NextPage } from 'next';
import { notFound, redirect } from 'next/navigation';
import React from 'react';

import { prisma } from '../../../../../../infrastructures/prisma';
import type { CourseId } from '../../../../../../problems/problemData';
import { courseIdToLectureIds } from '../../../../../../problems/problemData';
import {
  fetchUserLectureCompletedProblems,
  fetchUserLectureProblemSessionWithAnswer,
} from '../../../../../../utils/fetch';
import { getNullableSessionOnServer } from '../../../../../../utils/session';

import { Lecture } from './Lecture';

const LecturePage: NextPage<{ params: { courseId: CourseId; lectureId: string } }> = async ({ params }) => {
  const { session } = await getNullableSessionOnServer();
  if (!session) redirect('/auth');

  const user = await prisma.user.findUnique({
    where: {
      id: session.superTokensUserId,
    },
  });
  if (!user) redirect('/auth');

  const { courseId, lectureId } = params;
  if (!(courseId in courseIdToLectureIds)) notFound();
  const lectureIndex = courseIdToLectureIds[courseId].indexOf(lectureId);
  if (lectureIndex === -1) notFound();

  const userCompletedProblems = await fetchUserLectureCompletedProblems(user.id, courseId, lectureId);
  const userProblemSessions = await fetchUserLectureProblemSessionWithAnswer(user.id, lectureId);

  return (
    <Lecture
      courseId={courseId}
      lectureId={lectureId}
      lectureIndex={lectureIndex}
      userCompletedProblems={userCompletedProblems}
      userProblemSessions={userProblemSessions}
    />
  );
};

export default LecturePage;
