import React from 'react';

import {
  Box,
  Table,
  TableCaption,
  TableContainer,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
  VStack,
} from '../../../../../../infrastructures/useClient/chakra';
import { charToColor, type TraceItemVar } from '../../../../../../problems/traceProgram';

interface VariablesProps {
  traceItemVars?: TraceItemVar;
}

export const dirCharToJapanese = {
  N: '上',
  E: '右',
  S: '下',
  W: '左',
};

const penStateJapanese = (penDown: boolean): string => {
  return penDown ? 'おいている' : 'あげている';
};

export const Variables: React.FC<VariablesProps> = ({ traceItemVars }) => {
  const characterVars = [];
  const otherVars = [];
  for (const key in traceItemVars) {
    const value = traceItemVars[key];
    if (typeof value === 'string' || typeof value === 'number') {
      otherVars.push({ key, value });
    } else if (value.dir && value.color) {
      characterVars.push({ key, value });
    }
  }

  return (
    <VStack>
      <TableContainer w="100%">
        <Table variant="simple">
          <TableCaption placement="top">キャラクター</TableCaption>
          <Thead>
            <Tr>
              <Th>変数名</Th>
              <Th>線の色</Th>
              <Th>向き</Th>
              <Th>ペンの状態</Th>
            </Tr>
          </Thead>
          <Tbody>
            {characterVars?.map((variable) => (
              <Tr key={variable.key}>
                <Td>{variable.key}</Td>
                <Td>
                  <Box bg={charToColor[variable.value.color as keyof typeof charToColor]} h="20px" w="20px" />
                </Td>
                <Td>{dirCharToJapanese[variable.value.dir as keyof typeof dirCharToJapanese]}</Td>
                <Td>{penStateJapanese(variable.value.pen)}</Td>
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
            {otherVars?.map((variable) => (
              <Tr key={variable.key}>
                <Td>{variable.key}</Td>
                <Td>{variable.value}</Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      </TableContainer>
    </VStack>
  );
};
