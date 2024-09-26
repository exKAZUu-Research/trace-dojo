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
import { isTurtleTrace, type TurtleTrace } from '../../../../../../../../problems/traceProgram';
import type { ColorChar, SelectedCell } from '../../../../../../../../types';

import { BoardViewer } from './BoardViewer';

const DIRECTIONS = ['N', 'E', 'S', 'W'];
const DX = [0, 1, 0, -1];
const DY = [1, 0, -1, 0];

interface TurtleGraphicsProps {
  currentTraceItemIndex: number;
  focusTraceItemIndex: number;
  handleClickSubmitButton: () => Promise<void>;
  problem: Problem;
}

export interface TurtleGraphicsHandle {
  isCorrect(): boolean;
}

export const BoardEditor = forwardRef<TurtleGraphicsHandle, TurtleGraphicsProps>(
  ({ currentTraceItemIndex, focusTraceItemIndex, handleClickSubmitButton, problem }, ref) => {
    const [board, updateBoard] = useImmer<ColorChar[][]>([]);
    const [turtles, updateTurtles] = useImmer<TurtleTrace[]>([]);
    const [selectedCell, setSelectedCell] = useState<SelectedCell>();
    const selectedTurtle = turtles.find((char) => char.x === selectedCell?.x && char.y === selectedCell?.y);
    const focusTraceItem = problem.traceItems[focusTraceItemIndex];
    const currentTraceItem = problem.traceItems[currentTraceItemIndex];

    const initialize = useCallback(
      (keepSelectedCell = false): void => {
        const initialBoard = parseBoard(focusTraceItem.board);
        updateBoard(initialBoard);
        updateTurtles(Object.values(focusTraceItem.vars ?? {}).filter(isTurtleTrace));
        if (!keepSelectedCell) setSelectedCell(undefined);
      },
      [focusTraceItem, updateBoard, updateTurtles]
    );

    useImperativeHandle(ref, () => ({
      isCorrect,
    }));

    useEffect(() => {
      initialize(focusTraceItemIndex >= 1);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentTraceItemIndex, problem]);

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
      const expectedBoard = parseBoard(currentTraceItem.board);
      return fastDeepEqual(expectedTurtles, turtles) && fastDeepEqual(expectedBoard, board);
    };

    const handleClickTurtle = (turtle: TurtleTrace): void => {
      setSelectedCell({ x: turtle.x, y: turtle.y });
    };

    const handleMoveTurtle = (forward: boolean): void => {
      if (!selectedTurtle) return;

      const index = DIRECTIONS.indexOf(selectedTurtle.dir);
      const multiplier = forward ? 1 : -1;
      const newX = selectedTurtle.x + DX[index] * multiplier;
      const newY = selectedTurtle.y + DY[index] * multiplier;
      if (!canPutTurtle(turtles, newX, newY)) return;

      updateCellColor(selectedTurtle.color as ColorChar, newX, newY);
      updateTurtle(selectedTurtle, { x: newX, y: newY });
      setSelectedCell({ x: newX, y: newY });
    };

    const handleTurnTurtle = (left: boolean): void => {
      if (!selectedTurtle) return;

      const directionChange = left ? 3 : 1;
      updateTurtle(selectedTurtle, {
        dir: DIRECTIONS[(DIRECTIONS.indexOf(selectedTurtle.dir) + directionChange) % 4],
      });
    };

    const handleAddCharacterButton = (): void => {
      if (!selectedCell) return;
      if (!canPutTurtle(turtles, selectedCell.x, selectedCell.y)) return;

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

    const onCellClick = (x: number, y: number): void => {
      setSelectedCell({ x, y });
    };

    const onCellRightClick = (x: number, y: number): void => {
      onCellClick(x, y);
      updateCellColor('.', x, y);
    };

    const selectedPosition = selectedCell ? { x: selectedCell.x, y: selectedCell.y } : undefined;

    useShortcutKeys(handleClickSubmitButton);

    return (
      <HStack align="stretch" bgColor="gray.50" overflow="hidden" rounded="md">
        <Center flexBasis={0} flexGrow={2} minW={0} px={4} py={20}>
          <BoardViewer
            enableTransitions
            board={board.map((cells) => cells.join('')).join('\n')}
            focusedCell={selectedPosition}
            turtles={turtles}
            onCellClick={onCellClick}
            onCellRightClick={onCellRightClick}
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
                    onClick={() => handleMoveTurtle(true)}
                  >
                    前に進む
                  </Button>
                  <Button
                    colorScheme="brand"
                    gridColumnStart={2}
                    gridRowStart={2}
                    size="sm"
                    variant="outline"
                    onClick={() => handleMoveTurtle(false)}
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
                    onClick={() => handleTurnTurtle(true)}
                  />
                  <IconButton
                    aria-label="Turn right"
                    colorScheme="brand"
                    gridColumnStart={3}
                    gridRowStart={2}
                    icon={<Icon as={MdTurnRight} />}
                    size="sm"
                    variant="outline"
                    onClick={() => handleTurnTurtle(false)}
                  />
                </Grid>
                <HStack justify="space-between" width="100%">
                  <Button
                    colorScheme="brand"
                    leftIcon={<Icon as={MdOutlineDelete} />}
                    size="sm"
                    variant="outline"
                    width="100%"
                    onClick={() => handleRemoveCharacterButton()}
                  >
                    タートルを削除
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
            {selectedPosition && (
              <Box color="brand.600" fontSize="sm">
                右クリックでマスを白色に戻せます。
              </Box>
            )}
          </VStack>
          <Spacer />
          <Button colorScheme="brand" variant="outline" onClick={() => initialize()}>
            盤面をリセット
          </Button>

          <Button
            colorScheme="brand"
            rightIcon={
              <Box as="span" color="whiteAlpha.800" fontSize="sm" fontWeight="bold">
                (Enter)
              </Box>
            }
            onClick={() => handleClickSubmitButton()}
          >
            提出
          </Button>
        </VStack>
      </HStack>
    );
  }
);

BoardEditor.displayName = 'BoardEditor';

function canPutTurtle(turtlesTraces: TurtleTrace[], x: number, y: number): boolean {
  return 0 <= x && x < COLUMNS && 0 <= y && y < ROWS && !turtlesTraces.some((t) => t.x === x && t.y === y);
}

function parseBoard(boardString: string): ColorChar[][] {
  return boardString
    .trim()
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => [...line.trim()]) as ColorChar[][];
}

function useShortcutKeys(handleClickSubmitButton: () => Promise<void>): void {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void handleClickSubmitButton();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleClickSubmitButton]);
}
