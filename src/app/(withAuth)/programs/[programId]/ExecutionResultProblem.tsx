'use client';

import { Box, Button, Flex, HStack, VStack } from '@chakra-ui/react';
import { useRef } from 'react';

import { SyntaxHighlighter } from '../../../../components/organisms/SyntaxHighlighter';
import type { TurtleGraphicsHandle } from '../../../../components/organisms/TurtleGraphics';
import { TurtleGraphics } from '../../../../components/organisms/TurtleGraphics';
import type { ProblemType } from '../../../../types';

interface ExecutionResultProblemProps {
  problemProgram: string;
  selectedLanguageId: string;
  setStep: (step: ProblemType) => void;
}

export const ExecutionResultProblem: React.FC<ExecutionResultProblemProps> = ({
  problemProgram,
  selectedLanguageId,
  setStep,
}) => {
  const turtleGraphicsRef = useRef<TurtleGraphicsHandle>(null);

  const handleClickResetButton = (): void => {
    turtleGraphicsRef.current?.init();
  };

  const handleClickAnswerButton = (): void => {
    const isCorrect = turtleGraphicsRef.current?.isCorrect();

    // TODO: 一旦アラートで表示
    if (isCorrect) {
      alert('正解です。この問題は終了です');
    } else {
      alert('不正解です。チェックポイントごとに回答してください');
      setStep('checkpoint');
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
