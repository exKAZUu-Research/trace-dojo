'use client';

import {
  Accordion,
  AccordionButton,
  AccordionIcon,
  AccordionItem,
  AccordionPanel,
  Box,
  Flex,
  Heading,
  HStack,
  Select,
  Table,
  TableContainer,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
  VStack,
} from '@chakra-ui/react';
import Image from 'next/image';
import NextLink from 'next/link';
import React, { useEffect, useState } from 'react';

import type { CourseId, ProgramId, VisibleLanguageId } from '../../../../problems/problemData';
import {
  courseIdToProgramIdLists,
  languageIdToName,
  programIdToName,
  visibleLanguageIds,
} from '../../../../problems/problemData';
import { getLanguageIdFromSessionStorage, setLanguageIdToSessionStorage } from '../../../lib/SessionStorage';

export const Course: React.FC<{
  courseId: CourseId;
  userCompletedProblems: { programId: ProgramId; languageId: VisibleLanguageId }[];
}> = ({ courseId, userCompletedProblems }) => {
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

  const countUserCompletedProblems = (programId: string, languageId: string): number => {
    return userCompletedProblems.filter(
      (userCompletedProblem) =>
        userCompletedProblem.programId === programId && userCompletedProblem.languageId === languageId
    ).length;
  };

  const countCompletedProblems = (programIds: string[], languageId: string): number => {
    let count = 0;

    for (const programId of programIds) {
      if (countUserCompletedProblems(programId, languageId) >= SPECIFIED_COMPLETION_COUNT) count++;
    }
    return count;
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
        {visibleLanguageIds.map((languageId) => (
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
                  <Box flex="1">
                    <HStack spacing="50%">
                      <Box>第{iLesson + 1}回</Box>
                      <HStack>
                        <Box>
                          Completed {countCompletedProblems(programIds, selectedLanguageId)} / {programIds.length}
                        </Box>
                        {countCompletedProblems(programIds, selectedLanguageId) >= programIds.length && (
                          <Box h={4} ml={2} position={'relative'} w={4}>
                            <Image fill alt="完了の王冠" src="/crown.png" />
                          </Box>
                        )}
                      </HStack>
                    </HStack>
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
                                  {countUserCompletedProblems(programId, selectedLanguageId)} /{' '}
                                  {SPECIFIED_COMPLETION_COUNT}
                                </p>
                                {countUserCompletedProblems(programId, selectedLanguageId) >=
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
