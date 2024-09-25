import fastDeepEqual from 'fast-deep-equal';
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useState } from 'react';
import { MdOutlineDelete, MdTurnLeft, MdTurnRight } from 'react-icons/md';
import { useImmer } from 'use-immer';

import {
  TURTLE_GRAPHICS_BOARD_COLUMNS as COLUMNS,
  TURTLE_GRAPHICS_BOARD_ROWS as ROWS,
  TURTLE_GRAPHICS_DEFAULT_COLOR as DEFAULT_COLOR,
} from '../../../../../../../../constants';
import {
  Box,
  Button,
  Center,
  Grid,
  Heading,
  HStack,
  Icon,
  IconButton,
  Spacer,
  VStack,
} from '../../../../../../../../infrastructures/useClient/chakra';
import type { Problem } from '../../../../../../../../problems/generateProblem';
import { isTurtleTrace, type TraceItem, type TurtleTrace } from '../../../../../../../../problems/traceProgram';
import type { ColorChar, SelectedCell } from '../../../../../../../../types';

import { BoardViewer } from './BoardViewer';

const DIRECTIONS = ['N', 'E', 'S', 'W'];
const DX = [0, 1, 0, -1];
const DY = [1, 0, -1, 0];

interface TurtleGraphicsProps {
  isEditable?: boolean;
  problem: Problem;
  currentTraceItem?: TraceItem;
  previousTraceItem?: TraceItem;
}

export interface TurtleGraphicsHandle {
  initialize(): void;
  isCorrect(): boolean;
}

export const BoardEditor = forwardRef<TurtleGraphicsHandle, TurtleGraphicsProps>(
  ({ currentTraceItem, isEditable = false, previousTraceItem, problem }, ref) => {
    const [board, updateBoard] = useImmer<ColorChar[][]>([]);
    const [turtles, updateTurtles] = useImmer<TurtleTrace[]>([]);
    const [selectedCell, setSelectedCell] = useState<SelectedCell>();
    const selectedTurtle = turtles.find((char) => char.x === selectedCell?.x && char.y === selectedCell?.y);

    const initialize = useCallback((): void => {
      console.log('initialize:', problem, previousTraceItem);
      if (!problem || !previousTraceItem) return;

      const initialBoard = previousTraceItem.board
        .trim()
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => [...line.trim()]);
      updateBoard(initialBoard as ColorChar[][]);
      updateTurtles(Object.values(previousTraceItem.vars ?? {}).filter(isTurtleTrace));
      setSelectedCell(undefined);
    }, [previousTraceItem, problem]);

    useImperativeHandle(ref, () => ({
      // 親コンポーネントから関数を呼び出せるようにする
      initialize,
      isCorrect,
    }));

    useEffect(() => {
      initialize();
    }, [previousTraceItem, problem]);

    const updateTurtle = (currentTurtle: TurtleTrace, newTurtle: Partial<TurtleTrace>): void => {
      updateTurtles((draft) => {
        const index = draft.findIndex((t) => t.x === currentTurtle.x && t.y === currentTurtle.y);
        if (index !== -1) {
          draft[index] = { ...currentTurtle, ...newTurtle };
        }
      });
    };

    const updateCellColor = (color: ColorChar, columnIndex: number, rowIndex: number): void => {
      updateBoard((draft) => {
        draft[rowIndex][columnIndex] = color;
      });
    };

    const isCorrect = (): boolean => {
      if (!currentTraceItem) return false;

      const expectedTurtles = Object.values(currentTraceItem.vars ?? {}).filter(isTurtleTrace);
      const expectedBoard = currentTraceItem.board
        .trim()
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => [...line.trim()]);

      // TODO: remove this later
      console.log('expectedTurtles', expectedTurtles);
      console.log('turtles', turtles);
      console.log('expectedBoard', expectedBoard);
      console.log('board', board);

      return fastDeepEqual(expectedTurtles, turtles) && fastDeepEqual(expectedBoard, board);
    };

    const handleClickTurtle = (turtle: TurtleTrace): void => {
      setSelectedCell({ x: turtle.x, y: turtle.y });
    };

    const handleClickCharacterMoveForwardButton = (): void => {
      if (!selectedTurtle) return;

      const index = DIRECTIONS.indexOf(selectedTurtle.dir);
      const newX = selectedTurtle.x + DX[index];
      const newY = selectedTurtle.y + DY[index];

      if (newX < 0 || COLUMNS <= newX || newY < 0 || ROWS <= newY) return;
      if (checkNoTurtle(turtles, newX, newY)) return;

      updateCellColor(selectedTurtle.color as ColorChar, newX, newY);
      updateTurtle(selectedTurtle, { x: newX, y: newY });
      setSelectedCell({ x: newX, y: newY });
    };

    const handleClickCharacterMoveBackwardButton = (): void => {
      if (!selectedTurtle) return;

      const index = DIRECTIONS.indexOf(selectedTurtle.dir);
      const newX = selectedTurtle.x - DX[index];
      const newY = selectedTurtle.y - DY[index];

      if (newX < 0 || COLUMNS <= newX || newY < 0 || ROWS <= newY) return;
      if (checkNoTurtle(turtles, newX, newY)) return;

      updateCellColor(selectedTurtle.color as ColorChar, newX, newY);
      updateTurtle(selectedTurtle, { x: newX, y: newY });
      setSelectedCell({ x: newX, y: newY });
    };

    const handleClickCharacterTurnLeftButton = (): void => {
      if (!selectedTurtle) return;

      updateTurtle(selectedTurtle, {
        dir: DIRECTIONS[(DIRECTIONS.indexOf(selectedTurtle.dir) + 3) % 4],
      });
    };

    const handleClickCharacterTurnRightButton = (): void => {
      if (!selectedTurtle) return;

      updateTurtle(selectedTurtle, {
        dir: DIRECTIONS[(DIRECTIONS.indexOf(selectedTurtle.dir) + 1) % 4],
      });
    };

    const handleAddCharacterButton = (): void => {
      if (!selectedCell) return;
      if (checkNoTurtle(turtles, selectedCell.x, selectedCell.y)) return;

      const newTurtle = {
        x: selectedCell.x,
        y: selectedCell.y,
        color: DEFAULT_COLOR,
        dir: 'N',
      };

      updateTurtles((draft) => {
        draft.push(newTurtle);
      });
      updateCellColor(newTurtle.color as ColorChar, newTurtle.x, newTurtle.y);
    };

    const handleRemoveCharacterButton = (): void => {
      if (!selectedCell) return;

      updateTurtles((draft) => {
        const index = draft.findIndex((t) => t.x === selectedCell.x && t.y === selectedCell.y);
        if (index !== -1) {
          draft.splice(index, 1);
        }
      });
      setSelectedCell(undefined);
    };

    const handleClickCell = (x: number, y: number): void => {
      if (!isEditable) return;

      setSelectedCell({ x, y });
    };

    const handleContextMenu = (columnIndex: number, rowIndex: number): void => {
      handleClickCell(columnIndex, rowIndex);
      updateCellColor('.', columnIndex, rowIndex);
    };

    const selectedPosition = selectedCell ? { x: selectedCell.x, y: selectedCell.y } : undefined;

    return (
      <HStack align="stretch" bgColor="gray.50" overflow="hidden" rounded="md">
        <Center flexBasis={0} flexGrow={2} minW={0} px={4} py={16}>
          <BoardViewer
            enableTransitions
            board={board.map((cells) => cells.join('')).join('\n')}
            focusedCell={selectedPosition}
            turtles={turtles}
            onCellClick={handleClickCell}
            onCellRightClick={handleContextMenu}
            onTurtleClick={(x, y) => {
              const turtle = turtles.find((t) => t.x === x && t.y === y);
              if (turtle) handleClickTurtle(turtle);
            }}
          />
        </Center>

        <VStack align="stretch" bgColor="white" flexBasis={0} flexGrow={1} minW={0} p={5} shadow="xs" spacing={4}>
          <VStack align="stretch">
            <Heading size="sm">選択したマス</Heading>
            <HStack spacing={4}>
              {selectedPosition ? (
                <>
                  <div>x = {selectedPosition.x}</div>
                  <div>y = {selectedPosition.y}</div>
                </>
              ) : (
                <Box color="gray.600">なし</Box>
              )}
            </HStack>
          </VStack>

          <VStack align="stretch">
            <Heading size="sm">選択したタートル</Heading>
            {selectedTurtle ? (
              <>
                <Grid gap={2} gridTemplateColumns="repeat(3, auto)">
                  <Button
                    colorScheme="brand"
                    gridColumnStart={2}
                    gridRowStart={1}
                    size="sm"
                    variant="outline"
                    onClick={() => handleClickCharacterMoveForwardButton()}
                  >
                    前に進む
                  </Button>
                  <Button
                    colorScheme="brand"
                    gridColumnStart={2}
                    gridRowStart={2}
                    size="sm"
                    variant="outline"
                    onClick={() => handleClickCharacterMoveBackwardButton()}
                  >
                    後に戻る
                  </Button>
                  <IconButton
                    aria-label="Turn left"
                    colorScheme="brand"
                    gridColumnStart={1}
                    gridRowStart={2}
                    icon={<Icon as={MdTurnLeft} />}
                    size="sm"
                    variant="outline"
                    onClick={() => handleClickCharacterTurnLeftButton()}
                  />
                  <IconButton
                    aria-label="Turn right"
                    colorScheme="brand"
                    gridColumnStart={3}
                    gridRowStart={2}
                    icon={<Icon as={MdTurnRight} />}
                    size="sm"
                    variant="outline"
                    onClick={() => handleClickCharacterTurnRightButton()}
                  />
                </Grid>
                <HStack justify="flex-end">
                  <Button
                    colorScheme="brand"
                    leftIcon={<Icon as={MdOutlineDelete} />}
                    size="sm"
                    variant="outline"
                    onClick={() => handleRemoveCharacterButton()}
                  >
                    削除
                  </Button>
                </HStack>
              </>
            ) : (
              <Box color="gray.600">なし</Box>
            )}
            {!selectedTurtle && selectedPosition && (
              <Button colorScheme="brand" size="sm" variant="outline" onClick={() => handleAddCharacterButton()}>
                タートルを配置
              </Button>
            )}
          </VStack>

          <Spacer />

          <Box color="gray.600" fontSize="sm">
            右クリックでマスを白色に戻せます。
          </Box>
        </VStack>
      </HStack>
    );
  }
);

function checkNoTurtle(turtlesTraces: TurtleTrace[], x: number, y: number): boolean {
  return turtlesTraces.some((char) => char.x === x && char.y === y);
}

BoardEditor.displayName = 'BoardEditor';
