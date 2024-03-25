import type React from 'react';

export interface LayoutProps {
  children: React.ReactNode;
}

export type LayoutComponent = React.FC<LayoutProps>;

export type SelectedCell = {
  x: number;
  y: number;
};

export type ProblemType = 'executionResult' | 'checkpoint' | 'step';

export type GeneratedProgram = {
  /**
   * The program to be displayed to the user.
   */
  displayProgram: string;

  /**
   * The instrumented program to be executed with `eval()`.
   */
  instrumentedProgram: string;
};
