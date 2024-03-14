'use client';

import { Heading, VStack } from '@chakra-ui/react';
import type { UserProblemSession } from '@prisma/client';
import type { NextPage } from 'next';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useIdleTimer } from 'react-idle-timer';
import { useSessionContext } from 'supertokens-auth-react/recipe/session';
import { useLocalStorage } from 'usehooks-ts';

import { INTERVAL_MS_OF_IDLE_TIMER } from '../../../../../../constants';
import type { CourseId, LanguageId, ProgramId, VisibleLanguageId } from '../../../../../../problems/problemData';
import {
  defaultLanguageId,
  generateProgram,
  getExplanation,
  programIdToName,
  visibleLanguageIds,
} from '../../../../../../problems/problemData';
import type { GeneratedProgram, ProblemType } from '../../../../../../types';
import {
  createUserAnswer,
  createUserCompletedProblem,
  getSuspendedUserProblemSession,
  upsertUserProblemSession,
  updateUserProblemSession,
} from '../../../../../lib/actions';
import { selectedLanguageIdKey } from '../../../../../lib/sessionStorage';

import { CheckpointProblem } from './CheckpointProblem';
import { ExecutionResultProblem } from './ExecutionResultProblem';
import { StepProblem } from './StepProblem';

const ProblemPage: NextPage<{ params: { courseId: CourseId; programId: ProgramId } }> = ({ params }) => {
  const didFetchSessionRef = useRef(false);

  const session = useSessionContext();
  const userId = session.loading ? '' : session.userId;
  const courseId = params.courseId;
  const programId = params.programId;
  // TODO: チェックポイントを取得する処理が実装できたら置き換える
  const checkPointLines = [2, 6, 8, 12];

  const [startedAt] = useState(new Date());
  const [suspendedSession, setSuspendedSession] = useState<UserProblemSession>();
  const [selectedLanguageId, setSelectedLanguageId] = useLocalStorage<VisibleLanguageId>(
    selectedLanguageIdKey,
    defaultLanguageId
  );
  const [problemType, setProblemType] = useState<ProblemType>('executionResult');
  const problemProgram = useMemo<GeneratedProgram>(() => {
    if (!suspendedSession) return { displayProgram: '', instrumentedProgram: '' };
    return generateProgram(
      suspendedSession.programId as ProgramId,
      suspendedSession.languageId as LanguageId,
      suspendedSession.problemVariablesSeed
    );
  }, [suspendedSession]);
  const [beforeCheckPointLine, setBeforeCheckPointLine] = useState(0);
  const [currentCheckPointLine, setCurrentCheckPointLine] = useState(checkPointLines[0]);
  const [timeSpent, setTimeSpent] = useState(0);
  const [activityState, setActivityState] = useState<'Active' | 'Idle'>('Active');

  const { getActiveTime, reset } = useIdleTimer({
    onIdle: () => setActivityState('Idle'),
    onActive: () => setActivityState('Active'),
    timeout: 10_000,
    throttle: 500,
  });

  useEffect(() => {
    const interval = setInterval(async () => {
      console.log('timeSpent:', suspendedSession?.timeSpent);
      console.log('activeTime:', getActiveTime());

      if (suspendedSession && activityState === 'Active') {
        await updateUserProblemSession(suspendedSession.id, {
          timeSpent: timeSpent + getActiveTime(),
        });
      }
    }, INTERVAL_MS_OF_IDLE_TIMER);

    return () => {
      clearInterval(interval);
    };
  }, [activityState, getActiveTime, suspendedSession, timeSpent]);

  useEffect(() => {
    (async () => {
      if (!visibleLanguageIds.includes(selectedLanguageId)) {
        setSelectedLanguageId(defaultLanguageId);
      }

      let suspendedSession = await getSuspendedUserProblemSession(userId, courseId, programId, selectedLanguageId);

      if (suspendedSession) {
        // 中断中のセッションを再開する
        setProblemType(suspendedSession.currentProblemType as ProblemType);
        setBeforeCheckPointLine(suspendedSession.beforeStep);
        setCurrentCheckPointLine(suspendedSession.currentStep);
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
        setTimeSpent(suspendedSession.timeSpent);
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
        problemType === 'executionResult' ? 0 : beforeCheckPointLine,
        problemType === 'executionResult' ? 0 : currentCheckPointLine,
        suspendedSession.timeSpent,
        suspendedSession.startedAt,
        undefined,
        false
      );
      if (updatedSession) {
        setSuspendedSession(updatedSession);
        setTimeSpent(updatedSession.timeSpent);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentCheckPointLine, problemType]);

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
        problemType === 'executionResult' ? 0 : beforeCheckPointLine,
        problemType === 'executionResult' ? 0 : currentCheckPointLine,
        0,
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
      currentCheckPointLine,
      isPassed,
      activeTime,
      startedAt
    );

    if (suspendedSession) {
      const userProblemSession = await updateUserProblemSession(suspendedSession.id, {
        timeSpent: timeSpent + activeTime,
      });

      if (userProblemSession) {
        setTimeSpent(userProblemSession.timeSpent);
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
            beforeCheckPointLine={beforeCheckPointLine}
            checkPointLines={checkPointLines}
            createAnswerLog={createAnswerLog}
            currentCheckPointLine={currentCheckPointLine}
            explanation={explanation}
            problemProgram={problemProgram}
            selectedLanguageId={selectedLanguageId}
            setBeforeCheckPointLine={setBeforeCheckPointLine}
            setCurrentCheckPointLine={setCurrentCheckPointLine}
            setProblemType={setProblemType}
          />
        );
      }
      case 'step': {
        return (
          <StepProblem
            beforeCheckPointLine={beforeCheckPointLine}
            createAnswerLog={createAnswerLog}
            currentCheckPointLine={currentCheckPointLine}
            explanation={explanation}
            handleComplete={handleSolveProblem}
            problemProgram={problemProgram}
            selectedLanguageId={selectedLanguageId}
            setBeforeCheckPointLine={setBeforeCheckPointLine}
            setCurrentCheckPointLine={setCurrentCheckPointLine}
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

export default ProblemPage;
