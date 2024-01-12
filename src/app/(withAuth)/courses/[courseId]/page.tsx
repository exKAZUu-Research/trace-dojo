import { Box, Heading, OrderedList, ListItem, VStack } from '@chakra-ui/react';
import type { NextPage } from 'next';

import { courseIdToProgramIdLists, programIdToName } from '../../../../problems/problemData';

const CoursePage: NextPage<{ params: { courseId: string } }> = async ({ params }) => {
  return (
    <main>
      <Heading as="h1">Lessons</Heading>
      <VStack align="stretch">
        {courseIdToProgramIdLists[params.courseId].map((programIds, iLesson) => (
          <Box key={iLesson}>
            <Heading as="h2" size="md">
              第{iLesson + 1}回
            </Heading>
            <OrderedList>
              {programIds.map((programId) => (
                <ListItem key={programId}>{programIdToName[programId]}</ListItem>
              ))}
            </OrderedList>
          </Box>
        ))}
      </VStack>
    </main>
  );
};

export default CoursePage;
