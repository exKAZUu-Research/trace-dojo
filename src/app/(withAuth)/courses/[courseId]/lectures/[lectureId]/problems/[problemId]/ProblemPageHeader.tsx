'use client';

import type { ReactNode } from 'react';
import { NextLinkWithoutPrefetch } from '@/components/atoms/NextLinkWithoutPrefetch';
import { Heading, HStack, Link, Text, VStack } from '@/infrastructures/useClient/chakra';
import type { CourseId, ProblemId } from '@/problems/problemData';
import { courseIdToLectureIds, courseIdToName, problemIdToName } from '@/problems/problemData';

interface Props {
  courseId: CourseId;
  lectureId: string;
  problemId: ProblemId;
  actions?: ReactNode;
}

export const ProblemPageHeader: React.FC<Props> = ({ courseId, lectureId, problemId, actions }) => {
  const lectureIndex = courseIdToLectureIds[courseId].indexOf(lectureId);
  return (
    <VStack align="stretch" spacing={1}>
      <HStack spacing={2}>
        <Link as={NextLinkWithoutPrefetch} color="gray.600" fontWeight="bold" href={`/courses/${courseId}`}>
          {courseIdToName[courseId]}
        </Link>
        <Text color="gray.600">{'>'}</Text>
        <Link
          as={NextLinkWithoutPrefetch}
          color="gray.600"
          fontWeight="bold"
          href={`/courses/${courseId}/lectures/${lectureId}`}
        >
          第{lectureIndex + 1}回
        </Link>
      </HStack>
      <HStack justify="space-between" spacing={2}>
        <Heading as="h1">{problemIdToName[problemId]}</Heading>
        {actions}
      </HStack>
    </VStack>
  );
};
