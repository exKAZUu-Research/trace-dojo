import type React from 'react';

import type { Board } from './app/lib/Board';
import type { Character } from './app/lib/Character';

export interface LayoutProps {
  children: React.ReactNode;
}

export type LayoutComponent = React.FC<LayoutProps>;

export type CellColor = 'red' | 'green' | 'blue';
export type Cell = {
  color: CellColor | undefined;
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
