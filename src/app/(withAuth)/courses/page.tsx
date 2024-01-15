import { Box, Heading, LinkBox, LinkOverlay, List, ListItem, Text } from '@chakra-ui/react';
import type { NextPage } from 'next';
import NextLink from 'next/link';

import { courseIds, courseIdToName } from '../../../problems/problemData';
import { getNonNullableSessionOnServer } from '../../../utils/session';

const CoursesPage: NextPage = async () => {
  const session = await getNonNullableSessionOnServer();

  return (
    <main>
      <Box>
        <Text>User ID: {session.getUserId()}</Text>
        <Heading as="h1" size="xl">
          Courses
        </Heading>
        <List spacing={3}>
          {courseIds.map((id) => (
            <ListItem key={id}>
              <LinkBox borderWidth="1px" p="5" rounded="md">
                <LinkOverlay passHref as={NextLink} href={`/courses/${id}`}>
                  {courseIdToName[id]}
                </LinkOverlay>
              </LinkBox>
            </ListItem>
          ))}
        </List>
      </Box>
    </main>
  );
};

export default CoursesPage;
