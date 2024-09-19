import type { NextPage } from 'next';

import { Box, Heading, VStack } from '../../../infrastructures/useClient/chakra';

const CoursesPage: NextPage = async () => {
  return (
    <VStack align="stretch" spacing={6}>
      <Heading as="h1">トレース道場の使い方</Heading>
      <Box>TBD</Box>
    </VStack>
  );
};

export default CoursesPage;
