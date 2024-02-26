'use client';

import { Box, Button, Flex, HStack, VStack } from '@chakra-ui/react';
import { useRef } from 'react';

import { SyntaxHighlighter } from '../../../../../../components/organisms/SyntaxHighlighter';
import type { TurtleGraphicsHandle } from '../../../../../../components/organisms/TurtleGraphics';
import { TurtleGraphics } from '../../../../../../components/organisms/TurtleGraphics';
import type { ProblemType } from '../../../../../../types';

interface ExecutionResultProblemProps {
  problemProgram: string;
  selectedLanguageId: string;
  setProblemType: (step: ProblemType) => void;
  handleComplete: () => void;
  createAnswerLog: (isPassed: boolean) => void;
}

export const ExecutionResultProblem: React.FC<ExecutionResultProblemProps> = ({
  createAnswerLog,
  handleComplete,
  problemProgram,
  selectedLanguageId,
  setProblemType,
}) => {
  const turtleGraphicsRef = useRef<TurtleGraphicsHandle>(null);

  const handleClickResetButton = (): void => {
    turtleGraphicsRef.current?.init();
  };

  const handleClickAnswerButton = async (): Promise<void> => {
    const isPassed = turtleGraphicsRef.current?.isPassed() || false;

    createAnswerLog(isPassed);

    // TODO: 一旦アラートで表示
    if (isPassed) {
      alert('正解です。この問題は終了です');
      handleComplete();
    } else {
      alert('不正解です。チェックポイントごとに回答してください');
      setProblemType('checkpoint');
    }
  };

  return (
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
  );
};
