'use client';

import type { ProblemSession } from '@prisma/client';
import NextLink from 'next/link';
import { useEffect, useState } from 'react';
import { useIdleTimer } from 'react-idle-timer';

import { INTERVAL_MS_OF_IDLE_TIMER } from '../../../../../../constants';
import { backendTrpcReact } from '../../../../../../infrastructures/trpcBackend/client';
import { Heading, Link, VStack } from '../../../../../../infrastructures/useClient/chakra';
import type { Problem } from '../../../../../../problems/generateProblem';
import type { CourseId, ProgramId, VisibleLanguageId } from '../../../../../../problems/problemData';
import { courseIdToName, getExplanation, programIdToName } from '../../../../../../problems/problemData';
import type { ProblemType } from '../../../../../../types';

import { CheckpointProblem, ExecutionResultProblem, StepProblem } from './Problems';

type Props = {
  params: { courseId: CourseId; languageId: VisibleLanguageId; programId: ProgramId };
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

  const { getActiveTime, isIdle, reset } = useIdleTimer({
    timeout: 10_000,
    throttle: 500,
  });

  const updateProblemSessionMutation = backendTrpcReact.updateProblemSession.useMutation();
  const createUserCompletedProblemQuery = backendTrpcReact.createUserCompletedProblem.useMutation();
  const createUserAnswerQuery = backendTrpcReact.createUserAnswer.useMutation();

  useEffect(() => {
    const interval = window.setInterval(async () => {
      if (suspendedSession && !isIdle()) {
        await updateProblemSessionMutation.mutateAsync({
          id: suspendedSession.id,
          elapsedMilliseconds: lastTimeSpent + getActiveTime(),
        });
      }
    }, INTERVAL_MS_OF_IDLE_TIMER);

    return () => {
      window.clearInterval(interval);
    };
  }, [isIdle, getActiveTime, suspendedSession, lastTimeSpent, updateProblemSessionMutation]);

  useEffect(() => {
    // 中断中のセッションを再開する
    if (!suspendedSession) return;

    setProblemType(suspendedSession.currentProblemType as ProblemType);
    setPreviousTraceItemIndex(suspendedSession.previousTraceItemIndex);
    setCurrentTraceItemIndex(suspendedSession.currentTraceItemIndex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (
      !props.userId ||
      !props.params.courseId ||
      !props.params.programId ||
      !props.params.languageId ||
      !suspendedSession
    )
      return;

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

    await createUserCompletedProblemQuery.mutateAsync({
      userId: props.userId,
      courseId: props.params.courseId,
      programId: props.params.programId,
      languageId: props.params.languageId,
    });
    await updateProblemSessionMutation.mutateAsync({
      id: suspendedSession.id,
      currentProblemType: problemType,
      currentTraceItemIndex: problemType === 'executionResult' ? 0 : currentTraceItemIndex,
      previousTraceItemIndex: problemType === 'executionResult' ? 0 : previousTraceItemIndex,
      elapsedMilliseconds: suspendedSession.elapsedMilliseconds,
      completedAt: new Date(),
    });
  };

  const createAnswerLog = async (isPassed: boolean): Promise<void> => {
    if (!props.userId || !suspendedSession) return;

    const activeTime = getActiveTime();
    const now = new Date();
    const startedAt = new Date(now.getTime() - activeTime);

    await createUserAnswerQuery.mutateAsync({
      programId: props.params.programId,
      problemType,
      languageId: props.params.languageId,
      userId: props.userId,
      userProblemSessionId: suspendedSession.id,
      step: currentTraceItemIndex,
      isPassed,
      timeSpent: activeTime,
      startedAt,
    });

    if (suspendedSession) {
      const updated = await updateProblemSessionMutation.mutateAsync({
        id: suspendedSession.id,
        elapsedMilliseconds: lastTimeSpent + activeTime,
      });

      if (updated) {
        setLastTimeSpent(updated.elapsedMilliseconds);
        reset(); // Reset activeTime
      }
    }
  };

  const explanation = getExplanation(props.params.programId, props.params.languageId);

  return (
    <VStack align="stretch" spacing={8}>
      <VStack align="stretch" spacing={1}>
        <Link as={NextLink} color="gray.600" fontWeight="bold" href={`/courses/${props.params.courseId}`}>
          {courseIdToName[props.params.courseId]}
        </Link>
        <Heading as="h1">{programIdToName[props.params.programId]}</Heading>
      </VStack>

      {problemType === 'executionResult' ? (
        <ExecutionResultProblem
          createAnswerLog={createAnswerLog}
          explanation={explanation}
          handleComplete={handleSolveProblem}
          problem={props.problem}
          selectedLanguageId={props.params.languageId}
          setCurrentTraceItemIndex={setCurrentTraceItemIndex}
          setProblemType={setProblemType}
        />
      ) : problemType === 'checkpoint' ? (
        <CheckpointProblem
          beforeTraceItemIndex={previousTraceItemIndex}
          createAnswerLog={createAnswerLog}
          currentTraceItemIndex={currentTraceItemIndex}
          explanation={explanation}
          problem={props.problem}
          selectedLanguageId={props.params.languageId}
          setBeforeTraceItemIndex={setPreviousTraceItemIndex}
          setCurrentTraceItemIndex={setCurrentTraceItemIndex}
          setProblemType={setProblemType}
        />
      ) : (
        <StepProblem
          beforeTraceItemIndex={previousTraceItemIndex}
          createAnswerLog={createAnswerLog}
          currentTraceItemIndex={currentTraceItemIndex}
          explanation={explanation}
          handleComplete={handleSolveProblem}
          problem={props.problem}
          selectedLanguageId={props.params.languageId}
          setBeforeTraceItemIndex={setPreviousTraceItemIndex}
          setCurrentTraceItemIndex={setCurrentTraceItemIndex}
        />
      )}
    </VStack>
  );
};
