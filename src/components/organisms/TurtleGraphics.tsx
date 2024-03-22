'use client';

import { Box, Grid, GridItem } from '@chakra-ui/react';
import Image from 'next/image';
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useState } from 'react';

import type { TraceItem, TurtleTrace } from '../../tracer/traceProgram';
import type { GeneratedProgram, SelectedCell } from '../../types';
import { TurtleGraphicsController } from '../molecules/TurtleGraphicsController';

export const GRID_COLUMNS = 13;
export const GRID_ROWS = 9;
export const GRID_SIZE = 40;

export const EMPTY_COLOR = '.';
export const DEFAULT_COLOR = 'R';
export type Color = typeof EMPTY_COLOR | 'R' | 'G' | 'B' | 'Y' | 'P';
export const COLOR_MAP = {
  '.': 'white',
  R: 'red',
  G: 'green',
  B: 'blue',
  Y: 'yellow',
  P: 'purple',
};
const TURTLE_DIRS = ['N', 'E', 'S', 'W'];
const DX = [0, 1, 0, -1];
const DY = [-1, 0, 1, 0];
export const DIR_JAPANESE = {
  N: '上',
  E: '下',
  S: '左',
  W: '右',
};
const TURTLE_ROTATE = {
  N: 'rotate(180deg)',
  S: 'rotate(0deg)',
  W: 'rotate(90deg)',
  E: 'rotate(270deg)',
};

interface TurtleGraphicsProps {
  isEnableOperation?: boolean;
  problemProgram: GeneratedProgram;
  currentCheckPointLine: number;
  beforeCheckPointLine?: number;
  traceItems: TraceItem[];
}

export interface TurtleGraphicsHandle {
  init(): void;
  isPassed(): boolean;
}

export const TurtleGraphics = forwardRef<TurtleGraphicsHandle, TurtleGraphicsProps>(
  ({ beforeCheckPointLine = 0, currentCheckPointLine, isEnableOperation = false, problemProgram, traceItems }, ref) => {
    const [board, setBoard] = useState<Color[][]>([]);
    const [turtleVars, setTurtleVars] = useState<TurtleTrace[]>([]);
    const [selectedTurtle, setSelectedTurtle] = useState<TurtleTrace>();
    const [selectedCell, setSelectedCell] = useState<SelectedCell>();

    const init = useCallback((): void => {
      if (!problemProgram) return;

      const traceItem = traceItems[beforeCheckPointLine];

      if (!traceItem) return;

      const initBoard = traceItem.board
        .trim()
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => [...line.trim()]);

      const variables = traceItem.vars;
      const initTurtleVars = [];
      const initOtherVars = [];
      for (const key in variables) {
        const value = variables[key];
        if (typeof value === 'string' || typeof value === 'number') {
          initOtherVars.push(value);
        } else if (value.dir && value.color) {
          initTurtleVars.push(value);
        }
      }

      setBoard(initBoard as Color[][]);
      setTurtleVars(initTurtleVars || []);
      setSelectedTurtle(undefined);
      setSelectedCell(undefined);
    }, [beforeCheckPointLine, problemProgram, traceItems]);

    useImperativeHandle(ref, () => ({
      // 親コンポーネントから関数を呼び出せるようにする
      init,
      isPassed,
    }));

    useEffect(() => {
      init();
    }, [beforeCheckPointLine, init, problemProgram]);

    const updateTurtles = (turtle: TurtleTrace): void => {
      setTurtleVars((prevTurtles) =>
        prevTurtles.map((prevTurtle) => {
          if (prevTurtle === selectedTurtle) {
            return turtle;
          }
          return prevTurtle;
        })
      );
    };

    const updateCellColor = (color: Color, columnIndex: number, rowIndex: number): void => {
      setBoard((prevBoard) => {
        const newBoard = prevBoard.map((row) => [...row]);
        newBoard[rowIndex][columnIndex] = color;
        return newBoard;
      });
    };

    const isPassed = (): boolean => {
      const traceItem = traceItems[currentCheckPointLine];

      if (!traceItem) return false;

      const variables = traceItem.vars;
      const correctTurtles = [];
      for (const key in variables) {
        const value = variables[key];
        if (typeof value !== 'string' && typeof value !== 'number' && value.dir && value.color) {
          correctTurtles.push(value);
        }
      }

      const correctBoard = traceItem.board
        .trim()
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => [...line.trim()]);

      // TODO: remove this later
      console.log('correctTurtles', correctTurtles);
      console.log('userTurtles', turtleVars);
      console.log('correctBoard', correctBoard);
      console.log('userBoard', board);

      return (
        JSON.stringify(correctTurtles) === JSON.stringify(turtleVars) &&
        JSON.stringify(correctBoard) === JSON.stringify(board)
      );
    };

    const handleClickTurtle = (turtle: TurtleTrace): void => {
      setSelectedCell(undefined);
      setSelectedTurtle(turtle);
    };

    const handleClickTurtleMoveForwardButton = (): void => {
      if (!selectedTurtle) return;

      const index = TURTLE_DIRS.indexOf(selectedTurtle.dir);
      const updatedX = selectedTurtle.x + DX[index];
      const updatedY = selectedTurtle.y + DY[index];

      if (updatedX < 0 || GRID_COLUMNS <= updatedX || updatedY < 0 || GRID_ROWS <= updatedY) {
        return;
      }

      selectedTurtle.x = updatedX;
      selectedTurtle.y = updatedY;
      if (selectedTurtle.pen) {
        updateCellColor(selectedTurtle.color as Color, selectedTurtle.x, selectedTurtle.y);
      }
      updateTurtles(selectedTurtle);
    };

    const handleClickChangeTurtleDirectionButton = (dir: string): void => {
      if (!selectedTurtle) return;

      if (dir === 'left') {
        selectedTurtle.dir = TURTLE_DIRS[(TURTLE_DIRS.indexOf(selectedTurtle.dir) + 3) % 4];
      } else if (dir === 'right') {
        selectedTurtle.dir = TURTLE_DIRS[(TURTLE_DIRS.indexOf(selectedTurtle.dir) + 1) % 4];
      }

      updateTurtles(selectedTurtle);
    };

    const handleClickTurtlePenUpButton = (): void => {
      if (!selectedTurtle) return;

      selectedTurtle.pen = false;
      updateTurtles(selectedTurtle);
    };

    const handleClickTurtlePenDownButton = (): void => {
      if (!selectedTurtle) return;

      selectedTurtle.pen = true;
      updateCellColor(selectedTurtle.color as Color, selectedTurtle.x, selectedTurtle.y);
      updateTurtles(selectedTurtle);
    };

    const handleAddTurtleButton = (color: Color): void => {
      if (!selectedCell || !color) return;

      const newTurtle = {
        x: selectedCell.x,
        y: selectedCell.y,
        color,
        dir: 'N',
        pen: true,
      };

      setTurtleVars((prevTurtles) => [...prevTurtles, newTurtle]);
      updateCellColor(newTurtle.color as Color, newTurtle.x, newTurtle.y);
      setSelectedTurtle(newTurtle);
      setSelectedCell(undefined);
    };

    const handleRemoveTurtleButton = (turtle: TurtleTrace): void => {
      setTurtleVars((prevTurtles) => prevTurtles.filter((prevTurtle) => prevTurtle === turtle));
      setSelectedTurtle(undefined);
    };

    const handleClickCell = (x: number, y: number): void => {
      if (!isEnableOperation) return;

      setSelectedTurtle(undefined);
      setSelectedCell({ x, y });
    };

    const handleChangeCellColorButton = (color: Color): void => {
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
                backgroundColor={COLOR_MAP[color as keyof typeof COLOR_MAP]}
                borderColor="black"
                borderWidth={selectedCell?.x === columnIndex && selectedCell?.y === rowIndex ? '2px' : '0.5px'}
                className="grid-cell"
                onClick={() => handleClickCell(columnIndex, rowIndex)}
                onContextMenu={(e) => handleContextMenu(e, columnIndex, rowIndex)}
              />
            ))
          )}
          {turtleVars.map((turtle) => (
            <Box
              key={'turtle' + turtle.x + turtle.y}
              h={GRID_SIZE + 'px'}
              left={turtle.x * GRID_SIZE + 'px'}
              position="absolute"
              top={turtle.y * GRID_SIZE + 'px'}
              w={GRID_SIZE + 'px'}
              onClick={() => handleClickTurtle(turtle)}
              onContextMenu={(e) => handleContextMenu(e, turtle.x, turtle.y)}
            >
              <Box p="0.2rem" transform={TURTLE_ROTATE[turtle.dir as keyof typeof TURTLE_ROTATE]}>
                <Image
                  alt={'turtle' + turtle.x + turtle.y}
                  height={GRID_SIZE}
                  src={`/turtle/${COLOR_MAP[turtle.color as keyof typeof COLOR_MAP]}.png`}
                  width={GRID_SIZE}
                />
              </Box>
            </Box>
          ))}
        </Grid>
        {isEnableOperation && (
          <TurtleGraphicsController
            board={board}
            handleAddTurtleButton={handleAddTurtleButton}
            handleChangeCellColorButton={handleChangeCellColorButton}
            handleClickChangeTurtleDirectionButton={handleClickChangeTurtleDirectionButton}
            handleClickTurtleMoveForwardButton={handleClickTurtleMoveForwardButton}
            handleClickTurtlePenDownButton={handleClickTurtlePenDownButton}
            handleClickTurtlePenUpButton={handleClickTurtlePenUpButton}
            handleRemoveTurtleButton={handleRemoveTurtleButton}
            selectedCell={selectedCell}
            selectedTurtle={selectedTurtle}
          />
        )}
      </Box>
    );
  }
);

TurtleGraphics.displayName = 'TurtleGraphics';
