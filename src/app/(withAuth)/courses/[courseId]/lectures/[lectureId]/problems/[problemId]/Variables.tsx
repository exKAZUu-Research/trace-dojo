import type React from 'react';
import { useImmer } from 'use-immer';

import {
  Box,
  Table,
  TableContainer,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
} from '../../../../../../../../infrastructures/useClient/chakra';
import type { DisplayNode, TraceItemVariable } from '../../../../../../../../problems/traceProgram';

interface VariablesProps {
  traceItemVars: TraceItemVariable;
  referenceVars?: Record<string, DisplayNode>;
}

type DisplayRow =
  | { kind: 'scalar'; path: string; depth: number; text: string }
  | {
      kind: 'reference';
      path: string;
      depth: number;
      node: Extract<DisplayNode, { kind: 'object' | 'array' }>;
      expanded: boolean;
    };

export const Variables: React.FC<VariablesProps> = ({ traceItemVars, referenceVars = {} }) => {
  const [expandedPaths, updateExpandedPaths] = useImmer<Record<string, boolean>>({});
  const rows = buildDisplayRows(traceItemVars, referenceVars, expandedPaths);

  if (rows.length === 0) return <></>;

  return (
    <TableContainer textAlign="left">
      <Table>
        <Thead>
          <Tr>
            <Th pl="32px">変数/式</Th>
            <Th isNumeric w="0">
              値
            </Th>
          </Tr>
        </Thead>
        <Tbody>
          {rows.map((row) =>
            row.kind === 'reference' ? (
              <Tr key={row.path}>
                <Td colSpan={2} p={0}>
                  <Box
                    _focusVisible={{ outline: '2px solid', outlineColor: 'blue.500', outlineOffset: '2px' }}
                    _hover={{ bg: 'gray.100' }}
                    alignItems="baseline"
                    aria-expanded={row.expanded}
                    as="button"
                    bg="transparent"
                    border="0"
                    borderRadius="sm"
                    color="inherit"
                    cursor="pointer"
                    display="flex"
                    fontFamily="mono"
                    fontSize="inherit"
                    lineHeight="inherit"
                    pl={`${16 + row.depth * 16}px`}
                    pr="16px"
                    py="8px"
                    textAlign="left"
                    type="button"
                    w="100%"
                    onClick={() => {
                      updateExpandedPaths((draft) => {
                        draft[row.path] = !row.expanded;
                      });
                    }}
                  >
                    <Box aria-hidden="true" as="span" flexShrink={0} w="16px">
                      {row.expanded ? '▾' : '▸'}
                    </Box>
                    <Box as="span" flexShrink={0}>
                      {row.path}
                    </Box>
                    <Box as="span" color="gray.400" minW={0} ml="16px" overflowWrap="anywhere" whiteSpace="normal">
                      {formatSummary(row.node)}
                    </Box>
                  </Box>
                </Td>
              </Tr>
            ) : (
              <Tr key={row.path}>
                <Td fontFamily="mono" pl={`${32 + row.depth * 16}px`} py="8px">
                  {row.path}
                </Td>
                <Td isNumeric fontFamily="mono" py="8px">
                  {row.text}
                </Td>
              </Tr>
            )
          )}
        </Tbody>
      </Table>
    </TableContainer>
  );
};

const buildDisplayRows = (
  traceItemVars: TraceItemVariable,
  referenceVars: Record<string, DisplayNode>,
  expandedPaths: Record<string, boolean>
): DisplayRow[] => {
  const references = Object.entries(referenceVars);
  const referencePaths = new Set(references.flatMap(([name, node]) => collectPaths(name, node)));
  const rows: DisplayRow[] = Object.entries(traceItemVars)
    .filter(([name]) => !referencePaths.has(name))
    .map(([path, value]) => ({
      kind: 'scalar',
      path,
      text: Array.isArray(value) ? value.join(', ') : String(value),
      depth: 0,
    }));

  for (const [path, node] of references) appendReferenceRows(rows, path, node, 0, expandedPaths);
  return rows;
};

const appendReferenceRows = (
  rows: DisplayRow[],
  path: string,
  node: DisplayNode,
  depth: number,
  expandedPaths: Record<string, boolean>
): void => {
  if (node.kind === 'value') {
    rows.push({ kind: 'scalar', path, text: formatScalar(node.value), depth });
    return;
  }

  const expanded = expandedPaths[path] ?? path === 'this';
  rows.push({ kind: 'reference', path, node, depth, expanded });
  if (!expanded) return;
  for (const [key, child] of Object.entries(node.entries)) {
    appendReferenceRows(rows, childPath(path, node.kind, key), child, depth + 1, expandedPaths);
  }
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
