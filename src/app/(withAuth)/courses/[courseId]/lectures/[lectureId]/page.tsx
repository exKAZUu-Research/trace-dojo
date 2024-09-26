import type { NextPage } from 'next';
import { notFound, redirect } from 'next/navigation';
import React from 'react';

import { prisma } from '../../../../../../infrastructures/prisma';
import type { CourseId } from '../../../../../../problems/problemData';
import { courseIdToLectureIds } from '../../../../../../problems/problemData';
import { getNullableSessionOnServer } from '../../../../../../utils/session';

import { Lecture } from './pageOnClient';

type Props = { params: { courseId: CourseId; lectureId: string } };

const LecturePage: NextPage<Props> = async (props) => {
  const { session } = await getNullableSessionOnServer();
  if (!session) redirect('/auth');

  if (!(props.params.courseId in courseIdToLectureIds)) notFound();

  const lectureIndex = courseIdToLectureIds[props.params.courseId].indexOf(props.params.lectureId);
  if (lectureIndex === -1) notFound();

  const currentUserProblemSessions = await prisma.problemSession.findMany({
    orderBy: { createdAt: 'asc' },
    select: {
      problemId: true,
      completedAt: true,
      submissions: { select: { isCorrect: true } },
    },
    where: { userId: session.superTokensUserId, courseId: props.params.courseId, lectureId: props.params.lectureId },
  });

  return <Lecture lectureIndex={lectureIndex} params={props.params} problemSessions={currentUserProblemSessions} />;
};

export default LecturePage;
