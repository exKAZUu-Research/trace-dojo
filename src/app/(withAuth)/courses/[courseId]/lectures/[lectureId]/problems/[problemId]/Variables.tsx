import React from 'react';

import {
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
import { type TraceItemVariable } from '../../../../../../../../problems/traceProgram';

interface VariablesProps {
  traceItemVars: TraceItemVariable;
}

export const Variables: React.FC<VariablesProps> = ({ traceItemVars }) => {
  const variables = Object.entries(traceItemVars).map(([key, value]) => ({ key, value }));
  return (
    <HStack align="flex-start" divider={<StackDivider />} justify="center" mx={-5}>
      <TableContainer flexBasis={0} flexGrow={1} maxW="80%">
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
            {variables.map((variable) => (
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
