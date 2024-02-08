'use client';

import { Box, Button, Flex, HStack, VStack } from '@chakra-ui/react';
import { useRef } from 'react';

import { SyntaxHighlighter } from '../../../../components/organisms/SyntaxHighlighter';
import type { TurtleGraphicsHandle } from '../../../../components/organisms/TurtleGraphics';
import { TurtleGraphics } from '../../../../components/organisms/TurtleGraphics';
import type { ProblemType } from '../../../../types';

interface CheckpointProblemProps {
  problemProgram: string;
  selectedLanguageId: string;
  checkPointLines: number[];
  setStep: (step: ProblemType) => void;
  beforeCheckPointLine: number;
  setBeforeCheckPointLine: (line: number) => void;
  currentCheckPointLine: number;
  setCurrentCheckPointLine: (line: number) => void;
}

export const CheckpointProblem: React.FC<CheckpointProblemProps> = ({
  beforeCheckPointLine,
  checkPointLines,
  currentCheckPointLine,
  problemProgram,
  selectedLanguageId,
  setBeforeCheckPointLine,
  setCurrentCheckPointLine,
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
      alert('正解です');

      if (currentCheckPointLine === checkPointLines.at(-1)) return;

      setBeforeCheckPointLine(currentCheckPointLine);
      setCurrentCheckPointLine(checkPointLines[checkPointLines.indexOf(currentCheckPointLine) + 1]);
    } else {
      alert('不正解です');
      setCurrentCheckPointLine(beforeCheckPointLine + 1);
      setStep('step');
    }
  };

  return (
    <Flex gap="6" w="100%">
      <VStack spacing="10">
        <Box>茶色にハイライトされている行における盤面を作成してください。</Box>
        <Box>青色のハイライト時点の実行結果</Box>
        <Box>
          <TurtleGraphics
            ref={turtleGraphicsRef}
            beforeCheckPointLine={beforeCheckPointLine}
            currentCheckPointLine={currentCheckPointLine}
            isEnableOperation={false}
            problemProgram={problemProgram}
          />
        </Box>
        <Box>茶色のハイライト時点の実行結果</Box>
        <Box>
          <TurtleGraphics
            ref={turtleGraphicsRef}
            beforeCheckPointLine={beforeCheckPointLine}
            currentCheckPointLine={currentCheckPointLine}
            isEnableOperation={true}
            problemProgram={problemProgram}
          />
        </Box>
      </VStack>
      <VStack align="end" minW="50%" overflow="hidden">
        <Button colorScheme="gray">解説</Button>
        <Box h="840px" w="100%">
          <SyntaxHighlighter
            beforeCheckPointLine={beforeCheckPointLine}
            code={problemProgram}
            currentCheckPointLine={currentCheckPointLine}
            programmingLanguageId={selectedLanguageId}
          />
        </Box>
        <HStack>
          <Button onClick={() => handleClickResetButton()}>リセット</Button>
          <Button onClick={() => handleClickAnswerButton()}>解答</Button>
        </HStack>
      </VStack>
    </Flex>
  );
};
