'use client';

import React, { useEffect } from 'react';

interface CharacterProps {
  character: {
    id: number;
    name: string;
    x: number;
    y: number;
    direction: string;
    color: string;
    penDown: boolean;
    path: string[];
  };
  gridColumns: number;
  gridSize: number;
  onMoveForward: (id: number) => void;
}

export const Character: React.FC<CharacterProps> = ({ character, gridColumns, gridSize, onMoveForward }) => {
  const characterStyle: React.CSSProperties = {
    position: 'absolute',
    top: character.y * gridSize + 'px',
    left: character.x * gridSize + 'px',
    width: gridSize + 'px',
    height: gridSize + 'px',
    backgroundColor: character.color,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'white',
    textAlign: 'center',
  };

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
    <div style={characterStyle}>
      <button onClick={() => onMoveForward(character.id)}>{character.name}</button>
    </div>
  );
};
