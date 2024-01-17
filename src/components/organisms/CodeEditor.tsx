import { Box } from '@chakra-ui/react';
import React, { createRef } from 'react';
import { Prism } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/cjs/styles/prism';

interface CodeEditorProps {
  code: string;
  programmingLanguageId: string;
}

export const CodeEditor: React.FC<CodeEditorProps> = ({ code: code, programmingLanguageId: programmingLanguageId }) => {
  const scrollRef = createRef<HTMLDivElement>();
  const scrollContentRef = createRef<HTMLDivElement>();

  return (
    <Box ref={scrollRef} bgColor="#011627" flexGrow={1} flexShrink={1} minH={0} overflowX="hidden" overflowY="auto">
      <Box ref={scrollContentRef} pb={2}>
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
    </Box>
  );
};
