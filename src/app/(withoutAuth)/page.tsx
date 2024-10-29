import { Box, Card, Heading, LinkBox, LinkOverlay, SimpleGrid, VStack } from '@chakra-ui/react';
import type { NextPage } from 'next';
import NextLink from 'next/link';

import { courseIds, courseIdToName } from '../../problems/problemData';

const HomePage: NextPage = async () => {
  return (
    <VStack align="stretch" gap={16}>
      <Heading as="div" lineHeight={1.25} py={16} textStyle="4xl">
        <Box asChild>
          <span style={{ color: 'var(--chakra-colors-red-500)' }}>トレーシング力</span>
        </Box>
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
                <Heading as="h3" textStyle="md">
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
