import type React from 'react';

import {
  Box,
  Table,
  TableContainer,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
  VStack,
} from '../../../../../../../../infrastructures/useClient/chakra';
import type { DisplayNode, TraceItemVariable } from '../../../../../../../../problems/traceProgram';

interface VariablesProps {
  traceItemVars: TraceItemVariable;
  referenceVars?: Record<string, DisplayNode>;
}

interface ReferenceNodeProps {
  path: string;
  node: DisplayNode;
}

export const Variables: React.FC<VariablesProps> = ({ traceItemVars, referenceVars = {} }) => {
  const references = Object.entries(referenceVars);
  const referencePaths = new Set(references.flatMap(([name, node]) => collectPaths(name, node)));
  const variables = Object.entries(traceItemVars).filter(([name]) => !referencePaths.has(name));

  return (
    <VStack align="stretch" spacing={3} textAlign="left">
      {variables.length > 0 && (
        <TableContainer>
          <Table>
            <Thead>
              <Tr>
                <Th>変数/式</Th>
                <Th isNumeric w="0">
                  値
                </Th>
              </Tr>
            </Thead>
            <Tbody>
              {variables.map(([name, value]) => (
                <Tr key={name}>
                  <Td fontFamily="mono">{name}</Td>
                  <Td isNumeric fontFamily="mono">
                    {Array.isArray(value) ? value.join(', ') : value}
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        </TableContainer>
      )}
      {references.map(([name, node]) => (
        <ReferenceNode key={name} node={node} path={name} />
      ))}
    </VStack>
  );
};

const ReferenceNode: React.FC<ReferenceNodeProps> = ({ path, node }) => {
  if (node.kind === 'value') {
    return (
      <Box fontFamily="mono">
        {path}: {formatScalar(node.value)}
      </Box>
    );
  }

  const children = Object.entries(node.entries);
  const values = children.filter(([, child]) => child.kind === 'value');
  const nested = children.filter(([, child]) => child.kind !== 'value');

  return (
    <details open={path === 'this'}>
      <summary>
        <Box as="span" fontFamily="mono">
          {path}
        </Box>{' '}
        <Box as="span" color="gray.600" overflowWrap="anywhere" whiteSpace="normal">
          {formatSummary(node)}
        </Box>
      </summary>
      <VStack align="stretch" pl={4} spacing={2}>
        {values.length > 0 && (
          <TableContainer>
            <Table size="sm">
              <Tbody>
                {values.map(([key, child]) => (
                  <Tr key={key}>
                    <Td fontFamily="mono">
                      <Box as="span">{childPath(path, node.kind, key)}</Box>
                    </Td>
                    <Td isNumeric fontFamily="mono">
                      {child.kind === 'value' && formatScalar(child.value)}
                    </Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          </TableContainer>
        )}
        {nested.map(([key, child]) => (
          <ReferenceNode key={key} node={child} path={childPath(path, node.kind, key)} />
        ))}
      </VStack>
    </details>
  );
};

const collectPaths = (path: string, node: DisplayNode): string[] => {
  if (node.kind === 'value') return [path];
  return [
    path,
    ...Object.entries(node.entries).flatMap(([key, child]) => collectPaths(childPath(path, node.kind, key), child)),
  ];
};

const childPath = (path: string, kind: 'object' | 'array', key: string): string =>
  kind === 'array' ? `${path}[${key}]` : `${path}.${key}`;

const formatSummary = (node: DisplayNode): string => {
  if (node.kind === 'value') return formatScalar(node.value);
  const entries = Object.entries(node.entries);
  if (entries.length === 0) return node.kind === 'array' ? '[]' : '{}';
  if (node.kind === 'array') return formatPreview(node);
  return entries.map(([key, child]) => `${key}=${formatPreview(child)}`).join(', ');
};

const formatPreview = (node: DisplayNode, depth = 0): string => {
  if (node.kind === 'value') return formatScalar(node.value);
  if (depth >= 2) return node.kind === 'array' ? '[…]' : '{…}';
  const entries = Object.entries(node.entries);
  const preview = entries
    .slice(0, 3)
    .map(([key, child]) => `${key}=${formatPreview(child, depth + 1)}`)
    .join(', ');
  const suffix = entries.length > 3 ? ', …' : '';
  return node.kind === 'array' ? `[${preview}${suffix}]` : `{${preview}${suffix}}`;
};

const formatScalar = (value: number | string | boolean | null): string =>
  typeof value === 'string' ? JSON.stringify(value) : String(value);
