'use client';

import { Heading, VStack } from '@chakra-ui/react';
import type { UserProblemSession } from '@prisma/client';
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
  visibleLanguageIds,
} from '../../../../../../problems/problemData';
import type { GeneratedProgram, ProblemType } from '../../../../../../types';
import {
  createUserAnswer,
  createUserCompletedProblem,
  getSuspendedUserProblemSession,
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

  const [startedAt] = useState(new Date());
  const [suspendedSession, setSuspendedSession] = useState<UserProblemSession>();
  const [selectedLanguageId, setSelectedLanguageId] = useLocalStorage<VisibleLanguageId>(
    selectedLanguageIdKey,
    defaultLanguageId
  );
  const [problemType, setProblemType] = useState<ProblemType>('executionResult');
  const problemProgram = useMemo<GeneratedProgram>(
    () => generateProgram(programId, selectedLanguageId),
    [programId, selectedLanguageId]
  );
  const [beforeCheckPointLine, setBeforeCheckPointLine] = useState(0);
  const [currentCheckPointLine, setCurrentCheckPointLine] = useState(checkPointLines[0]);

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
      } else {
        // MEMO: reactStrictModeを有効にするとレコードが二重に作成されるため、無効化している
        suspendedSession = await upsertUserProblemSession(
          // レコードが存在しない場合に作成するためにidに0を指定
          0,
          userId,
          courseId,
          programId,
          selectedLanguageId,
          problemType,
          0,
          0,
          0,
          startedAt,
          undefined,
          false
        );
      }
      setSuspendedSession(suspendedSession);
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
        problemType,
        problemType === 'executionResult' ? 0 : beforeCheckPointLine,
        problemType === 'executionResult' ? 0 : currentCheckPointLine,
        0,
        suspendedSession.startedAt,
        undefined,
        false
      );
      setSuspendedSession(updatedSession);
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
