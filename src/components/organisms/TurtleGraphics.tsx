'use client';
import { Box, Grid, GridItem } from '@chakra-ui/react';
import Image from 'next/image';
import React, { useState, forwardRef, useImperativeHandle, useMemo, useCallback } from 'react';

import { Character, CharacterDirection } from '../../app/lib/Character';
import { TurtleGraphicsCell } from '../../app/lib/TurtleGraphicsCell';
import { TurtleGraphicsController } from '../molecules/TurtleGraphicsController';

// 原点（左上隅）の座標
export const ORIGIN_X = 1;
export const ORIGIN_Y = 1;

interface TurtleGraphicsProps {
  gridColumns?: number;
  gridRows?: number;
  gridSize?: number;
  isEnableOperation?: boolean;
}

export interface TurtleGraphicsHandle {
  reset(): void;
  isCorrect(): boolean;
}

export const TurtleGraphics = forwardRef<TurtleGraphicsHandle, TurtleGraphicsProps>(
  ({ gridColumns = 12, gridRows = 8, gridSize = 40, isEnableOperation = false }, ref) => {
    const [selectedCharacter, setSelectedCharacter] = useState<Character>();
    const [selectedCell, setSelectedCell] = useState<TurtleGraphicsCell>();
    const [dragging, setDragging] = useState<boolean>(false);

    useImperativeHandle(ref, () => ({
      // 親コンポーネントから関数を呼び出せるようにする
      reset,
      isCorrect,
    }));

    // TODO: プログラムから盤面を生成する処理ができたら置き換える
    const getInithialCells = useCallback((): TurtleGraphicsCell[] => {
      return Array.from({ length: gridColumns * gridRows }).map((_, index) => {
        const x = (index % gridColumns) + ORIGIN_X;
        const y = Math.floor(index / gridColumns) + ORIGIN_Y;

        let color = '';

        if ((x === 1 && y === 2) || (x === 2 && y === 2) || (x === 3 && y === 2)) {
          color = 'red';
        }

        return new TurtleGraphicsCell(index, x, y, color);
      });
    }, [gridColumns, gridRows]);
    const getInitialCellsResult = useMemo(() => getInithialCells(), [getInithialCells]);
    const [cells, setCells] = useState(getInitialCellsResult);

    // TODO: プログラムから盤面を生成する処理ができたら置き換える
    const getInitialCharacters = (): Character[] => {
      return [new Character('A', 4, 2, 'right', 'red', true, ['1,2', '2,2', '3,2'])];
    };
    const getInitialCharactersResult = useMemo(() => getInitialCharacters(), []);
    const [characters, setCharacters] = useState(getInitialCharactersResult);

    const updateCharacter = (updater: (char: Character) => void): void => {
      if (!selectedCharacter) return;

      const updatedCharacter = new Character(
        selectedCharacter.name,
        selectedCharacter.x,
        selectedCharacter.y,
        selectedCharacter.direction,
        selectedCharacter.color,
        selectedCharacter.penDown,
        selectedCharacter.path
      );
      updater(updatedCharacter);

      setCharacters((prevCharacters) =>
        prevCharacters.map((prevCharacter) => {
          if (prevCharacter.id === selectedCharacter.id) {
            return updatedCharacter;
          }
          return prevCharacter;
        })
      );
      setSelectedCharacter(updatedCharacter);
    };

    const reset = (): void => {
      setCells(getInithialCells());
      setCharacters(getInitialCharacters());
      setSelectedCharacter(undefined);
      setSelectedCell(undefined);
    };

    const isCorrect = (): boolean => {
      // TODO: 正答を取得する処理ができたら置き換える
      const correctCharacters = [new Character('A', 5, 2, 'right', 'red', true, ['1,2', '2,2', '3,2'])];
      // 順番は関係なく、name, x, y, direction, color、penDownが一致していれば正解
      const isCorrectCharacters = correctCharacters.every((correctCharacter) => {
        const character = characters.find((character) => character.name === correctCharacter.name);

        if (!character) return false;

        return (
          character.x === correctCharacter.x &&
          character.y === correctCharacter.y &&
          character.direction === correctCharacter.direction &&
          character.color === correctCharacter.color &&
          character.penDown === correctCharacter.penDown
        );
      });

      const correctCells = Array.from({ length: gridColumns * gridRows }).map((_, index) => {
        const x = (index % gridColumns) + ORIGIN_X;
        const y = Math.floor(index / gridColumns) + ORIGIN_Y;

        let color = '';

        if ((x === 1 && y === 2) || (x === 2 && y === 2) || (x === 3 && y === 2) || (x === 4 && y === 2)) {
          color = 'red';
        }

        return new TurtleGraphicsCell(index, x, y, color);
      });
      // すべてのセルの色が一致していれば正解
      const isCorrectCells = correctCells.every((correctCell) => {
        const cell = cells.find((cell) => cell.id === correctCell.id);

        if (!cell) return false;

        return correctCell.backgroundColor === cell.backgroundColor;
      });

      return isCorrectCharacters && isCorrectCells;
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
        let x = Math.floor((event.clientX - rect.left) / gridSize) + 1;
        let y = Math.floor((event.clientY - rect.top) / gridSize) + 1;

        // 移動先の座標がマップ内に収まるように制御
        x = Math.max(ORIGIN_X, Math.min(x, ORIGIN_X + gridColumns - 1));
        y = Math.max(ORIGIN_Y, Math.min(y, ORIGIN_Y + gridRows - 1));

        // 移動先のセルのインデックス
        const destinationCellIndex = (y - ORIGIN_Y) * gridColumns + (x - ORIGIN_X);

        // 移動先のセルに色がついていない、かつ他のキャラクターがいない場合のみ移動可能
        const destinationCell = cells[destinationCellIndex];
        if (destinationCell && destinationCell.backgroundColor === '') {
          const isCellOccupied = characters.some(
            (character) => character.x === x && character.y === y && character.id !== selectedCharacter.id
          );

          if (!isCellOccupied) {
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
        }
      }
    };

    const handleClickCharacterMoveForwardButton = (): void => {
      if (!selectedCharacter) return;

      updateCharacter((character) => {
        character.moveForward(gridColumns, gridRows);
      });
    };

    const handleClickChangeCharacterDirectionButton = (direction: string): void => {
      if (!selectedCharacter) return;

      updateCharacter((character) => {
        if (direction === CharacterDirection.Left) character.turnLeft();
        else if (direction === CharacterDirection.Right) character.turnRight();
      });
    };

    const handleClickChangeCharacterColorButton = (color: string): void => {
      if (!selectedCharacter) return;

      updateCharacter((character) => {
        character.setColor(color);
      });
    };

    const handleClickCharacterPenUpButton = (): void => {
      if (!selectedCharacter) return;

      updateCharacter((character) => {
        character.upPen();
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

      selectedCell.setBackgroundColor('');

      const x = (selectedCell.id % gridColumns) + ORIGIN_X;
      const y = Math.floor(selectedCell.id / gridColumns) + ORIGIN_Y;
      const newCharacter = new Character('', x, y, 'down', '', true, [`${x},${y}`]);

      setCharacters((prevCharacters) => [...prevCharacters, newCharacter]);
      setSelectedCharacter(newCharacter);
      setSelectedCell(undefined);
    };

    const handleRemoveCharacterButton = (character: Character): void => {
      setCharacters((prevCharacters) => prevCharacters.filter((prevCharacter) => prevCharacter.id !== character.id));
      setSelectedCharacter(undefined);
    };

    const handleClickCell = (index: number): void => {
      setSelectedCharacter(undefined);
      setSelectedCell(cells[index]);
    };

    const handleChangeCellColorButton = (color: string): void => {
      setCells((prevCells) =>
        prevCells.map((prevCell) => {
          if (prevCell.id === selectedCell?.id) {
            selectedCell.setBackgroundColor(color);
            return selectedCell;
          }
          return prevCell;
        })
      );
    };

    return (
      <Box
        className="turtle-graphics-container"
        onMouseMove={handleCharacterDragging}
        onMouseUp={finishCharacterDragging}
      >
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
              borderWidth={selectedCell?.id === cell.id ? '2px' : '0.5px'}
              className="grid-cell"
              onClick={() => handleClickCell(cell.id)}
            />
          ))}
          {characters.map((character) => (
            <Box
              key={character.id}
              bgColor={character.color}
              borderColor={selectedCharacter?.id === character.id ? 'black' : 'transparent'}
              borderWidth="2px"
              h={gridSize + 'px'}
              left={(character.x - ORIGIN_X) * gridSize + 'px'}
              position="absolute"
              top={(character.y - ORIGIN_Y) * gridSize + 'px'}
              w={gridSize + 'px'}
              onClick={() => handleClickCharacter(character)}
            >
              <Box transform={character.rotateCss()}>
                <Image alt={character.name} height={gridSize} src="/character.png" width={gridSize} />
              </Box>
            </Box>
          ))}
        </Grid>
        {isEnableOperation && (
          <TurtleGraphicsController
            handleAddCharacterButton={handleAddCharacterButton}
            handleChangeCellColorButton={handleChangeCellColorButton}
            handleChangeCharacterColorButton={handleClickChangeCharacterColorButton}
            handleClickChangeCharacterDirectionButton={handleClickChangeCharacterDirectionButton}
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
