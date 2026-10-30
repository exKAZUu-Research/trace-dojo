import { courseIdToLectureIds, type CourseId } from '../problemData';

const retiredDefinitions: Record<string, { courseId: CourseId; lectureIndex: number }> = {
  practiceBeginner1L1A: { courseId: 'tuBeginner1', lectureIndex: 0 },
  practiceBeginner1L1B: { courseId: 'tuBeginner1', lectureIndex: 0 },
  practiceBeginner1L2A: { courseId: 'tuBeginner1', lectureIndex: 1 },
  practiceBeginner1L2B: { courseId: 'tuBeginner1', lectureIndex: 1 },
  practiceBeginner1L3A: { courseId: 'tuBeginner1', lectureIndex: 2 },
  practiceBeginner1L3B: { courseId: 'tuBeginner1', lectureIndex: 2 },
  practiceBeginner1L4A: { courseId: 'tuBeginner1', lectureIndex: 3 },
  practiceBeginner1L4B: { courseId: 'tuBeginner1', lectureIndex: 3 },
  practiceBeginner1L5A: { courseId: 'tuBeginner1', lectureIndex: 4 },
  practiceBeginner1L5B: { courseId: 'tuBeginner1', lectureIndex: 4 },
  practiceBeginner1L6A: { courseId: 'tuBeginner1', lectureIndex: 5 },
  practiceBeginner1L6B: { courseId: 'tuBeginner1', lectureIndex: 5 },
  practiceBeginner1L7A: { courseId: 'tuBeginner1', lectureIndex: 6 },
  practiceBeginner1L7B: { courseId: 'tuBeginner1', lectureIndex: 6 },
  practiceBeginner1L8A: { courseId: 'tuBeginner1', lectureIndex: 7 },
  practiceBeginner1L8B: { courseId: 'tuBeginner1', lectureIndex: 7 },
  practiceBeginner2L1A: { courseId: 'tuBeginner2', lectureIndex: 0 },
  practiceBeginner2L1B: { courseId: 'tuBeginner2', lectureIndex: 0 },
  practiceBeginner2L2A: { courseId: 'tuBeginner2', lectureIndex: 1 },
  practiceBeginner2L2B: { courseId: 'tuBeginner2', lectureIndex: 1 },
  practiceBeginner2L3A: { courseId: 'tuBeginner2', lectureIndex: 2 },
  practiceBeginner2L3B: { courseId: 'tuBeginner2', lectureIndex: 2 },
  practiceBeginner2L4A: { courseId: 'tuBeginner2', lectureIndex: 3 },
  practiceBeginner2L4B: { courseId: 'tuBeginner2', lectureIndex: 3 },
  practiceBeginner2L5A: { courseId: 'tuBeginner2', lectureIndex: 4 },
  practiceBeginner2L5B: { courseId: 'tuBeginner2', lectureIndex: 4 },
  practiceBeginner2L5C: { courseId: 'tuBeginner2', lectureIndex: 4 },
  practiceBeginner2L6A: { courseId: 'tuBeginner2', lectureIndex: 5 },
  practiceBeginner2L6B: { courseId: 'tuBeginner2', lectureIndex: 5 },
  practiceBeginner2L6C: { courseId: 'tuBeginner2', lectureIndex: 5 },
  practiceBeginner2L7A: { courseId: 'tuBeginner2', lectureIndex: 6 },
  practiceBeginner2L7B: { courseId: 'tuBeginner2', lectureIndex: 6 },
  practiceBeginner2L8A: { courseId: 'tuBeginner2', lectureIndex: 7 },
  practiceBeginner2L8B: { courseId: 'tuBeginner2', lectureIndex: 7 },
  practiceTestL1A: { courseId: 'test', lectureIndex: 0 },
  practiceTestL1B: { courseId: 'test', lectureIndex: 0 },
};

export const isRetiredPracticeProblem = (problemId: string, courseId: string, lectureId: string): boolean => {
  if (!Object.hasOwn(retiredDefinitions, problemId)) return false;
  const retired = retiredDefinitions[problemId];
  return retired.courseId === courseId && courseIdToLectureIds[retired.courseId]?.[retired.lectureIndex] === lectureId;
};
