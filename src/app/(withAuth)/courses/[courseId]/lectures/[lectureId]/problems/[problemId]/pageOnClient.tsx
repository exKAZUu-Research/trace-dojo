'use client';

import type { ProblemSession } from '@prisma/client';
import NextLink from 'next/link';
import { notFound, useParams } from 'next/navigation';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useIdleTimer } from 'react-idle-timer';

import {
  DEFAULT_LANGUAGE_ID,
  MAX_ACTIVE_DURATION_MS_AFTER_LAST_EVENT,
  MIN_INTERVAL_MS_OF_ACTIVE_EVENTS,
} from '../../../../../../../../constants';
import { useAuthContextSelector } from '../../../../../../../../contexts/AuthContext';
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
import { instantiateProblem } from '../../../../../../../../problems/instantiateProblem';
import type { CourseId, ProblemId } from '../../../../../../../../problems/problemData';
import { courseIdToLectureIds, courseIdToName, problemIdToName } from '../../../../../../../../problems/problemData';

import { ProblemBody } from './ProblmBody';

type Props = {
  initialProblemSession: ProblemSession;
  userId: string;
};

export const ProblemPageOnClient: React.FC<Props> = (props) => {
  const isAdmin = useAuthContextSelector((c) => c.isAdmin);

  const params = useParams<{ courseId: CourseId; lectureId: string; problemId: ProblemId }>();
  const lectureIndex = courseIdToLectureIds[params.courseId].indexOf(params.lectureId);
  const problem = useMemo(
    () =>
      instantiateProblem(
        params.problemId as ProblemId,
        DEFAULT_LANGUAGE_ID,
        props.initialProblemSession.problemVariablesSeed
      ),
    [params.problemId, props.initialProblemSession.problemVariablesSeed]
  );

  const [problemSession, setProblemSession] = useState(props.initialProblemSession);

  const lastActionTimeRef = useRef(Date.now());
  useMonitorUserActivity(props, lastActionTimeRef);

  const updateProblemSessionMutation = backendTrpcReact.updateProblemSession.useMutation();
  const createProblemSubmissionMutation = backendTrpcReact.createProblemSubmission.useMutation();

  const createSubmissionUpdatingProblemSession = useCallback(
    async (isCorrect: boolean, isCompleted: boolean): Promise<void> => {
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
    },
    [problemSession, updateProblemSessionMutation, createProblemSubmissionMutation, lastActionTimeRef]
  );

  const updateProblemSession = useCallback(
    async (newProblemType: string, newTraceItemIndex: number): Promise<void> => {
      const newProblemSession = await updateProblemSessionMutation.mutateAsync({
        id: problemSession.id,
        problemType: newProblemType,
        traceItemIndex: newTraceItemIndex,
      });
      setProblemSession(newProblemSession);
    },
    [problemSession.id, updateProblemSessionMutation]
  );

  if (!problem) notFound();

  return (
    <VStack align="stretch" spacing={4}>
      <VStack align="stretch" spacing={1}>
        <HStack justify="space-between" spacing={2}>
          <HStack spacing={2}>
            <Link as={NextLink} color="gray.600" fontWeight="bold" href={`/courses/${params.courseId}`}>
              {courseIdToName[params.courseId]}
            </Link>
            <Text color="gray.600">{'>'}</Text>
            <Link
              as={NextLink}
              color="gray.600"
              fontWeight="bold"
              href={`/courses/${params.courseId}/lectures/${params.lectureId}`}
            >
              第{lectureIndex + 1}回
            </Link>
          </HStack>
        </HStack>
        <HStack justify="space-between" spacing={2}>
          <Heading as="h1">{problemIdToName[params.problemId]}</Heading>
          <HStack spacing={2}>
            <Tooltip
              label={
                problemSession.problemType === 'executionResult'
                  ? '減点になりますが、確実に問題を解けます。'
                  : undefined
              }
            >
              <Button
                colorScheme="blue"
                variant="outline"
                onClick={() => {
                  void updateProblemSession('step', 1);
                }}
              >
                {problemSession.problemType === 'executionResult'
                  ? '諦めてステップ実行モードに移る'
                  : 'ステップ実行モードで最初からやり直す'}
              </Button>
            </Tooltip>
            {isAdmin && (
              <Button
                colorScheme="blue"
                variant="outline"
                onClick={() =>
                  updateProblemSession(
                    'step',
                    Math.min(problemSession.traceItemIndex + 1, problem.traceItems.length - 1)
                  )
                }
              >
                次のステップに進む（管理者のみ）
              </Button>
            )}
          </HStack>
        </HStack>
      </VStack>

      <ProblemBody
        createSubmissionUpdatingProblemSession={createSubmissionUpdatingProblemSession}
        problem={problem}
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
