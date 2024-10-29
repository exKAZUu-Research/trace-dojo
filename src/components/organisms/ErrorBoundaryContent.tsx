import { Box, Code, Heading, Stack, Text } from '@chakra-ui/react';
import React, { useEffect } from 'react';
import { MdContentCopy } from 'react-icons/md';

import { Button } from '@/components/ui/button';
import { toaster } from '@/components/ui/toaster';

export const ErrorBoundaryContent: React.FC<{ error: Error & { digest?: string }; reset: () => void }> = ({
  error,
  reset,
}) => {
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

  const handleCopy = (): void => {
    void navigator.clipboard.writeText(errorText);
    toaster.success({
      description: 'コピーしました',
      duration: 2000,
    });
  };

  return (
    <Stack gap={4}>
      <Heading as="h2" color="red.500" size="xl">
        エラーが発生しました
      </Heading>
      <Text>
        予期せぬエラーが発生しました。問題が解決しない場合は、以下のエラー全文を坂本 (sakamoto.kazunori@internet.ac.jp)
        にお知らせください。
      </Text>
      <Button colorPalette="blue" onClick={reset}>
        再試行
      </Button>
      <Box bg="gray.100" border="1px solid" borderColor="gray.300" borderRadius="md" p={3} position="relative">
        <Button colorPalette="brand" position="absolute" right={2} size="sm" top={2} onClick={handleCopy}>
          <MdContentCopy />
          コピー
        </Button>
        <Code display="block" fontFamily="monospace" overflowX="auto" whiteSpace="pre-wrap">
          {errorText}
        </Code>
      </Box>
    </Stack>
  );
};
