import { Box, Heading, Link, List, ListItem, Text } from '@chakra-ui/react';
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
              <NextLink passHref href={`/courses/${id}`}>
                <Link>{courseIdToName[id]}</Link>
              </NextLink>
            </ListItem>
          ))}
        </List>
      </Box>
    </main>
  );
};

export default CoursesPage;
