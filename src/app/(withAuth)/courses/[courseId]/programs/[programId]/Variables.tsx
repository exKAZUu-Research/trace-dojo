import { Box, Table, TableCaption, TableContainer, Tbody, Td, Th, Thead, Tr, VStack } from '@chakra-ui/react';
import React from 'react';

import { COLOR_MAP, DIR_JAPANESE } from '../../../../../../components/organisms/TurtleGraphics';
import type { TraceItemVar } from '../../../../../../tracer/traceProgram';

interface VariablesProps {
  traceItemVars?: TraceItemVar;
}

const penStateJapanese = (pen: boolean): string => {
  return pen ? 'おいている' : 'あげている';
};

export const Variables: React.FC<VariablesProps> = ({ traceItemVars }) => {
  const turtleVars = [];
  const otherVars = [];
  for (const key in traceItemVars) {
    const value = traceItemVars[key];
    if (typeof value === 'string' || typeof value === 'number') {
      otherVars.push({ key, value });
    } else if (value.dir && value.color) {
      turtleVars.push({ key, value });
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
            {turtleVars?.map((variable) => (
              <Tr key={variable.key}>
                <Td>{variable.key}</Td>
                <Td>
                  <Box bg={COLOR_MAP[variable.value.color as keyof typeof COLOR_MAP]} h="20px" w="20px" />
                </Td>
                <Td>{DIR_JAPANESE[variable.value.dir as keyof typeof DIR_JAPANESE]}</Td>
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
