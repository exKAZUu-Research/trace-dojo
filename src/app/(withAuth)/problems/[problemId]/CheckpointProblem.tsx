'use client';

import { Box, Button, Flex, HStack, VStack } from '@chakra-ui/react';
import { useEffect, useRef, useState } from 'react';

import { SyntaxHighlighter } from '../../../../components/organisms/SyntaxHighlighter';
import type { TurtleGraphicsHandle } from '../../../../components/organisms/TurtleGraphics';
import { TurtleGraphics } from '../../../../components/organisms/TurtleGraphics';
import { generateProgram } from '../../../../problems/problemData';
import type { ProblemType } from '../../../../types';
import { getLanguageIdFromSessionStorage } from '../../../lib/SessionStorage';

interface CheckpointProblemProps {
  problemId: string;
  setStep: (step: ProblemType) => void;
}

export const CheckpointProblem: React.FC<CheckpointProblemProps> = ({ problemId, setStep }) => {
  const turtleGraphicsRef = useRef<TurtleGraphicsHandle>(null);
  const [selectedLanguageId, setSelectedLanguageId] = useState('');

  // TODO: チェックポイントを取得する処理が実装できたら置き換える
  const getCheckPointLines = [2, 4];
  const [problemProgram, setProblemProgram] = useState<string>('');
  const [beforeCheckPointLine, setBeforeCheckPointLine] = useState(1);
  const [currentCheckPointLine, setCurrentCheckPointLine] = useState(getCheckPointLines[0]);

  useEffect(() => {
    setSelectedLanguageId(getLanguageIdFromSessionStorage());
  }, []);

  useEffect(() => {
    setProblemProgram(generateProgram(problemId, selectedLanguageId));
  }, [problemId, selectedLanguageId]);

  const handleClickResetButton = (): void => {
    turtleGraphicsRef.current?.init();
  };

  const handleClickAnswerButton = (): void => {
    const isCorrect = turtleGraphicsRef.current?.isCorrect();

    // TODO: 一旦アラートで表示
    if (isCorrect) {
      alert('正解です');

      if (currentCheckPointLine === getCheckPointLines.at(-1)) return;

      setBeforeCheckPointLine(currentCheckPointLine);
      setCurrentCheckPointLine(getCheckPointLines[getCheckPointLines.indexOf(currentCheckPointLine) + 1]);
    } else {
      alert('不正解です');
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
        {/* 画面に収まる高さに設定 */}
        <Box h="calc(100vh - 370px)" w="100%">
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
