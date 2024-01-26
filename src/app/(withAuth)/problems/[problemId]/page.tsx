'use client';

import { Box, Button, Flex, HStack, Heading, VStack } from '@chakra-ui/react';
import type { NextPage } from 'next';
import { useEffect, useState, useRef } from 'react';

import { SyntaxHighlighter } from '../../../../components/organisms/SyntaxHighlighter';
import type { TurtleGraphicsHandle } from '../../../../components/organisms/TurtleGraphics';
import { TurtleGraphics } from '../../../../components/organisms/TurtleGraphics';
import { programIdToName, generateProgram } from '../../../../problems/problemData';
import { getLanguageIdFromSessionStorage } from '../../../lib/SessionStorage';

const ProblemPage: NextPage<{ params: { problemId: string } }> = ({ params }) => {
  const turtleGraphicsRef = useRef<TurtleGraphicsHandle>(null);
  const [selectedLanguageId, setSelectedLanguageId] = useState('');

  useEffect(() => {
    setSelectedLanguageId(getLanguageIdFromSessionStorage());
  }, []);

  const problemProgram = generateProgram(params.problemId, selectedLanguageId);

  const handleClickResetButton = (): void => {
    turtleGraphicsRef.current?.reset();
  };

  const handleClickAnswerButton = (): void => {
    const isCorrect = turtleGraphicsRef.current?.isCorrect();

    // TODO: 一旦アラートで表示
    if (isCorrect) {
      alert('正解です');
    } else {
      alert('不正解です');
    }
  };

  return (
    <main>
      <VStack spacing="4">
        <Heading as="h1">{programIdToName[params.problemId]}</Heading>
        <Flex gap="6" w="100%">
          <VStack spacing="10">
            <Box>プログラムの実行後の結果を解答してください。</Box>
            <Box>
              <TurtleGraphics ref={turtleGraphicsRef} isEnableOperation={true} problemProgram={problemProgram} />
            </Box>
          </VStack>
          <VStack align="end" minW="50%" overflow="hidden">
            <Button colorScheme="gray">解説</Button>
            {/* 画面に収まる高さに設定 */}
            <Box h="calc(100vh - 370px)" w="100%">
              <SyntaxHighlighter code={problemProgram} programmingLanguageId={selectedLanguageId} />
            </Box>
            <HStack>
              <Button onClick={() => handleClickResetButton()}>リセット</Button>
              <Button onClick={() => handleClickAnswerButton()}>解答</Button>
            </HStack>
          </VStack>
        </Flex>
      </VStack>
    </main>
  );
};

export default ProblemPage;
