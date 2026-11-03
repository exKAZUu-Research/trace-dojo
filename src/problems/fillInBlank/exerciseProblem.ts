import type { TurtleTrace } from '@/problems/trace';

export interface ExerciseDisplay {
  problemFormat: 'fillInBlank' | 'bugFix';
  sessionId: number;
  problemId: string;
  displayProgram: string;
  finalBoard: string;
  finalTurtles: TurtleTrace[];
  completed: boolean;
}
