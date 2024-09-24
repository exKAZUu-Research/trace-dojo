import type { ErrorInfo } from 'react';
import type React from 'react';
import { Component } from 'react';
import { MdContentCopy } from 'react-icons/md';

import { logger } from '../../infrastructures/pino';
import { Box, Button, Code, Heading, Text, VStack, useToast } from '../../infrastructures/useClient/chakra';

type Props = {
  children: React.ReactNode;
};

type State = {
  hasError: boolean;
  error?: Error;
  errorInfo?: ErrorInfo;
};

export class ErrorBoundary extends Component<Props, State> {
  static getDerivedStateFromError(error: Error): State {
    logger.error('getDerivedStateFromError:', error);
    return { hasError: true, error };
  }
  constructor(props: Props) {
    super(props);

    this.state = { hasError: false };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    logger.error('componentDidCatch:', { error, errorInfo });
    this.setState({ hasError: true, error, errorInfo });
  }
  render(): React.ReactNode {
    if (this.state.hasError) {
      const errorText = `Error:
  - Name: ${this.state.error?.name}
  - Message: ${this.state.error?.message}
  - Stack: ----------- start -----------
${this.state.error?.stack}
  ---------------- end -----------------

Error Info:
  - Componet Stack: ----------- start -----------
${this.state.errorInfo?.componentStack}
  -------------------- end ----------------------`;

      return <ErrorBoundaryContent errorText={errorText} onReset={() => this.setState({ hasError: false })} />;
    }

    return this.props.children;
  }
}

const ErrorBoundaryContent: React.FC<{ errorText: string; onReset: () => void }> = ({ errorText, onReset }) => {
  const toast = useToast();

  return (
    <Box borderRadius="lg" borderWidth={1} boxShadow="md" p={4}>
      <VStack align="stretch" spacing={4}>
        <Heading as="h2" color="red.500" size="xl">
          エラーが発生しました
        </Heading>
        <Text>
          予期せぬエラーが発生しました。問題が解決しない場合は、以下のエラー全文を坂本
          (sakamoto.kazunori@internet.ac.jp) にお知らせください。
        </Text>
        <Button colorScheme="blue" onClick={onReset}>
          再試行
        </Button>
        <Box bg="gray.100" borderRadius="md" p={3} position="relative">
          <Button
            leftIcon={<MdContentCopy />}
            position="absolute"
            right={2}
            size="sm"
            top={2}
            onClick={() => {
              navigator.clipboard.writeText(errorText);
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
    </Box>
  );
};
