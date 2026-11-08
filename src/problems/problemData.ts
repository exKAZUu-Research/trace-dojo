export * from './courses/definitions';
import { ordinaryPrograms } from './catalog/java/regular';

export const problemIdToProgram = ordinaryPrograms;

export function getProblemProgram(problemId: string): string | undefined {
  return problemIdToProgram[problemId];
}
