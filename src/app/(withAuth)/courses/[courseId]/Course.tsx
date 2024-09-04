'use client';

import type { UserAnswer } from '@prisma/client';
import Image from 'next/image';
import NextLink from 'next/link';
import React, { useEffect } from 'react';
import { useLocalStorage } from 'usehooks-ts';

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
  Tag,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
  VStack,
} from '../../../../infrastructures/useClient/chakra';
import type { CourseId, ProgramId, VisibleLanguageId } from '../../../../problems/problemData';
import {
  courseIdToProgramIdLists,
  defaultLanguageId,
  languageIdToName,
  programIdToName,
  visibleLanguageIds,
} from '../../../../problems/problemData';
import type { UserProblemSessionWithUserAnswers } from '../../../lib/actions';
import { selectedLanguageIdKey } from '../../../lib/sessionStorage';

const SPECIFIED_COMPLETION_COUNT = 2;

const countFailedAnswers = (userProblemSession: UserProblemSessionWithUserAnswers | undefined): number => {
  if (!userProblemSession) return 0;

  return userProblemSession.userAnswers.filter((userAnswer: UserAnswer) => !userAnswer.isPassed).length;
};

const totalAnswerTimeSpent = (userProblemSession: UserProblemSessionWithUserAnswers | undefined): number => {
  if (!userProblemSession) return 0;

  return userProblemSession.userAnswers.reduce(
    (totalTimeSpent: number, userAnswer: UserAnswer) => totalTimeSpent + (userAnswer.timeSpent || 0),
    0
  );
};

export const Course: React.FC<{
  courseId: CourseId;
  userCompletedProblems: { programId: string; languageId: VisibleLanguageId }[];
  userProblemSessions: UserProblemSessionWithUserAnswers[];
}> = ({ courseId, userCompletedProblems, userProblemSessions }) => {
  const [selectedLanguageId, setSelectedLanguageId] = useLocalStorage<VisibleLanguageId>(
    selectedLanguageIdKey,
    defaultLanguageId
  );

  useEffect(() => {
    // 念の為、未知の言語が指定された場合、デフォルト言語に設定し直す。
    if (!visibleLanguageIds.includes(selectedLanguageId)) {
      setSelectedLanguageId(defaultLanguageId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLanguageId]);

  const handleSelectLanguage = (event: React.ChangeEvent<HTMLSelectElement>): void => {
    const inputValue = event.target.value;
    setSelectedLanguageId(inputValue as VisibleLanguageId);
  };

  const countUserCompletedProblems = (programId: ProgramId, languageId: VisibleLanguageId): number => {
    return userCompletedProblems.filter(
      (userCompletedProblem) =>
        userCompletedProblem.programId === programId && userCompletedProblem.languageId === languageId
    ).length;
  };

  const countCompletedProblems = (programIds: ProgramId[], languageId: VisibleLanguageId): number => {
    let count = 0;

    for (const programId of programIds) {
      if (countUserCompletedProblems(programId, languageId) >= SPECIFIED_COMPLETION_COUNT) count++;
    }
    return count;
  };

  const SuspendedSession = (programId: string): UserProblemSessionWithUserAnswers | undefined => {
    return userProblemSessions.find(
      (session) =>
        session.courseId === courseId &&
        session.programId === programId &&
        session.languageId === selectedLanguageId &&
        !session.finishedAt &&
        !session.isCompleted
    ) as UserProblemSessionWithUserAnswers | undefined;
  };

  const firstSession = (programId: string): UserProblemSessionWithUserAnswers | undefined => {
    return userProblemSessions.find(
      (session) =>
        session.courseId === courseId && session.programId === programId && session.languageId === selectedLanguageId
    ) as UserProblemSessionWithUserAnswers | undefined;
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
                          <Th textAlign="left">プログラム</Th>
                          <Th></Th>
                          <Th align="left">進捗</Th>
                          <Th align="left">
                            初回セッションの
                            <br />
                            不正解回数
                          </Th>
                          <Th align="left">
                            初回セッションの
                            <br />
                            所要時間（秒）
                          </Th>
                        </Tr>
                      </Thead>
                      <Tbody>
                        {programIds.map(async (programId) => (
                          <Tr key={programId}>
                            <Td>
                              <NextLink passHref href={`${courseId}/${selectedLanguageId}/${programId}`}>
                                {programIdToName[programId]}
                              </NextLink>
                            </Td>
                            <Td>{SuspendedSession(programId) && <Tag>挑戦中</Tag>}</Td>
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
                            <Td>{countFailedAnswers(firstSession(programId))}</Td>
                            <Td>
                              {typeof firstSession(programId)?.timeSpent === 'number'
                                ? Math.floor(totalAnswerTimeSpent(firstSession(programId)) / 1000)
                                : 0}
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
