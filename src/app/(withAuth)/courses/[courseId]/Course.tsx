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
  Flex,
} from '@chakra-ui/react';
import Image from 'next/image';
import NextLink from 'next/link';
import React, { useEffect, useState } from 'react';

import {
  courseIdToProgramIdLists,
  languageIdToName,
  languageIds,
  programIdToName,
} from '../../../../problems/problemData';
import { getLanguageIdFromSessionStorage, setLanguageIdToSessionStorage } from '../../../lib/SessionStorage';

export const Course: React.FC<{
  courseId: string;
  userSolvedProblems: { programId: string; languageId: string }[];
}> = ({ courseId, userSolvedProblems }) => {
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

  const countUserSolvedProblems = (programId: string, languageId: string): number => {
    return userSolvedProblems.filter(
      (userSolvedProblem) => userSolvedProblem.programId === programId && userSolvedProblem.languageId === languageId
    ).length;
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
        {courseIdToProgramIdLists[courseId].map((programIds, iLesson) => (
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
                          <Th textAlign="left" width="50%">
                            プログラム
                          </Th>
                          <Th align="left" width="50%">
                            進捗
                          </Th>
                        </Tr>
                      </Thead>
                      <Tbody>
                        {programIds.map((programId) => (
                          <Tr key={programId}>
                            <Td>
                              <NextLink passHref href={`${courseId}/programs/${programId}`}>
                                {programIdToName[programId]}
                              </NextLink>
                            </Td>
                            <Td>
                              <Flex>
                                <p>
                                  {countUserSolvedProblems(programId, selectedLanguageId)} /{' '}
                                  {SPECIFIED_COMPLETION_COUNT}
                                </p>
                                {countUserSolvedProblems(programId, selectedLanguageId) >=
                                  SPECIFIED_COMPLETION_COUNT && (
                                  <Box h={4} ml={2} position={'relative'} w={4}>
                                    <Image fill alt="完了の王冠" src="/crown.png" />
                                  </Box>
                                )}
                              </Flex>
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
