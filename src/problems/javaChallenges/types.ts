import type { TurtleTrace } from '../traceProgram';

export type JavaChallengeFormat = 'fillInBlank' | 'bugFix';

export interface JavaChallengeTarget {
  finalBoard: string;
  finalTurtles: TurtleTrace[];
}

export interface JavaChallengeDefinition extends JavaChallengeTarget {
  title: string;
  courseId: 'tuBeginner1' | 'tuBeginner2' | 'test';
  lectureIndex: number;
  problemFormat: JavaChallengeFormat;
  correctProgram: string;
  starterProgram: string;
  finalTurtles: (Omit<TurtleTrace, 'dir'> & { dir: 'N' | 'E' | 'S' | 'W' })[];
  bugKind?: 'logical' | 'syntax';
}
