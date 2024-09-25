'use client';

import type { ProblemSession } from '@prisma/client';
import NextLink from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useIdleTimer } from 'react-idle-timer';

import {
  MAX_ACTIVE_DURATION_MS_AFTER_LAST_EVENT,
  MIN_INTERVAL_MS_OF_ACTIVE_EVENTS,
} from '../../../../../../../../constants';
import { backendTrpcReact } from '../../../../../../../../infrastructures/trpcBackend/client';
import { Heading, HStack, Link, Text, VStack } from '../../../../../../../../infrastructures/useClient/chakra';
import type { Problem } from '../../../../../../../../problems/generateProblem';
import type { CourseId, ProblemId } from '../../../../../../../../problems/problemData';
import { courseIdToLectureIds, courseIdToName, problemIdToName } from '../../../../../../../../problems/problemData';
import type { ProblemType } from '../../../../../../../../types';

import { ExecutionResultProblem, StepProblem } from './Problems';

type Props = {
  params: { courseId: CourseId; lectureId: string; problemId: ProblemId };
  problem: Problem;
  userId: string;
  initialProblemSession: ProblemSession;
};

export const ProblemPageOnClient: React.FC<Props> = (props) => {
  const lectureIndex = courseIdToLectureIds[props.params.courseId].indexOf(props.params.lectureId);

  const [problemType, setProblemType] = useState(props.initialProblemSession.currentProblemType as ProblemType);
  const [currentTraceItemIndex, setCurrentTraceItemIndex] = useState(props.initialProblemSession.currentTraceItemIndex);
  const [previousTraceItemIndex, setPreviousTraceItemIndex] = useState(
    props.initialProblemSession.previousTraceItemIndex
  );

  const updateProblemSessionMutation = backendTrpcReact.updateProblemSession.useMutation();
  const createProblemSubmissionMutation = backendTrpcReact.createProblemSubmission.useMutation();

  const lastActionTimeRef = useRef(Date.now());
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

  useEffect(() => {
    // ステップ実行中に以下の式は成り立たない。不整合を起こさないように、念の為チェックする。
    if (currentTraceItemIndex === previousTraceItemIndex) return;

    void updateProblemSessionMutation.mutateAsync({
      id: props.initialProblemSession.id,
      incrementalElapsedMilliseconds: getIncrementalElapsedMilliseconds(lastActionTimeRef),
      currentProblemType: problemType,
      currentTraceItemIndex,
      previousTraceItemIndex,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTraceItemIndex]);

  const createSubmission = async (isCorrect: boolean): Promise<void> => {
    const { elapsedMilliseconds } = await updateProblemSessionMutation.mutateAsync({
      id: props.initialProblemSession.id,
      incrementalElapsedMilliseconds: getIncrementalElapsedMilliseconds(lastActionTimeRef),
    });
    await createProblemSubmissionMutation.mutateAsync({
      sessionId: props.initialProblemSession.id,
      problemType,
      traceItemIndex: currentTraceItemIndex,
      elapsedMilliseconds,
      isCorrect,
    });
  };

  const handleSolveProblem = async (): Promise<void> => {
    await updateProblemSessionMutation.mutateAsync({
      id: props.initialProblemSession.id,
      incrementalElapsedMilliseconds: getIncrementalElapsedMilliseconds(lastActionTimeRef),
      completedAt: new Date(),
    });
  };

  return (
    <VStack align="stretch" spacing={8}>
      <VStack align="stretch" spacing={1}>
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
        <Heading as="h1">{problemIdToName[props.params.problemId]}</Heading>
      </VStack>

      {problemType === 'executionResult' ? (
        <ExecutionResultProblem
          createSubmission={createSubmission}
          handleComplete={handleSolveProblem}
          problem={props.problem}
          setCurrentTraceItemIndex={setCurrentTraceItemIndex}
          setProblemType={setProblemType}
        />
      ) : (
        <StepProblem
          createSubmission={createSubmission}
          currentTraceItemIndex={currentTraceItemIndex}
          handleComplete={handleSolveProblem}
          previousTraceItemIndex={previousTraceItemIndex}
          problem={props.problem}
          setCurrentTraceItemIndex={setCurrentTraceItemIndex}
          setPreviousTraceItemIndex={setPreviousTraceItemIndex}
        />
      )}
    </VStack>
  );
};

function getIncrementalElapsedMilliseconds(lastActionTimeRef: React.MutableRefObject<number>): number {
  const nowTime = Date.now();
  const incrementalElapsedMilliseconds = Math.min(
    nowTime - lastActionTimeRef.current,
    MAX_ACTIVE_DURATION_MS_AFTER_LAST_EVENT
  );
  lastActionTimeRef.current = nowTime;
  return incrementalElapsedMilliseconds;
}
