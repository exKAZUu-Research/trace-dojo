'use client';

import { Box, Button, Flex, HStack, VStack } from '@chakra-ui/react';
import { useRef } from 'react';

import { SyntaxHighlighter } from '../../../../../../components/organisms/SyntaxHighlighter';
import type { TurtleGraphicsHandle } from '../../../../../../components/organisms/TurtleGraphics';
import { TurtleGraphics } from '../../../../../../components/organisms/TurtleGraphics';
import type { ProblemType } from '../../../../../../types';
import { solveProblem } from '../../../../../lib/solveProblem';

import { Variables } from './Variables';

interface CheckpointProblemProps {
  problemProgram: string;
  selectedLanguageId: string;
  checkPointLines: number[];
  setProblemType: (step: ProblemType) => void;
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
  setProblemType,
}) => {
  const turtleGraphicsRef = useRef<TurtleGraphicsHandle>(null);

  const beforeCheckpointResult = solveProblem(problemProgram).histories?.at(beforeCheckPointLine);

  const handleClickResetButton = (): void => {
    turtleGraphicsRef.current?.init();
  };

  const handleClickAnswerButton = (): void => {
    const isPassed = turtleGraphicsRef.current?.isPassed();

    // TODO: 一旦アラートで表示
    if (isPassed) {
      setBeforeCheckPointLine(currentCheckPointLine);

      if (currentCheckPointLine === checkPointLines.at(-1)) {
        // 最終チェックポイントを正解した場合はその次の行からステップ問題に移行
        alert('正解です。このチェックポイントから1行ずつ回答してください');
        setCurrentCheckPointLine(currentCheckPointLine + 1);
        setProblemType('step');
      } else {
        alert('正解です。次のチェックポイントに進みます');
        setCurrentCheckPointLine(checkPointLines[checkPointLines.indexOf(currentCheckPointLine) + 1]);
      }
    } else {
      // 不正解の場合は最後に正解したチェックポイントからステップ問題に移行
      alert('不正解です。最後に正解したチェックポイントから1行ずつ回答してください');
      setCurrentCheckPointLine(beforeCheckPointLine + 1);
      setProblemType('step');
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
        <Box h="640px" w="100%">
          <SyntaxHighlighter
            beforeCheckPointLine={beforeCheckPointLine}
            code={problemProgram}
            currentCheckPointLine={currentCheckPointLine}
            programmingLanguageId={selectedLanguageId}
          />
        </Box>
        <Variables
          characterVariables={beforeCheckpointResult?.characterVariables}
          variables={beforeCheckpointResult?.otherVariables}
        />
        <HStack>
          <Button onClick={() => handleClickResetButton()}>リセット</Button>
          <Button onClick={() => handleClickAnswerButton()}>解答</Button>
        </HStack>
      </VStack>
    </Flex>
  );
};
