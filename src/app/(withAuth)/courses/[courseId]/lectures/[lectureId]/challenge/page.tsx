import { notFound } from 'next/navigation';

import { ChallengePageOnClient } from './pageOnClient';

import { withAuthorizationOnServer, type MyAuthorizedNextPageOrLayout } from '@/app/utils/withAuth';
import { courseIdToLectureIds, type CourseId } from '@/problems/problemData';

const ChallengePage: MyAuthorizedNextPageOrLayout<{ courseId: CourseId; lectureId: string }> = ({ params }) => {
  if (!(params.courseId in courseIdToLectureIds) || !courseIdToLectureIds[params.courseId]?.includes(params.lectureId))
    notFound();
  return <ChallengePageOnClient key={`${params.courseId}:${params.lectureId}`} />;
};

export default withAuthorizationOnServer(ChallengePage);
