import { notFound } from 'next/navigation';
import { PracticePageOnClient } from './pageOnClient';
import { withAuthorizationOnServer, type MyAuthorizedNextPageOrLayout } from '@/app/utils/withAuth';
import { courseIdToLectureIds, type CourseId } from '@/problems/problemData';

const PracticePage: MyAuthorizedNextPageOrLayout<{ courseId: CourseId; lectureId: string }> = ({ params }) => {
  if (
    !Object.hasOwn(courseIdToLectureIds, params.courseId) ||
    !courseIdToLectureIds[params.courseId]?.includes(params.lectureId)
  )
    notFound();
  return <PracticePageOnClient key={`${params.courseId}:${params.lectureId}`} />;
};

export default withAuthorizationOnServer(PracticePage);
