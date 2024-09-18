import React from 'react';

import {
  Box,
  Table,
  TableContainer,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
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
    <>
      <TableContainer maxW="unset" mx={-5}>
        <Table>
          <Thead>
            <Tr>
              <Th>タートル名</Th>
              <Th w="0">線の色</Th>
              <Th w="0">向き</Th>
            </Tr>
          </Thead>
          <Tbody>
            {characterVars?.map((variable) => (
              <Tr key={variable.key}>
                <Td>{variable.key}</Td>
                <Td py={0}>
                  <Box
                    bg={charToColor[variable.value.color as keyof typeof charToColor]}
                    h="1.5em"
                    rounded="md"
                    w="1.5em"
                  />
                </Td>
                <Td>{dirCharToJapanese[variable.value.dir as keyof typeof dirCharToJapanese]}</Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      </TableContainer>

      <TableContainer maxW="unset" mx={-5}>
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
                <Td>{variable.key}</Td>
                <Td isNumeric>{variable.value}</Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      </TableContainer>
    </>
  );
};
