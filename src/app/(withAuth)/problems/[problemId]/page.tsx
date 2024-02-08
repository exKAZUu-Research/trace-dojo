'use client';

import { Heading, VStack } from '@chakra-ui/react';
import type { NextPage } from 'next';
import { useEffect, useState } from 'react';

import { generateProgram, programIdToName } from '../../../../problems/problemData';
import type { ProblemType } from '../../../../types';
import { getLanguageIdFromSessionStorage } from '../../../lib/SessionStorage';

import { CheckpointProblem } from './CheckpointProblem';
import { ExecutionResultProblem } from './ExecutionResultProblem';
import { StepProblem } from './StepProblem';

const ProblemPage: NextPage<{ params: { problemId: string } }> = ({ params }) => {
  const problemId = params.problemId;
  // TODO: チェックポイントを取得する処理が実装できたら置き換える
  const checkPointLines = [1, 4];

  const [selectedLanguageId, setSelectedLanguageId] = useState('');
  const [problemProgram, setProblemProgram] = useState<string>('');
  const [step, setStep] = useState<ProblemType>('normal');
  const [beforeCheckPointLine, setBeforeCheckPointLine] = useState(0);
  const [currentCheckPointLine, setCurrentCheckPointLine] = useState(checkPointLines[0]);

  useEffect(() => {
    setSelectedLanguageId(getLanguageIdFromSessionStorage());
  }, []);

  useEffect(() => {
    setProblemProgram(generateProgram(problemId, selectedLanguageId));
  }, [problemId, selectedLanguageId]);

  const ProblemComponent: React.FC = () => {
    switch (step) {
      case 'normal': {
        return (
          <ExecutionResultProblem
            problemProgram={problemProgram}
            selectedLanguageId={selectedLanguageId}
            setStep={setStep}
          />
        );
      }
      case 'checkpoint': {
        return (
          <CheckpointProblem
            beforeCheckPointLine={beforeCheckPointLine}
            checkPointLines={checkPointLines}
            currentCheckPointLine={currentCheckPointLine}
            problemProgram={problemProgram}
            selectedLanguageId={selectedLanguageId}
            setBeforeCheckPointLine={setBeforeCheckPointLine}
            setCurrentCheckPointLine={setCurrentCheckPointLine}
            setStep={setStep}
          />
        );
      }
      case 'step': {
        return <StepProblem problemId={problemId} setStep={setStep} />;
      }
    }
  };

  return (
    <main>
      <VStack spacing="4">
        <Heading as="h1">{programIdToName[problemId]}</Heading>
        <ProblemComponent />
      </VStack>
    </main>
  );
};

export default ProblemPage;
