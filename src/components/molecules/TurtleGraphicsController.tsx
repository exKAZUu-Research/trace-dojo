'use client';

import { Box, Button, HStack, VStack } from '@chakra-ui/react';
import React from 'react';

import type { Board } from '../../app/lib/Board';
import type { Character } from '../../app/lib/Character';
import type { CellColor, CharacterDirection, SelectedCell } from '../../types';

interface TurtleGraphicsControllerProps {
  board: Board;
  selectedCharacter?: Character;
  selectedCell?: SelectedCell;
  handleChangeCellColorButton: (color: CellColor) => void;
  handleChangeCharacterColorButton: (color: CellColor) => void;
  handleAddCharacterButton: () => void;
  handleRemoveCharacterButton: (character: Character) => void;
  handleClickCharacterMoveButton: () => void;
  handleClickChangeCharacterDirectionButton: (direction: CharacterDirection) => void;
  handleClickCharacterMoveForwardButton: () => void;
  handleClickCharacterMoveBackButton: () => void;
  handleClickCharacterPenUpButton: () => void;
  handleClickCharacterPenDownButton: () => void;
}

interface ColorChangeButtonProps {
  color: CellColor;
  selectedColor?: CellColor;
  handleOnClick: (color: CellColor) => void;
}

export const TurtleGraphicsController: React.FC<TurtleGraphicsControllerProps> = ({
  board,
  handleAddCharacterButton,
  handleChangeCellColorButton,
  handleChangeCharacterColorButton,
  handleClickChangeCharacterDirectionButton,
  handleClickCharacterMoveBackButton,
  handleClickCharacterMoveButton,
  handleClickCharacterMoveForwardButton,
  handleClickCharacterPenDownButton,
  handleClickCharacterPenUpButton,
  handleRemoveCharacterButton,
  selectedCell,
  selectedCharacter,
}) => {
  const ColorChangeButton: React.FC<ColorChangeButtonProps> = ({ color, handleOnClick, selectedColor }) => {
    return (
      <Button
        backgroundColor={color}
        border={'1px'}
        borderColor={'gray.400'}
        opacity={color === selectedColor ? '1' : '0.3'}
        onClick={() => handleOnClick(color)}
      ></Button>
    );
  };

  return (
    <VStack justifyContent="center" marginTop="4" spacing="4">
      {selectedCharacter && (
        <>
          <HStack>
            <Button onClick={() => handleClickChangeCharacterDirectionButton('left')}>⤹</Button>
            <Button onClick={() => handleClickChangeCharacterDirectionButton('right')}>⤵</Button>
          </HStack>
          <HStack>
            <Button onClick={() => handleClickCharacterMoveButton()}>✜</Button>
            <Button onClick={() => handleClickCharacterMoveForwardButton()}>前に進む</Button>
            <Button onClick={() => handleClickCharacterMoveBackButton()}>後ろに進む</Button>
          </HStack>
          <HStack>
            <ColorChangeButton
              color={'red'}
              handleOnClick={() => handleChangeCharacterColorButton('red')}
              selectedColor={selectedCharacter.color}
            />
            <ColorChangeButton
              color={'blue'}
              handleOnClick={() => handleChangeCharacterColorButton('blue')}
              selectedColor={selectedCharacter.color}
            />
            <ColorChangeButton
              color={'green'}
              handleOnClick={() => handleChangeCharacterColorButton('green')}
              selectedColor={selectedCharacter.color}
            />
            <ColorChangeButton
              color={'yellow'}
              handleOnClick={() => handleChangeCharacterColorButton('yellow')}
              selectedColor={selectedCharacter.color}
            />
            <ColorChangeButton
              color={'purple'}
              handleOnClick={() => handleChangeCharacterColorButton('purple')}
              selectedColor={selectedCharacter.color}
            />
          </HStack>
          <HStack>
            <Button border={selectedCharacter.penDown ? '' : '1px'} onClick={() => handleClickCharacterPenUpButton()}>
              ペンを上げる
            </Button>
            <Button border={selectedCharacter.penDown ? '1px' : ''} onClick={() => handleClickCharacterPenDownButton()}>
              ペンを下ろす
            </Button>
          </HStack>
          <Box>
            <Button onClick={() => handleRemoveCharacterButton(selectedCharacter)}>削除する</Button>
          </Box>
        </>
      )}

      {selectedCell && (
        <>
          <Box>
            <Button onClick={() => handleAddCharacterButton()}>キャラクターを追加する</Button>
          </Box>
          <HStack>
            <ColorChangeButton
              color={'red'}
              handleOnClick={() => handleChangeCellColorButton('red')}
              selectedColor={board.getCellColor(selectedCell.x, selectedCell.y)}
            />
            <ColorChangeButton
              color={'blue'}
              handleOnClick={() => handleChangeCellColorButton('blue')}
              selectedColor={board.getCellColor(selectedCell.x, selectedCell.y)}
            />
            <ColorChangeButton
              color={'green'}
              handleOnClick={() => handleChangeCellColorButton('green')}
              selectedColor={board.getCellColor(selectedCell.x, selectedCell.y)}
            />
            <ColorChangeButton
              color={'yellow'}
              handleOnClick={() => handleChangeCellColorButton('yellow')}
              selectedColor={board.getCellColor(selectedCell.x, selectedCell.y)}
            />
            <ColorChangeButton
              color={'purple'}
              handleOnClick={() => handleChangeCellColorButton('purple')}
              selectedColor={board.getCellColor(selectedCell.x, selectedCell.y)}
            />
            <ColorChangeButton
              color={undefined}
              handleOnClick={() => handleChangeCellColorButton(undefined)}
              selectedColor={board.getCellColor(selectedCell.x, selectedCell.y)}
            />
          </HStack>
        </>
      )}
    </VStack>
  );
};
