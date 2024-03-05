'use client';

import { Heading, VStack } from '@chakra-ui/react';
import { useLocalStorage } from '@uidotdev/usehooks';
import type { NextPage } from 'next';
import { useEffect, useMemo, useState } from 'react';
import { useSessionContext } from 'supertokens-auth-react/recipe/session';

import type { CourseId, ProgramId, VisibleLanguageId } from '../../../../../../problems/problemData';
import {
  defaultLanguageId,
  generateProgram,
  getExplanation,
  programIdToName,
} from '../../../../../../problems/problemData';
import type { GeneratedProgram, ProblemType } from '../../../../../../types';
import {
  createUserAnswer,
  createUserCompletedProblem,
  fetchUserProblemSessions,
  upsertUserProblemSession,
} from '../../../../../lib/actions';
import { selectedLanguageIdKey } from '../../../../../lib/sessionStorage';

import { CheckpointProblem } from './CheckpointProblem';
import { ExecutionResultProblem } from './ExecutionResultProblem';
import { StepProblem } from './StepProblem';

const ProblemPage: NextPage<{ params: { courseId: CourseId; programId: ProgramId } }> = ({ params }) => {
  const session = useSessionContext();
  const userId = session.loading ? '' : session.userId;
  const courseId = params.courseId;
  const programId = params.programId;
  // TODO: チェックポイントを取得する処理が実装できたら置き換える
  const checkPointLines = [2, 6, 8, 12];

  const [selectedLanguageId] = useLocalStorage<VisibleLanguageId>(selectedLanguageIdKey, defaultLanguageId);
  const [problemType, setProblemType] = useState<ProblemType>('executionResult');
  const problemProgram = useMemo<GeneratedProgram>(
    () => generateProgram(programId, selectedLanguageId),
    [programId, selectedLanguageId]
  );
  const [beforeCheckPointLine, setBeforeCheckPointLine] = useState(0);
  const [currentCheckPointLine, setCurrentCheckPointLine] = useState(checkPointLines[0]);

  useEffect(() => {
    if (!userId || !courseId || !programId || !selectedLanguageId) return;

    (async () => {
      const sessions = await fetchUserProblemSessions({ userId, courseId, programId, languageId: selectedLanguageId });
      const suspendedSession = sessions.find((session) => !session.finishedAt && !session.isCompleted);

      void upsertUserProblemSession(
        // レコードが存在しない場合に作成するためにidに0を指定
        suspendedSession ? suspendedSession.id : 0,
        userId,
        courseId,
        programId,
        selectedLanguageId,
        problemType,
        problemType === 'executionResult' ? 0 : currentCheckPointLine,
        0,
        new Date(),
        undefined,
        false
      );
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentCheckPointLine, problemType, selectedLanguageId]);

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
