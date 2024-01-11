import { Button, Heading, VStack } from '@chakra-ui/react';
import type { NextPage } from 'next';
import NextLink from 'next/link';

const HomePage: NextPage = async () => {
  return (
    <VStack align="stretch" spacing={16}>
      <VStack bg="gray.100" py={16} rounded="xl" spacing={8}>
        <Heading as="div" lineHeight="base" size="2xl" textAlign="center">
          トレーシング力を鍛えよう
        </Heading>
        <Button as={NextLink} colorScheme="brand" href="/courses" size="lg">
          今すぐはじめる
        </Button>
      </VStack>
    </VStack>
  );
};

export default HomePage;
