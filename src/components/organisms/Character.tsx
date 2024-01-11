'use client';

import { Box } from '@chakra-ui/react';
import React, { useEffect } from 'react';

export interface CharacterInterface {
  id: number;
  name: string;
  x: number;
  y: number;
  direction: string;
  color: string;
  penDown: boolean;
  path: string[];
}

interface CharacterProps {
  character: CharacterInterface;
  gridColumns: number;
  gridSize: number;
  onMoveForward: (id: number) => void;
}

export const Character: React.FC<CharacterProps> = ({ character, gridColumns, gridSize, onMoveForward }) => {
  // 軌跡の描画
  useEffect(() => {
    for (const position of character.path) {
      const [x, y] = position.split(',').map(Number);
      const gridCell = document.querySelectorAll('.grid-cell')[x + y * gridColumns] as HTMLElement;

      if (!gridCell) return;

      gridCell.style.backgroundColor = character.color;
      gridCell.style.opacity = '0.5';
    }
  });

  return (
    <Box
      bgColor={character.color}
      h={gridSize + 'px'}
      left={character.x * gridSize + 'px'}
      position="absolute"
      top={character.y * gridSize + 'px'}
      w={gridSize + 'px'}
    >
      <button onClick={() => onMoveForward(character.id)}>{character.name}</button>
    </Box>
  );
};
