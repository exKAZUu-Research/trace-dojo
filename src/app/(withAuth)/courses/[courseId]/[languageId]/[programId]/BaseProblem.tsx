'use client';

import { Heading, VStack } from '@chakra-ui/react';
import type { UserProblemSession } from '@prisma/client';
import { useEffect, useState } from 'react';
import { useIdleTimer } from 'react-idle-timer';

import { INTERVAL_MS_OF_IDLE_TIMER } from '../../../../../../constants';
import type { Problem } from '../../../../../../problems/generateProblem';
import type { CourseId, ProgramId, VisibleLanguageId } from '../../../../../../problems/problemData';
import { getExplanation, programIdToName } from '../../../../../../problems/problemData';
import type { ProblemType } from '../../../../../../types';
import {
  createUserAnswer,
  createUserCompletedProblem,
  updateUserProblemSession,
  upsertUserProblemSession,
} from '../../../../../lib/actions';

import { CheckpointProblem } from './CheckpointProblem';
import { ExecutionResultProblem } from './ExecutionResultProblem';
import { StepProblem } from './StepProblem';

export const BaseProblem: React.FC<{
  courseId: CourseId;
  programId: ProgramId;
  userId: string;
  languageId: VisibleLanguageId;
  userProblemSession: UserProblemSession;
  problem: Problem;
}> = ({ courseId, languageId, problem, programId, userId, userProblemSession }) => {
  const [suspendedSession, setSuspendedSession] = useState<UserProblemSession>(userProblemSession);
  const [problemType, setProblemType] = useState<ProblemType>(userProblemSession.currentProblemType as ProblemType);

  const [beforeTraceItemIndex, setBeforeTraceItemIndex] = useState(0);
  const [currentTraceItemIndex, setCurrentTraceItemIndex] = useState(0);
  const [lastTimeSpent, setLastTimeSpent] = useState(0);

  const { getActiveTime, isIdle, reset } = useIdleTimer({
    timeout: 10_000,
    throttle: 500,
  });

  useEffect(() => {
    const interval = setInterval(async () => {
      if (suspendedSession && !isIdle()) {
        await updateUserProblemSession(suspendedSession.id, {
          timeSpent: lastTimeSpent + getActiveTime(),
        });
      }
    }, INTERVAL_MS_OF_IDLE_TIMER);

    return () => {
      clearInterval(interval);
    };
  }, [isIdle, getActiveTime, suspendedSession, lastTimeSpent]);

  useEffect(() => {
    // 中断中のセッションを再開する
    if (!suspendedSession) return;

    setProblemType(suspendedSession.currentProblemType as ProblemType);
    setBeforeTraceItemIndex(suspendedSession.beforeTraceItemIndex);
    setCurrentTraceItemIndex(suspendedSession.currentTraceItemIndex);
  }, []);

  useEffect(() => {
    if (!userId || !courseId || !programId || !languageId || !suspendedSession) return;

    (async () => {
      const updatedSession = await upsertUserProblemSession(
        suspendedSession.id,
        userId,
        courseId,
        programId,
        languageId,
        suspendedSession.problemVariablesSeed,
        problemType,
        problemType === 'executionResult' ? 0 : beforeTraceItemIndex,
        problemType === 'executionResult' ? 0 : currentTraceItemIndex,
        suspendedSession.timeSpent,
        suspendedSession.startedAt,
        undefined,
        false
      );
      if (updatedSession) {
        setSuspendedSession(updatedSession);
        setLastTimeSpent(updatedSession.timeSpent);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTraceItemIndex, problemType]);

  const handleSolveProblem = async (): Promise<void> => {
    if (userId && suspendedSession) {
      await createUserCompletedProblem(userId, courseId, programId, languageId);
      await upsertUserProblemSession(
        suspendedSession.id,
        userId,
        courseId,
        programId,
        languageId,
        suspendedSession.problemVariablesSeed,
        problemType,
        problemType === 'executionResult' ? 0 : beforeTraceItemIndex,
        problemType === 'executionResult' ? 0 : currentTraceItemIndex,
        suspendedSession.timeSpent,
        suspendedSession.startedAt,
        new Date(),
        true
      );
    }
  };

  const createAnswerLog = async (isPassed: boolean): Promise<void> => {
    if (!userId || !suspendedSession) return;

    const activeTime = getActiveTime();
    const now = new Date();
    const startedAt = new Date(now.getTime() - activeTime);

    await createUserAnswer(
      programId,
      problemType,
      languageId,
      userId,
      suspendedSession.id,
      currentTraceItemIndex,
      isPassed,
      activeTime,
      startedAt
    );

    if (suspendedSession) {
      const userProblemSession = await updateUserProblemSession(suspendedSession.id, {
        timeSpent: lastTimeSpent + activeTime,
      });

      if (userProblemSession) {
        setLastTimeSpent(userProblemSession.timeSpent);
        reset(); // Reset activeTime
      }
    }
  };

  const explanation = getExplanation(programId, languageId);

  const ProblemComponent: React.FC = () => {
    switch (problemType) {
      case 'executionResult': {
        return (
          <ExecutionResultProblem
            createAnswerLog={createAnswerLog}
            explanation={explanation}
            handleComplete={handleSolveProblem}
            problem={problem}
            selectedLanguageId={languageId}
            setCurrentTraceItemIndex={setCurrentTraceItemIndex}
            setProblemType={setProblemType}
          />
        );
      }
      case 'checkpoint': {
        return (
          <CheckpointProblem
            beforeTraceItemIndex={beforeTraceItemIndex}
            createAnswerLog={createAnswerLog}
            currentTraceItemIndex={currentTraceItemIndex}
            explanation={explanation}
            problem={problem}
            selectedLanguageId={languageId}
            setBeforeTraceItemIndex={setBeforeTraceItemIndex}
            setCurrentTraceItemIndex={setCurrentTraceItemIndex}
            setProblemType={setProblemType}
          />
        );
      }
      case 'step': {
        return (
          <StepProblem
            beforeTraceItemIndex={beforeTraceItemIndex}
            createAnswerLog={createAnswerLog}
            currentTraceItemIndex={currentTraceItemIndex}
            explanation={explanation}
            handleComplete={handleSolveProblem}
            problem={problem}
            selectedLanguageId={languageId}
            setBeforeTraceItemIndex={setBeforeTraceItemIndex}
            setCurrentTraceItemIndex={setCurrentTraceItemIndex}
          />
        );
      }
    }
  };

  return (
    <main>
      <VStack spacing="4">
        <Heading as="h1">{programIdToName[programId]}</Heading>
        <ProblemComponent />
      </VStack>
    </main>
  );
};
