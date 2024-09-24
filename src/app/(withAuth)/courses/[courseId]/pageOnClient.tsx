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
import type { CourseId } from '../../../../problems/problemData';
import { courseIdToLectureIds, courseIdToName, courseIdToProblemIdLists } from '../../../../problems/problemData';
import type { UserProblemSessionWithUserAnswers } from '../../../../utils/fetch';

type Props = {
  params: { courseId: CourseId };
  currentUserCompletedProblemIdSet: ReadonlySet<string>;
  currentUserProblemSessions: UserProblemSessionWithUserAnswers[];
};

export const CoursePageOnClient: React.FC<Props> = (props) => {
  const openedProblemIds = new Set(props.currentUserProblemSessions.map((session) => session.problemId));
  return (
    <VStack align="stretch" spacing={6}>
      <Heading as="h1">{courseIdToName[props.params.courseId]}</Heading>

      <SimpleGrid columnGap={4} columns={{ base: 1, lg: 2 }} rowGap={6}>
        {courseIdToProblemIdLists[props.params.courseId].map((problemIds, lessonIndex) => {
          const isDisabled = problemIds.filter((problemId) => openedProblemIds.has(problemId)).length === 0;

          const completedProblemCount = problemIds.filter((problemId) =>
            props.currentUserCompletedProblemIdSet.has(problemId)
          ).length;
          const isLessonCompleted = completedProblemCount >= problemIds.length;

          const url = isDisabled
            ? '#'
            : `${props.params.courseId}/lectures/${courseIdToLectureIds[props.params.courseId][lessonIndex]}`;

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
