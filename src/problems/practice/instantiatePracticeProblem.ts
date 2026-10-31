import { type InstantiatedProblem, instantiateTemplate } from '../instantiateTemplate';
import type { LanguageId } from '../problemData';
import { practiceIdToDefinition } from './definitions';

export function instantiatePracticeProblem(
  problemId: string,
  languageId: LanguageId,
  variableSeed: string
): InstantiatedProblem | undefined {
  if (!Object.hasOwn(practiceIdToDefinition, problemId)) return;
  const problem = instantiateTemplate(practiceIdToDefinition[problemId].program, languageId, variableSeed);
  return problem.blankAnswers.length === 0 ? problem : undefined;
}
