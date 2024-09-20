import type { NextPage } from 'next';
import { notFound, redirect } from 'next/navigation';
import React from 'react';

import { prisma } from '../../../../../infrastructures/prisma';
import type { CourseId } from '../../../../../problems/problemData';
import { UUIDs } from '../../../../../problems/problemData';
import {
  fetchUserLectureCompletedProblems,
  fetchUserLectureProblemSessionWithAnswer,
} from '../../../../../utils/fetch';
import { getNullableSessionOnServer } from '../../../../../utils/session';

import { LectureCard } from './LectureCard';

const LecturePage: NextPage<{ params: { courseId: CourseId; lectureId: string } }> = async ({ params }) => {
  const { session } = await getNullableSessionOnServer();
  if (!session) return redirect('/auth');

  const user = await prisma.user.findUnique({
    where: {
      id: session.superTokensUserId,
    },
  });
  if (!user) return redirect('/auth');

  const { courseId, lectureId } = params;
  const uuid = lectureId.split('-').slice(1).join('-');
  const lectureNumberMatch = lectureId.match(/lecture(\d+)/);
  const lectureNumber = lectureNumberMatch ? Number(lectureNumberMatch[1]) : undefined;
  if (!lectureNumber || UUIDs[lectureNumber - 1] !== uuid) return notFound();

  const userCompletedProblems = await fetchUserLectureCompletedProblems(user.id, courseId, lectureId);
  const userProblemSessions = await fetchUserLectureProblemSessionWithAnswer(user.id, lectureId);

  return (
    <LectureCard
      courseId={courseId}
      lectureId={lectureId}
      lectureNumber={lectureNumber}
      userCompletedProblems={userCompletedProblems}
      userProblemSessions={userProblemSessions}
    />
  );
};

export default LecturePage;
