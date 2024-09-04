import React from 'react';
import { Prism } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/cjs/styles/prism';

import { Box } from '../../infrastructures/useClient/chakra';

interface SyntaxHighlighterProps {
  beforeCheckpointLine?: number;
  code: string;
  programmingLanguageId: string;
  currentCheckpointLine?: number;
}

export const SyntaxHighlighter: React.FC<SyntaxHighlighterProps> = ({
  beforeCheckpointLine,
  code,
  currentCheckpointLine,
  programmingLanguageId,
}) => {
  return (
    <Box h="100%">
      <Prism
        codeTagProps={{ style: { fontSize: '1rem' } }}
        customStyle={{
          backgroundColor: '#011627',
          marginTop: 0,
          overflow: 'auto',
          padding: 10,
          height: '100%',
        }}
        language={programmingLanguageId === 'c' ? 'cpp' : programmingLanguageId}
        lineNumberStyle={{ paddingRight: 0, marginRight: 16, minWidth: '1rem' }}
        lineProps={(lineNumber) => {
          const style: React.CSSProperties = {
            padding: 0,
            backgroundColor: '',
          };
          // チェックポイント問題・ステップ問題のハイライト
          if (lineNumber === beforeCheckpointLine) {
            style.backgroundColor = '#2E3D9F';
          } else if (lineNumber === currentCheckpointLine) {
            style.backgroundColor = '#744210';
          }
          return { style };
        }}
        showLineNumbers={true}
        style={vscDarkPlus}
        wrapLines={true}
      >
        {code ?? ''}
      </Prism>
    </Box>
  );
};
