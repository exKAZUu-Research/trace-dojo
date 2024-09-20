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
import type { CourseId, ProgramId, VisibleLanguageId } from '../../../../problems/problemData';
import { courseIdToProgramIdLists, courseIdToName, UUIDs } from '../../../../problems/problemData';
import type { UserProblemSessionWithUserAnswers } from '../../../../utils/fetch';

export const SPECIFIED_COMPLETION_COUNT = 1;

export const Course: React.FC<{
  courseId: CourseId;
  userCompletedProblems: { programId: string; languageId: VisibleLanguageId }[];
  userProblemSessions: UserProblemSessionWithUserAnswers[];
}> = ({ courseId, userCompletedProblems, userProblemSessions }) => {
  const openedProblemIds = new Set(userProblemSessions.map((session) => session.programId));
  return (
    <VStack align="stretch" spacing={6}>
      <Heading as="h1">{courseIdToName[courseId]}</Heading>

      <SimpleGrid columnGap={4} columns={{ base: 1, lg: 2 }} rowGap={6}>
        {courseIdToProgramIdLists[courseId].map((programIds, lessonIndex) => {
          const completedProblemCount = programIds.filter(
            (programId) =>
              countUserCompletedProblems(userCompletedProblems, programId, 'java') >= SPECIFIED_COMPLETION_COUNT
          ).length;

          const openedProblems = programIds.filter((programId) => openedProblemIds.has(programId));
          if (openedProblems.length === 0) return;
          const isLessonCompleted = completedProblemCount >= programIds.length;

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
                <Link href={`${courseId}/lecture${lessonIndex + 1}-${UUIDs[lessonIndex]}`}>
                  <Button colorScheme="brand" mt={4}>
                    レッスンを始める
                  </Button>
                </Link>
              </CardHeader>

              <CardBody align="stretch" as={VStack}>
                <Progress
                  colorScheme="brand"
                  max={programIds.length}
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
