import { Box, Table, TableCaption, TableContainer, Tbody, Td, Th, Thead, Tr } from '@chakra-ui/react';
import React from 'react';

import type { Character } from '../../app/lib/Character';
import type { CharacterDirection } from '../../types';

interface VariablesProps {
  characters?: Character[];
}

const directionJapanese: { [key in CharacterDirection]: string } = {
  up: '上',
  down: '下',
  left: '左',
  right: '右',
};

const penStateJapanese = (penDown: boolean): string => {
  return penDown ? 'おいている' : 'あげている';
};

export const Variables: React.FC<VariablesProps> = ({ characters }) => {
  return (
    <TableContainer mb="4" w="100%">
      <Table variant="simple">
        <TableCaption placement="top">キャラクター</TableCaption>
        <Thead>
          <Tr>
            <Th>変数名</Th>
            <Th>名前</Th>
            <Th>線の色</Th>
            <Th>向き</Th>
            <Th>ペンの状態</Th>
          </Tr>
        </Thead>
        <Tbody>
          {characters?.map((character) => (
            <Tr key={character.id}>
              <Td></Td>
              <Td>{character.name}</Td>
              <Td>
                <Box bg={character.color} h="20px" w="20px" />
              </Td>
              <Td>{directionJapanese[character.direction]}</Td>
              <Td>{penStateJapanese(character.penDown)}</Td>
            </Tr>
          ))}
        </Tbody>
      </Table>
    </TableContainer>
  );
};
