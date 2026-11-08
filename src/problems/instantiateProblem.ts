import { extractBlanks } from './fillInBlank/blanks';
import { type InstantiatedProblem, instantiateTemplate } from './instantiateTemplate';
import { getProblemProgram } from './problemData';

export type { InstantiatedProblem } from './instantiateTemplate';

export function isFillInBlankProblem(problemId: string): boolean {
  return extractBlanks(getProblemProgram(problemId) ?? '').answers.length > 0;
}

export function instantiateProblem(problemId: string, variableSeed: string): InstantiatedProblem | undefined {
  const template = getProblemProgram(problemId);
  if (!template) return;
  return instantiateTemplate(template, variableSeed);
}
