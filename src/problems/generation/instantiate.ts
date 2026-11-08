import { Random } from '../../app/utils/random';
import { challengeBases } from '../catalog/java/definitions';
import { selectorsFor } from '../courses/generationPolicies';
import { getProblemProgram } from '../problemData';
import { generateJavaExercise } from './languages/java/generate';
import type { ChallengeFormat } from './types';

export function instantiateGeneratedChallenge(
  problemId: string,
  seed: string,
  format: ChallengeFormat,
  courseId: string,
  lectureIndex: number
): ReturnType<typeof generateJavaExercise> {
  const template = getProblemProgram(problemId) ?? challengeBases.find((base) => base.id === problemId)?.java;
  if (!template) throw new Error(`Unknown source problem: ${problemId}`);
  const random = new Random(seed);
  const source = template.replaceAll(/<(\d+)-(\d+)>/g, (_, min: string, max: string) =>
    random.getInteger(Number(min), Number(max)).toString()
  );
  return generateJavaExercise({ source, seed, format, selectors: selectorsFor(courseId, lectureIndex) });
}
