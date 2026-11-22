import type { TurtleTrace } from '@/problems/trace';

/** What a Java editing problem shows: the program to edit and the state in which the edited program must end. */
export interface JavaProblemPresentation {
  displayProgram: string;
  finalBoard: string;
  finalTurtles: TurtleTrace[];
}

/** A Java editing problem as the server describes it. */
export type JavaProblemSource =
  | JavaProblemPresentation
  /** A problem with blanks and random numbers, which the browser instantiates with `seed` and traces. */
  | { programTemplate: string; seed: string };

export type ExerciseDisplay = JavaProblemSource & {
  problemFormat: 'fillInBlank' | 'bugFix';
  sessionId: number;
  problemId: string;
  completed: boolean;
};
