import type { NextPage } from 'next';
import NextLink from 'next/link';

import { Box, Heading, LinkBox, LinkOverlay, List, ListItem } from '../../../infrastructures/useClient/chakra';
import { courseIds, courseIdToName } from '../../../problems/problemData';

const CoursesPage: NextPage = async () => {
  return (
    <main>
      <Box>
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
