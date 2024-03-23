'use client';

import { Box, Grid, GridItem } from '@chakra-ui/react';
import Image from 'next/image';
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useState } from 'react';

import { Board } from '../../app/lib/board';
import { Character, convertCharacterDirectionToCss } from '../../app/lib/character';
import { isAnswerCorrect, solveProblem } from '../../app/lib/solveProblem';
import type { GeneratedProgram } from '../../problems/generateProgram';
import type { CellColor, CharacterDirection, SelectedCell } from '../../types';
import { TurtleGraphicsController } from '../molecules/TurtleGraphicsController';

// 原点（左上隅）の座標
export const ORIGIN_X = 1;
export const ORIGIN_Y = 1;

export const GRID_COLUMNS = 13;
export const GRID_ROWS = 9;
export const GRID_SIZE = 40;

export const EMPTY_COLOR = '.';
export const DEFAULT_COLOR = '#';

interface TurtleGraphicsProps {
  isEnableOperation?: boolean;
  problemProgram: GeneratedProgram;
  currentCheckpointSid?: number;
  beforeCheckpointSid?: number;
}

export interface TurtleGraphicsHandle {
  init(): void;
  isPassed(): boolean;
}

export const TurtleGraphics = forwardRef<TurtleGraphicsHandle, TurtleGraphicsProps>(
  ({ beforeCheckpointSid = 0, currentCheckpointSid, isEnableOperation = false, problemProgram }, ref) => {
    const [board, setBoard] = useState<Board>(new Board());
    const [characters, setCharacters] = useState<Character[]>([]);
    const [selectedCharacter, setSelectedCharacter] = useState<Character>();
    const [selectedCell, setSelectedCell] = useState<SelectedCell>();
    const [dragging, setDragging] = useState<boolean>(false);

    const init = useCallback((): void => {
      if (!problemProgram) return;

      // TODO: Use problemProgram.traceItems instead of solveProblem
      const solveResult = solveProblem(problemProgram.displayProgram).histories?.at(beforeCheckpointSid);
      const initBoard = solveResult?.board;
      const initCharacters = solveResult?.characterVariables?.map((character) => character.value);

      setBoard(initBoard || new Board());
      setCharacters(initCharacters || []);
      setSelectedCharacter(undefined);
      setSelectedCell(undefined);
    }, [beforeCheckpointSid, problemProgram]);

    useImperativeHandle(ref, () => ({
      // 親コンポーネントから関数を呼び出せるようにする
      init,
      isPassed,
    }));

    useEffect(() => {
      init();
    }, [beforeCheckpointSid, init, problemProgram]);

    const updateCharacter = (updater: (char: Character) => void): void => {
      if (!selectedCharacter) return;

      const updatedCharacter = new Character({ ...selectedCharacter });
      updater(updatedCharacter);

      setCharacters((prevCharacters) =>
        prevCharacters.map((prevCharacter) => {
          if (prevCharacter.id === selectedCharacter.id) {
            return updatedCharacter;
          }
          return prevCharacter;
        })
      );
      board.updateGrid(updatedCharacter);
      setSelectedCharacter(updatedCharacter);
    };

    const updateCellColor = (color: CellColor, columnIndex: number, rowIndex: number): void => {
      setBoard((prevBoard) => {
        const newBoard = new Board();
        for (const [y, rows] of prevBoard.grid.entries()) {
          for (const [x, column] of rows.entries()) {
            newBoard.setCellColor(x, y, column.color);
          }
        }
        newBoard.setCellColor(columnIndex, rowIndex, color);
        return newBoard;
      });
    };

    const isPassed = (): boolean => {
      return isAnswerCorrect(problemProgram, characters, board, currentCheckpointSid);
    };

    const handleClickCharacter = (character: Character): void => {
      setSelectedCell(undefined);
      setSelectedCharacter(character);
    };

    const handleClickCharacterMoveButton = (): void => {
      setDragging(true);
    };

    const finishCharacterDragging = (): void => {
      setDragging(false);
    };

    const handleCharacterDragging = (event: React.MouseEvent<HTMLDivElement>): void => {
      if (selectedCharacter && dragging) {
        const rect = event.currentTarget.getBoundingClientRect();
        let x = Math.floor((event.clientX - rect.left) / GRID_SIZE) + 1;
        let y = Math.floor((event.clientY - rect.top) / GRID_SIZE) + 1;

        // 移動先の座標がマップ内に収まるように制御
        x = Math.max(ORIGIN_X, Math.min(x, ORIGIN_X + GRID_COLUMNS - 1));
        y = Math.max(ORIGIN_Y, Math.min(y, ORIGIN_Y + GRID_ROWS - 1));

        setCharacters((prevCharacters) =>
          prevCharacters.map((prevCharacter) => {
            if (prevCharacter.id === selectedCharacter.id) {
              selectedCharacter.setPosition(x, y);
              return selectedCharacter;
            }
            return prevCharacter;
          })
        );
      }
    };

    const handleClickCharacterMoveForwardButton = (): void => {
      if (!selectedCharacter) return;

      updateCharacter((character) => {
        character.moveForward();
      });
    };

    const handleClickCharacterMoveBackButton = (): void => {
      if (!selectedCharacter) return;

      updateCharacter((character) => {
        character.moveBack();
      });
    };

    const handleClickChangeCharacterDirectionButton = (direction: CharacterDirection): void => {
      if (!selectedCharacter) return;

      updateCharacter((character) => {
        if (direction === 'left') character.turnLeft();
        else if (direction === 'right') character.turnRight();
      });
    };

    const handleClickChangeCharacterColorButton = (color: CellColor): void => {
      if (!selectedCharacter) return;

      updateCharacter((character) => {
        character.setColor(color);
      });
    };

    const handleClickCharacterPenUpButton = (): void => {
      if (!selectedCharacter) return;

      updateCharacter((character) => {
        character.penUp();
      });
    };

    const handleClickCharacterPenDownButton = (): void => {
      if (!selectedCharacter) return;

      updateCharacter((character) => {
        character.putPen();
      });
    };

    const handleAddCharacterButton = (): void => {
      if (!selectedCell) return;

      const newCharacter = new Character({
        x: selectedCell.x + ORIGIN_X,
        y: selectedCell.y + ORIGIN_Y,
        path: [`${selectedCell.x + ORIGIN_X},${selectedCell.y + ORIGIN_Y}`],
      });

      board.updateGrid(newCharacter);
      setCharacters((prevCharacters) => [...prevCharacters, newCharacter]);
      setSelectedCharacter(newCharacter);
      setSelectedCell(undefined);
    };

    const handleRemoveCharacterButton = (character: Character): void => {
      setCharacters((prevCharacters) => prevCharacters.filter((prevCharacter) => prevCharacter.id !== character.id));
      setSelectedCharacter(undefined);
    };

    const handleClickCell = (x: number, y: number): void => {
      if (!isEnableOperation) return;

      setSelectedCharacter(undefined);
      setSelectedCell({ x, y });
    };

    const handleChangeCellColorButton = (color: CellColor): void => {
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
      updateCellColor('white', columnIndex, rowIndex);
    };

    return (
      <Box
        className="turtle-graphics-container"
        onMouseMove={handleCharacterDragging}
        onMouseUp={finishCharacterDragging}
      >
        <Grid
          position="relative"
          templateColumns={`repeat(${GRID_COLUMNS}, ${GRID_SIZE}px)`}
          templateRows={`repeat(${GRID_ROWS}, ${GRID_SIZE}px)`}
        >
          {board.grid.map((columns, rowIndex) =>
            columns.map((g, columnIndex) => (
              <GridItem
                key={columnIndex}
                backgroundColor={g.color}
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
              key={character.id}
              borderColor={selectedCharacter?.id === character.id ? 'black' : 'transparent'}
              borderWidth="2px"
              h={GRID_SIZE + 'px'}
              left={(character.x - ORIGIN_X) * GRID_SIZE + 'px'}
              position="absolute"
              top={(character.y - ORIGIN_Y) * GRID_SIZE + 'px'}
              w={GRID_SIZE + 'px'}
              onClick={() => handleClickCharacter(character)}
              onContextMenu={(e) => handleContextMenu(e, character.x - ORIGIN_X, character.y - ORIGIN_Y)}
            >
              <Box p="0.2rem" transform={convertCharacterDirectionToCss(character)}>
                <Image
                  alt={character.name}
                  height={GRID_SIZE}
                  src={`/character/${character.color}.png`}
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
            handleChangeCharacterColorButton={handleClickChangeCharacterColorButton}
            handleClickChangeCharacterDirectionButton={handleClickChangeCharacterDirectionButton}
            handleClickCharacterMoveBackButton={handleClickCharacterMoveBackButton}
            handleClickCharacterMoveButton={handleClickCharacterMoveButton}
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
