import type React from 'react';

import type { Board } from './app/lib/Board';
import type { Character } from './app/lib/Character';

export interface LayoutProps {
  children: React.ReactNode;
}

export type LayoutComponent = React.FC<LayoutProps>;

export type CellColor = 'red' | 'blue' | 'green' | 'yellow' | 'purple' | 'white';
export type Cell = {
  color: CellColor;
};
export type SelectedCell = {
  x: number;
  y: number;
};

export type History = {
  step: number;
  character: Character;
  board: Board;
};

export type SolveProblemResult = {
  character: Character;
  board: Board;
  histories: History[] | undefined;
};

export type CharacterDirection = 'up' | 'down' | 'left' | 'right';
