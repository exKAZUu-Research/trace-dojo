import type React from 'react';

import type { Board } from './app/lib/Board';
import type { Character } from './app/lib/Character';
import type { Variable } from './app/lib/Variable';

export interface LayoutProps {
  children: React.ReactNode;
}

export type LayoutComponent = React.FC<LayoutProps>;

export type CellColor = 'red' | 'blue' | 'green' | 'yellow' | 'purple' | undefined;
export type Cell = {
  color: CellColor;
};
export type SelectedCell = {
  x: number;
  y: number;
};

export type CharacterVariable = { name: string; value: Character };

export type History = {
  step: number;
  characterVariables: CharacterVariable[] | undefined;
  board: Board;
  variables: Variable[];
};

export type SolveProblemResult = {
  characterVariables: CharacterVariable[] | undefined;
  variables: Variable[] | undefined;
  board: Board;
  histories: History[] | undefined;
};

export type CharacterDirection = 'up' | 'down' | 'left' | 'right';

export type ProblemType = 'normal' | 'checkpoint' | 'step';
