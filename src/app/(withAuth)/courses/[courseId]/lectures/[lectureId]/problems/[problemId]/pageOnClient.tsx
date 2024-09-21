'use client';

import type { UserProblemSession } from '@prisma/client';
import NextLink from 'next/link';
import { useEffect, useState } from 'react';
import { useIdleTimer } from 'react-idle-timer';

import { INTERVAL_MS_OF_IDLE_TIMER } from '../../../../../../../../constants';
import { backendTrpcReact } from '../../../../../../../../infrastructures/trpcBackend/client';
import { Heading, Link, VStack } from '../../../../../../../../infrastructures/useClient/chakra';
import type { Problem } from '../../../../../../../../problems/generateProblem';
import type { CourseId, ProgramId } from '../../../../../../../../problems/problemData';
import { courseIdToName, getExplanation, programIdToName } from '../../../../../../../../problems/problemData';
import type { ProblemType } from '../../../../../../../../types';

import { CheckpointProblem, ExecutionResultProblem, StepProblem } from './Problems';

type Props = {
  params: { courseId: CourseId; lectureId: string; problemId: ProgramId };
  problem: Problem;
  userId: string;
  userProblemSession: UserProblemSession;
};

export const ProblemPageOnClient: React.FC<Props> = (props) => {
  const [suspendedSession, setSuspendedSession] = useState<UserProblemSession>(props.userProblemSession);
  const [problemType, setProblemType] = useState<ProblemType>(
    props.userProblemSession.currentProblemType as ProblemType
  );

  const [beforeTraceItemIndex, setBeforeTraceItemIndex] = useState(0);
  const [currentTraceItemIndex, setCurrentTraceItemIndex] = useState(0);
  const [lastTimeSpent, setLastTimeSpent] = useState(0);

  const { getActiveTime, isIdle, reset } = useIdleTimer({
    timeout: 10_000,
    throttle: 500,
  });

  const updatedSessionQuery = backendTrpcReact.upsertUserProblemSession.useMutation();
  const updateUserProblemSessionQuery = backendTrpcReact.updateUserProblemSession.useMutation();
  const createUserCompletedProblemQuery = backendTrpcReact.createUserCompletedProblem.useMutation();
  const createUserAnswerQuery = backendTrpcReact.createUserAnswer.useMutation();

  useEffect(() => {
    const interval = window.setInterval(async () => {
      if (suspendedSession && !isIdle()) {
        await updateUserProblemSessionQuery.mutateAsync({
          id: suspendedSession.id,
          data: {
            timeSpent: lastTimeSpent + getActiveTime(),
          },
        });
      }
    }, INTERVAL_MS_OF_IDLE_TIMER);

    return () => {
      window.clearInterval(interval);
    };
  }, [isIdle, getActiveTime, suspendedSession, lastTimeSpent, updateUserProblemSessionQuery]);

  useEffect(() => {
    // 中断中のセッションを再開する
    if (!suspendedSession) return;

    setProblemType(suspendedSession.currentProblemType as ProblemType);
    setBeforeTraceItemIndex(suspendedSession.beforeTraceItemIndex);
    setCurrentTraceItemIndex(suspendedSession.currentTraceItemIndex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!props.userId || !props.params.courseId || !props.params.problemId || !suspendedSession) return;

    (async () => {
      const updatedSession = await updatedSessionQuery.mutateAsync({
        id: suspendedSession.id,
        userId: props.userId,
        courseId: props.params.courseId,
        lectureId: props.params.lectureId,
        programId: props.params.problemId,
        problemVariablesSeed: suspendedSession.problemVariablesSeed,
        currentProblemType: problemType,
        beforeTraceItemIndex: problemType === 'executionResult' ? 0 : beforeTraceItemIndex,
        currentTraceItemIndex: problemType === 'executionResult' ? 0 : currentTraceItemIndex,
        timeSpent: suspendedSession.timeSpent,
        startedAt: suspendedSession.startedAt,
        finishedAt: undefined,
        isCompleted: false,
      });
      if (updatedSession) {
        setSuspendedSession(updatedSession);
        setLastTimeSpent(updatedSession.timeSpent);
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
      lectureId: props.params.lectureId,
      programId: props.params.problemId,
    });
    await updatedSessionQuery.mutateAsync({
      id: suspendedSession.id,
      userId: props.userId,
      courseId: props.params.courseId,
      lectureId: props.params.lectureId,
      programId: props.params.problemId,
      problemVariablesSeed: suspendedSession.problemVariablesSeed,
      currentProblemType: problemType,
      beforeTraceItemIndex: problemType === 'executionResult' ? 0 : beforeTraceItemIndex,
      currentTraceItemIndex: problemType === 'executionResult' ? 0 : currentTraceItemIndex,
      timeSpent: suspendedSession.timeSpent,
      startedAt: suspendedSession.startedAt,
      finishedAt: new Date(),
      isCompleted: true,
    });
  };

  const createAnswerLog = async (isPassed: boolean): Promise<void> => {
    if (!props.userId || !suspendedSession) return;

    const activeTime = getActiveTime();
    const now = new Date();
    const startedAt = new Date(now.getTime() - activeTime);

    await createUserAnswerQuery.mutateAsync({
      programId: props.params.problemId,
      problemType,
      userId: props.userId,
      userProblemSessionId: suspendedSession.id,
      step: currentTraceItemIndex,
      isPassed,
      timeSpent: activeTime,
      startedAt,
    });

    if (suspendedSession) {
      const userProblemSession = await updateUserProblemSessionQuery.mutateAsync({
        id: suspendedSession.id,
        data: {
          timeSpent: lastTimeSpent + activeTime,
        },
      });

      if (userProblemSession) {
        setLastTimeSpent(userProblemSession.timeSpent);
        reset(); // Reset activeTime
      }
    }
  };

  const explanation = getExplanation(props.params.problemId);

  return (
    <VStack align="stretch" spacing={8}>
      <VStack align="stretch" spacing={1}>
        <Link as={NextLink} color="gray.600" fontWeight="bold" href={`/courses/${props.params.courseId}`}>
          {courseIdToName[props.params.courseId]}
        </Link>
        <Heading as="h1">{programIdToName[props.params.problemId]}</Heading>
      </VStack>

      {problemType === 'executionResult' ? (
        <ExecutionResultProblem
          createAnswerLog={createAnswerLog}
          explanation={explanation}
          handleComplete={handleSolveProblem}
          problem={props.problem}
          setCurrentTraceItemIndex={setCurrentTraceItemIndex}
          setProblemType={setProblemType}
        />
      ) : problemType === 'checkpoint' ? (
        <CheckpointProblem
          beforeTraceItemIndex={beforeTraceItemIndex}
          createAnswerLog={createAnswerLog}
          currentTraceItemIndex={currentTraceItemIndex}
          explanation={explanation}
          problem={props.problem}
          setBeforeTraceItemIndex={setBeforeTraceItemIndex}
          setCurrentTraceItemIndex={setCurrentTraceItemIndex}
          setProblemType={setProblemType}
        />
      ) : (
        <StepProblem
          beforeTraceItemIndex={beforeTraceItemIndex}
          createAnswerLog={createAnswerLog}
          currentTraceItemIndex={currentTraceItemIndex}
          explanation={explanation}
          handleComplete={handleSolveProblem}
          problem={props.problem}
          setBeforeTraceItemIndex={setBeforeTraceItemIndex}
          setCurrentTraceItemIndex={setCurrentTraceItemIndex}
        />
      )}
    </VStack>
  );
};
