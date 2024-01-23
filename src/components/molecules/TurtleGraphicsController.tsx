'use client';

import { Box, Button, HStack, VStack } from '@chakra-ui/react';
import React from 'react';

import type { Character } from '../../app/lib/Character';
import { CharacterColor, CharacterDirection } from '../../app/lib/Character';
import type { TurtleGraphicsCell } from '../../app/lib/TurtleGraphicsCell';

interface TurtleGraphicsControllerProps {
  selectedCharacter?: Character;
  selectedCell?: TurtleGraphicsCell;
  handleChangeCellColorButton: (color: string) => void;
  handleChangeCharacterColorButton: (color: string) => void;
  handleAddCharacterButton: () => void;
  handleRemoveCharacterButton: (character: Character) => void;
  handleClickCharacterMoveButton: () => void;
  handleClickChangeCharacterDirectionButton: (direction: string) => void;
}

interface ColorChangeButtonProps {
  color: string;
  selectedColor?: string;
  handleOnClick: (color: string) => void;
}

export const TurtleGraphicsController: React.FC<TurtleGraphicsControllerProps> = ({
  handleAddCharacterButton,
  handleChangeCellColorButton,
  handleChangeCharacterColorButton,
  handleClickChangeCharacterDirectionButton,
  handleClickCharacterMoveButton,
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
    <VStack justifyContent="center" minH="200px" spacing="4">
      {selectedCharacter && (
        <>
          <HStack>
            <Button
              border={CharacterDirection.Up === selectedCharacter.direction ? '1px' : ''}
              onClick={() => handleClickChangeCharacterDirectionButton(CharacterDirection.Up)}
            >
              ↑
            </Button>
            <Button
              border={CharacterDirection.Down === selectedCharacter.direction ? '1px' : ''}
              onClick={() => handleClickChangeCharacterDirectionButton(CharacterDirection.Down)}
            >
              ↓
            </Button>
            <Button
              border={CharacterDirection.Left === selectedCharacter.direction ? '1px' : ''}
              onClick={() => handleClickChangeCharacterDirectionButton(CharacterDirection.Left)}
            >
              ←
            </Button>
            <Button
              border={CharacterDirection.Right === selectedCharacter.direction ? '1px' : ''}
              onClick={() => handleClickChangeCharacterDirectionButton(CharacterDirection.Right)}
            >
              →
            </Button>
          </HStack>
          <HStack>
            <ColorChangeButton
              color={CharacterColor.Red}
              handleOnClick={() => handleChangeCharacterColorButton(CharacterColor.Red)}
              selectedColor={selectedCharacter.color}
            />
            <ColorChangeButton
              color={CharacterColor.Blue}
              handleOnClick={() => handleChangeCharacterColorButton(CharacterColor.Blue)}
              selectedColor={selectedCharacter.color}
            />
            <ColorChangeButton
              color={CharacterColor.Green}
              handleOnClick={() => handleChangeCharacterColorButton(CharacterColor.Green)}
              selectedColor={selectedCharacter.color}
            />
            <ColorChangeButton
              color={CharacterColor.Yellow}
              handleOnClick={() => handleChangeCharacterColorButton(CharacterColor.Yellow)}
              selectedColor={selectedCharacter.color}
            />
            <ColorChangeButton
              color={CharacterColor.Purple}
              handleOnClick={() => handleChangeCharacterColorButton(CharacterColor.Purple)}
              selectedColor={selectedCharacter.color}
            />
            <ColorChangeButton
              color={'white'}
              handleOnClick={() => handleChangeCharacterColorButton('')}
              selectedColor={selectedCharacter.color}
            />
          </HStack>
          <HStack>
            <Button onClick={() => handleRemoveCharacterButton(selectedCharacter)}>削除する</Button>
            <Button onClick={() => handleClickCharacterMoveButton()}>移動する</Button>
          </HStack>
        </>
      )}

      {selectedCell && (
        <>
          <Box>
            <Button onClick={() => handleAddCharacterButton()}>キャラクターを追加する</Button>
          </Box>
          <HStack>
            <ColorChangeButton
              color={CharacterColor.Red}
              handleOnClick={() => handleChangeCellColorButton(CharacterColor.Red)}
              selectedColor={selectedCell.backgroundColor}
            />
            <ColorChangeButton
              color={CharacterColor.Blue}
              handleOnClick={() => handleChangeCellColorButton(CharacterColor.Blue)}
              selectedColor={selectedCell.backgroundColor}
            />
            <ColorChangeButton
              color={CharacterColor.Green}
              handleOnClick={() => handleChangeCellColorButton(CharacterColor.Green)}
              selectedColor={selectedCell.backgroundColor}
            />
            <ColorChangeButton
              color={CharacterColor.Yellow}
              handleOnClick={() => handleChangeCellColorButton(CharacterColor.Yellow)}
              selectedColor={selectedCell.backgroundColor}
            />
            <ColorChangeButton
              color={CharacterColor.Purple}
              handleOnClick={() => handleChangeCellColorButton(CharacterColor.Purple)}
              selectedColor={selectedCell.backgroundColor}
            />
            <ColorChangeButton
              color={'white'}
              handleOnClick={() => handleChangeCellColorButton('')}
              selectedColor={selectedCell.backgroundColor}
            />
          </HStack>
        </>
      )}
    </VStack>
  );
};
