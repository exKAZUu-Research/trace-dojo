import type { InstantiatedProblem } from '../instantiateProblem';

/** The state of a regular exercise session, which changes as the learner answers within it. */
export interface RegularExerciseState {
  problemFormat: 'regular';
  sessionId: number;
  problemId: string;
  seed: string;
  problemType: 'executionResult' | 'step';
  traceItemIndex: number;
  completed: boolean;
}

export interface RegularExerciseDisplay extends RegularExerciseState {
  /** Generated on the server, where the Java interpreter runs. */
  problem: InstantiatedProblem;
}
