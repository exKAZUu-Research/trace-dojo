'use client';

import { Heading, VStack } from '@chakra-ui/react';
import type { NextPage } from 'next';
import { useState } from 'react';

import { programIdToName } from '../../../../problems/problemData';
import type { ProblemType } from '../../../../types';

import { CheckpointProblem } from './CheckpointProblem';
import { ExecutionResultProblem } from './ExecutionResultProblem';

const ProblemPage: NextPage<{ params: { programId: string } }> = ({ params }) => {
  const [step, setStep] = useState<ProblemType>('normal');

  const ProblemComponent: React.FC = () => {
    switch (step) {
      case 'normal': {
        return <ExecutionResultProblem programId={params.programId} setStep={setStep} />;
      }
      case 'checkpoint': {
        return <CheckpointProblem programId={params.programId} setStep={setStep} />;
      }
    }
  };

  return (
    <main>
      <VStack spacing="4">
        <Heading as="h1">{programIdToName[params.programId]}</Heading>
        <ProblemComponent />
      </VStack>
    </main>
  );
};

export default ProblemPage;
