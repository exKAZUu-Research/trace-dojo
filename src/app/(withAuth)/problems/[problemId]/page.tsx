'use client';

import { Heading, VStack } from '@chakra-ui/react';
import type { NextPage } from 'next';
import { useState } from 'react';

import { programIdToName } from '../../../../problems/problemData';
import type { ProblemType } from '../../../../types';

import { CheckpointProblem } from './CheckpointProblem';
import { ExecutionResultProblem } from './ExecutionResultProblem';
import { StepProblem } from './StepProblem';

const ProblemPage: NextPage<{ params: { problemId: string } }> = ({ params }) => {
  const [step, setStep] = useState<ProblemType>('normal');

  const ProblemComponent: React.FC = () => {
    switch (step) {
      case 'normal': {
        return <ExecutionResultProblem problemId={params.problemId} setStep={setStep} />;
      }
      case 'checkpoint': {
        return <CheckpointProblem problemId={params.problemId} setStep={setStep} />;
      }
      case 'step': {
        return <StepProblem problemId={params.problemId} setStep={setStep} />;
      }
    }
  };

  return (
    <main>
      <VStack spacing="4">
        <Heading as="h1">{programIdToName[params.problemId]}</Heading>
        <ProblemComponent />
      </VStack>
    </main>
  );
};

export default ProblemPage;
