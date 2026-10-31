import { extractBlanks } from './fillInBlank/blanks';
import { type InstantiatedProblem, instantiateTemplate } from './instantiateTemplate';
import { type LanguageId, type ProblemId, problemIdToLanguageIdToProgram } from './problemData';

export type { InstantiatedProblem } from './instantiateTemplate';

export function isFillInBlankProblem(problemId: string): boolean {
  if (!Object.hasOwn(problemIdToLanguageIdToProgram, problemId)) return false;
  return extractBlanks(problemIdToLanguageIdToProgram[problemId as ProblemId].java).answers.length > 0;
}

export function instantiateProblem(
  problemId: string,
  languageId: LanguageId,
  variableSeed: string
): InstantiatedProblem | undefined {
  if (!Object.hasOwn(problemIdToLanguageIdToProgram, problemId)) return;
  return instantiateTemplate(problemIdToLanguageIdToProgram[problemId as ProblemId], languageId, variableSeed);
}
