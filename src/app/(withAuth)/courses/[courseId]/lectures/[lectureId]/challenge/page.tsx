import { notFound } from 'next/navigation';

import { ChallengePageOnClient } from './pageOnClient';

import { withAuthorizationOnServer, type MyAuthorizedNextPageOrLayout } from '@/app/utils/withAuth';
import { courseIdToLectureIds, type CourseId } from '@/problems/problemData';

const ChallengePage: MyAuthorizedNextPageOrLayout<
  { courseId: CourseId; lectureId: string },
  { format?: string | string[] }
> = ({ params, searchParams }) => {
  if (!(params.courseId in courseIdToLectureIds) || !courseIdToLectureIds[params.courseId]?.includes(params.lectureId))
    notFound();
  const initialFormat =
    searchParams.format === 'regular' || searchParams.format === 'fillInBlank' ? searchParams.format : undefined;
  return <ChallengePageOnClient key={`${params.courseId}:${params.lectureId}`} initialFormat={initialFormat} />;
};

export default withAuthorizationOnServer(ChallengePage);
