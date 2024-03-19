'use client';

import { Box, Button, HStack, Select, VStack } from '@chakra-ui/react';
import React, { useState } from 'react';

import type { TurtleTrace } from '../../tracer/traceProgram';
import type { SelectedCell } from '../../types';
import { COLOR_MAP, type Color } from '../organisms/TurtleGraphics';

interface TurtleGraphicsControllerProps {
  board: string[][];
  selectedTurtle?: TurtleTrace;
  selectedCell?: SelectedCell;
  handleChangeCellColorButton: (color: Color) => void;
  handleAddTurtleButton: (color: Color) => void;
  handleRemoveTurtleButton: (turtle: TurtleTrace) => void;
  handleClickChangeTurtleDirectionButton: (dir: string) => void;
  handleClickTurtleMoveForwardButton: () => void;
  handleClickTurtlePenUpButton: () => void;
  handleClickTurtlePenDownButton: () => void;
}

interface ColorChangeButtonProps {
  color: Color;
  selectedColor?: Color;
  handleOnClick: (color: Color) => void;
}

export const TurtleGraphicsController: React.FC<TurtleGraphicsControllerProps> = ({
  board,
  handleAddTurtleButton,
  handleChangeCellColorButton,
  handleClickChangeTurtleDirectionButton,
  handleClickTurtleMoveForwardButton,
  handleClickTurtlePenDownButton,
  handleClickTurtlePenUpButton,
  handleRemoveTurtleButton,
  selectedCell,
  selectedTurtle,
}) => {
  const [selectedTurtleColor, setSelectedTurtleColor] = useState<Color>('.');

  const ColorChangeButton: React.FC<ColorChangeButtonProps> = ({ color, handleOnClick, selectedColor }) => {
    return (
      <Button
        backgroundColor={COLOR_MAP[color]}
        border={'1px'}
        borderColor={'gray.400'}
        opacity={color === selectedColor ? '1' : '0.3'}
        onClick={() => handleOnClick(color)}
      ></Button>
    );
  };

  const handleSelectTurtleColor = (event: React.ChangeEvent<HTMLSelectElement>): void => {
    const inputValue = event.target.value;
    setSelectedTurtleColor(inputValue as Color);
  };

  return (
    <VStack justifyContent="center" marginTop="4" spacing="4">
      {selectedTurtle && (
        <>
          <HStack>
            <Button onClick={() => handleClickChangeTurtleDirectionButton('left')}>⤹</Button>
            <Button onClick={() => handleClickChangeTurtleDirectionButton('right')}>⤵</Button>
          </HStack>
          <HStack>
            <Button onClick={() => handleClickTurtleMoveForwardButton()}>前に進む</Button>
          </HStack>
          <HStack>
            <Button border={selectedTurtle.pen ? '' : '1px'} onClick={() => handleClickTurtlePenUpButton()}>
              ペンを上げる
            </Button>
            <Button border={selectedTurtle.pen ? '1px' : ''} onClick={() => handleClickTurtlePenDownButton()}>
              ペンを下ろす
            </Button>
          </HStack>
          <Box>
            <Button onClick={() => handleRemoveTurtleButton(selectedTurtle)}>削除する</Button>
          </Box>
        </>
      )}

      {selectedCell && (
        <>
          <HStack>
            <Box>
              <Button onClick={() => handleAddTurtleButton(selectedTurtleColor)}>キャラクターを追加する</Button>
            </Box>
            <Select
              maxW="300"
              placeholder="Select color"
              value={selectedTurtleColor}
              onChange={(e) => handleSelectTurtleColor(e)}
            >
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
              selectedColor={board[selectedCell.y][selectedCell.x] as Color}
            />
            <ColorChangeButton
              color={'B'}
              handleOnClick={() => handleChangeCellColorButton('B')}
              selectedColor={board[selectedCell.y][selectedCell.x] as Color}
            />
            <ColorChangeButton
              color={'G'}
              handleOnClick={() => handleChangeCellColorButton('G')}
              selectedColor={board[selectedCell.y][selectedCell.x] as Color}
            />
            <ColorChangeButton
              color={'Y'}
              handleOnClick={() => handleChangeCellColorButton('Y')}
              selectedColor={board[selectedCell.y][selectedCell.x] as Color}
            />
            <ColorChangeButton
              color={'P'}
              handleOnClick={() => handleChangeCellColorButton('P')}
              selectedColor={board[selectedCell.y][selectedCell.x] as Color}
            />
          </HStack>
        </>
      )}
    </VStack>
  );
};
