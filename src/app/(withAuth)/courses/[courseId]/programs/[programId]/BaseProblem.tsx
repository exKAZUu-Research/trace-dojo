'use client';

import { Heading, VStack } from '@chakra-ui/react';
import type { UserProblemSession } from '@prisma/client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useIdleTimer } from 'react-idle-timer';
import { useLocalStorage } from 'usehooks-ts';

import { INTERVAL_MS_OF_IDLE_TIMER } from '../../../../../../constants';
import type { GeneratedProgram } from '../../../../../../problems/generateProgram';
import { generateProgram } from '../../../../../../problems/generateProgram';
import type { CourseId, LanguageId, ProgramId, VisibleLanguageId } from '../../../../../../problems/problemData';
import {
  defaultLanguageId,
  getExplanation,
  programIdToName,
  visibleLanguageIds,
} from '../../../../../../problems/problemData';
import type { ProblemType } from '../../../../../../types';
import {
  createUserAnswer,
  createUserCompletedProblem,
  getSuspendedUserProblemSession,
  updateUserProblemSession,
  upsertUserProblemSession,
} from '../../../../../lib/actions';
import { selectedLanguageIdKey } from '../../../../../lib/sessionStorage';

import { CheckpointProblem } from './CheckpointProblem';
import { ExecutionResultProblem } from './ExecutionResultProblem';
import { StepProblem } from './StepProblem';

export const BaseProblem: React.FC<{ courseId: CourseId; programId: ProgramId; userId: string }> = ({
  courseId,
  programId,
  userId,
}) => {
  const didFetchSessionRef = useRef(false);

  const [startedAt] = useState(new Date());
  const [suspendedSession, setSuspendedSession] = useState<UserProblemSession>();
  const [selectedLanguageId, setSelectedLanguageId] = useLocalStorage<VisibleLanguageId>(
    selectedLanguageIdKey,
    defaultLanguageId
  );
  const [problemType, setProblemType] = useState<ProblemType>('executionResult');
  const problemProgram = useMemo<GeneratedProgram>(() => {
    // TODO: 後述の通り、Server Componentで `suspendedSession` 取得することで、ダミーデータを使う状況を排除したい。
    if (!suspendedSession)
      return {
        languageId: selectedLanguageId,
        displayProgram: '',
        checkpointSids: [],
        traceItems: [],
        sidToLineIndex: new Map(),
      };
    return generateProgram(
      suspendedSession.programId as ProgramId,
      suspendedSession.languageId as LanguageId,
      suspendedSession.problemVariablesSeed
    );
  }, [suspendedSession]);

  // TODO: チェックポイントはあくまで `sid` なので、可視化する際は `sidToLineIndex` を用いて、行番号を特定すること。
  const [beforeCheckpointSid, setBeforeCheckpointSid] = useState(0);
  const [currentCheckpointSid, setCurrentCheckpointSid] = useState(problemProgram.checkpointSids[0] ?? 0);
  const [lastTimeSpent, setLastTimeSpent] = useState(0);
  const [activityState, setActivityState] = useState<'Active' | 'Idle'>('Active');

  const { getActiveTime, reset } = useIdleTimer({
    onIdle: () => setActivityState('Idle'),
    onActive: () => setActivityState('Active'),
    timeout: 10_000,
    throttle: 500,
  });

  useEffect(() => {
    const interval = setInterval(async () => {
      if (suspendedSession && activityState === 'Active') {
        await updateUserProblemSession(suspendedSession.id, {
          timeSpent: lastTimeSpent + getActiveTime(),
        });
      }
    }, INTERVAL_MS_OF_IDLE_TIMER);

    return () => {
      clearInterval(interval);
    };
  }, [activityState, getActiveTime, suspendedSession, lastTimeSpent]);

  useEffect(() => {
    (async () => {
      if (!visibleLanguageIds.includes(selectedLanguageId)) {
        setSelectedLanguageId(defaultLanguageId);
      }

      // TODO: suspendedSessionが読み込まれる前の状態では、不正確な画面が描画されてしまうため、Server Componentで読み込むこと。
      let suspendedSession = await getSuspendedUserProblemSession(userId, courseId, programId, selectedLanguageId);

      if (suspendedSession) {
        // 中断中のセッションを再開する
        setProblemType(suspendedSession.currentProblemType as ProblemType);
        setBeforeCheckpointSid(suspendedSession.beforeStep);
        setCurrentCheckpointSid(suspendedSession.currentStep);
        didFetchSessionRef.current = true;
      } else {
        // reactStrictModeが有効の場合にレコードが二重に作成されることを防ぐためrefで制御
        if (didFetchSessionRef.current === false) {
          didFetchSessionRef.current = true;

          const problemVariableSeed = Date.now().toString();
          suspendedSession = await upsertUserProblemSession(
            // createするためにidに0を指定
            0,
            userId,
            courseId,
            programId,
            selectedLanguageId,
            problemVariableSeed,
            problemType,
            0,
            0,
            undefined,
            startedAt,
            undefined,
            false
          );
        }
      }
      if (suspendedSession) {
        setSuspendedSession(suspendedSession);
        setLastTimeSpent(suspendedSession.timeSpent);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!userId || !courseId || !programId || !selectedLanguageId || !suspendedSession) return;

    (async () => {
      const updatedSession = await upsertUserProblemSession(
        suspendedSession.id,
        userId,
        courseId,
        programId,
        selectedLanguageId,
        suspendedSession.problemVariablesSeed,
        problemType,
        problemType === 'executionResult' ? 0 : beforeCheckpointSid,
        problemType === 'executionResult' ? 0 : currentCheckpointSid,
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
  }, [currentCheckpointSid, problemType]);

  const handleSolveProblem = async (): Promise<void> => {
    if (userId && suspendedSession) {
      await createUserCompletedProblem(userId, courseId, programId, selectedLanguageId);
      await upsertUserProblemSession(
        suspendedSession.id,
        userId,
        courseId,
        programId,
        selectedLanguageId,
        suspendedSession.problemVariablesSeed,
        problemType,
        problemType === 'executionResult' ? 0 : beforeCheckpointSid,
        problemType === 'executionResult' ? 0 : currentCheckpointSid,
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
      selectedLanguageId,
      userId,
      suspendedSession.id,
      currentCheckpointSid,
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

  const explanation = getExplanation(programId, selectedLanguageId);

  const ProblemComponent: React.FC = () => {
    switch (problemType) {
      case 'executionResult': {
        return (
          <ExecutionResultProblem
            createAnswerLog={createAnswerLog}
            explanation={explanation}
            handleComplete={handleSolveProblem}
            problemProgram={problemProgram}
            selectedLanguageId={selectedLanguageId}
            setProblemType={setProblemType}
          />
        );
      }
      case 'checkpoint': {
        return (
          <CheckpointProblem
            beforeCheckpointSid={beforeCheckpointSid}
            createAnswerLog={createAnswerLog}
            currentCheckpointSid={currentCheckpointSid}
            explanation={explanation}
            problemProgram={problemProgram}
            selectedLanguageId={selectedLanguageId}
            setBeforeCheckpointSid={setBeforeCheckpointSid}
            setCurrentCheckpointSid={setCurrentCheckpointSid}
            setProblemType={setProblemType}
          />
        );
      }
      case 'step': {
        return (
          <StepProblem
            beforeCheckPointLine={beforeCheckpointSid}
            createAnswerLog={createAnswerLog}
            currentCheckPointLine={currentCheckpointSid}
            explanation={explanation}
            handleComplete={handleSolveProblem}
            problemProgram={problemProgram}
            selectedLanguageId={selectedLanguageId}
            setBeforeCheckpointSid={setBeforeCheckpointSid}
            setCurrentCheckpointSid={setCurrentCheckpointSid}
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
