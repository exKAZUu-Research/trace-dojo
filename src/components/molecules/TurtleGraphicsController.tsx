'use client';

import React from 'react';
import { FaArrowRotateRight, FaArrowRotateLeft } from 'react-icons/fa6';

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
  handleClickCharacterPenUpButton: () => void;
  handleClickCharacterPenDownButton: () => void;
}

export const TurtleGraphicsController: React.FC<TurtleGraphicsControllerProps> = ({
  handleAddCharacterButton,
  handleClickCharacterMoveBackwardButton,
  handleClickCharacterMoveForwardButton,
  handleClickCharacterPenDownButton,
  handleClickCharacterPenUpButton,
  handleClickCharacterTurnLeftButton,
  handleClickCharacterTurnRightButton,
  handleRemoveCharacterButton,
  selectedCell,
  selectedCharacter,
}) => {
  return (
    <VStack justifyContent="center" marginTop="4" spacing="4">
      {selectedCharacter && (
        <>
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
            <Button onClick={() => handleClickCharacterMoveBackwardButton()}>後ろに戻る</Button>
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
        <HStack>
          <Box>
            <Button onClick={() => handleAddCharacterButton()}>キャラクターを追加する</Button>
          </Box>
        </HStack>
      )}
    </VStack>
  );
};
