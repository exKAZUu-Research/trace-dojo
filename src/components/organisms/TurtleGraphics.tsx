'use client';

// TurtleGraphics.tsx

import React, { useState } from 'react';

import { Character } from '../../components/organisms/Character';
import './TurtleGraphics.css';

interface TurtleGraphicsProps {
  characters: {
    id: number;
    name: string;
    x: number;
    y: number;
    direction: string;
    color: string;
    penDown: boolean;
    path: string[];
  }[];
}

export const TurtleGraphics: React.FC<TurtleGraphicsProps> = ({ characters: initialCharacters }) => {
  const [characters, setCharacters] = useState(initialCharacters);

  const handleMoveForward = (id: number): void => {
    setCharacters((prevCharacters) =>
      prevCharacters.map((character) => {
        if (character.id === id) {
          const updatedCharacter = { ...character };

          switch (updatedCharacter.direction) {
            case 'up': {
              updatedCharacter.y = Math.max(0, updatedCharacter.y - 1);
              break;
            }
            case 'down': {
              updatedCharacter.y = Math.min(7, updatedCharacter.y + 1);
              break;
            }
            case 'left': {
              updatedCharacter.x = Math.max(0, updatedCharacter.x - 1);
              break;
            }
            case 'right': {
              updatedCharacter.x = Math.min(11, updatedCharacter.x + 1);
              break;
            }
          }

          return updatedCharacter;
        }
        return character;
      })
    );
  };

  return (
    <div className="turtle-graphics-container">
      <div className="grid">
        {Array.from({ length: 96 }).map((_, index) => (
          <div key={index} className="grid-cell"></div>
        ))}
        {characters.map((character) => (
          <Character key={character.id} character={character} onMoveForward={handleMoveForward} />
        ))}
      </div>
    </div>
  );
};
