'use client';

import { Heading, VStack } from '@chakra-ui/react';
import type { NextPage } from 'next';
import { useEffect, useState } from 'react';
import { useSessionContext } from 'supertokens-auth-react/recipe/session';

import { generateProgram, programIdToName } from '../../../../../../problems/problemData';
import type { ProblemType } from '../../../../../../types';
import { getLanguageIdFromSessionStorage } from '../../../../../lib/SessionStorage';
import { createProblemAnswerLog, createUserSolvedProblem } from '../../../../../lib/actions';

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

  const [startedAt, setStartedAt] = useState(new Date());
  const [selectedLanguageId, setSelectedLanguageId] = useState('');
  const [problemProgram, setProblemProgram] = useState<string>('');
  const [problemType, setProblemType] = useState<ProblemType>('executionResult');
  const [beforeCheckPointLine, setBeforeCheckPointLine] = useState(0);
  const [currentCheckPointLine, setCurrentCheckPointLine] = useState(checkPointLines[0]);

  useEffect(() => {
    setSelectedLanguageId(getLanguageIdFromSessionStorage());
  }, []);

  useEffect(() => {
    setProblemProgram(generateProgram(programId, selectedLanguageId));
  }, [programId, selectedLanguageId]);

  const handleSolveProblem = async (): Promise<void> => {
    if (userId) {
      await createUserSolvedProblem(userId, courseId, programId, selectedLanguageId);
    }
  };

  const createAnswerLog = async (isPassed: boolean): Promise<void> => {
    await createProblemAnswerLog(programId, problemType, selectedLanguageId, userId, startedAt, new Date(), isPassed);
    setStartedAt(new Date());
  };

  const ProblemComponent: React.FC = () => {
    switch (problemType) {
      case 'executionResult': {
        return (
          <ExecutionResultProblem
            createAnswerLog={createAnswerLog}
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
            problemProgram={problemProgram}
            selectedLanguageId={selectedLanguageId}
            setBeforeCheckPointLine={setBeforeCheckPointLine}
            setCurrentCheckPointLine={setCurrentCheckPointLine}
            setProblemType={setProblemType}
            setStartedAt={setStartedAt}
          />
        );
      }
      case 'step': {
        return (
          <StepProblem
            beforeCheckPointLine={beforeCheckPointLine}
            createAnswerLog={createAnswerLog}
            currentCheckPointLine={currentCheckPointLine}
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
