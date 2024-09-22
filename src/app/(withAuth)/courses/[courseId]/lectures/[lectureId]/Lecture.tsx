'use client';

import type { UserAnswer } from '@prisma/client';
import NextLink from 'next/link';
import React from 'react';
import { MdCheckCircle, MdCheckCircleOutline, MdOutlineVerified, MdVerified } from 'react-icons/md';

import {
  Box,
  Card,
  CardBody,
  CardHeader,
  Heading,
  HStack,
  Icon,
  Link,
  Progress,
  SimpleGrid,
  Table,
  Tag,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
  VStack,
} from '../../../../../../infrastructures/useClient/chakra';
import type { CourseId, ProblemId } from '../../../../../../problems/problemData';
import { courseIdToName, courseIdToProblemIdLists, problemIdToName } from '../../../../../../problems/problemData';
import { type UserProblemSessionWithUserAnswers } from '../../../../../../utils/fetch';
import { SPECIFIED_COMPLETION_COUNT } from '../../Course';

export const Lecture: React.FC<{
  courseId: CourseId;
  lectureId: string;
  lectureIndex: number;
  userCompletedProblems: { problemId: string }[];
  userProblemSessions: UserProblemSessionWithUserAnswers[];
}> = ({ courseId, lectureId, lectureIndex, userCompletedProblems, userProblemSessions }) => {
  const problemIds = courseIdToProblemIdLists[courseId][lectureIndex];
  const completedProblemCount = problemIds.filter(
    (problemId) => countUserCompletedProblems(userCompletedProblems, problemId) >= SPECIFIED_COMPLETION_COUNT
  ).length;
  const isLessonCompleted = completedProblemCount >= problemIds.length;
  return (
    <VStack align="stretch" spacing={6}>
      <Heading as="h1">{courseIdToName[courseId]}</Heading>

      <SimpleGrid columnGap={4} mx="auto" rowGap={6} w={{ base: '100%', lg: '80%' }}>
        <Card>
          <CardHeader as={HStack} gap={6} pb={0}>
            <Icon
              as={isLessonCompleted ? MdVerified : MdOutlineVerified}
              color={isLessonCompleted ? 'brand.500' : 'gray.200'}
              fontSize="3xl"
              mx="-0.125em"
            />
            <Heading size="md">第{lectureIndex + 1}回</Heading>
          </CardHeader>

          <CardBody align="stretch" as={VStack} pb={2}>
            <Progress
              colorScheme="brand"
              max={problemIds.length}
              rounded="sm"
              size="sm"
              value={completedProblemCount}
            />

            <Table
              mx={-5}
              sx={{
                'td:not(:first-of-type), th:not(:first-of-type)': { ps: 1.5 },
                'td:not(:last-of-type), th:not(:last-of-type)': { pe: 1.5 },
              }}
              w="unset"
            >
              <Thead>
                <Tr whiteSpace="nowrap">
                  <Th w="0" />
                  <Th w="0" />
                  <Th isNumeric w="0">
                    初回不正解
                  </Th>
                  <Th isNumeric w="0">
                    初回所要時間
                  </Th>
                </Tr>
              </Thead>

              <Tbody>
                {problemIds.map((problemId) => {
                  const suspendedSession = userProblemSessions.find(
                    (session) =>
                      session.courseId === courseId &&
                      session.problemId === problemId &&
                      !session.finishedAt &&
                      !session.isCompleted
                  );
                  const firstSession = userProblemSessions.find(
                    (session) => session.courseId === courseId && session.problemId === problemId
                  );
                  const completedProblemCount = countUserCompletedProblems(userCompletedProblems, problemId);
                  const isProblemCompleted = completedProblemCount >= SPECIFIED_COMPLETION_COUNT;

                  return (
                    <Tr key={problemId}>
                      <Td>
                        <Icon
                          as={isProblemCompleted ? MdCheckCircle : MdCheckCircleOutline}
                          color={isProblemCompleted ? 'brand.500' : 'gray.200'}
                          fontSize="lg"
                          mx="-0.125em"
                        />
                      </Td>
                      <Td textOverflow="ellipsis" whiteSpace="nowrap">
                        <VStack align="flex-start">
                          {suspendedSession && (
                            <Tag colorScheme="brand" fontWeight="bold" size="sm" variant="solid">
                              挑戦中
                            </Tag>
                          )}
                          <Link as={NextLink} href={`${lectureId}/problems/${problemId}`}>
                            {problemIdToName[problemId]}
                          </Link>
                        </VStack>
                      </Td>
                      <Td isNumeric color="gray.600">
                        {countFailedAnswers(firstSession)}
                        <Box as="span" fontSize="xs" ms={1}>
                          回
                        </Box>
                      </Td>
                      <Td isNumeric color="gray.600">
                        {typeof firstSession?.timeSpent === 'number'
                          ? Math.floor(totalAnswerTimeSpent(firstSession) / 1000)
                          : 0}
                        <Box as="span" fontSize="xs" ms={1}>
                          秒
                        </Box>
                      </Td>
                    </Tr>
                  );
                })}
              </Tbody>
            </Table>
          </CardBody>
        </Card>
      </SimpleGrid>
    </VStack>
  );
};

function countUserCompletedProblems(userCompletedProblems: { problemId: string }[], problemId: ProblemId): number {
  return userCompletedProblems.filter((userCompletedProblem) => userCompletedProblem.problemId === problemId).length;
}

function countFailedAnswers(userProblemSession?: UserProblemSessionWithUserAnswers): number {
  if (!userProblemSession) return 0;

  return userProblemSession.userAnswers.filter((userAnswer: UserAnswer) => !userAnswer.isPassed).length;
}

function totalAnswerTimeSpent(userProblemSession?: UserProblemSessionWithUserAnswers): number {
  if (!userProblemSession) return 0;

  return userProblemSession.userAnswers.reduce(
    (totalTimeSpent: number, userAnswer: UserAnswer) => totalTimeSpent + (userAnswer.timeSpent || 0),
    0
  );
}
