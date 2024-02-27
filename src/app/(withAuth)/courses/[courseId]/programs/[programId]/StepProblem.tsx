'use client';

import { Box, Button, Flex, HStack, VStack, useDisclosure } from '@chakra-ui/react';
import { useRef } from 'react';

import { CustomModal } from '../../../../../../components/molecules/CustomModal';
import { SyntaxHighlighter } from '../../../../../../components/organisms/SyntaxHighlighter';
import type { TurtleGraphicsHandle } from '../../../../../../components/organisms/TurtleGraphics';
import { TurtleGraphics } from '../../../../../../components/organisms/TurtleGraphics';
import type { GeneratedProgram } from '../../../../../../types';
import { solveProblem } from '../../../../../lib/solveProblem';

import { Variables } from './Variables';

interface StepProblemProps {
  beforeCheckPointLine: number;
  createAnswerLog: (isPassed: boolean) => void;
  currentCheckPointLine: number;
  problemProgram: GeneratedProgram;
  explanation?: Record<'title' | 'body', string>;
  handleComplete: () => void;
  selectedLanguageId: string;
  setBeforeCheckPointLine: (line: number) => void;
  setCurrentCheckPointLine: (line: number) => void;
}

export const StepProblem: React.FC<StepProblemProps> = ({
  beforeCheckPointLine,
  createAnswerLog,
  currentCheckPointLine,
  explanation,
  handleComplete,
  problemProgram,
  selectedLanguageId,
  setBeforeCheckPointLine,
  setCurrentCheckPointLine,
}) => {
  const turtleGraphicsRef = useRef<TurtleGraphicsHandle>(null);
  const {
    isOpen: isExplanationModalOpen,
    onClose: onExplanationModalClose,
    onOpen: onExplanationModalOpen,
  } = useDisclosure();
  const { isOpen: isHelpModalOpen, onClose: onHelpModalClose, onOpen: onHelpModalOpen } = useDisclosure();

  const beforeCheckpointResult = solveProblem(problemProgram.excuteProgram).histories?.at(beforeCheckPointLine);

  const handleClickResetButton = (): void => {
    turtleGraphicsRef.current?.init();
  };

  const handleClickAnswerButton = (): void => {
    const isPassed = turtleGraphicsRef.current?.isPassed() || false;

    createAnswerLog(isPassed);

    // TODO: 一旦アラートで表示
    if (isPassed) {
      const problemProgramLines = problemProgram.displayProgram.split('\n').length;

      if (currentCheckPointLine === problemProgramLines) {
        alert('正解です。この問題は終了です');
        handleComplete();
      } else {
        alert('正解です。次の行に進みます');
        setBeforeCheckPointLine(currentCheckPointLine);
        setCurrentCheckPointLine(currentCheckPointLine + 1);
      }
    } else {
      alert('不正解です。もう一度回答してください');
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
        <HStack>
          <Button colorScheme="gray" onClick={onHelpModalOpen}>
            解答方法
          </Button>
          <CustomModal
            body="ステップ問題の解答方法の説明"
            isOpen={isHelpModalOpen}
            title="ステップ問題について"
            onClose={onHelpModalClose}
          />
          {explanation && (
            <>
              <Button colorScheme="gray" onClick={onExplanationModalOpen}>
                解説
              </Button>
              <CustomModal
                body={explanation.body}
                isOpen={isExplanationModalOpen}
                title={explanation.title}
                onClose={onExplanationModalClose}
              />
            </>
          )}
        </HStack>
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
