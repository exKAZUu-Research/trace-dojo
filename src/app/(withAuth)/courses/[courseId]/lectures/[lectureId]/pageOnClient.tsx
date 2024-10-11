'use client';

import type { ProblemSession, ProblemSubmission } from '@prisma/client';
import { useLocalStorage } from '@willbooster/shared-lib-react';
import NextLink from 'next/link';
import React, { useEffect, useMemo } from 'react';
import { MdCheckCircle, MdCheckCircleOutline, MdOutlineVerified, MdVerified } from 'react-icons/md';

import { useAuthContextSelector } from '../../../../../../contexts/AuthContext';
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
  courseIdToLectureIndexToProblemIds,
  courseIdToName,
  problemIdToName,
} from '../../../../../../problems/problemData';

type Props = {
  params: { courseId: CourseId; lectureId: string };
  lectureIndex: number;
  problemSessions: (Pick<ProblemSession, 'problemId' | 'completedAt'> & {
    submissions: Pick<ProblemSubmission, 'isCorrect'>[];
  })[];
};

export const Lecture: React.FC<Props> = (props) => {
  const completedProblemIdSet = useMemo(
    () => new Set(props.problemSessions.filter((s) => s.completedAt).map((s) => s.problemId)),
    [props.problemSessions]
  );

  const lectureProblemIds = courseIdToLectureIndexToProblemIds[props.params.courseId][props.lectureIndex];
  const completedProblemCount = lectureProblemIds.filter((problemId) => completedProblemIdSet.has(problemId)).length;
  const isLessonCompleted = completedProblemCount >= lectureProblemIds.length;

  const currentUserId = useAuthContextSelector((c) => c.currentUserId);
  const [, setIsOpened] = useLocalStorage(
    `trace-dojo.${props.params.courseId}.${props.lectureIndex}.${currentUserId}`,
    false
  );
  useEffect(() => {
    setIsOpened(true);
  }, [setIsOpened]);

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
                    初回の不正解
                  </Th>
                  <Th isNumeric w="0">
                    初回の完了日時
                  </Th>
                </Tr>
              </Thead>

              <Tbody>
                {lectureProblemIds.map((problemId) => {
                  const firstSession = props.problemSessions.find((s) => s.problemId === problemId);
                  const suspendedSession = props.problemSessions.find(
                    (s) => s.problemId === problemId && !s.completedAt
                  );
                  const isProblemCompleted = completedProblemIdSet.has(problemId);

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
                          {suspendedSession &&
                            (isProblemCompleted ? (
                              <Tag colorScheme="brand" fontWeight="bold" size="sm" variant="outline">
                                再挑戦中
                              </Tag>
                            ) : (
                              <Tag colorScheme="brand" fontWeight="bold" size="sm" variant="solid">
                                挑戦中
                              </Tag>
                            ))}
                        </HStack>
                      </Td>
                      <Td isNumeric color="gray.600">
                        {firstSession?.submissions.filter((a) => !a.isCorrect).length ?? 0}
                        <Box as="span" fontSize="xs" ms={1}>
                          回
                        </Box>
                      </Td>
                      <Td isNumeric color="gray.600">
                        {firstSession?.completedAt?.toLocaleString() ?? '未完了'}
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
