import type React from 'react';

export interface LayoutProps {
  children: React.ReactElement;
}

export type LayoutComponent = React.FC<LayoutProps>;

export type ColorChar = '#' | '.' | 'R' | 'B' | 'G' | 'Y' | 'P';
export type CellColor = 'black' | 'white' | 'red' | 'blue' | 'green' | 'yellow' | 'purple';

export interface SelectedCell {
  x: number;
  y: number;
}

export type ProblemType = 'executionResult' | 'step';
