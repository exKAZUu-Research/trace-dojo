import { courseIdToLectureIds, type CourseId } from '../problemData';
import { extractBlanks } from '../fillInBlank/blanks';
import { beginner1PracticeDefinitions } from './beginner1';
import { beginner2PracticeDefinitions } from './beginner2';
import { testPracticeDefinitions } from './test';
import type { PracticeDefinition } from './types';

const courseDefinitions: Record<CourseId, PracticeDefinition[]> = {
  tuBeginner1: beginner1PracticeDefinitions,
  tuBeginner2: beginner2PracticeDefinitions,
  test: testPracticeDefinitions,
};
export const practiceDefinitions = Object.values(courseDefinitions).flat();
export const practiceIdToDefinition: Record<string, PracticeDefinition> = Object.fromEntries(
  practiceDefinitions.map((definition) => [definition.id, definition])
);

export function getPracticeProblemIds(courseId: string, lectureId: string): string[] {
  if (!Object.hasOwn(courseDefinitions, courseId) || !Object.hasOwn(courseIdToLectureIds, courseId)) return [];
  const lectureIndex = courseIdToLectureIds[courseId as CourseId].indexOf(lectureId);
  if (lectureIndex === -1) return [];
  const definitions = courseDefinitions[courseId as CourseId].filter((item) => item.lectureIndex === lectureIndex);
  for (const definition of definitions) {
    if (Object.values(definition.program).some((source) => extractBlanks(source).answers.length > 0)) {
      throw new Error(`Practice definition contains blanks: ${definition.id}`);
    }
  }
  return definitions.map((item) => item.id);
}
