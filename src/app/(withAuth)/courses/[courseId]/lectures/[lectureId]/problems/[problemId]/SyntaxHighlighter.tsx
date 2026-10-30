import type { BoxProps } from '@chakra-ui/react';
import type React from 'react';
import { useState } from 'react';
import { MdOutlineZoomIn, MdOutlineZoomOut } from 'react-icons/md';
import { Prism } from 'react-syntax-highlighter';
import { oneLight } from 'react-syntax-highlighter/dist/cjs/styles/prism';

import { JavaSyntaxHints } from './JavaSyntaxHints';

import { Box, IconButton } from '../../../../../../../../infrastructures/useClient/chakra';

type SyntaxHighlighterProps = BoxProps & {
  code: string;
  enableSyntaxHints?: boolean;
  callerLines?: (number | undefined)[];
  currentFocusLine?: number;
  previousFocusLine?: number;
  programmingLanguageId: string;
};

export const SyntaxHighlighter: React.FC<SyntaxHighlighterProps> = ({
  callerLines,
  code,
  currentFocusLine,
  enableSyntaxHints = false,
  previousFocusLine,
  programmingLanguageId,
  ...boxProps
}) => {
  const [fontSize, setFontSize] = useState(1);
  const hintsEnabled = enableSyntaxHints && programmingLanguageId === 'java';
  const handleZoomIn = (): void => {
    setFontSize((prev) => Math.min(prev + 0.1, 2));
  };
  const handleZoomOut = (): void => {
    setFontSize((prev) => Math.max(prev - 0.1, 0.5));
  };

  return (
    <Box position="relative" {...boxProps}>
      <Box position="absolute" right="0.5rem" top="0.5rem" zIndex="1">
        <IconButton aria-label="Zoom out" icon={<MdOutlineZoomOut size={24} />} mr={2} onClick={handleZoomOut} />
        <IconButton aria-label="Zoom in" icon={<MdOutlineZoomIn size={24} />} onClick={handleZoomIn} />
      </Box>
      <Box
        sx={{
          '.java-syntax-hint': {
            cursor: 'inherit',
            _focusVisible: { outline: '2px solid', outlineColor: 'blue.600', outlineOffset: '2px' },
          },
        }}
        bg="white"
        overflow="auto"
        role={hintsEnabled ? 'group' : undefined}
        aria-label={hintsEnabled ? 'Java の構文ヒント' : undefined}
      >
        <Prism
          codeTagProps={{
            style: {
              display: 'flex',
              flexDirection: 'column',
              fontSize: `${fontSize}rem`,
            },
          }}
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
            if (callerLines?.includes(lineNumber)) {
              style.border = '2px dotted #f56565';
            }
            if (lineNumber === previousFocusLine) {
              style.backgroundColor = '#feebc8';
            }
            if (lineNumber === currentFocusLine) {
              style.border = '4px solid #f56565';
              style.padding = '0 calc(1rem - 4px)';
            }
            return { style };
          }}
          renderer={hintsEnabled ? (props) => <JavaSyntaxHints key={code} {...props} /> : undefined}
          showLineNumbers={true}
          style={oneLight}
          wrapLines={true}
        >
          {code || ''}
        </Prism>
      </Box>
    </Box>
  );
};
