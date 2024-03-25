'use client';

import { Box, Grid, GridItem, Image } from '@chakra-ui/react';
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useState } from 'react';

import type { Problem } from '../../problems/generateProblem';
import { charToColor, type CharacterTrace } from '../../problems/traceProgram';
import type { ColorChar, SelectedCell } from '../../types';
import { TurtleGraphicsController } from '../molecules/TurtleGraphicsController';

export const GRID_COLUMNS = 13;
export const GRID_ROWS = 9;
export const GRID_SIZE = 40;

export const EMPTY_COLOR = '.';
export const DEFAULT_COLOR = '#';

const CHARACTER_DIRS = ['N', 'E', 'S', 'W'];
const DX = [0, 1, 0, -1];
const DY = [-1, 0, 1, 0];

const charToRotateStyle = {
  N: 'rotate(180deg)',
  S: 'rotate(0deg)',
  W: 'rotate(90deg)',
  E: 'rotate(270deg)',
} as const;

interface TurtleGraphicsProps {
  isEnableOperation?: boolean;
  problem: Problem;
  currentCheckpointSid?: number;
  beforeCheckpointSid?: number;
}

export interface TurtleGraphicsHandle {
  init(): void;
  isPassed(): boolean;
}

export const TurtleGraphics = forwardRef<TurtleGraphicsHandle, TurtleGraphicsProps>(
  ({ beforeCheckpointSid = 0, currentCheckpointSid, isEnableOperation = false, problem }, ref) => {
    const [board, setBoard] = useState<ColorChar[][]>([]);
    const [characters, setCharacters] = useState<CharacterTrace[]>([]);
    const [selectedCharacter, setSelectedCharacter] = useState<CharacterTrace>();
    const [selectedCell, setSelectedCell] = useState<SelectedCell>();

    const init = useCallback((): void => {
      if (!problem) return;

      const traceItem = problem.traceItems.find((traceItem) => traceItem.sid === beforeCheckpointSid);

      if (!traceItem) return;

      const initBoard = traceItem.board
        .trim()
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => [...line.trim()]);

      const variables = traceItem.vars;
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
    }, [beforeCheckpointSid, problem]);

    useImperativeHandle(ref, () => ({
      // 親コンポーネントから関数を呼び出せるようにする
      init,
      isPassed,
    }));

    useEffect(() => {
      init();
    }, [beforeCheckpointSid, init, problem]);

    const updateCharacters = (character: CharacterTrace): void => {
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
      const traceItem = problem.traceItems.find((traceItem) => traceItem.sid === currentCheckpointSid);

      if (!traceItem) return false;

      const variables = traceItem.vars;
      const correctCharacters = [];
      for (const key in variables) {
        const value = variables[key];
        if (typeof value !== 'string' && typeof value !== 'number' && value.dir && value.color) {
          correctCharacters.push(value);
        }
      }

      const correctBoard = traceItem.board
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

      selectedCharacter.x = updatedX;
      selectedCharacter.y = updatedY;
      if (selectedCharacter.pen) {
        updateCellColor(selectedCharacter.color as ColorChar, selectedCharacter.x, selectedCharacter.y);
      }
      updateCharacters(selectedCharacter);
    };

    const handleClickChangeCharacterDirectionButton = (dir: string): void => {
      if (!selectedCharacter) return;

      if (dir === 'left') {
        selectedCharacter.dir = CHARACTER_DIRS[(CHARACTER_DIRS.indexOf(selectedCharacter.dir) + 3) % 4];
      } else if (dir === 'right') {
        selectedCharacter.dir = CHARACTER_DIRS[(CHARACTER_DIRS.indexOf(selectedCharacter.dir) + 1) % 4];
      }

      updateCharacters(selectedCharacter);
    };

    const handleClickCharacterPenUpButton = (): void => {
      if (!selectedCharacter) return;

      selectedCharacter.pen = false;
      updateCharacters(selectedCharacter);
    };

    const handleClickCharacterPenDownButton = (): void => {
      if (!selectedCharacter) return;

      selectedCharacter.pen = true;
      updateCellColor(selectedCharacter.color as ColorChar, selectedCharacter.x, selectedCharacter.y);
      updateCharacters(selectedCharacter);
    };

    const handleAddCharacterButton = (color: ColorChar): void => {
      if (!selectedCell || !color) return;

      const newTurtle = {
        x: selectedCell.x,
        y: selectedCell.y,
        color,
        dir: 'N',
        pen: true,
      };

      setCharacters((prevCharacters) => [...prevCharacters, newTurtle]);
      updateCellColor(newTurtle.color as ColorChar, newTurtle.x, newTurtle.y);
      setSelectedCharacter(newTurtle);
      setSelectedCell(undefined);
    };

    const handleRemoveCharacterButton = (character: CharacterTrace): void => {
      setCharacters((prevCharacters) => prevCharacters.filter((prevCharacter) => prevCharacter === character));
      setSelectedCharacter(undefined);
    };

    const handleClickCell = (x: number, y: number): void => {
      if (!isEnableOperation) return;

      setSelectedCharacter(undefined);
      setSelectedCell({ x, y });
    };

    const handleChangeCellColorButton = (color: ColorChar): void => {
      if (!selectedCell) return;

      updateCellColor(color, selectedCell.x, selectedCell.y);
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
          {board.map((columns, rowIndex) =>
            columns.map((color, columnIndex) => (
              <GridItem
                key={columnIndex}
                backgroundColor={charToColor[color]}
                borderColor="black"
                borderWidth={selectedCell?.x === columnIndex && selectedCell?.y === rowIndex ? '2px' : '0.5px'}
                className="grid-cell"
                onClick={() => handleClickCell(columnIndex, rowIndex)}
                onContextMenu={(e) => handleContextMenu(e, columnIndex, rowIndex)}
              />
            ))
          )}
          {characters.map((character) => (
            <Box
              key={'character' + character.x + character.y}
              borderColor={selectedCharacter?.color === character.color ? 'black' : 'transparent'}
              borderWidth="2px"
              h={GRID_SIZE + 'px'}
              left={character.x * GRID_SIZE + 'px'}
              position="absolute"
              top={character.y * GRID_SIZE + 'px'}
              w={GRID_SIZE + 'px'}
              onClick={() => handleClickCharacter(character)}
              onContextMenu={(e) => handleContextMenu(e, character.x, character.y)}
            >
              <Box p="0.2rem" transform={charToRotateStyle[character.dir as keyof typeof charToRotateStyle]}>
                <Image
                  alt={'character' + character.x + character.y}
                  height={GRID_SIZE}
                  src={`/character/${charToColor[character.color as keyof typeof charToColor]}.png`}
                  width={GRID_SIZE}
                />
              </Box>
            </Box>
          ))}
        </Grid>
        {isEnableOperation && (
          <TurtleGraphicsController
            board={board}
            handleAddCharacterButton={handleAddCharacterButton}
            handleChangeCellColorButton={handleChangeCellColorButton}
            handleClickChangeCharacterDirectionButton={handleClickChangeCharacterDirectionButton}
            handleClickCharacterMoveForwardButton={handleClickCharacterMoveForwardButton}
            handleClickCharacterPenDownButton={handleClickCharacterPenDownButton}
            handleClickCharacterPenUpButton={handleClickCharacterPenUpButton}
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
