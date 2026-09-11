export function getLectureStorageKey(
  courseId: string,
  lectureIndex: number,
  userId: string,
  learningPeriodStart?: string
): string {
  const key = `trace-dojo.${courseId}.${lectureIndex}.${userId}`;
  return learningPeriodStart ? `${key}.${learningPeriodStart}` : key;
}
