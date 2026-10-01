'use client';

import { Button, Heading, Text, VStack } from '@/infrastructures/useClient/chakra';

interface Props {
  title: string;
  message: string;
}

export const ReloadNotice: React.FC<Props> = ({ title, message }) => (
  <VStack align="stretch" role="alert" spacing={4}>
    <Heading size="md">{title}</Heading>
    <Text>{message}</Text>
    <Button alignSelf="start" colorScheme="brand" onClick={() => globalThis.location.reload()}>
      ページを再読み込み
    </Button>
  </VStack>
);
