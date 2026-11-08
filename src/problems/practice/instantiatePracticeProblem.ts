import { type InstantiatedProblem, instantiateTemplate } from '../instantiateTemplate';
import { practiceIdToDefinition } from './definitions';

export function instantiatePracticeProblem(problemId: string, variableSeed: string): InstantiatedProblem | undefined {
  if (!Object.hasOwn(practiceIdToDefinition, problemId)) return;
  const problem = instantiateTemplate(practiceIdToDefinition[problemId].program, variableSeed);
  return problem.blankAnswers.length === 0 ? problem : undefined;
}
