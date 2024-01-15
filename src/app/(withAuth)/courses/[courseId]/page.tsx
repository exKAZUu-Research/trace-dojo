import {
  Box,
  Heading,
  OrderedList,
  ListItem,
  VStack,
  Accordion,
  AccordionItem,
  AccordionButton,
  AccordionIcon,
  AccordionPanel,
} from '@chakra-ui/react';
import type { NextPage } from 'next';
import NextLink from 'next/link';

import { courseIdToProgramIdLists, programIdToName } from '../../../../problems/problemData';

const CoursePage: NextPage<{ params: { courseId: string } }> = async ({ params }) => {
  return (
    <main>
      <Heading as="h1">Lessons</Heading>
      <VStack align="stretch">
        {courseIdToProgramIdLists[params.courseId].map((programIds, iLesson) => (
          <Box key={iLesson}>
            <Accordion allowToggle>
              <AccordionItem>
                <AccordionButton>
                  <Box flex="1" textAlign="left">
                    第{iLesson + 1}回
                  </Box>
                  <AccordionIcon />
                </AccordionButton>
                <AccordionPanel pb={4}>
                  <OrderedList>
                    {programIds.map((programId) => (
                      <ListItem key={programId}>
                        <NextLink passHref href={`/problems/${programId}`}>
                          {programIdToName[programId]}
                        </NextLink>
                      </ListItem>
                    ))}
                  </OrderedList>
                </AccordionPanel>
              </AccordionItem>
            </Accordion>
          </Box>
        ))}
      </VStack>
    </main>
  );
};

export default CoursePage;
