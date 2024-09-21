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
import type { CourseId, ProgramId } from '../../../../../../problems/problemData';
import { courseIdToProgramIdLists, programIdToName, courseIdToName } from '../../../../../../problems/problemData';
import { type UserProblemSessionWithUserAnswers } from '../../../../../../utils/fetch';
import { SPECIFIED_COMPLETION_COUNT } from '../../Course';

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

export const LectureCard: React.FC<{
  courseId: CourseId;
  lectureId: string;
  lectureNumber: number;
  userCompletedProblems: { programId: string }[];
  userProblemSessions: UserProblemSessionWithUserAnswers[];
}> = async ({ courseId, lectureId, lectureNumber, userCompletedProblems, userProblemSessions }) => {
  const programIds = courseIdToProgramIdLists[courseId][lectureNumber - 1];
  const completedProblemCount = programIds.filter(
    (programId) => countUserCompletedProblems(userCompletedProblems, programId) >= SPECIFIED_COMPLETION_COUNT
  ).length;
  const isLessonCompleted = completedProblemCount >= programIds.length;
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
            <Heading size="md">第{lectureNumber}回</Heading>
          </CardHeader>

          <CardBody align="stretch" as={VStack} pb={2}>
            <Progress
              colorScheme="brand"
              max={programIds.length}
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
                  const completedProblemCount = countUserCompletedProblems(userCompletedProblems, programId);
                  const isProgramCompleted = completedProblemCount >= SPECIFIED_COMPLETION_COUNT;

                  return (
                    <Tr key={programId}>
                      <Td>
                        <Icon
                          as={isProgramCompleted ? MdCheckCircle : MdCheckCircleOutline}
                          color={isProgramCompleted ? 'brand.500' : 'gray.200'}
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
                          <Link as={NextLink} href={`lectures/${lectureId}/${programId}`}>
                            {programIdToName[programId]}
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

function countUserCompletedProblems(userCompletedProblems: { programId: string }[], programId: ProgramId): number {
  return userCompletedProblems.filter((userCompletedProblem) => userCompletedProblem.programId === programId).length;
}
