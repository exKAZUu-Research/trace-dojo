import { Box, Table, TableCaption, TableContainer, Tbody, Td, Th, Thead, Tr, VStack } from '@chakra-ui/react';
import React from 'react';

import type { CharacterDirection, CharacterVariable, Variable } from '../../../../../../types';

interface VariablesProps {
  characterVariables?: CharacterVariable[];
  variables?: Variable[];
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

export const Variables: React.FC<VariablesProps> = ({ characterVariables, variables }) => {
  return (
    <VStack>
      <TableContainer w="100%">
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
            {characterVariables?.map((variable) => (
              <Tr key={variable.value.id}>
                <Td>{variable.name}</Td>
                <Td>{variable.value.name}</Td>
                <Td>
                  <Box bg={variable.value.color} h="20px" w="20px" />
                </Td>
                <Td>{directionJapanese[variable.value.direction]}</Td>
                <Td>{penStateJapanese(variable.value.penDown)}</Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      </TableContainer>
      <TableContainer mb="4" w="100%">
        <Table variant="simple">
          <TableCaption placement="top">変数</TableCaption>
          <Thead>
            <Tr>
              <Th>変数名</Th>
              <Th>値</Th>
            </Tr>
          </Thead>
          <Tbody>
            {variables?.map((variable) => (
              <Tr key={variable.name}>
                <Td>{variable.name}</Td>
                <Td>{variable.value}</Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      </TableContainer>
    </VStack>
  );
};
