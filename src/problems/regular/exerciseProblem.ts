export interface RegularExerciseDisplay {
  problemFormat: 'regular';
  sessionId: number;
  problemId: string;
  seed: string;
  problemType: 'executionResult' | 'step';
  traceItemIndex: number;
  completed: boolean;
}
