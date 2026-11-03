import { traceProgram } from '../../interpreter/program';
import type { InstantiatedProblem } from '../instantiateProblem';
import { challengeBases } from './definitions';

export const instantiateRegularChallenge = (problemId: string): InstantiatedProblem | undefined => {
  const base = challengeBases.find(({ id }) => id === problemId);
  if (!base) return;
  return {
    ...traceProgram('java', base.java, base.java),
    blankAnswers: [],
    displayProgramTemplate: base.java,
  };
};
