'use client';

import { Box, Grid, GridItem } from '@chakra-ui/react';
import Image from 'next/image';
import React, { useState, forwardRef, useImperativeHandle, useMemo } from 'react';

import { Board } from '../../app/lib/Board';
import { Character } from '../../app/lib/Character';
import { solveProblem } from '../../app/lib/solveProblem';
import type { CellColor, CharacterDirection, SelectedCell } from '../../types';
import { TurtleGraphicsController } from '../molecules/TurtleGraphicsController';

// 原点（左上隅）の座標
export const ORIGIN_X = 1;
export const ORIGIN_Y = 1;

export const GRID_COLUMNS = 12;
export const GRID_ROWS = 8;
export const GRID_SIZE = 40;

interface TurtleGraphicsProps {
  isEnableOperation?: boolean;
  problemProgram: string;
}

export interface TurtleGraphicsHandle {
  reset(): void;
  isCorrect(): boolean;
}

export const TurtleGraphics = forwardRef<TurtleGraphicsHandle, TurtleGraphicsProps>(
  ({ isEnableOperation = false, problemProgram }, ref) => {
    const [board, setBoard] = useState<Board>(new Board());
    const [selectedCharacter, setSelectedCharacter] = useState<Character>();
    const [selectedCell, setSelectedCell] = useState<SelectedCell>();
    const [dragging, setDragging] = useState<boolean>(false);

    useImperativeHandle(ref, () => ({
      // 親コンポーネントから関数を呼び出せるようにする
      reset,
      isCorrect,
    }));

    // // TODO: プログラムから盤面を生成する処理ができたら置き換える
    const getInitialBoard = (): Board => {
      return new Board();
    };

    // TODO: プログラムから盤面を生成する処理ができたら置き換える
    const getInitialCharacters = (): Character[] => {
      return [];
    };
    const getInitialCharactersResult = useMemo(() => getInitialCharacters(), []);
    const [characters, setCharacters] = useState(getInitialCharactersResult);

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

    const reset = (): void => {
      setBoard(getInitialBoard());
      setCharacters(getInitialCharacters());
      setSelectedCharacter(undefined);
      setSelectedCell(undefined);
    };

    const isCorrect = (): boolean => {
      const answer = solveProblem(problemProgram);

      // TODO: 正答を取得する処理ができたら置き換える
      const correctCharacters = answer.characters;
      if (!correctCharacters) return false;
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

      const correctBoard = answer.board;
      // すべてのセルの色が一致していれば正解
      const isCorrectBoard = correctBoard.grid.every((rows, rowIndex) =>
        rows.every((column, columnIndex) => {
          const cell = board.grid[rowIndex][columnIndex];
          return cell.color === column.color;
        })
      );

      return isCorrectCharacters && isCorrectBoard;
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

      const newCharacter = new Character({
        x: selectedCell.x + ORIGIN_X,
        y: selectedCell.y + ORIGIN_Y,
        penDown: false,
        path: [`${selectedCell.x},${selectedCell.y}`],
      });

      setCharacters((prevCharacters) => [...prevCharacters, newCharacter]);
      setSelectedCharacter(newCharacter);
      setSelectedCell(undefined);
    };

    const handleRemoveCharacterButton = (character: Character): void => {
      setCharacters((prevCharacters) => prevCharacters.filter((prevCharacter) => prevCharacter.id !== character.id));
      setSelectedCharacter(undefined);
    };

    const handleClickCell = (x: number, y: number): void => {
      setSelectedCharacter(undefined);
      setSelectedCell({ x, y });
    };

    const handleChangeCellColorButton = (color: CellColor): void => {
      if (!selectedCell) return;

      setBoard((prevBoard) => {
        const newBoard = new Board();
        for (const [y, rows] of prevBoard.grid.entries()) {
          for (const [x, column] of rows.entries()) {
            newBoard.setCellColor(x, y, column.color);
          }
        }
        newBoard.setCellColor(selectedCell.x, selectedCell.y, color);
        return newBoard;
      });
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
              />
            ))
          )}
          {characters.map((character) => (
            <Box
              key={character.id}
              borderColor={selectedCharacter?.id === character.id ? 'black' : 'transparent'}
              borderWidth="2px"
              h={GRID_SIZE + 'px'}
              left={(character.x - ORIGIN_Y) * GRID_SIZE + 'px'}
              position="absolute"
              top={(character.y - ORIGIN_X) * GRID_SIZE + 'px'}
              w={GRID_SIZE + 'px'}
              onClick={() => handleClickCharacter(character)}
            >
              <Box p="0.2rem" transform={character.rotateCss()}>
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
