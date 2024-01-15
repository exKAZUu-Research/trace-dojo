import { Box, Button, Flex, Heading } from '@chakra-ui/react';
import type { NextPage } from 'next';

import { TurtleGraphics } from '../../../../components/organisms/TurtleGraphics';
import { programIdToName } from '../../../../problems/problemData';

const ProblemPage: NextPage<{ params: { problemId: string } }> = async ({ params }) => {
  return (
    <main>
      <Heading as="h1">問題: {programIdToName[params.problemId]}</Heading>
      <Flex>
        <Box>
          <Box>ここに問題文を表示する</Box>
          <Box>
            <TurtleGraphics characters={[]} />
          </Box>
        </Box>
        <Box>
          <Button colorScheme="gray">解説</Button>
          <Box>ここにエディタを表示する</Box>
          <Button colorScheme="gray">リセット</Button>
          <Button colorScheme="gray">解答</Button>
        </Box>
      </Flex>
    </main>
  );
};

export default ProblemPage;
