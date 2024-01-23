'use client';

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
  Select,
} from '@chakra-ui/react';
import type { NextPage } from 'next';
import NextLink from 'next/link';
import React, { useState } from 'react';

import { courseIdToProgramIdLists, languageIds, programIdToName } from '../../../../problems/problemData';

const CoursePage: NextPage<{ params: { courseId: string } }> = ({ params }) => {
  const [selectedLanguageId, setSelectedLanguageId] = useState('java');

  const handleSelectLanguage = (event: React.ChangeEvent<HTMLSelectElement>): void => {
    setSelectedLanguageId(event.target.value);
  };

  return (
    <main>
      <Heading as="h1" marginBottom="4">
        Lessons
      </Heading>
      <Select
        marginBottom="4"
        maxW="300"
        placeholder="Select language"
        value={selectedLanguageId}
        onChange={(e) => handleSelectLanguage(e)}
      >
        {languageIds.map((languageId) => (
          <option key={languageId} value={languageId}>
            {languageId}
          </option>
        ))}
      </Select>
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
