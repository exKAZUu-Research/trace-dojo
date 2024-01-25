'use client';

import { Box, Grid, GridItem } from '@chakra-ui/react';
import Image from 'next/image';
import React, { useState } from 'react';

import { Character } from '../../app/lib/Character';
import { TurtleGraphicsCell } from '../../app/lib/TurtleGraphicsCell';

// 原点（左上隅）の座標
const ORIGIN_X = 1;
const ORIGIN_Y = 1;

interface TurtleGraphicsProps {
  characters: Character[];
  gridColumns?: number;
  gridRows?: number;
  gridSize?: number;
  isEnableOperation?: boolean;
}

export const TurtleGraphics: React.FC<TurtleGraphicsProps> = ({
  characters: initialCharacters,
  gridColumns: gridColumns = 12,
  gridRows: gridRows = 8,
  gridSize: gridSize = 40,
  isEnableOperation: isEnableOperation = false,
}) => {
  const [characters, setCharacters] = useState(initialCharacters);
  const [cells] = useState<TurtleGraphicsCell[]>(
    Array.from({ length: gridColumns * gridRows }).map((_, index) => {
      const x = (index % gridColumns) + ORIGIN_X;
      const y = Math.floor(index / gridColumns) + ORIGIN_Y;
      return new TurtleGraphicsCell(index, x, y, '');
    })
  );

  const updateCharacter = (character: Character, updater: (char: Character) => void): void => {
    setCharacters((prevCharacters) =>
      prevCharacters.map((prevCharacter) => {
        if (prevCharacter.id === character.id) {
          const updatedCharacter = new Character({ ...character });
          updater(updatedCharacter);
          return updatedCharacter;
        }
        return prevCharacter;
      })
    );
  };

  const handleMoveForward = (character: Character): void => {
    updateCharacter(character, (updatedCharacter) => {
      updatedCharacter.moveForward(gridColumns, gridRows);
    });
  };

  const handleMoveBack = (character: Character): void => {
    updateCharacter(character, (updatedCharacter) => {
      updatedCharacter.moveBack(gridColumns, gridRows);
    });
  };

  const handleTurnleft = (character: Character): void => {
    updateCharacter(character, (updatedCharacter) => {
      updatedCharacter.turnLeft();
    });
  };

  const handleTurnRight = (character: Character): void => {
    updateCharacter(character, (updatedCharacter) => {
      updatedCharacter.turnRight();
    });
  };

  const handlePutPen = (character: Character): void => {
    updateCharacter(character, (updatedCharacter) => {
      updatedCharacter.putPen();
    });
  };

  const handleUpPen = (character: Character): void => {
    updateCharacter(character, (updatedCharacter) => {
      updatedCharacter.upPen();
    });
  };

  return (
    <div className="turtle-graphics-container">
      <Grid
        position="relative"
        templateColumns={`repeat(${gridColumns}, ${gridSize}px)`}
        templateRows={`repeat(${gridRows}, ${gridSize}px)`}
      >
        {cells.map((cell) => (
          <GridItem
            key={cell.id}
            backgroundColor={cell.backgroundColor}
            borderColor="black"
            borderWidth="1px"
            className="grid-cell"
          />
        ))}
        {characters.map((character) => (
          <Box
            key={character.id}
            bgColor={character.color}
            h={gridSize + 'px'}
            left={(character.x - ORIGIN_X) * gridSize + 'px'}
            position="absolute"
            top={(character.y - ORIGIN_Y) * gridSize + 'px'}
            w={gridSize + 'px'}
          >
            <Box transform={character.rotateCss()}>
              <Image alt={character.name} height={gridSize} src="/character.png" width={gridSize} />
            </Box>
            <Box position="absolute">{character.name}</Box>
          </Box>
        ))}
      </Grid>
      {isEnableOperation &&
        characters.map((character) => (
          <div key={character.id}>
            <div>{character.name}</div>
            <div>
              <button onClick={() => handleMoveForward(character)}>Move Forword</button>
            </div>
            <div>
              <button onClick={() => handleMoveBack(character)}>Move Back</button>
            </div>
            <div>
              <button onClick={() => handleTurnleft(character)}>Turn Left</button>
            </div>
            <div>
              <button onClick={() => handleTurnRight(character)}>Turn Right</button>
            </div>
            <div>
              <button onClick={() => handlePutPen(character)}>Put Pen</button>
            </div>
            <div>
              <button onClick={() => handleUpPen(character)}>Up Pen</button>
            </div>
            <div> --- </div>
          </div>
        ))}
    </div>
  );
};
