import { zenkakuAlphanumericalsToHankaku } from '@willbooster/shared-lib';
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
  Input,
  Spacer,
  Spinner,
  Table,
  TableContainer,
  Tbody,
  Td,
  Th,
  Thead,
  Tooltip,
  Tr,
  VStack,
} from '../../../../../../../../infrastructures/useClient/chakra';
import type { InstantiatedProblem } from '../../../../../../../../problems/instantiateProblem';
import type { TraceItemVariable, TurtleTrace } from '../../../../../../../../problems/traceProgram';
import type { ColorChar, ProblemType, SelectedCell } from '../../../../../../../../types';

import { BoardViewer } from './BoardViewer';

const DIRECTIONS = ['N', 'E', 'S', 'W'];
const DX = [0, 1, 0, -1];
const DY = [1, 0, -1, 0];

interface TurtleGraphicsProps {
  currentTraceItemIndex: number;
  currentVariables: TraceItemVariable;
  initialVariables: Record<string, string>;
  previousTraceItemIndex: number;
  handleSubmit: () => Promise<void>;
  problem: InstantiatedProblem;
  problemType: ProblemType;
}

export interface TurtleGraphicsHandle {
  findIncorrectLocationsAndHintText(): [string[], string];
}

export const BoardEditor = forwardRef<TurtleGraphicsHandle, TurtleGraphicsProps>((props, ref) => {
  const [board, updateBoard] = useImmer<ColorChar[][]>([]);
  const [turtles, updateTurtles] = useImmer<TurtleTrace[]>([]);
  const [selectedCell, setSelectedCell] = useState<SelectedCell>();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const selectedTurtle = turtles.find((char) => char.x === selectedCell?.x && char.y === selectedCell?.y);
  const previousTraceItem = props.problem.traceItems[props.previousTraceItemIndex];
  const currentTraceItem = props.problem.traceItems[props.currentTraceItemIndex];
  const [variables, updateVariables] = useImmer<Record<string, string>>(props.initialVariables);

  const initialize = useCallback(
    (keepSelectedCell = false): void => {
      const initialBoard = parseBoard(previousTraceItem.board);
      updateBoard(initialBoard);
      updateTurtles(previousTraceItem.turtles);
      updateVariables(props.initialVariables);
      if (!keepSelectedCell) setSelectedCell(undefined);
    },
    [previousTraceItem, props.initialVariables, updateBoard, updateTurtles]
  );

  useImperativeHandle(ref, () => ({
    findIncorrectLocationsAndHintText,
  }));

  useEffect(() => {
    initialize(props.previousTraceItemIndex >= 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.currentTraceItemIndex, props.problem]);

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

  const findIncorrectLocationsAndHintText = (): [string[], string] => {
    const locations: string[] = [];
    let hintText = '';
    if (!fastDeepEqual(currentTraceItem.turtles, turtles)) {
      locations.push('亀');
    }
    if (!fastDeepEqual(parseBoard(currentTraceItem.board), board)) {
      locations.push('盤面（マスの色）');
    }
    for (const [name, value] of Object.entries(variables)) {
      if (
        zenkakuAlphanumericalsToHankaku(value) !==
        zenkakuAlphanumericalsToHankaku(props.currentVariables[name].toString())
      ) {
        locations.push(`変数${name}`);
        if (props.initialVariables[name].toString() === props.currentVariables[name].toString()) {
          hintText +=
            '\n\nヒント: たとえ変数を参照する式があっても、変数を更新する演算子（=, +=, ++）などがなければ、変数の値が変化しないことに注意してください。';
        }
      }
    }
    return [locations, hintText];
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
    if (isSubmitting) return;

    onCellClick(x, y);
    updateCellColor('.', x, y);
  };

  const areAllVariablesFilled = Object.values(variables).every((value) => value.trim() !== '');
  const handleSubmitAndToggleSubmitting = useCallback(async () => {
    if (isSubmitting || !areAllVariablesFilled) return;

    setIsSubmitting(true);
    try {
      await props.handleSubmit();
    } finally {
      setIsSubmitting(false);
    }
  }, [isSubmitting, areAllVariablesFilled, props.handleSubmit]);
  useShortcutKeys(handleSubmitAndToggleSubmitting, isSubmitting);

  return (
    <HStack align="stretch" height="100%" overflow="hidden" rounded="md">
      <VStack flexBasis={0} flexGrow={2} justifyContent="center" minW={0} px={4} py={4} spacing={4}>
        <Center>
          <BoardViewer
            enableTransitions
            board={board.map((cells) => cells.join('')).join('\n')}
            focusedCell={selectedCell}
            turtles={turtles}
            onCellClick={onCellClick}
            onCellRightClick={onCellRightClick}
            onTurtleClick={(x, y) => {
              const turtle = turtles.find((t) => t.x === x && t.y === y);
              if (turtle) handleClickTurtle(turtle);
            }}
          />
        </Center>
        {Object.keys(variables).length > 0 && (
          <TableContainer bgColor="white" width="100%">
            <Table size="sm">
              <Thead>
                <Tr>
                  <Th>変数名</Th>
                  <Th>値（=や+=などの代入がないと変化しない）</Th>
                </Tr>
              </Thead>
              <Tbody>
                {Object.entries(variables).map(([variableKey, variableValue]) => (
                  <Tr key={variableKey}>
                    <Td fontFamily="mono">{variableKey}</Td>
                    <Td fontFamily="mono">
                      <Input
                        fontFamily="mono"
                        size="sm"
                        value={variableValue}
                        onChange={(e) => {
                          updateVariables((draft) => {
                            draft[variableKey] = e.target.value.trim();
                          });
                        }}
                      />
                    </Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          </TableContainer>
        )}
        {Object.values(props.currentVariables).some((value) => typeof value === 'string') && (
          <Box color="red.500" fontSize="sm" mt={2}>
            文字列や文字を入力する際にダブルクォーテーション(&quot;)やシングルクォーテーション(&apos;)は不要です。
          </Box>
        )}
      </VStack>

      <VStack align="stretch" bgColor="white" flexBasis={0} flexGrow={1} minW={0} p={5} shadow="xs" spacing={4}>
        <VStack align="stretch">
          <Heading size="sm">選択したマス</Heading>
          <HStack spacing={4}>
            {selectedCell ? (
              <>
                <div>x = {selectedCell.x}</div>
                <div>y = {selectedCell.y}</div>
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
                  isDisabled={isSubmitting}
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
                  isDisabled={isSubmitting}
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
                  isDisabled={isSubmitting}
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
                  isDisabled={isSubmitting}
                  size="sm"
                  variant="outline"
                  onClick={() => handleTurnTurtle(false)}
                />
              </Grid>
              <HStack justify="space-between" width="100%">
                <Button
                  colorScheme="brand"
                  isDisabled={isSubmitting}
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
          {!selectedTurtle && selectedCell && (
            <Button
              colorScheme="brand"
              isDisabled={isSubmitting}
              size="sm"
              variant="outline"
              onClick={() => handleAddCharacterButton()}
            >
              タートルを配置
            </Button>
          )}
          {selectedCell && (
            <Box color="brand.600" fontSize="sm">
              右クリックでマスを白色に戻せます。
            </Box>
          )}
        </VStack>
        <Spacer />
        <Button colorScheme="brand" isDisabled={isSubmitting} variant="outline" onClick={() => initialize()}>
          盤面をリセット
        </Button>

        <Tooltip
          isDisabled={areAllVariablesFilled}
          label={areAllVariablesFilled ? '' : 'すべての変数の値を入力してください。'}
        >
          <Button
            colorScheme="brand"
            isDisabled={isSubmitting || !areAllVariablesFilled}
            rightIcon={
              isSubmitting ? (
                <Spinner size="sm" />
              ) : (
                <Box as="span" color="whiteAlpha.800" fontSize="sm" fontWeight="bold">
                  (Enter)
                </Box>
              )
            }
            onClick={handleSubmitAndToggleSubmitting}
          >
            提出
          </Button>
        </Tooltip>
      </VStack>
    </HStack>
  );
});

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

function useShortcutKeys(handleSubmit: () => Promise<void>, isSubmitting: boolean): void {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void handleSubmit();
      }
    };
    globalThis.addEventListener('keydown', handleKeyDown);
    return () => globalThis.removeEventListener('keydown', handleKeyDown);
  }, [handleSubmit, isSubmitting]);
}
