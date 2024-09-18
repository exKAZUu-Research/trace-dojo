'use client';

import type { UserAnswer } from '@prisma/client';
import Image from 'next/image';
import NextLink from 'next/link';

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
import { courseIdToProgramIdLists, programIdToName } from '../../../../problems/problemData';
import type { UserProblemSessionWithUserAnswers } from '../../../../utils/fetch';

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
  return (
    <main>
      <Heading as="h1" marginBottom="4">
        Lessons
      </Heading>

      <VStack align="stretch">
        {courseIdToProgramIdLists[courseId].map((programIds, iLesson) => {
          const completedProblemCount = programIds.filter(
            (programId) =>
              countUserCompletedProblems(userCompletedProblems, programId, 'java') >= SPECIFIED_COMPLETION_COUNT
          ).length;

          return (
            <Box key={iLesson}>
              <Accordion allowToggle>
                <AccordionItem>
                  <AccordionButton>
                    <Box flex="1">
                      <HStack spacing="50%">
                        <Box>第{iLesson + 1}回</Box>
                        <HStack>
                          <Box>
                            Completed {completedProblemCount} / {programIds.length}
                          </Box>
                          {completedProblemCount >= programIds.length && (
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
                          {programIds.map((programId) => {
                            const suspendedSession = userProblemSessions.find(
                              (session) =>
                                session.courseId === courseId &&
                                session.programId === programId &&
                                !session.finishedAt &&
                                !session.isCompleted
                            );
                            const firstSession = userProblemSessions.find(
                              (session) => session.courseId === courseId && session.programId === programId
                            );
                            const completedProblemCount = countUserCompletedProblems(
                              userCompletedProblems,
                              programId,
                              'java'
                            );
                            return (
                              <Tr key={programId}>
                                <Td>
                                  <NextLink passHref href={`${courseId}/${programId}`}>
                                    {programIdToName[programId]}
                                  </NextLink>
                                </Td>
                                <Td>{suspendedSession && <Tag>挑戦中</Tag>}</Td>
                                <Td>
                                  <Flex>
                                    <p>
                                      {completedProblemCount} / {SPECIFIED_COMPLETION_COUNT}
                                    </p>
                                    {completedProblemCount >= SPECIFIED_COMPLETION_COUNT && (
                                      <Box h={4} ml={2} position={'relative'} w={4}>
                                        <Image fill alt="完了の王冠" src="/crown.png" />
                                      </Box>
                                    )}
                                  </Flex>
                                </Td>
                                <Td>{countFailedAnswers(firstSession)}</Td>
                                <Td>
                                  {typeof firstSession?.timeSpent === 'number'
                                    ? Math.floor(totalAnswerTimeSpent(firstSession) / 1000)
                                    : 0}
                                </Td>
                              </Tr>
                            );
                          })}
                        </Tbody>
                      </Table>
                    </TableContainer>
                  </AccordionPanel>
                </AccordionItem>
              </Accordion>
            </Box>
          );
        })}
      </VStack>
    </main>
  );
};

function countUserCompletedProblems(
  userCompletedProblems: { programId: string; languageId: VisibleLanguageId }[],
  programId: ProgramId,
  languageId: VisibleLanguageId
): number {
  return userCompletedProblems.filter(
    (userCompletedProblem) =>
      userCompletedProblem.programId === programId && userCompletedProblem.languageId === languageId
  ).length;
}
