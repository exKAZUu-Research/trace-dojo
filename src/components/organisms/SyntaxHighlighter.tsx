import { Box } from '@chakra-ui/react';
import React from 'react';
import { Prism } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/cjs/styles/prism';

interface SyntaxHighlighterProps {
  code: string;
  programmingLanguageId: string;
}

export const SyntaxHighlighter: React.FC<SyntaxHighlighterProps> = ({
  code: code,
  programmingLanguageId: programmingLanguageId,
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
        // lineProps={(lineNumber) => {
        lineProps={() => {
          const style = {
            padding: 0,
          };
          // TODO: チェックポイント問題・ステップ問題のハイライト
          // if (isStepPage && problem && lineNumber === problem.traceList[highlightedLineCount].row + 1) {
          //   style.backgroundColor = '#744210';
          // }
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
