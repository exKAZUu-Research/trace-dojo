import type React from 'react';

import type { Board } from './app/lib/board';
import type { Character } from './app/lib/character';
import type { LanguageId } from './problems/problemData';

export interface LayoutProps {
  children: React.ReactNode;
}

export type LayoutComponent = React.FC<LayoutProps>;

export type ColorChar = '#' | '.' | 'R' | 'B' | 'G' | 'Y' | 'P';
export type CellColor = 'black' | 'white' | 'red' | 'blue' | 'green' | 'yellow' | 'purple';
export type Cell = {
  color: CellColor;
};
export type SelectedCell = {
  x: number;
  y: number;
};

export type CharacterVariable = { name: string; value: Character };

export type Variable = { name: string; value: string };

export type History = {
  step: number;
  characterVariables: CharacterVariable[] | undefined;
  board: Board;
  otherVariables: Variable[];
};

export type SolveProblemResult = {
  characterVariables: CharacterVariable[] | undefined;
  otherVariables: Variable[] | undefined;
  board: Board;
  histories: History[] | undefined;
};

export type CharacterDirection = 'up' | 'down' | 'left' | 'right';

export type ProblemType = 'executionResult' | 'checkpoint' | 'step';

export type GeneratedProgram = {
  languageId: LanguageId;

  /**
   * The program to be displayed to the user.
   */
  displayProgram: string;

  /**
   * The instrumented program to be executed with `eval()`.
   */
  instrumentedProgram: string;
};
