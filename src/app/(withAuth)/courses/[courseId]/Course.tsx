'use client';

import { MdOutlineVerified, MdVerified } from 'react-icons/md';

import {
  Box,
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
  Tooltip,
  VStack,
} from '../../../../infrastructures/useClient/chakra';
import type { CourseId, ProblemId } from '../../../../problems/problemData';
import { courseIdToLectureIds, courseIdToName, courseIdToProblemIdLists } from '../../../../problems/problemData';
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
          const isDisabled = problemIds.filter((problemId) => openedProblemIds.has(problemId)).length === 0;
          const completedProblemCount = problemIds.filter(
            (problemId) => countUserCompletedProblems(userCompletedProblems, problemId) >= SPECIFIED_COMPLETION_COUNT
          ).length;
          const isLessonCompleted = completedProblemCount >= problemIds.length;
          const url = isDisabled ? '#' : `${courseId}/lectures/${courseIdToLectureIds[courseId][lessonIndex]}`;

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
                <Tooltip
                  isDisabled={!isDisabled}
                  label={`第${lessonIndex + 1}回の配布資料のURLから問題を一度開くと、ボタンが有効になります。`}
                >
                  <Link href={url}>
                    <Button colorScheme="brand" isDisabled={isDisabled} mt={4}>
                      課題を解く
                    </Button>
                  </Link>
                </Tooltip>
              </CardHeader>

              <CardBody align="stretch" as={VStack}>
                <Progress
                  colorScheme="brand"
                  max={problemIds.length}
                  rounded="sm"
                  size="sm"
                  title={`${completedProblemCount}/${problemIds.length} 問題完了`}
                  value={completedProblemCount}
                />
                <Box textAlign="right">
                  解答状況: {completedProblemCount}/{problemIds.length} 問 (
                  {Math.round((completedProblemCount / problemIds.length) * 100)}%)
                </Box>
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
