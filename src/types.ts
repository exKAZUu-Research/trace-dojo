import type React from 'react';

export interface LayoutProps {
  children: React.ReactNode;
}

export type LayoutComponent = React.FC<LayoutProps>;

export type ColorChar = '#' | '.' | 'R' | 'B' | 'G' | 'Y' | 'P';
export type CellColor = 'black' | 'white' | 'red' | 'blue' | 'green' | 'yellow' | 'purple';

export type SelectedCell = {
  x: number;
  y: number;
};

export type ProblemType = 'executionResult' | 'checkpoint' | 'step';
