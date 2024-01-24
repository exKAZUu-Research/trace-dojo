'use client';

import { Box, Grid, GridItem } from '@chakra-ui/react';
import React, { useState, useEffect } from 'react';

import { Character } from '../../app/lib/Character';

// 原点（左上隅）の座標
const ORIGIN_X = 1;
const ORIGIN_Y = 1;

interface TurtleGraphicsProps {
  characters: Character[];
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

  useEffect(() => {
    // 軌跡の描画
    for (const character of characters) {
      if (!character.penDown) continue;
      for (const position of character.path) {
        const [x, y] = position.split(',').map(Number);
        const gridCell = document.querySelectorAll('.grid-cell')[
          x - ORIGIN_X + (y - ORIGIN_Y) * gridColumns
        ] as HTMLElement;
        if (!gridCell) return;
        gridCell.style.backgroundColor = character.color;
        gridCell.style.opacity = '0.5';
      }
    }
  }, [characters, gridColumns]);

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
        {Array.from({ length: gridColumns * gridRows }).map((_, index) => (
          <GridItem key={index} borderColor="black" borderWidth="1px" className="grid-cell" />
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
            {character.name}
          </Box>
        ))}
      </Grid>
      {characters.map((character) => (
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
