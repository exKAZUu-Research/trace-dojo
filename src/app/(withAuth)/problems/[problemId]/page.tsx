'use client';

import { Box, Button, Flex, HStack, Heading, VStack } from '@chakra-ui/react';
import type { NextPage } from 'next';
import { useEffect, useState } from 'react';

import { SyntaxHighlighter } from '../../../../components/organisms/SyntaxHighlighter';
import { TurtleGraphics } from '../../../../components/organisms/TurtleGraphics';
import { programIdToName, generateProgram, getDescription } from '../../../../problems/problemData';
import { getLanguageIdFromSessionStorage } from '../../../lib/SessionStorage';

const GRID_COLUMNS = 12;
const GRID_ROWS = 8;
const GRID_SIZE = 40;

const ProblemPage: NextPage<{ params: { problemId: string } }> = ({ params }) => {
  const [selectedLanguageId, setSelectedLanguageId] = useState('');

  useEffect(() => {
    setSelectedLanguageId(getLanguageIdFromSessionStorage());
  }, []);

  return (
    <main>
      <VStack spacing="4">
        <Heading as="h1">{programIdToName[params.problemId]}</Heading>
        <Flex gap="6" w="100%">
          <VStack spacing="10" w={GRID_COLUMNS * GRID_SIZE}>
            <Box>{getDescription(params.problemId)}</Box>
            <Box>
              <TurtleGraphics characters={[]} gridColumns={GRID_COLUMNS} gridRows={GRID_ROWS} gridSize={GRID_SIZE} />
            </Box>
          </VStack>
          <VStack align="end" minW="50%" overflow="hidden">
            <Button colorScheme="gray">解説</Button>
            {/* 画面に収まる高さに設定 */}
            <Box h="calc(100vh - 370px)" w="100%">
              <SyntaxHighlighter
                code={generateProgram(params.problemId, selectedLanguageId)}
                programmingLanguageId={selectedLanguageId}
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
