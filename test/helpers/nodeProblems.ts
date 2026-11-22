import { executeProgram, traceProgram } from '../../src/interpreter/program';
import { challengeBases } from '../../src/problems/challenge/definitions';
import { type InstantiatedProblem, instantiateTemplate } from '../../src/problems/instantiateTemplate';
import { practiceIdToDefinition } from '../../src/problems/practice/definitions';
import { getProblemProgram } from '../../src/problems/problemData';
import type { ProblemRunner } from '../../src/problems/problemRunner';

/** Runs programs in this process as the interpreter worker runs them in a browser. */
export const nodeRunner: ProblemRunner = {
  // oxlint-disable-next-line typescript/require-await -- The worker's runner is asynchronous.
  traceProgram: async (language, program, displayProgram, input) =>
    traceProgram(language, program, displayProgram, input),
  // oxlint-disable-next-line typescript/require-await -- The worker's runner is asynchronous.
  executeProgram: async (language, source, input) => executeProgram(language, source, input),
};

/** Instantiates a problem as a browser does from the template the server sends for it. */
export async function instantiateProblem(problemId: string, variableSeed: string): Promise<InstantiatedProblem> {
  return await instantiateTemplate(nodeRunner, getProgramTemplate(problemId), variableSeed);
}

export function getProgramTemplate(problemId: string): string {
  const template =
    getProblemProgram(problemId) ??
    (Object.hasOwn(practiceIdToDefinition, problemId) ? practiceIdToDefinition[problemId].program : undefined) ??
    challengeBases.find(({ id }) => id === problemId)?.java;
  if (!template) throw new Error(`Unknown problem: ${problemId}`);
  return template;
}
