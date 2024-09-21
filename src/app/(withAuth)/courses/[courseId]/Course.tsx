'use client';

import { MdOutlineVerified, MdVerified } from 'react-icons/md';

import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Heading,
  HStack,
  Icon,
  Link,
  Progress,
  SimpleGrid,
  Spacer,
  VStack,
} from '../../../../infrastructures/useClient/chakra';
import type { CourseId, ProblemId } from '../../../../problems/problemData';
import { courseIdToProblemIdLists, courseIdToName, UUIDs } from '../../../../problems/problemData';
import type { UserProblemSessionWithUserAnswers } from '../../../../utils/fetch';

export const SPECIFIED_COMPLETION_COUNT = 1;

export const Course: React.FC<{
  courseId: CourseId;
  userCompletedProblems: { problemId: string }[];
  userProblemSessions: UserProblemSessionWithUserAnswers[];
}> = ({ courseId, userCompletedProblems, userProblemSessions }) => {
  const openedProblemIds = new Set(userProblemSessions.map((session) => session.problemId));
  return (
    <VStack align="stretch" spacing={6}>
      <Heading as="h1">{courseIdToName[courseId]}</Heading>

      <SimpleGrid columnGap={4} columns={{ base: 1, lg: 2 }} rowGap={6}>
        {courseIdToProblemIdLists[courseId].map((problemIds, lessonIndex) => {
          const completedProblemCount = problemIds.filter(
            (problemId) => countUserCompletedProblems(userCompletedProblems, problemId) >= SPECIFIED_COMPLETION_COUNT
          ).length;

          const openedProblems = problemIds.filter((problemId) => openedProblemIds.has(problemId));
          if (openedProblems.length === 0) return;
          const isLessonCompleted = completedProblemCount >= problemIds.length;

          return (
            <Card key={lessonIndex} p={2}>
              <CardHeader as={HStack} gap={3}>
                <Icon
                  as={isLessonCompleted ? MdVerified : MdOutlineVerified}
                  color={isLessonCompleted ? 'brand.500' : 'gray.200'}
                  fontSize="3xl"
                  mx="-0.125em"
                />
                <Heading size="md">第{lessonIndex + 1}回</Heading>
                <Spacer />
                <Link href={`${courseId}/lectures/lecture${lessonIndex + 1}-${UUIDs[courseId][lessonIndex]}`}>
                  <Button colorScheme="brand" mt={4}>
                    レッスンを始める
                  </Button>
                </Link>
              </CardHeader>

              <CardBody align="stretch" as={VStack}>
                <Progress
                  colorScheme="brand"
                  max={problemIds.length}
                  rounded="sm"
                  size="sm"
                  value={completedProblemCount}
                />
              </CardBody>
            </Card>
          );
        })}
      </SimpleGrid>
    </VStack>
  );
};

function countUserCompletedProblems(userCompletedProblems: { problemId: string }[], problemId: ProblemId): number {
  return userCompletedProblems.filter((userCompletedProblem) => userCompletedProblem.problemId === problemId).length;
}
