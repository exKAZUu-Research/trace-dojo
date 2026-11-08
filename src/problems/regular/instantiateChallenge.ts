import { traceProgram } from '../../interpreter/program';
import { challengeBases } from '../catalog/java/definitions';
import type { InstantiatedProblem } from '../instantiateProblem';

export const instantiateRegularChallenge = (problemId: string): InstantiatedProblem | undefined => {
  const base = challengeBases.find(({ id }) => id === problemId);
  if (!base) return;
  return {
    ...traceProgram('java', base.java, base.java),
    blankAnswers: [],
    displayProgramTemplate: base.java,
  };
};
