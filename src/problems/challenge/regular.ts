import type { InstantiatedProblem } from '../instantiateProblem';
import { traceProgram } from '../traceProgram';
import { challengeRegularPrograms } from './regularPrograms';

export const instantiateRegularChallenge = (problemId: string): InstantiatedProblem | undefined => {
  const source = challengeRegularPrograms[problemId];
  if (!source) return;
  return {
    ...traceProgram(source.instrumented, source.java, 'java'),
    blankAnswers: [],
    displayProgramTemplate: source.java,
    instrumentedTemplate: source.instrumented,
  };
};
