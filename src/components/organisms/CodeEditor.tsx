import { Box } from '@chakra-ui/react';
import React from 'react';
import { Prism } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/cjs/styles/prism';

interface CodeEditorProps {
  code: string;
  programmingLanguageId: string;
}

export const CodeEditor: React.FC<CodeEditorProps> = ({ code: code, programmingLanguageId: programmingLanguageId }) => {
  return (
    <Box bgColor="#011627" h="100%" overflowY="auto" pb={2}>
      <Prism
        codeTagProps={{ style: { fontSize: '1rem' } }}
        customStyle={{
          backgroundColor: 'transparent',
          marginTop: 0,
          overflow: 'auto',
          padding: 0,
        }}
        language={programmingLanguageId === 'c' ? 'cpp' : programmingLanguageId}
        lineNumberStyle={{ paddingRight: 0, marginRight: 10 }}
        // lineProps={(lineNumber) => {
        lineProps={() => {
          const style = {
            backgroundColor: 'transparent',
            marginTop: 0,
            overflow: 'auto',
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
