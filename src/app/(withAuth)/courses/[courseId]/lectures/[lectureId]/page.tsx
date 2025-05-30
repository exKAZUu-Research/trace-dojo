import { notFound } from 'next/navigation';

import { Lecture } from './pageOnClient';

import { withAuthorizationOnServer } from '@/app/utils/withAuth';
import type { MyAuthorizedNextPageOrLayout } from '@/app/utils/withAuth';
import { prisma } from '@/infrastructures/prisma';
import type { CourseId } from '@/problems/problemData';
import { courseIdToLectureIds } from '@/problems/problemData';

const LecturePage: MyAuthorizedNextPageOrLayout<{ courseId: CourseId; lectureId: string }> = async ({
  params,
  session,
}) => {
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

export default withAuthorizationOnServer(LecturePage);
