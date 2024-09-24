'use client';

import type { ProblemSession, ProblemSessionAnswer } from '@prisma/client';
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
import type { CourseId } from '../../../../../../problems/problemData';
import {
  courseIdToName,
  courseIdToLectureIndexToProblemIds,
  problemIdToName,
} from '../../../../../../problems/problemData';

type Props = {
  params: { courseId: CourseId; lectureId: string };
  lectureIndex: number;
  currentUserCompletedProblemIdSet: ReadonlySet<string>;
  currentUserProblemSessions: (Pick<ProblemSession, 'problemId' | 'completedAt' | 'elapsedMilliseconds'> & {
    answers: Pick<ProblemSessionAnswer, 'elapsedMilliseconds' | 'isCorrect'>[];
  })[];
};

export const Lecture: React.FC<Props> = (props) => {
  const lectureProblemIds = courseIdToLectureIndexToProblemIds[props.params.courseId][props.lectureIndex];

  const completedProblemCount = lectureProblemIds.filter((problemId) =>
    props.currentUserCompletedProblemIdSet.has(problemId)
  ).length;
  const isLessonCompleted = completedProblemCount >= lectureProblemIds.length;

  return (
    <VStack align="stretch" spacing={6}>
      <Heading as="h1">
        <Link as={NextLink} href={`/courses/${props.params.courseId}`}>
          {courseIdToName[props.params.courseId]}
        </Link>
      </Heading>

      <SimpleGrid columnGap={4} mx="auto" rowGap={6} w={{ base: '100%', lg: '80%' }}>
        <Card>
          <CardHeader as={HStack} gap={6} pb={0}>
            <Icon
              as={isLessonCompleted ? MdVerified : MdOutlineVerified}
              color={isLessonCompleted ? 'brand.500' : 'gray.200'}
              fontSize="3xl"
              mx="-0.125em"
            />
            <Heading size="md">第{props.lectureIndex + 1}回</Heading>
          </CardHeader>

          <CardBody align="stretch" as={VStack} pb={2}>
            <Progress
              colorScheme="brand"
              max={lectureProblemIds.length}
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
                {lectureProblemIds.map((problemId) => {
                  const firstSession = props.currentUserProblemSessions.find((s) => s.problemId === problemId);

                  const suspendedSession = props.currentUserProblemSessions.find(
                    (s) => s.problemId === problemId && !s.completedAt
                  );

                  const isProblemCompleted = props.currentUserCompletedProblemIdSet.has(problemId);

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
                        <HStack align="center" spacing={2}>
                          <Link as={NextLink} href={`${props.params.lectureId}/problems/${problemId}`}>
                            {problemIdToName[problemId]}
                          </Link>
                          {suspendedSession && (
                            <Tag colorScheme="brand" fontWeight="bold" size="sm" variant="solid">
                              挑戦中
                            </Tag>
                          )}
                        </HStack>
                      </Td>
                      <Td isNumeric color="gray.600">
                        {firstSession?.answers.filter((a) => !a.isCorrect).length ?? 0}
                        <Box as="span" fontSize="xs" ms={1}>
                          回
                        </Box>
                      </Td>
                      <Td isNumeric color="gray.600">
                        {/* TODO: なぜ`firstSession?.elapsedMilliseconds`をそのまま表示しない実装になっているのか確認する。 */}
                        {typeof firstSession?.elapsedMilliseconds === 'number'
                          ? Math.floor(
                              firstSession.answers.reduce((sum, answer) => sum + answer.elapsedMilliseconds, 0) / 1000
                            )
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
