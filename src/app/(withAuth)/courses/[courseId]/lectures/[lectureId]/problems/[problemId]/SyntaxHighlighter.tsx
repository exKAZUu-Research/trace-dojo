import type { BoxProps } from '@chakra-ui/react';
import React from 'react';
import { Prism } from 'react-syntax-highlighter';
import { oneLight } from 'react-syntax-highlighter/dist/cjs/styles/prism';

import { Box } from '../../../../../../../../infrastructures/useClient/chakra';

type SyntaxHighlighterProps = BoxProps & {
  code: string;
  callerLines?: (number | undefined)[];
  currentFocusLine?: number;
  previousFocusLine?: number;
  programmingLanguageId: string;
};

export const SyntaxHighlighter: React.FC<SyntaxHighlighterProps> = ({
  callerLines,
  code,
  currentFocusLine,
  previousFocusLine,
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
        lineNumberStyle={{ minWidth: '1.5rem', marginRight: '2rem', paddingRight: 0 }}
        lineProps={(lineNumber) => {
          const style: React.CSSProperties = { padding: '0 1rem', backgroundColor: '', border: '' };
          // Show dotted border for callerLines
          if (callerLines?.includes(lineNumber)) {
            style.border = '2px dotted #f56565'; /* red.500 */
          }
          // previousFocusLine と currentFocusLine が等しくなるケースがある。
          if (lineNumber === previousFocusLine) {
            style.backgroundColor = '#feebc8' /* orange.100 */;
          }
          if (lineNumber === currentFocusLine) {
            style.border = '4px solid #f56565' /* red.500 */;
            style.padding = '0 calc(1rem - 4px)'; // Adjust margin to compensate for border width
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
