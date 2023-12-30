import { Button, Heading, Text, VStack } from '@chakra-ui/react';
import type { NextPage } from 'next';
import NextLink from 'next/link';

import { prisma } from '../../infrastructures/prisma';

const HomePage: NextPage = async () => {
  const users = await prisma.user.findMany();

  return (
    <VStack align="stretch" spacing={16}>
      <VStack bg="gray.100" py={16} rounded="xl" spacing={8}>
        <Heading as="div" lineHeight="base" size="2xl" textAlign="center">
          トレーシング力を鍛えよう
        </Heading>
        <Button as={NextLink} colorScheme="brand" href="/courses" size="lg">
          今すぐはじめる
        </Button>
        <ul>
          {users.map((user) => (
            <li key={user.id}>
              <Text>{user.superTokensUserId}</Text>
            </li>
          ))}
        </ul>
      </VStack>
    </VStack>
  );
};

export default HomePage;
