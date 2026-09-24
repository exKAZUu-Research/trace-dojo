import type { TraceItemVariable, TurtleTrace } from '@/problems/traceProgram';

export interface ExerciseDisplay {
  sessionId: number;
  problemId: string;
  displayProgram: string;
  blankCount: number;
  expectedBoard: string;
  expectedTurtles: TurtleTrace[];
  finalVars: TraceItemVariable;
  completed: boolean;
}
