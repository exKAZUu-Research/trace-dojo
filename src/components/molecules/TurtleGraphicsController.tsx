'use client';

import { Box, Button, HStack, Select, VStack } from '@chakra-ui/react';
import React, { useState } from 'react';

import type { CharacterTrace } from '../../problems/traceProgram';
import type { ColorChar, SelectedCell } from '../../types';
import { DEFAULT_COLOR } from '../organisms/TurtleGraphics';

interface TurtleGraphicsControllerProps {
  board: ColorChar[][];
  selectedCharacter?: CharacterTrace;
  selectedCell?: SelectedCell;
  handleChangeCellColorButton: (color: ColorChar) => void;
  handleAddCharacterButton: (color: ColorChar) => void;
  handleRemoveCharacterButton: (character: CharacterTrace) => void;
  handleClickChangeCharacterDirectionButton: (dir: string) => void;
  handleClickCharacterMoveForwardButton: () => void;
  handleClickCharacterPenUpButton: () => void;
  handleClickCharacterPenDownButton: () => void;
}

export const TurtleGraphicsController: React.FC<TurtleGraphicsControllerProps> = ({
  board,
  handleAddCharacterButton,
  handleChangeCellColorButton,
  handleClickChangeCharacterDirectionButton,
  handleClickCharacterMoveForwardButton,
  handleClickCharacterPenDownButton,
  handleClickCharacterPenUpButton,
  handleRemoveCharacterButton,
  selectedCell,
  selectedCharacter,
}) => {
  const [selectedCharacterColor, setSelectedCharacterColor] = useState<ColorChar>(DEFAULT_COLOR);

  interface ColorChangeButtonProps {
    color: ColorChar;
    selectedColor?: ColorChar;
    handleOnClick: (color: ColorChar) => void;
  }

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

  const handleSelectCharacterColor = (event: React.ChangeEvent<HTMLSelectElement>): void => {
    const inputValue = event.target.value;
    setSelectedCharacterColor(inputValue as ColorChar);
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
            <Button onClick={() => handleClickCharacterMoveForwardButton()}>前に進む</Button>
          </HStack>
          <HStack>
            <Button border={selectedCharacter.pen ? '' : '1px'} onClick={() => handleClickCharacterPenUpButton()}>
              ペンを上げる
            </Button>
            <Button border={selectedCharacter.pen ? '1px' : ''} onClick={() => handleClickCharacterPenDownButton()}>
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
          <HStack>
            <Box>
              <Button onClick={() => handleAddCharacterButton(selectedCharacterColor)}>キャラクターを追加する</Button>
            </Box>
            <Select maxW="300" value={selectedCharacterColor} onChange={(e) => handleSelectCharacterColor(e)}>
              <option key={'R'} value={'R'}>
                赤
              </option>
              <option key={'B'} value={'B'}>
                青
              </option>
              <option key={'G'} value={'G'}>
                緑
              </option>
              <option key={'Y'} value={'Y'}>
                黄
              </option>
              <option key={'P'} value={'P'}>
                紫
              </option>
            </Select>
          </HStack>
          <HStack>
            <ColorChangeButton
              color={'R'}
              handleOnClick={() => handleChangeCellColorButton('R')}
              selectedColor={board[selectedCell.y][selectedCell.x] as ColorChar}
            />
            <ColorChangeButton
              color={'B'}
              handleOnClick={() => handleChangeCellColorButton('B')}
              selectedColor={board[selectedCell.y][selectedCell.x] as ColorChar}
            />
            <ColorChangeButton
              color={'G'}
              handleOnClick={() => handleChangeCellColorButton('G')}
              selectedColor={board[selectedCell.y][selectedCell.x] as ColorChar}
            />
            <ColorChangeButton
              color={'Y'}
              handleOnClick={() => handleChangeCellColorButton('Y')}
              selectedColor={board[selectedCell.y][selectedCell.x] as ColorChar}
            />
            <ColorChangeButton
              color={'P'}
              handleOnClick={() => handleChangeCellColorButton('P')}
              selectedColor={board[selectedCell.y][selectedCell.x] as ColorChar}
            />
          </HStack>
        </>
      )}
    </VStack>
  );
};
