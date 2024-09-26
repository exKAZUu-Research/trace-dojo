'use client';

import type { ProblemSession } from '@prisma/client';
import NextLink from 'next/link';
import { useRef, useState } from 'react';
import { useIdleTimer } from 'react-idle-timer';

import {
  MAX_ACTIVE_DURATION_MS_AFTER_LAST_EVENT,
  MIN_INTERVAL_MS_OF_ACTIVE_EVENTS,
} from '../../../../../../../../constants';
import { backendTrpcReact } from '../../../../../../../../infrastructures/trpcBackend/client';
import {
  Button,
  Heading,
  HStack,
  Link,
  Text,
  Tooltip,
  VStack,
} from '../../../../../../../../infrastructures/useClient/chakra';
import type { Problem } from '../../../../../../../../problems/generateProblem';
import type { CourseId, ProblemId } from '../../../../../../../../problems/problemData';
import { courseIdToLectureIds, courseIdToName, problemIdToName } from '../../../../../../../../problems/problemData';

import { ProblemBody } from './ProblmBody';

type Props = {
  params: { courseId: CourseId; lectureId: string; problemId: ProblemId };
  problem: Problem;
  userId: string;
  initialProblemSession: ProblemSession;
};

export const ProblemPageOnClient: React.FC<Props> = (props) => {
  const lectureIndex = courseIdToLectureIds[props.params.courseId].indexOf(props.params.lectureId);

  const [problemSession, setProblemSession] = useState(props.initialProblemSession);

  const lastActionTimeRef = useRef(Date.now());
  useMonitorUserActivity(props, lastActionTimeRef);

  const updateProblemSessionMutation = backendTrpcReact.updateProblemSession.useMutation();
  const createProblemSubmissionMutation = backendTrpcReact.createProblemSubmission.useMutation();

  const createSubmissionUpdatingProblemSession = async (isCorrect: boolean, isCompleted: boolean): Promise<void> => {
    const newProblemSession = await updateProblemSessionMutation.mutateAsync({
      id: problemSession.id,
      incrementalElapsedMilliseconds: getIncrementalElapsedMilliseconds(lastActionTimeRef),
      completedAt: isCompleted ? new Date() : undefined,
    });
    await createProblemSubmissionMutation.mutateAsync({
      sessionId: problemSession.id,
      problemType: problemSession.problemType,
      traceItemIndex: problemSession.traceItemIndex,
      elapsedMilliseconds: newProblemSession.elapsedMilliseconds,
      isCorrect,
    });
  };

  const updateProblemSession = async (newProblemType: string, newTraceItemIndex: number): Promise<void> => {
    const newProblemSession = await updateProblemSessionMutation.mutateAsync({
      id: problemSession.id,
      problemType: newProblemType,
      traceItemIndex: newTraceItemIndex,
    });
    setProblemSession(newProblemSession);
  };

  return (
    <VStack align="stretch" spacing={4}>
      <VStack align="stretch" spacing={1}>
        <HStack justify="space-between" spacing={2}>
          <HStack spacing={2}>
            <Link as={NextLink} color="gray.600" fontWeight="bold" href={`/courses/${props.params.courseId}`}>
              {courseIdToName[props.params.courseId]}
            </Link>
            <Text color="gray.600">{'>'}</Text>
            <Link
              as={NextLink}
              color="gray.600"
              fontWeight="bold"
              href={`/courses/${props.params.courseId}/lectures/${props.params.lectureId}`}
            >
              第{lectureIndex + 1}回
            </Link>
          </HStack>
        </HStack>
        <HStack justify="space-between" spacing={2}>
          <Heading as="h1">{problemIdToName[props.params.problemId]}</Heading>
          {problemSession.problemType === 'executionResult' && (
            <Tooltip label="減点になりますが、確実に問題を解けます。">
              <Button
                colorScheme="blue"
                variant="outline"
                onClick={() => {
                  void updateProblemSession('step', 1);
                }}
              >
                諦めてステップ実行モードに移る
              </Button>
            </Tooltip>
          )}
        </HStack>
      </VStack>

      <ProblemBody
        createSubmissionUpdatingProblemSession={createSubmissionUpdatingProblemSession}
        params={props.params}
        problem={props.problem}
        problemSession={problemSession}
        updateProblemSession={updateProblemSession}
      />
    </VStack>
  );
};

function useMonitorUserActivity(props: Props, lastActionTimeRef: React.MutableRefObject<number>): void {
  const updateProblemSessionMutation = backendTrpcReact.updateProblemSession.useMutation();

  useIdleTimer({
    async onAction() {
      await updateProblemSessionMutation.mutateAsync({
        id: props.initialProblemSession.id,
        incrementalElapsedMilliseconds: getIncrementalElapsedMilliseconds(lastActionTimeRef),
      });
    },
    // Events within the throttle period are ignored.
    throttle: MIN_INTERVAL_MS_OF_ACTIVE_EVENTS,
  });
}

function getIncrementalElapsedMilliseconds(lastActionTimeRef: React.MutableRefObject<number>): number {
  const nowTime = Date.now();
  const incrementalElapsedMilliseconds = Math.min(
    nowTime - lastActionTimeRef.current,
    MAX_ACTIVE_DURATION_MS_AFTER_LAST_EVENT
  );
  lastActionTimeRef.current = nowTime;
  return incrementalElapsedMilliseconds;
}
