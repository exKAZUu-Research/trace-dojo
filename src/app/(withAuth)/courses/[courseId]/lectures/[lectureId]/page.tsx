import type { NextPage } from 'next';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import React from 'react';

import { Lecture } from './pageOnClient';

import { prisma } from '@/infrastructures/prisma';
import type { CourseId } from '@/problems/problemData';
import { courseIdToLectureIds } from '@/problems/problemData';
import { getNonNullableSessionOnServer } from '@/utils/session';

type Props = { params: Promise<{ courseId: CourseId; lectureId: string }> };

const LecturePage: NextPage<Props> = async (props) => {
  const session = await getNonNullableSessionOnServer(await cookies());

  const params = await props.params;
  if (!(params.courseId in courseIdToLectureIds)) notFound();

  const lectureIndex = courseIdToLectureIds[params.courseId].indexOf(params.lectureId);
  if (lectureIndex === -1) notFound();

  const currentUserProblemSessions = await prisma.problemSession.findMany({
    orderBy: { createdAt: 'asc' },
    select: {
      problemId: true,
      completedAt: true,
      submissions: { select: { isCorrect: true } },
    },
    where: { userId: session.superTokensUserId, courseId: params.courseId, lectureId: params.lectureId },
  });

  return <Lecture lectureIndex={lectureIndex} problemSessions={currentUserProblemSessions} />;
};

export default LecturePage;
