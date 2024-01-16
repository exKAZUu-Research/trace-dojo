'use client';

import { Box, Button, Flex, HStack, Heading, VStack } from '@chakra-ui/react';
import type { NextPage } from 'next';

import { TurtleGraphics } from '../../../../components/organisms/TurtleGraphics';
import { programIdToName, generateProgram, getTurtleGraphicsInitialCharacters } from '../../../../problems/problemData';

const GRID_COLUMNS = 12;
const GRID_ROWS = 8;
const GRID_SIZE = 40;

const ProblemPage: NextPage<{ params: { problemId: string } }> = ({ params }) => {
  return (
    <main>
      <VStack spacing="10">
        <Heading as="h1">{programIdToName[params.problemId]}</Heading>
        <Flex gap="10" w="100%">
          <VStack spacing="10" w={GRID_COLUMNS * GRID_SIZE}>
            <Box>ここに問題文を表示する</Box>
            <Box>
              <TurtleGraphics
                characters={getTurtleGraphicsInitialCharacters(params.problemId)}
                gridColumns={GRID_COLUMNS}
                gridRows={GRID_ROWS}
                gridSize={GRID_SIZE}
              />
            </Box>
          </VStack>
          <VStack align="end" w="100%">
            <Button colorScheme="gray">解説</Button>
            <Box border="1px" h="500" p="4" w="100%">
              ここにエディタを表示する
              <pre>{generateProgram(params.problemId, 'java')}</pre>
            </Box>
            <HStack>
              <Button colorScheme="gray">リセット</Button>
              <Button colorScheme="gray">解答</Button>
            </HStack>
          </VStack>
        </Flex>
      </VStack>
    </main>
  );
};

export default ProblemPage;
