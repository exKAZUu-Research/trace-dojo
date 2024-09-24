'use client';

import type { ProblemSession } from '@prisma/client';
import NextLink from 'next/link';
import { useEffect, useState } from 'react';
import { useIdleTimer } from 'react-idle-timer';

import { INTERVAL_MS_OF_IDLE_TIMER } from '../../../../../../../../constants';
import { backendTrpcReact } from '../../../../../../../../infrastructures/trpcBackend/client';
import { Heading, Link, VStack } from '../../../../../../../../infrastructures/useClient/chakra';
import type { Problem } from '../../../../../../../../problems/generateProblem';
import type { CourseId, ProblemId } from '../../../../../../../../problems/problemData';
import { courseIdToName, problemIdToName } from '../../../../../../../../problems/problemData';
import type { ProblemType } from '../../../../../../../../types';

import { CheckpointProblem, ExecutionResultProblem, StepProblem } from './Problems';

type Props = {
  params: { courseId: CourseId; lectureId: string; problemId: ProblemId };
  problem: Problem;
  userId: string;
  initialProblemSession: ProblemSession;
};

export const ProblemPageOnClient: React.FC<Props> = (props) => {
  const [suspendedSession, setSuspendedSession] = useState<ProblemSession>(props.initialProblemSession);
  const [problemType, setProblemType] = useState<ProblemType>(
    props.initialProblemSession.currentProblemType as ProblemType
  );

  const [currentTraceItemIndex, setCurrentTraceItemIndex] = useState(0);
  const [previousTraceItemIndex, setPreviousTraceItemIndex] = useState(0);
  const [lastTimeSpent, setLastTimeSpent] = useState(0);

  const idleTimer = useIdleTimer({ timeout: 10_000, throttle: 500 });

  const updateProblemSessionMutation = backendTrpcReact.updateProblemSession.useMutation();
  const createProblemSessionAnswerMutation = backendTrpcReact.createProblemSessionAnswer.useMutation();

  useEffect(() => {
    const interval = window.setInterval(async () => {
      if (suspendedSession && !idleTimer.isIdle()) {
        await updateProblemSessionMutation.mutateAsync({
          id: suspendedSession.id,
          elapsedMilliseconds: lastTimeSpent + idleTimer.getActiveTime(),
        });
      }
    }, INTERVAL_MS_OF_IDLE_TIMER);

    return () => {
      window.clearInterval(interval);
    };
  }, [suspendedSession, lastTimeSpent, updateProblemSessionMutation, idleTimer]);

  useEffect(() => {
    // 中断中のセッションを再開する
    if (!suspendedSession) return;

    setProblemType(suspendedSession.currentProblemType as ProblemType);
    setPreviousTraceItemIndex(suspendedSession.previousTraceItemIndex);
    setCurrentTraceItemIndex(suspendedSession.currentTraceItemIndex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!props.userId || !props.params.courseId || !props.params.problemId || !suspendedSession) return;

    (async () => {
      const updated = await updateProblemSessionMutation.mutateAsync({
        id: suspendedSession.id,
        currentProblemType: problemType,
        currentTraceItemIndex: problemType === 'executionResult' ? 0 : currentTraceItemIndex,
        previousTraceItemIndex: problemType === 'executionResult' ? 0 : previousTraceItemIndex,
        elapsedMilliseconds: suspendedSession.elapsedMilliseconds,
      });
      if (updated) {
        setSuspendedSession(updated);
        setLastTimeSpent(updated.elapsedMilliseconds);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTraceItemIndex, problemType]);

  const handleSolveProblem = async (): Promise<void> => {
    console.log('handleSolveProblem:', props.userId, suspendedSession);
    if (!props.userId || !suspendedSession) return;

    await updateProblemSessionMutation.mutateAsync({
      id: suspendedSession.id,
      currentProblemType: problemType,
      currentTraceItemIndex: problemType === 'executionResult' ? 0 : currentTraceItemIndex,
      previousTraceItemIndex: problemType === 'executionResult' ? 0 : previousTraceItemIndex,
      elapsedMilliseconds: suspendedSession.elapsedMilliseconds,
      completedAt: new Date(),
    });
  };

  const createAnswerLog = async (isCorrect: boolean): Promise<void> => {
    if (!props.userId || !suspendedSession) return;

    const activeTime = idleTimer.getActiveTime();

    await createProblemSessionAnswerMutation.mutateAsync({
      sessionId: suspendedSession.id,
      problemType,
      traceItemIndex: currentTraceItemIndex,
      elapsedMilliseconds: activeTime,
      isCorrect,
    });

    const updated = await updateProblemSessionMutation.mutateAsync({
      id: suspendedSession.id,
      elapsedMilliseconds: lastTimeSpent + activeTime,
    });

    setLastTimeSpent(updated.elapsedMilliseconds);
    idleTimer.reset();
  };

  return (
    <VStack align="stretch" spacing={8}>
      <VStack align="stretch" spacing={1}>
        <Link as={NextLink} color="gray.600" fontWeight="bold" href={`/courses/${props.params.courseId}`}>
          {courseIdToName[props.params.courseId]}
        </Link>
        <Heading as="h1">{problemIdToName[props.params.problemId]}</Heading>
      </VStack>

      {problemType === 'executionResult' ? (
        <ExecutionResultProblem
          createAnswerLog={createAnswerLog}
          handleComplete={handleSolveProblem}
          problem={props.problem}
          setCurrentTraceItemIndex={setCurrentTraceItemIndex}
          setProblemType={setProblemType}
        />
      ) : problemType === 'checkpoint' ? (
        <CheckpointProblem
          beforeTraceItemIndex={previousTraceItemIndex}
          createAnswerLog={createAnswerLog}
          currentTraceItemIndex={currentTraceItemIndex}
          problem={props.problem}
          setBeforeTraceItemIndex={setPreviousTraceItemIndex}
          setCurrentTraceItemIndex={setCurrentTraceItemIndex}
          setProblemType={setProblemType}
        />
      ) : (
        <StepProblem
          beforeTraceItemIndex={previousTraceItemIndex}
          createAnswerLog={createAnswerLog}
          currentTraceItemIndex={currentTraceItemIndex}
          handleComplete={handleSolveProblem}
          problem={props.problem}
          setBeforeTraceItemIndex={setPreviousTraceItemIndex}
          setCurrentTraceItemIndex={setCurrentTraceItemIndex}
        />
      )}
    </VStack>
  );
};
