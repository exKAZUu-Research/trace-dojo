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
  /** The program that the browser instantiates with `seed` and traces. */
  programTemplate: string;
}
