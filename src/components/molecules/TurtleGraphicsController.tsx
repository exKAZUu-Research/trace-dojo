'use client';

import React from 'react';
import { FaArrowRotateRight, FaArrowRotateLeft, FaTrashCan } from 'react-icons/fa6';

import { TURTLE_GRAPHICS_GRID_ROWS as GRID_ROWS, TURTLE_GRAPHICS_GRID_SIZE as GRID_SIZE } from '../../constants';
import { Box, Button, HStack, IconButton, VStack } from '../../infrastructures/useClient/chakra';
import type { CharacterTrace } from '../../problems/traceProgram';
import type { SelectedCell } from '../../types';

interface TurtleGraphicsControllerProps {
  selectedCharacter?: CharacterTrace;
  selectedCell?: SelectedCell;
  handleAddCharacterButton: () => void;
  handleRemoveCharacterButton: (character: CharacterTrace) => void;
  handleClickCharacterTurnLeftButton: () => void;
  handleClickCharacterTurnRightButton: () => void;
  handleClickCharacterMoveForwardButton: () => void;
  handleClickCharacterMoveBackwardButton: () => void;
}

export const TurtleGraphicsController: React.FC<TurtleGraphicsControllerProps> = ({
  handleAddCharacterButton,
  handleClickCharacterMoveBackwardButton,
  handleClickCharacterMoveForwardButton,
  handleClickCharacterTurnLeftButton,
  handleClickCharacterTurnRightButton,
  handleRemoveCharacterButton,
  selectedCell,
  selectedCharacter,
}) => {
  return (
    <VStack align="center" justifyContent="center" marginTop="4" spacing="4" zIndex="10">
      {selectedCharacter && (
        <VStack
          alignItems="center"
          left={selectedCharacter.x * GRID_SIZE + GRID_SIZE / 2 + 'px'}
          position="absolute"
          top={(GRID_ROWS - selectedCharacter.y) * GRID_SIZE + GRID_SIZE / 4 + 'px'}
          transform="translate(-50%, 0%)"
        >
          <HStack>
            <IconButton
              aria-label="Turn Left"
              icon={<FaArrowRotateLeft />}
              onClick={() => handleClickCharacterTurnLeftButton()}
            />
            <IconButton
              aria-label="Turn Right"
              icon={<FaArrowRotateRight />}
              onClick={() => handleClickCharacterTurnRightButton()}
            />
          </HStack>
          <HStack>
            <Button onClick={() => handleClickCharacterMoveForwardButton()}>前に進む</Button>
            <Button onClick={() => handleClickCharacterMoveBackwardButton()}>後に戻る</Button>
          </HStack>
          <Box>
            <IconButton
              aria-label="Remove"
              colorScheme="red"
              icon={<FaTrashCan />}
              onClick={() => handleRemoveCharacterButton(selectedCharacter)}
            />
          </Box>
        </VStack>
      )}

      {selectedCell && (
        <HStack>
          <Box
            left={selectedCell.x * GRID_SIZE + GRID_SIZE / 2 + 'px'}
            position="absolute"
            top={(GRID_ROWS - selectedCell.y) * GRID_SIZE + GRID_SIZE / 4 + 'px'}
            transform="translate(-50%, 0%)"
          >
            <Button onClick={() => handleAddCharacterButton()}>キャラクターを追加する</Button>
          </Box>
        </HStack>
      )}
    </VStack>
  );
};
