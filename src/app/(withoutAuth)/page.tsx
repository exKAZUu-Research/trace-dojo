import type { NextPage } from 'next';
import { cookies } from 'next/headers';

import { NextLinkWithoutPrefetch } from '@/components/atoms/NextLinkWithoutPrefetch';
import { TryRefreshComponent } from '@/components/molecules/TryRefreshComponent';
import { Box, Card, Heading, LinkBox, LinkOverlay, SimpleGrid, VStack } from '@/infrastructures/useClient/chakra';
import { courseIds, courseIdToName } from '@/problems/problemData';
import { getNullableSessionOnServer, getRefreshAttemptKey } from '@/utils/session';

const HomePage: NextPage = async () => {
  const requestCookies = await cookies();
  const { hasToken, session } = await getNullableSessionOnServer(requestCookies);
  if (!session && hasToken) {
    return <TryRefreshComponent key={getRefreshAttemptKey(requestCookies)} />;
  }

  return (
    <VStack align="stretch" spacing={16}>
      <Heading as="div" lineHeight={1.25} py={16} size="4xl">
        <Box as="span" color="red.500">
          トレーシング力
        </Box>
        を<br />
        鍛えよう
      </Heading>

      <VStack align="stretch" spacing={6}>
        <Heading as="h2">コース</Heading>

        <SimpleGrid columns={{ base: 1, md: 2 }} gap={4}>
          {courseIds.map((id) => (
            <LinkBox
              key={id}
              _hover={{ shadow: 'md' }}
              as={Card}
              p={6}
              transitionDuration="normal"
              transitionProperty="box-shadow"
            >
              <Heading as="h3" size="md">
                <LinkOverlay passHref as={NextLinkWithoutPrefetch} href={`/courses/${id}`}>
                  {courseIdToName[id]}
                </LinkOverlay>
              </Heading>
            </LinkBox>
          ))}
        </SimpleGrid>
      </VStack>
    </VStack>
  );
};

export default HomePage;
