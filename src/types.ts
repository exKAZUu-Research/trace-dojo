import type React from 'react';
import type { TurtleTrace } from './problems/traceProgram';

export interface LayoutProps {
  children: React.ReactNode;
}

export type LayoutComponent = React.FC<LayoutProps>;

export type ColorChar = '#' | '.' | 'R' | 'B' | 'G' | 'Y' | 'P';
export type CellColor = 'black' | 'white' | 'red' | 'blue' | 'green' | 'yellow' | 'purple';

export interface SelectedCell {
  x: number;
  y: number;
}

export type ProblemType = 'executionResult' | 'step' | 'fillInBlank' | 'bugFix';

export interface OrdinaryJavaProblemData {
  problemFormat: 'bugFix';
  problemId: string;
  displayProgram: string;
  finalBoard: string;
  finalTurtles: TurtleTrace[];
}
