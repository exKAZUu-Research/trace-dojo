'use client';

import { useLocalStorage } from '@willbooster/shared-lib-react';
import { useParams } from 'next/navigation';
import { MdOutlineVerified, MdVerified } from 'react-icons/md';

import { useAuthContextSelector } from '../../../../contexts/AuthContext';
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
  Text,
  VStack,
} from '../../../../infrastructures/useClient/chakra';
import type { CourseId } from '../../../../problems/problemData';
import {
  courseIdToLectureIds,
  courseIdToLectureIndexToProblemIds,
  courseIdToName,
} from '../../../../problems/problemData';

interface Props {
  currentUserCompletedProblemIdSet: ReadonlySet<string>;
  currentUserStartedProblemIdSet: ReadonlySet<string>;
}

export const CoursePageOnClient: React.FC<Props> = (props) => {
  const params = useParams<{ courseId: CourseId }>();
  return (
    <VStack align="stretch" spacing={6}>
      <Heading as="h1">{courseIdToName[params.courseId]}</Heading>

      <SimpleGrid columnGap={4} columns={{ base: 1, lg: 2 }} rowGap={6}>
        {courseIdToLectureIndexToProblemIds[params.courseId].map((problemIds, lectureIndex) => (
          <LectureCard
            key={lectureIndex}
            courseId={params.courseId}
            currentUserCompletedProblemIdSet={props.currentUserCompletedProblemIdSet}
            currentUserStartedProblemIdSet={props.currentUserStartedProblemIdSet}
            lectureIndex={lectureIndex}
            problemIds={problemIds}
          />
        ))}
      </SimpleGrid>
    </VStack>
  );
};

interface LectureCardProps {
  courseId: CourseId;
  lectureIndex: number;
  problemIds: string[];
  currentUserCompletedProblemIdSet: ReadonlySet<string>;
  currentUserStartedProblemIdSet: ReadonlySet<string>;
}

const LectureCard: React.FC<LectureCardProps> = ({
  courseId,
  currentUserCompletedProblemIdSet,
  currentUserStartedProblemIdSet,
  lectureIndex,
  problemIds,
}) => {
  const completedProblemCount = problemIds.filter((problemId) =>
    currentUserCompletedProblemIdSet.has(problemId)
  ).length;
  const isLectureCompleted = completedProblemCount >= problemIds.length;

  const currentUserId = useAuthContextSelector((c) => c.currentUserId);
  const [isOpened] = useLocalStorage(`trace-dojo.${courseId}.${lectureIndex}.${currentUserId}`, false);
  const isDisabled = !isOpened && problemIds.every((problemId) => !currentUserStartedProblemIdSet.has(problemId));
  const url = isDisabled ? '#' : `${courseId}/lectures/${courseIdToLectureIds[courseId][lectureIndex]}`;

  return (
    <Card p={2}>
      <CardHeader as={HStack} gap={3}>
        <Icon
          as={isLectureCompleted ? MdVerified : MdOutlineVerified}
          color={isLectureCompleted ? 'brand.500' : 'gray.200'}
          fontSize="3xl"
          mx="-0.125em"
        />
        <Heading size="md">第{lectureIndex + 1}回</Heading>
        <Spacer />
        <Link href={url}>
          <Button colorScheme="brand" isDisabled={isDisabled} mt={4}>
            課題を解く
          </Button>
        </Link>
      </CardHeader>

      <CardBody align="stretch" as={VStack}>
        {isDisabled && (
          <Text color="red.500" fontSize="sm">
            第{lectureIndex + 1}回の配布資料のURLから問題を一度開くと、ボタンが有効になります。
          </Text>
        )}
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
};
