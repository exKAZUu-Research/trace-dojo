'use client';

import { Box, Button, Flex, HStack, Heading, VStack } from '@chakra-ui/react';
import type { NextPage } from 'next';

import { CodeEditor } from '../../../../components/organisms/CodeEditor';
import { TurtleGraphics } from '../../../../components/organisms/TurtleGraphics';
import { programIdToName, generateProgram, getDescription } from '../../../../problems/problemData';

const GRID_COLUMNS = 12;
const GRID_ROWS = 8;
const GRID_SIZE = 40;

const ProblemPage: NextPage<{ params: { problemId: string } }> = ({ params }) => {
  // TODO: 一旦Java固定 言語選択機能実装時に変更する
  const programmingLanguageId = 'java';

  return (
    <main>
      <VStack spacing="10">
        <Heading as="h1">{programIdToName[params.problemId]}</Heading>
        <Flex gap="6" w="100%">
          <VStack spacing="10" w={GRID_COLUMNS * GRID_SIZE}>
            <Box>{getDescription(params.problemId)}</Box>
            <Box>
              <TurtleGraphics characters={[]} gridColumns={GRID_COLUMNS} gridRows={GRID_ROWS} gridSize={GRID_SIZE} />
            </Box>
          </VStack>
          <VStack align="end" w="50%">
            <Button colorScheme="gray">解説</Button>
            <Box w="100%">
              <CodeEditor
                code={generateProgram(params.problemId, programmingLanguageId)}
                programmingLanguageId={programmingLanguageId}
              />
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
