// Character.tsx

import React from 'react';

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
  onMoveForward: (id: number) => void;
}

export const Character: React.FC<CharacterProps> = ({ character, onMoveForward }) => {
  const gridSize = 40;

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

  return (
    <div style={characterStyle}>
      <button onClick={() => onMoveForward(character.id)}>{character.name}</button>
    </div>
  );
};
