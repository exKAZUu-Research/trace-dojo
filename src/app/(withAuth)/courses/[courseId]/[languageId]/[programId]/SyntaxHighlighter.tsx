'use client';

import type { BoxProps } from '@chakra-ui/react';
import React from 'react';
import { Prism } from 'react-syntax-highlighter';
import { oneLight } from 'react-syntax-highlighter/dist/cjs/styles/prism';

import { Box } from '../../../../../../infrastructures/useClient/chakra';

type SyntaxHighlighterProps = BoxProps & {
  beforeCheckpointLine?: number;
  code: string;
  programmingLanguageId: string;
  currentCheckpointLine?: number;
};

export const SyntaxHighlighter: React.FC<SyntaxHighlighterProps> = ({
  beforeCheckpointLine,
  code,
  currentCheckpointLine,
  programmingLanguageId,
  ...boxProps
}) => {
  return (
    <Box bg="white" overflow="auto" {...boxProps}>
      <Prism
        codeTagProps={{ style: { display: 'flex', flexDirection: 'column', fontSize: '1rem' } }}
        customStyle={{
          background: 'unset',
          margin: 0,
          padding: '1rem 0',
          minWidth: 'max-content',
        }}
        language={programmingLanguageId === 'c' ? 'cpp' : programmingLanguageId}
        lineNumberStyle={{ minWidth: '1rem', marginRight: '2rem', paddingRight: 0 }}
        lineProps={(lineNumber) => {
          const style: React.CSSProperties = { padding: '0 1rem', backgroundColor: '' };
          // チェックポイント問題・ステップ問題のハイライト
          if (lineNumber === beforeCheckpointLine) {
            style.backgroundColor = '#feebc8' /* orange.100 */;
          }
          if (lineNumber === currentCheckpointLine) {
            style.backgroundColor = '#fed7d7' /* red.100 */;
          }
          return { style };
        }}
        showLineNumbers={true}
        style={oneLight}
        wrapLines={true}
      >
        {code ?? ''}
      </Prism>
    </Box>
  );
};
