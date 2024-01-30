'use client';

import { Heading, VStack } from '@chakra-ui/react';
import type { NextPage } from 'next';
import { useState } from 'react';

import { programIdToName } from '../../../../problems/problemData';
import type { ProblemType } from '../../../../types';

import { ExecutionResultProblem } from './ExecutionResultProblem';

const ProblemPage: NextPage<{ params: { problemId: string } }> = ({ params }) => {
  const [step, setStep] = useState<ProblemType>('normal');

  const ProblemComponent: React.FC = () => {
    switch (step) {
      case 'normal': {
        return <ExecutionResultProblem problemId={params.problemId} setStep={setStep} />;
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
