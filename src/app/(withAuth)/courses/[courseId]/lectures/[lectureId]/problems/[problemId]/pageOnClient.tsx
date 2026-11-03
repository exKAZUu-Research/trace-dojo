'use client';

import { notFound, useParams } from 'next/navigation';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useIdleTimer } from 'react-idle-timer';

import { MAX_ACTIVE_DURATION_MS_AFTER_LAST_EVENT, MIN_INTERVAL_MS_OF_ACTIVE_EVENTS } from '@/constants';
import { useAuthContextSelector } from '@/contexts/AuthContext';
import { backendTrpcReact } from '@/infrastructures/trpcBackend/client';
import { Button, HStack, Tooltip, VStack } from '@/infrastructures/useClient/chakra';
import type { FillInBlankVerdict } from '@/problems/fillInBlank/grade';
import type { InstantiatedProblem } from '@/problems/instantiateProblem';
import type { CourseId, ProblemId } from '@/problems/problemData';
import type { OrdinaryJavaProblemData } from '@/types';
import { isProblemSessionExpired } from '@/utils/problemSessionError';

import type { ProblemSession } from '../../../../../../../../../db/schema';
import { FillInBlankBody } from './FillInBlankBody';
import { ProblemPageHeader } from './ProblemPageHeader';
import { ProblemBody } from './ProblmBody';
import { ReloadNotice } from './ReloadNotice';

interface Props {
  initialProblemSession: ProblemSession;
  userId: string;
  javaProblem?: OrdinaryJavaProblemData;
  /** Generated on the server, where the Java interpreter runs. */
  problem?: InstantiatedProblem;
}

export const ProblemPageOnClient: React.FC<Props> = (props) => {
  const params = useParams<{ courseId: CourseId; lectureId: string; problemId: ProblemId }>();
  return (
    <ProblemSessionPage
      key={JSON.stringify([
        props.userId,
        params.courseId,
        params.lectureId,
        params.problemId,
        props.initialProblemSession.id,
      ])}
      {...props}
    />
  );
};

// code-gauge-allow functionCognitiveComplexity 28 -- The component predates this change, which only receives the problem as a prop.
// code-gauge-allow functionNcss 40 -- The component predates this change, which only receives the problem as a prop.
const ProblemSessionPage: React.FC<Props> = (props) => {
  const isAdmin = useAuthContextSelector((c) => c.isAdmin);

  const params = useParams<{ courseId: CourseId; lectureId: string; problemId: ProblemId }>();
  const problem = props.javaProblem ?? props.problem;

  const [problemSession, setProblemSession] = useState(props.initialProblemSession);

  const lastActionTimeRef = useRef(0);
  const isCurrentSession = useRef(false);
  useLayoutEffect(() => {
    lastActionTimeRef.current = Date.now();
    isCurrentSession.current = true;
    return () => {
      isCurrentSession.current = false;
    };
  }, []);
  const [isSessionExpired, setIsSessionExpired] = useState(false);
  const onSessionError = (error: unknown): void => {
    if (isCurrentSession.current && isProblemSessionExpired(error)) setIsSessionExpired(true);
  };
  useMonitorUserActivity(props, lastActionTimeRef, onSessionError, isSessionExpired);

  const updateProblemSessionMutation = backendTrpcReact.updateProblemSession.useMutation({ onError: onSessionError });
  const createProblemSubmissionMutation = backendTrpcReact.createProblemSubmission.useMutation({
    onError: onSessionError,
  });

  const createSubmissionUpdatingProblemSession = useCallback(
    async (isCorrect: boolean, isCompleted: boolean): Promise<void> => {
      await createProblemSubmissionMutation.mutateAsync({
        sessionId: problemSession.id,
        problemType: problemSession.problemType,
        traceItemIndex: problemSession.traceItemIndex,
        incrementalElapsedMilliseconds: getIncrementalElapsedMilliseconds(lastActionTimeRef),
        isCorrect,
        isCompleted,
      });
    },
    [problemSession, createProblemSubmissionMutation, lastActionTimeRef]
  );

  const gradeFillInBlankAnswersMutation = backendTrpcReact.gradeFillInBlankAnswers.useMutation({
    onError: onSessionError,
  });
  const gradeCode = useCallback(
    async (code: string): Promise<FillInBlankVerdict> => {
      const newProblemSession = await updateProblemSessionMutation.mutateAsync({
        id: problemSession.id,
        incrementalElapsedMilliseconds: getIncrementalElapsedMilliseconds(lastActionTimeRef),
      });
      if (!isCurrentSession.current) return { status: 'ungradable', detail: 'The problem session changed.' };
      return await gradeFillInBlankAnswersMutation.mutateAsync({
        sessionId: problemSession.id,
        code,
        elapsedMilliseconds: newProblemSession.elapsedMilliseconds,
      });
    },
    [problemSession.id, updateProblemSessionMutation, gradeFillInBlankAnswersMutation, lastActionTimeRef]
  );

  const updateProblemSession = useCallback(
    async (newProblemType: string, newTraceItemIndex: number): Promise<void> => {
      try {
        const newProblemSession = await updateProblemSessionMutation.mutateAsync({
          id: problemSession.id,
          problemType: newProblemType,
          traceItemIndex: newTraceItemIndex,
        });
        setProblemSession(newProblemSession);
      } catch (error) {
        if (!isProblemSessionExpired(error)) throw error;
      }
    },
    [problemSession.id, updateProblemSessionMutation]
  );

  if (!problem || !matchesRoute(props, params.problemId, problemSession.problemType)) notFound();

  if (isSessionExpired) {
    return (
      <ReloadNotice
        message="ページを再読み込みして、現在の学習期間の問題を開いてください。"
        title="学習セッションの有効期限が切れました"
      />
    );
  }

  const isJavaEditor = problemSession.problemType === 'fillInBlank' || problemSession.problemType === 'bugFix';

  return (
    <VStack align="stretch" spacing={4}>
      <ProblemPageHeader
        courseId={params.courseId}
        lectureId={params.lectureId}
        problemId={params.problemId}
        actions={
          !isJavaEditor && 'traceItems' in problem ? (
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
                    updateProblemSession('step', Math.min(problemSession.traceItemIndex + 1, problem.traceItems.length))
                  }
                >
                  次のステップに進む（管理者のみ）
                </Button>
              )}
            </HStack>
          ) : undefined
        }
      />

      {isJavaEditor ? (
        <FillInBlankBody
          key={`${problemSession.id}:${problem.displayProgram}`}
          draftContext={{
            userId: props.userId,
            mode: 'ordinary',
            ...(props.javaProblem ? { problemFormat: props.javaProblem.problemFormat } : {}),
            courseId: params.courseId,
            lectureId: params.lectureId,
            problemId: params.problemId,
            sessionId: problemSession.id,
            seed: props.initialProblemSession.problemVariablesSeed,
          }}
          gradeCode={gradeCode}
          problem={{
            ...(props.javaProblem ? { problemFormat: props.javaProblem.problemFormat } : {}),
            displayProgram: problem.displayProgram,
            finalBoard: problem.finalBoard,
            finalTurtles: problem.finalTurtles,
          }}
        />
      ) : 'traceItems' in problem ? (
        <ProblemBody
          createSubmissionUpdatingProblemSession={createSubmissionUpdatingProblemSession}
          problem={problem}
          problemSession={problemSession}
          updateProblemSession={updateProblemSession}
        />
      ) : undefined}
    </VStack>
  );
};

function useMonitorUserActivity(
  props: Props,
  lastActionTimeRef: React.RefObject<number>,
  onSessionError: (error: unknown) => void,
  isSessionExpired: boolean
): void {
  const updateProblemSessionMutation = backendTrpcReact.updateProblemSession.useMutation({ onError: onSessionError });
  useIdleTimer({
    disabled: isSessionExpired,
    onAction() {
      updateProblemSessionMutation.mutate({
        id: props.initialProblemSession.id,
        incrementalElapsedMilliseconds: getIncrementalElapsedMilliseconds(lastActionTimeRef),
      });
    },
    throttle: MIN_INTERVAL_MS_OF_ACTIVE_EVENTS,
  });
}

function getIncrementalElapsedMilliseconds(lastActionTimeRef: React.RefObject<number>): number {
  const nowTime = Date.now();
  const incrementalElapsedMilliseconds = Math.min(
    nowTime - (lastActionTimeRef.current || nowTime),
    MAX_ACTIVE_DURATION_MS_AFTER_LAST_EVENT
  );
  lastActionTimeRef.current = nowTime;
  return incrementalElapsedMilliseconds;
}

const matchesRoute = (props: Props, problemId: string, problemType: ProblemSession['problemType']): boolean => {
  if (!props.javaProblem) return problemType !== 'bugFix';
  return (
    props.javaProblem.problemId === problemId &&
    props.initialProblemSession.problemId === problemId &&
    problemType === props.javaProblem.problemFormat
  );
};
