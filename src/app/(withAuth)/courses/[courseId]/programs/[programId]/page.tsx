'use client';

import { Heading, VStack } from '@chakra-ui/react';
import type { NextPage } from 'next';
import { useEffect, useState } from 'react';
import { useSessionContext } from 'supertokens-auth-react/recipe/session';

import { generateProgram, getExplanation, programIdToName } from '../../../../../../problems/problemData';
import type { GeneratedProgram, ProblemType } from '../../../../../../types';
import { getLanguageIdFromSessionStorage } from '../../../../../lib/SessionStorage';
import {
  createUserAnswer,
  createUserCompletedProblem,
  fetchUserProblemSessions,
  upsertUserProblemSession,
} from '../../../../../lib/actions';

import { CheckpointProblem } from './CheckpointProblem';
import { ExecutionResultProblem } from './ExecutionResultProblem';
import { StepProblem } from './StepProblem';

const ProblemPage: NextPage<{ params: { courseId: string; programId: string } }> = ({ params }) => {
  const session = useSessionContext();
  const userId = session.loading ? '' : session.userId;
  const courseId = params.courseId;
  const programId = params.programId;
  // TODO: チェックポイントを取得する処理が実装できたら置き換える
  const checkPointLines = [2, 6, 8, 12];

  const [selectedLanguageId, setSelectedLanguageId] = useState('');
  const [problemType, setProblemType] = useState<ProblemType>('executionResult');
  const [problemProgram, setProblemProgram] = useState<GeneratedProgram>({ displayProgram: '', excuteProgram: '' });
  const [beforeCheckPointLine, setBeforeCheckPointLine] = useState(0);
  const [currentCheckPointLine, setCurrentCheckPointLine] = useState(checkPointLines[0]);

  useEffect(() => {
    (async () => {
      const languageId = getLanguageIdFromSessionStorage();
      setSelectedLanguageId(languageId);

      const sessions = await fetchUserProblemSessions({ userId });
      const suspendedSession = sessions.find(
        (session) =>
          session.courseId === courseId &&
          session.programId === programId &&
          session.languageId === languageId &&
          !session.finishedAt &&
          !session.isCompleted
      );

      if (suspendedSession) {
        // 中断中のセッションを再開する
        setProblemType(suspendedSession.currentProblemType as ProblemType);
        setBeforeCheckPointLine(suspendedSession.currentStep);
        setCurrentCheckPointLine(suspendedSession.currentStep);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setProblemProgram(generateProgram(programId, selectedLanguageId));
  }, [programId, selectedLanguageId]);

  useEffect(() => {
    if (!userId || !courseId || !programId || !selectedLanguageId) return;

    (async () => {
      const sessions = await fetchUserProblemSessions({ userId });
      const suspendedSession = sessions.find(
        (session) =>
          session.courseId === courseId &&
          session.programId === programId &&
          session.languageId === selectedLanguageId &&
          !session.finishedAt &&
          !session.isCompleted
      );

      await upsertUserProblemSession(
        // レコードが存在しない場合に作成するためにidに0を指定
        suspendedSession ? suspendedSession.id : 0,
        userId,
        courseId,
        programId,
        selectedLanguageId,
        problemType,
        problemType === 'executionResult' ? 0 : beforeCheckPointLine,
        problemType === 'executionResult' ? 0 : currentCheckPointLine,
        0,
        suspendedSession ? suspendedSession.startedAt : new Date(),
        undefined,
        false
      );
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentCheckPointLine, problemType]);

  const handleSolveProblem = async (): Promise<void> => {
    if (userId) {
      await createUserCompletedProblem(userId, courseId, programId, selectedLanguageId);
    }
  };

  const createAnswerLog = async (isPassed: boolean): Promise<void> => {
    await createUserAnswer(programId, problemType, selectedLanguageId, userId, currentCheckPointLine, isPassed);
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
