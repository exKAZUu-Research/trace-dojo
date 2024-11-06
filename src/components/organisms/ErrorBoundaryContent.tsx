import React, { useEffect } from 'react';
import { MdContentCopy } from 'react-icons/md';

import { Box, Button, Code, Heading, Text, useToast, VStack } from '@/infrastructures/useClient/chakra';

export const ErrorBoundaryContent: React.FC<{ error: Error & { digest?: string }; reset: () => void }> = ({
  error,
  reset,
}) => {
  const toast = useToast();
  const errorText = `Error:
  - Name: ${error.name}
  - Digest: ${error.digest}
  - Message: ${error.message}
  - Stack: ----------- start -----------
${error.stack}
  ---------------- end -----------------`;

  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <VStack align="stretch" spacing={4}>
      <Heading as="h2" color="red.500" size="xl">
        エラーが発生しました
      </Heading>
      <Text>
        予期せぬエラーが発生しました。問題が解決しない場合は、以下のエラー全文を坂本 (sakamoto.kazunori@internet.ac.jp)
        にお知らせください。
      </Text>
      <Button colorScheme="blue" onClick={reset}>
        再試行
      </Button>
      <Box bg="gray.100" border="1px solid" borderColor="gray.300" borderRadius="md" p={3} position="relative">
        <Button
          colorScheme="brand"
          leftIcon={<MdContentCopy />}
          position="absolute"
          right={2}
          size="sm"
          top={2}
          onClick={() => {
            void navigator.clipboard.writeText(errorText);
            toast({
              title: 'コピーしました',
              status: 'success',
              duration: 2000,
              isClosable: true,
            });
          }}
        >
          コピー
        </Button>
        <Code display="block" fontFamily="monospace" overflowX="auto" whiteSpace="pre-wrap">
          {errorText}
        </Code>
      </Box>
    </VStack>
  );
};
