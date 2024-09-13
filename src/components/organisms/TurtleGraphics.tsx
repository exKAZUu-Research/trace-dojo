'use client';

import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useState } from 'react';

import {
  TURTLE_GRAPHICS_DEFAULT_COLOR as DEFAULT_COLOR,
  TURTLE_GRAPHICS_GRID_COLUMNS as GRID_COLUMNS,
  TURTLE_GRAPHICS_GRID_ROWS as GRID_ROWS,
  TURTLE_GRAPHICS_GRID_SIZE as GRID_SIZE,
} from '../../constants';
import { Box, Grid, GridItem, Image } from '../../infrastructures/useClient/chakra';
import type { Problem } from '../../problems/generateProblem';
import { type CharacterTrace, charToColor, type TraceItem } from '../../problems/traceProgram';
import type { ColorChar, SelectedCell } from '../../types';
import { TurtleGraphicsController } from '../molecules/TurtleGraphicsController';

const CHARACTER_DIRS = ['N', 'E', 'S', 'W'];
const DX = [0, 1, 0, -1];
const DY = [1, 0, -1, 0];

const charToRotateStyle = {
  N: 'rotate(180deg)',
  S: 'rotate(0deg)',
  W: 'rotate(90deg)',
  E: 'rotate(270deg)',
} as const;

interface TurtleGraphicsProps {
  isEnableOperation?: boolean;
  problem: Problem;
  currentTraceItem?: TraceItem;
  beforeTraceItem?: TraceItem;
}

export interface TurtleGraphicsHandle {
  init(): void;
  isPassed(): boolean;
}

export const TurtleGraphics = forwardRef<TurtleGraphicsHandle, TurtleGraphicsProps>(
  ({ beforeTraceItem, currentTraceItem, isEnableOperation = false, problem }, ref) => {
    const [board, setBoard] = useState<ColorChar[][]>([]);
    const [characters, setCharacters] = useState<CharacterTrace[]>([]);
    const [selectedCharacter, setSelectedCharacter] = useState<CharacterTrace>();
    const [selectedCell, setSelectedCell] = useState<SelectedCell>();

    const init = useCallback((): void => {
      if (!problem || !beforeTraceItem) return;

      const initBoard = beforeTraceItem.board
        .trim()
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => [...line.trim()]);

      const variables = beforeTraceItem.vars;
      const initCharacters = [];
      const initOtherVars = [];
      for (const key in variables) {
        const value = variables[key];
        if (typeof value === 'string' || typeof value === 'number') {
          initOtherVars.push(value);
        } else if (value.dir && value.color) {
          initCharacters.push(value);
        }
      }

      setBoard(initBoard as ColorChar[][]);
      setCharacters(initCharacters || []);
      setSelectedCharacter(undefined);
      setSelectedCell(undefined);
    }, [beforeTraceItem, problem]);

    useImperativeHandle(ref, () => ({
      // 親コンポーネントから関数を呼び出せるようにする
      init,
      isPassed,
    }));

    useEffect(() => {
      init();
    }, [beforeTraceItem, init, problem]);

    const updateCharacters = (character: CharacterTrace): void => {
      setSelectedCharacter(character);
      setCharacters((prevCharacters) =>
        prevCharacters.map((prevCharacter) => {
          if (prevCharacter === selectedCharacter) {
            return character;
          }
          return prevCharacter;
        })
      );
    };

    const updateCellColor = (color: ColorChar, columnIndex: number, rowIndex: number): void => {
      setBoard((prevBoard) => {
        const newBoard = prevBoard.map((row) => [...row]);
        newBoard[rowIndex][columnIndex] = color;
        return newBoard;
      });
    };

    const isPassed = (): boolean => {
      if (!currentTraceItem) return false;

      const variables = currentTraceItem.vars;
      const correctCharacters = [];
      for (const key in variables) {
        const value = variables[key];
        if (typeof value !== 'string' && typeof value !== 'number' && value.dir && value.color) {
          correctCharacters.push(value);
        }
      }

      const correctBoard = currentTraceItem.board
        .trim()
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => [...line.trim()]);

      // TODO: remove this later
      console.log('correctCharacters', correctCharacters);
      console.log('userCharacters', characters);
      console.log('correctBoard', correctBoard);
      console.log('userBoard', board);

      return (
        JSON.stringify(correctCharacters) === JSON.stringify(characters) &&
        JSON.stringify(correctBoard) === JSON.stringify(board)
      );
    };

    const handleClickCharacter = (character: CharacterTrace): void => {
      setSelectedCell(undefined);
      setSelectedCharacter(character);
    };

    const handleClickCharacterMoveForwardButton = (): void => {
      if (!selectedCharacter) return;

      const index = CHARACTER_DIRS.indexOf(selectedCharacter.dir);
      const updatedX = selectedCharacter.x + DX[index];
      const updatedY = selectedCharacter.y + DY[index];

      if (updatedX < 0 || GRID_COLUMNS <= updatedX || updatedY < 0 || GRID_ROWS <= updatedY) {
        return;
      }

      const updatedCharacter = { ...selectedCharacter, x: updatedX, y: updatedY };
      updateCellColor(updatedCharacter.color as ColorChar, updatedCharacter.x, updatedCharacter.y);
      updateCharacters(updatedCharacter);
    };

    const handleClickCharacterMoveBackwardButton = (): void => {
      if (!selectedCharacter) return;

      const index = CHARACTER_DIRS.indexOf(selectedCharacter.dir);
      const updatedX = selectedCharacter.x - DX[index];
      const updatedY = selectedCharacter.y - DY[index];

      if (updatedX < 0 || GRID_COLUMNS <= updatedX || updatedY < 0 || GRID_ROWS <= updatedY) {
        return;
      }

      const updatedCharacter = { ...selectedCharacter, x: updatedX, y: updatedY };
      updateCellColor('.' as ColorChar, selectedCharacter.x, selectedCharacter.y);
      updateCharacters(updatedCharacter);
    };

    const handleClickCharacterTurnLeftButton = (): void => {
      if (!selectedCharacter) return;

      const updatedCharacter = {
        ...selectedCharacter,
        dir: CHARACTER_DIRS[(CHARACTER_DIRS.indexOf(selectedCharacter.dir) + 3) % 4],
      };
      updateCharacters(updatedCharacter);
    };

    const handleClickCharacterTurnRightButton = (): void => {
      if (!selectedCharacter) return;

      const updatedCharacter = {
        ...selectedCharacter,
        dir: CHARACTER_DIRS[(CHARACTER_DIRS.indexOf(selectedCharacter.dir) + 1) % 4],
      };
      updateCharacters(updatedCharacter);
    };

    const handleAddCharacterButton = (): void => {
      if (!selectedCell) return;

      const newTurtle = {
        x: selectedCell.x,
        y: selectedCell.y,
        color: DEFAULT_COLOR,
        dir: 'N',
      };

      setCharacters((prevCharacters) => [...prevCharacters, newTurtle]);
      updateCellColor(newTurtle.color as ColorChar, newTurtle.x, newTurtle.y);
      setSelectedCharacter(newTurtle);
      setSelectedCell(undefined);
    };

    const handleRemoveCharacterButton = (character: CharacterTrace): void => {
      setCharacters((prevCharacters) => prevCharacters.filter((prevCharacter) => prevCharacter !== character));
      setSelectedCharacter(undefined);
    };

    const handleClickCell = (x: number, y: number): void => {
      if (!isEnableOperation) return;

      setSelectedCharacter(undefined);
      setSelectedCell({ x, y });
    };

    const handleContextMenu = (
      event: React.MouseEvent<HTMLDivElement>,
      columnIndex: number,
      rowIndex: number
    ): void => {
      event.preventDefault();

      handleClickCell(columnIndex, rowIndex);
      updateCellColor('.', columnIndex, rowIndex);
    };

    return (
      <Box className="turtle-graphics-container">
        <Grid
          position="relative"
          templateColumns={`repeat(${GRID_COLUMNS}, ${GRID_SIZE}px)`}
          templateRows={`repeat(${GRID_ROWS}, ${GRID_SIZE}px)`}
        >
          {[...board]
            .reverse()
            .map((columns, rowIndex) =>
              columns.map((color, columnIndex) => (
                <GridItem
                  key={columnIndex}
                  backgroundColor={charToColor[color]}
                  borderColor="black"
                  borderWidth={
                    selectedCell?.x === columnIndex && selectedCell?.y === GRID_ROWS - rowIndex - 1 ? '2px' : '0.5px'
                  }
                  className="grid-cell"
                  onClick={() => handleClickCell(columnIndex, GRID_ROWS - rowIndex - 1)}
                  onContextMenu={(e) => handleContextMenu(e, columnIndex, GRID_ROWS - rowIndex - 1)}
                />
              ))
            )}
          {characters.map((character) => (
            <Box
              key={'character' + character.x + character.y}
              borderColor={selectedCharacter?.color === character.color ? 'black' : 'transparent'}
              borderWidth="2px"
              bottom={character.y * GRID_SIZE + 'px'}
              h={GRID_SIZE + 'px'}
              left={character.x * GRID_SIZE + 'px'}
              position="absolute"
              w={GRID_SIZE + 'px'}
              onClick={() => handleClickCharacter(character)}
              onContextMenu={(e) => handleContextMenu(e, character.x, character.y)}
            >
              <Box p="0.2rem" transform={charToRotateStyle[character.dir as keyof typeof charToRotateStyle]}>
                <Image
                  alt={'character' + character.x + character.y}
                  src={`/character/${charToColor[character.color as keyof typeof charToColor]}.png`}
                  width={GRID_SIZE}
                />
              </Box>
            </Box>
          ))}
        </Grid>
        {isEnableOperation && (
          <TurtleGraphicsController
            handleAddCharacterButton={handleAddCharacterButton}
            handleClickCharacterMoveBackwardButton={handleClickCharacterMoveBackwardButton}
            handleClickCharacterMoveForwardButton={handleClickCharacterMoveForwardButton}
            handleClickCharacterTurnLeftButton={handleClickCharacterTurnLeftButton}
            handleClickCharacterTurnRightButton={handleClickCharacterTurnRightButton}
            handleRemoveCharacterButton={handleRemoveCharacterButton}
            selectedCell={selectedCell}
            selectedCharacter={selectedCharacter}
          />
        )}
      </Box>
    );
  }
);

TurtleGraphics.displayName = 'TurtleGraphics';
