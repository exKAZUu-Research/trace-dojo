import React from 'react';

import {
  Box,
  HStack,
  StackDivider,
  Table,
  TableContainer,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
} from '../../../../../../../../infrastructures/useClient/chakra';
import { charToColor, type TraceItemVariable } from '../../../../../../../../problems/traceProgram';

interface VariablesProps {
  traceItemVars?: TraceItemVariable;
}

export const dirCharToJapanese = {
  N: '上',
  E: '右',
  S: '下',
  W: '左',
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
    <HStack align="flex-start" divider={<StackDivider />} mx={-5}>
      <TableContainer flexBasis={0} flexGrow={1} maxW="unset" overflowX="visible">
        <Table>
          <Thead>
            <Tr>
              <Th>タートルの変数名</Th>
              <Th w="0">向き</Th>
              <Th w="0">線の色</Th>
            </Tr>
          </Thead>
          <Tbody>
            {characterVars?.map((variable) => (
              <Tr key={variable.key}>
                <Td fontFamily="mono">{variable.key}</Td>
                <Td>{dirCharToJapanese[variable.value.dir as keyof typeof dirCharToJapanese]}</Td>
                <Td py={0}>
                  <Box
                    bg={charToColor[variable.value.color as keyof typeof charToColor]}
                    h="1.5em"
                    rounded="md"
                    w="1.5em"
                  />
                </Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      </TableContainer>

      <TableContainer flexBasis={0} flexGrow={1} maxW="unset">
        <Table>
          <Thead>
            <Tr>
              <Th>変数名</Th>
              <Th isNumeric w="0">
                値
              </Th>
            </Tr>
          </Thead>
          <Tbody>
            {otherVars?.map((variable) => (
              <Tr key={variable.key}>
                <Td fontFamily="mono">{variable.key}</Td>
                <Td isNumeric fontFamily="mono">
                  {variable.value}
                </Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      </TableContainer>
    </HStack>
  );
};
