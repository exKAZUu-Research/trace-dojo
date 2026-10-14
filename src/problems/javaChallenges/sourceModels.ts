import type { JavaChallengeDefinition } from './types';

export type SourceJavaModel = Pick<
  JavaChallengeDefinition,
  'title' | 'lectureIndex' | 'correctProgram' | 'finalBoard' | 'finalTurtles'
> & {
  courseId: 'tuBeginner1' | 'tuBeginner2';
  sourceProblemId: string;
  authoringSeed: string;
};

export const replaceSourceOnce = (program: string, before: string, after: string): string => {
  if (!before) throw new Error('Source edit requires a nonempty literal match');
  const index = program.indexOf(before);
  if (index === -1) throw new Error(`Source edit literal was not found: ${JSON.stringify(before)}`);
  if (program.includes(before, index + 1))
    throw new Error(`Source edit literal is ambiguous; include unique surrounding context: ${JSON.stringify(before)}`);
  return program.slice(0, index) + after + program.slice(index + before.length);
};
