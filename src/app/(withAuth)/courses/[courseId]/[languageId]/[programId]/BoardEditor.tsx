'use client';

import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { MdOutlineDelete, MdTurnLeft, MdTurnRight } from 'react-icons/md';

import {
  TURTLE_GRAPHICS_DEFAULT_COLOR as DEFAULT_COLOR,
  TURTLE_GRAPHICS_BOARD_COLUMNS as COLUMNS,
  TURTLE_GRAPHICS_BOARD_ROWS as ROWS,
} from '../../../../../../constants';
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
} from '../../../../../../infrastructures/useClient/chakra';
import type { Problem } from '../../../../../../problems/generateProblem';
import { type CharacterTrace, type TraceItem } from '../../../../../../problems/traceProgram';
import type { ColorChar, SelectedCell } from '../../../../../../types';

import { BoardViewer } from './BoardViewer';

const CHARACTER_DIRS = ['N', 'E', 'S', 'W'];
const DX = [0, 1, 0, -1];
const DY = [1, 0, -1, 0];

interface TurtleGraphicsProps {
  isEditable?: boolean;
  problem: Problem;
  currentTraceItem?: TraceItem;
  beforeTraceItem?: TraceItem;
}

export interface TurtleGraphicsHandle {
  initialize(): void;
  isPassed(): boolean;
}

export const BoardEditor = forwardRef<TurtleGraphicsHandle, TurtleGraphicsProps>(
  ({ beforeTraceItem, currentTraceItem, isEditable = false, problem }, ref) => {
    const [board, setBoard] = useState<ColorChar[][]>([]);
    const [characters, setCharacters] = useState<(CharacterTrace & { key: string })[]>([]);
    const [selectedCharacter, setSelectedCharacter] = useState<CharacterTrace & { key: string }>();
    const [selectedCell, setSelectedCell] = useState<SelectedCell>();

    const initialize = useCallback((): void => {
      console.log('initialize:', problem, beforeTraceItem);
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
          initCharacters.push({ ...value, key });
        }
      }

      setBoard(initBoard as ColorChar[][]);
      setCharacters(initCharacters || []);
      setSelectedCharacter(undefined);
      setSelectedCell(undefined);
    }, [beforeTraceItem, problem]);

    useImperativeHandle(ref, () => ({
      // 親コンポーネントから関数を呼び出せるようにする
      initialize,
      isPassed,
    }));

    useEffect(() => {
      initialize();
    }, [beforeTraceItem, initialize, problem]);

    const updateCharacters = (character: CharacterTrace & { key: string }): void => {
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

      const userCharacters = characters.map(({ key, ...rest }) => rest);

      // TODO: remove this later
      console.log('correctCharacters', correctCharacters);
      console.log('userCharacters', userCharacters);
      console.log('correctBoard', correctBoard);
      console.log('userBoard', board);

      // TODO: Implement a compare function without using JSON.
      return (
        JSON.stringify(correctCharacters) === JSON.stringify(userCharacters) &&
        JSON.stringify(correctBoard) === JSON.stringify(board)
      );
    };

    const handleClickCharacter = (character: CharacterTrace & { key: string }): void => {
      setSelectedCell(undefined);
      setSelectedCharacter(character);
    };

    const handleClickCharacterMoveForwardButton = (): void => {
      if (!selectedCharacter) return;

      const index = CHARACTER_DIRS.indexOf(selectedCharacter.dir);
      const updatedX = selectedCharacter.x + DX[index];
      const updatedY = selectedCharacter.y + DY[index];

      if (updatedX < 0 || COLUMNS <= updatedX || updatedY < 0 || ROWS <= updatedY) {
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

      if (updatedX < 0 || COLUMNS <= updatedX || updatedY < 0 || ROWS <= updatedY) {
        return;
      }

      const updatedCharacter = { ...selectedCharacter, x: updatedX, y: updatedY };
      updateCellColor(updatedCharacter.color as ColorChar, updatedCharacter.x, updatedCharacter.y);
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

    const autoIncrementedNextCharacterIdRef = useRef(1);

    const handleAddCharacterButton = (): void => {
      if (!selectedCell) return;

      const newTurtle = {
        key: `亀${autoIncrementedNextCharacterIdRef.current}`,
        x: selectedCell.x,
        y: selectedCell.y,
        color: DEFAULT_COLOR,
        dir: 'N',
      };
      autoIncrementedNextCharacterIdRef.current++;

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
      if (!isEditable) return;

      setSelectedCharacter(undefined);
      setSelectedCell({ x, y });
    };

    const handleContextMenu = (columnIndex: number, rowIndex: number): void => {
      handleClickCell(columnIndex, rowIndex);
      updateCellColor('.', columnIndex, rowIndex);
    };

    const selectedPosition = selectedCell
      ? { x: selectedCell.x, y: selectedCell.y }
      : selectedCharacter
        ? { x: selectedCharacter.x, y: selectedCharacter.y }
        : undefined;

    return (
      <HStack align="stretch" bgColor="gray.50" overflow="hidden" rounded="md">
        <Center flexBasis={0} flexGrow={2} minW={0} px={4} py={16}>
          <BoardViewer
            enableTransitions
            board={board.map((cells) => cells.join('')).join('\n')}
            focusedCell={selectedPosition}
            vars={Object.fromEntries(characters.map((character) => [character.key, character]))}
            onCellClick={handleClickCell}
            onCellRightClick={handleContextMenu}
            onCharacterClick={(key) => {
              const c = characters.find((c) => c.key === key);
              if (c) handleClickCharacter(c);
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
            {selectedCharacter ? (
              <>
                <div>{selectedCharacter.key}</div>
                <Grid gap={2} gridTemplateColumns="repeat(3, auto)">
                  <Button
                    colorScheme="brand"
                    gridColumnStart={2}
                    gridRowStart={1}
                    size="sm"
                    variant="outline"
                    onClick={() => void handleClickCharacterMoveForwardButton()}
                  >
                    前に進む
                  </Button>
                  <Button
                    colorScheme="brand"
                    gridColumnStart={2}
                    gridRowStart={2}
                    size="sm"
                    variant="outline"
                    onClick={() => void handleClickCharacterMoveBackwardButton()}
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
                    onClick={() => void handleClickCharacterTurnLeftButton()}
                  />
                  <IconButton
                    aria-label="Turn right"
                    colorScheme="brand"
                    gridColumnStart={3}
                    gridRowStart={2}
                    icon={<Icon as={MdTurnRight} />}
                    size="sm"
                    variant="outline"
                    onClick={() => void handleClickCharacterTurnRightButton()}
                  />
                </Grid>
                <HStack justify="flex-end">
                  <Button
                    colorScheme="brand"
                    leftIcon={<Icon as={MdOutlineDelete} />}
                    size="sm"
                    variant="outline"
                    onClick={() => void handleRemoveCharacterButton(selectedCharacter)}
                  >
                    削除
                  </Button>
                </HStack>
              </>
            ) : (
              <Box color="gray.600">なし</Box>
            )}
            {!selectedCharacter && selectedPosition && (
              <Button colorScheme="brand" size="sm" variant="outline" onClick={() => void handleAddCharacterButton()}>
                タートルを追加
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

BoardEditor.displayName = 'BoardEditor';
