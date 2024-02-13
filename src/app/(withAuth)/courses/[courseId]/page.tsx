'use client';

import {
  Box,
  Heading,
  VStack,
  Accordion,
  AccordionItem,
  AccordionButton,
  AccordionIcon,
  AccordionPanel,
  Select,
  Table,
  TableContainer,
  Thead,
  Tbody,
  Tr,
  Td,
  Th,
} from '@chakra-ui/react';
import type { NextPage } from 'next';
import NextLink from 'next/link';
import React, { useEffect, useState } from 'react';

import {
  courseIdToProgramIdLists,
  languageIdToName,
  languageIds,
  programIdToName,
} from '../../../../problems/problemData';
import { getLanguageIdFromSessionStorage, setLanguageIdToSessionStorage } from '../../../lib/SessionStorage';

const CoursePage: NextPage<{ params: { courseId: string } }> = ({ params }) => {
  const [selectedLanguageId, setSelectedLanguageId] = useState('');

  const SPECIFIED_COMPLETION_COUNT = 2;

  useEffect(() => {
    setSelectedLanguageId(getLanguageIdFromSessionStorage());
  }, []);

  const handleSelectLanguage = (event: React.ChangeEvent<HTMLSelectElement>): void => {
    const inputValue = event.target.value;
    setLanguageIdToSessionStorage(inputValue);
    setSelectedLanguageId(inputValue);
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
            {languageIdToName[languageId]}
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
                  <TableContainer>
                    <Table>
                      <Thead>
                        <Tr>
                          <Th textAlign="left">プログラム</Th>
                          <Th align="left">進捗</Th>
                        </Tr>
                      </Thead>
                      <Tbody>
                        {programIds.map((programId) => (
                          <Tr key={programId}>
                            <Td>
                              <NextLink passHref href={`${params.courseId}/programs/${programId}`}>
                                {programIdToName[programId]}
                              </NextLink>
                            </Td>
                            <Td>
                              <p>completedProblemCount / {SPECIFIED_COMPLETION_COUNT}</p>
                            </Td>
                          </Tr>
                        ))}
                      </Tbody>
                    </Table>
                  </TableContainer>
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
