import type React from 'react';

export type LayoutProps = {
  children: React.ReactElement;
}

export type LayoutComponent = React.FC<LayoutProps>;

export type ColorChar = '#' | '.' | 'R' | 'B' | 'G' | 'Y' | 'P';
export type CellColor = 'black' | 'white' | 'red' | 'blue' | 'green' | 'yellow' | 'purple';

export type SelectedCell = {
  x: number;
  y: number;
};

export type ProblemType = 'executionResult' | 'step';
