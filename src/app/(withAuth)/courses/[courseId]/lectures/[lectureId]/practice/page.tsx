import { notFound } from 'next/navigation';

import { type MyAuthorizedNextPageOrLayout, withAuthorizationOnServer } from '@/app/utils/withAuth';
import { type CourseId, courseIdToLectureIds } from '@/problems/problemData';

import { PracticePageOnClient } from './pageOnClient';

const PracticePage: MyAuthorizedNextPageOrLayout<{ courseId: CourseId; lectureId: string }> = ({ params }) => {
  if (
    !Object.hasOwn(courseIdToLectureIds, params.courseId) ||
    !courseIdToLectureIds[params.courseId]?.includes(params.lectureId)
  )
    notFound();
  return <PracticePageOnClient key={`${params.courseId}:${params.lectureId}`} />;
};

export default withAuthorizationOnServer(PracticePage);
