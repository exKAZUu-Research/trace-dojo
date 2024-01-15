import { Heading } from '@chakra-ui/react';
import type { NextPage } from 'next';

import { programIdToName } from '../../../../problems/problemData';

const ProblemPage: NextPage<{ params: { problemId: string } }> = async ({ params }) => {
  return (
    <main>
      <Heading as="h1">問題: {programIdToName[params.problemId]}</Heading>
    </main>
  );
};

export default ProblemPage;
