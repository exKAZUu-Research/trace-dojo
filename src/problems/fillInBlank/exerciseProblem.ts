import type { TurtleTrace } from '@/problems/traceProgram';

export interface ExerciseDisplay {
  problemFormat: 'fillInBlank' | 'bugFix';
  sessionId: number;
  problemId: string;
  displayProgram: string;
  finalBoard: string;
  finalTurtles: TurtleTrace[];
  completed: boolean;
}
