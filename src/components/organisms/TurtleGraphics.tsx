'use client';

import { Grid, GridItem } from '@chakra-ui/react';
import React, { useState } from 'react';

import { Character } from '../molecules/Character';
import type { CharacterInterface } from '../molecules/Character';

interface TurtleGraphicsProps {
  characters: CharacterInterface[];
  gridColumns?: number;
  gridRows?: number;
  gridSize?: number;
}

export const TurtleGraphics: React.FC<TurtleGraphicsProps> = ({
  characters: initialCharacters,
  gridColumns: gridColumns = 12,
  gridRows: gridRows = 8,
  gridSize: gridSize = 40,
}) => {
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
      <Grid
        position="relative"
        templateColumns={`repeat(${gridColumns}, ${gridSize}px)`}
        templateRows={`repeat(${gridRows}, ${gridSize}px)`}
      >
        {Array.from({ length: gridColumns * gridRows }).map((_, index) => (
          <GridItem key={index} borderColor="black" borderWidth="1px" className="grid-cell" />
        ))}
        {characters.map((character) => (
          <Character
            key={character.id}
            character={character}
            gridColumns={gridColumns}
            gridSize={gridSize}
            onMoveForward={handleMoveForward}
          />
        ))}
      </Grid>
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
