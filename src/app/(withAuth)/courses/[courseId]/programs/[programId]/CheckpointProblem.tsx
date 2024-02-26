'use client';

import { Box, Button, Flex, HStack, VStack, useDisclosure } from '@chakra-ui/react';
import { useRef } from 'react';

import { CustomModal } from '../../../../../../components/molecules/CustomModal';
import { SyntaxHighlighter } from '../../../../../../components/organisms/SyntaxHighlighter';
import type { TurtleGraphicsHandle } from '../../../../../../components/organisms/TurtleGraphics';
import { TurtleGraphics } from '../../../../../../components/organisms/TurtleGraphics';
import type { GeneratedProgram, ProblemType } from '../../../../../../types';
import { solveProblem } from '../../../../../lib/solveProblem';

import { Variables } from './Variables';

interface CheckpointProblemProps {
  problemProgram: GeneratedProgram;
  beforeCheckPointLine: number;
  checkPointLines: number[];
  currentCheckPointLine: number;
  explanation?: Record<'title' | 'body', string>;
  selectedLanguageId: string;
  setBeforeCheckPointLine: (line: number) => void;
  setCurrentCheckPointLine: (line: number) => void;
  setStep: (step: ProblemType) => void;
}

export const CheckpointProblem: React.FC<CheckpointProblemProps> = ({
  beforeCheckPointLine,
  checkPointLines,
  currentCheckPointLine,
  explanation,
  problemProgram,
  selectedLanguageId,
  setBeforeCheckPointLine,
  setCurrentCheckPointLine,
  setStep,
}) => {
  const turtleGraphicsRef = useRef<TurtleGraphicsHandle>(null);

  const { isOpen, onClose, onOpen } = useDisclosure();
  const beforeCheckpointResult = solveProblem(problemProgram.excuteProgram).histories?.at(beforeCheckPointLine);

  const handleClickResetButton = (): void => {
    turtleGraphicsRef.current?.init();
  };

  const handleClickAnswerButton = (): void => {
    const isCorrect = turtleGraphicsRef.current?.isCorrect();

    // TODO: 一旦アラートで表示
    if (isCorrect) {
      setBeforeCheckPointLine(currentCheckPointLine);

      if (currentCheckPointLine === checkPointLines.at(-1)) {
        // 最終チェックポイントを正解した場合はその次の行からステップ問題に移行
        alert('正解です。このチェックポイントから1行ずつ回答してください');
        setCurrentCheckPointLine(currentCheckPointLine + 1);
        setStep('step');
      } else {
        alert('正解です。次のチェックポイントに進みます');
        setCurrentCheckPointLine(checkPointLines[checkPointLines.indexOf(currentCheckPointLine) + 1]);
      }
    } else {
      // 不正解の場合は最後に正解したチェックポイントからステップ問題に移行
      alert('不正解です。最後に正解したチェックポイントから1行ずつ回答してください');
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
            problemProgram={problemProgram.excuteProgram}
          />
        </Box>
        <Box>茶色のハイライト時点の実行結果</Box>
        <Box>
          <TurtleGraphics
            ref={turtleGraphicsRef}
            beforeCheckPointLine={beforeCheckPointLine}
            currentCheckPointLine={currentCheckPointLine}
            isEnableOperation={true}
            problemProgram={problemProgram.excuteProgram}
          />
        </Box>
      </VStack>
      <VStack align="end" minW="50%" overflow="hidden">
        {explanation && (
          <>
            <Button colorScheme="gray" onClick={onOpen}>
              解説
            </Button>
            <CustomModal body={explanation.body} isOpen={isOpen} title={explanation.title} onClose={onClose} />
          </>
        )}
        <Box h="640px" w="100%">
          <SyntaxHighlighter
            beforeCheckPointLine={beforeCheckPointLine}
            code={problemProgram.displayProgram}
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
