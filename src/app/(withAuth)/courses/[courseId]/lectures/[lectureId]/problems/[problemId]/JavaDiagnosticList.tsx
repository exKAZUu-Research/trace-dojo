import type React from 'react';

import { Box, Heading } from '@/infrastructures/useClient/chakra';
import { javaOriginalMessageLabel, type JavaDiagnostic } from '@/problems/fillInBlank/javaDiagnostics';

export const JavaDiagnosticList: React.FC<{ diagnostics: JavaDiagnostic[] }> = ({ diagnostics }) => (
  <Box as="ul" listStyleType="none" m={0} p={0} whiteSpace="normal">
    {diagnostics.map((item, index) => (
      <Box
        as="li"
        key={index}
        borderTopWidth={index ? '1px' : 0}
        pt={index ? 4 : 0}
        mt={index ? 4 : 0}
        overflowWrap="anywhere"
      >
        <Heading as="h3" size="sm" mb={2}>
          {item.line ? `${item.line}行目付近` : 'コード全体'}
        </Heading>
        <Box as="p" whiteSpace="pre-wrap">
          {item.message}
        </Box>
        {item.originalMessage && (
          <Box mt={3} p={3} bg="gray.50" rounded="md" color="gray.600" fontSize="sm">
            <Box as="p" mb={1}>
              {javaOriginalMessageLabel}
            </Box>
            <Box as="p" whiteSpace="pre-wrap">
              {item.originalMessage}
            </Box>
          </Box>
        )}
      </Box>
    ))}
  </Box>
);
