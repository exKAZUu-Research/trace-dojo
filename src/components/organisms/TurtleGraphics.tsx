'use client';

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
          updatedCharacter.path.push(`${updatedCharacter.x},${updatedCharacter.y}`);

          return updatedCharacter;
        }
        return character;
      })
    );
  };

  const handleChangeDirection = (id: number, direction: string): void => {
    setCharacters((prevCharacters) =>
      prevCharacters.map((character) => {
        if (character.id === id) {
          const updatedCharacter = { ...character, direction };
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
      {characters.map((character) => (
        <div key={character.id}>
          <div>{character.name}</div>
          <select value={character.direction} onChange={(e) => handleChangeDirection(character.id, e.target.value)}>
            <option value="up">Up</option>
            <option value="down">Down</option>
            <option value="left">Left</option>
            <option value="right">Right</option>
          </select>
        </div>
      ))}
    </div>
  );
};
