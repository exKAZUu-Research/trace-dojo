'use client';

import React, { useState } from 'react';

import { TURTLE_GRAPHICS_DEFAULT_COLOR as DEFAULT_COLOR } from '../../constants';
import { Box, Button, HStack, Select, VStack } from '../../infrastructures/useClient/chakra';
import type { CharacterTrace } from '../../problems/traceProgram';
import type { ColorChar, SelectedCell } from '../../types';

interface TurtleGraphicsControllerProps {
  board: ColorChar[][];
  selectedCharacter?: CharacterTrace;
  selectedCell?: SelectedCell;
  handleChangeCellColorButton: (color: ColorChar) => void;
  handleAddCharacterButton: (color: ColorChar) => void;
  handleRemoveCharacterButton: (character: CharacterTrace) => void;
  handleClickCharacterTurnLeftButton: () => void;
  handleClickCharacterTurnRightButton: () => void;
  handleClickCharacterMoveForwardButton: () => void;
  handleClickCharacterPenUpButton: () => void;
  handleClickCharacterPenDownButton: () => void;
}

export const TurtleGraphicsController: React.FC<TurtleGraphicsControllerProps> = ({
  board,
  handleAddCharacterButton,
  handleChangeCellColorButton,
  handleClickCharacterMoveForwardButton,
  handleClickCharacterPenDownButton,
  handleClickCharacterPenUpButton,
  handleClickCharacterTurnLeftButton,
  handleClickCharacterTurnRightButton,
  handleRemoveCharacterButton,
  selectedCell,
  selectedCharacter,
}) => {
  const [selectedCharacterColor, setSelectedCharacterColor] = useState<ColorChar>(DEFAULT_COLOR);

  const handleSelectCharacterColor = (event: React.ChangeEvent<HTMLSelectElement>): void => {
    const inputValue = event.target.value;
    setSelectedCharacterColor(inputValue as ColorChar);
  };

  return (
    <VStack justifyContent="center" marginTop="4" spacing="4">
      {selectedCharacter && (
        <>
          <HStack>
            <Button onClick={() => handleClickCharacterTurnLeftButton()}>⤹</Button>
            <Button onClick={() => handleClickCharacterTurnRightButton()}>⤵</Button>
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
              <option key={'#'} value={'#'}>
                黒
              </option>
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
            <Button
              backgroundColor={'black'}
              border={'1px'}
              borderColor={'gray.400'}
              opacity={'#' === (board[selectedCell.y][selectedCell.x] as ColorChar) ? '1' : '0.3'}
              onClick={() => handleChangeCellColorButton('#')}
            ></Button>
            <Button
              backgroundColor={'red'}
              border={'1px'}
              borderColor={'gray.400'}
              opacity={'R' === (board[selectedCell.y][selectedCell.x] as ColorChar) ? '1' : '0.3'}
              onClick={() => handleChangeCellColorButton('R')}
            ></Button>
            <Button
              backgroundColor={'blue'}
              border={'1px'}
              borderColor={'gray.400'}
              opacity={'B' === (board[selectedCell.y][selectedCell.x] as ColorChar) ? '1' : '0.3'}
              onClick={() => handleChangeCellColorButton('B')}
            ></Button>
            <Button
              backgroundColor={'green'}
              border={'1px'}
              borderColor={'gray.400'}
              opacity={'G' === (board[selectedCell.y][selectedCell.x] as ColorChar) ? '1' : '0.3'}
              onClick={() => handleChangeCellColorButton('G')}
            ></Button>
            <Button
              backgroundColor={'yellow'}
              border={'1px'}
              borderColor={'gray.400'}
              opacity={'Y' === (board[selectedCell.y][selectedCell.x] as ColorChar) ? '1' : '0.3'}
              onClick={() => handleChangeCellColorButton('Y')}
            ></Button>
            <Button
              backgroundColor={'purple'}
              border={'1px'}
              borderColor={'gray.400'}
              opacity={'P' === (board[selectedCell.y][selectedCell.x] as ColorChar) ? '1' : '0.3'}
              onClick={() => handleChangeCellColorButton('P')}
            ></Button>
          </HStack>
        </>
      )}
    </VStack>
  );
};
