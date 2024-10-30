import { Card, Heading, LinkBox, LinkOverlay, SimpleGrid, VStack, Text } from '@chakra-ui/react';
import type { NextPage } from 'next';
import NextLink from 'next/link';

import { courseIds, courseIdToName } from '../../problems/problemData';

const HomePage: NextPage = async () => {
  return (
    <VStack align="stretch" gap={16}>
      <Heading as="div" lineHeight={1.25} py={16} size="6xl">
        <Text as="span" color={'brand.solid'}>
          トレーシング力
        </Text>
        を<br />
        鍛えよう
      </Heading>

      <VStack align="stretch" gap={6}>
        <Heading as="h2">コース</Heading>

        <SimpleGrid columns={{ base: 1, md: 2 }} gap={4}>
          {courseIds.map((id) => (
            <LinkBox
              key={id}
              asChild
              css={{
                '&:hover': { boxShadow: 'var(--chakra-shadows-md)' },
              }}
            >
              <Card.Root
                p={6}
                style={{
                  transitionDuration: 'var(--chakra-transition-duration-normal)',
                  transitionProperty: 'box-shadow',
                }}
              >
                <Heading as="h3" size="md">
                  <LinkOverlay asChild>
                    <NextLink href={`/courses/${id}`}>{courseIdToName[id]}</NextLink>
                  </LinkOverlay>
                </Heading>
              </Card.Root>
            </LinkBox>
          ))}
        </SimpleGrid>
      </VStack>
    </VStack>
  );
};

export default HomePage;
