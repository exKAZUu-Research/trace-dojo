'use client';

import { useRef } from 'react';

import { CustomModal } from '../../../../../../components/molecules/CustomModal';
import { SyntaxHighlighter } from '../../../../../../components/organisms/SyntaxHighlighter';
import type { TurtleGraphicsHandle } from '../../../../../../components/organisms/TurtleGraphics';
import { TurtleGraphics } from '../../../../../../components/organisms/TurtleGraphics';
import { Box, Button, Flex, HStack, useDisclosure, VStack } from '../../../../../../infrastructures/useClient/chakra';
import type { Problem } from '../../../../../../problems/generateProblem';
import type { ProblemType } from '../../../../../../types';

interface ExecutionResultProblemProps {
  problem: Problem;
  createAnswerLog: (isPassed: boolean) => void;
  explanation?: Record<'title' | 'body', string>;
  handleComplete: () => void;
  selectedLanguageId: string;
  setCurrentTraceItemIndex: (line: number) => void;
  setProblemType: (step: ProblemType) => void;
}

export const ExecutionResultProblem: React.FC<ExecutionResultProblemProps> = ({
  createAnswerLog,
  explanation,
  handleComplete,
  problem,
  selectedLanguageId,
  setCurrentTraceItemIndex,
  setProblemType,
}) => {
  const turtleGraphicsRef = useRef<TurtleGraphicsHandle>(null);
  const {
    isOpen: isExplanationModalOpen,
    onClose: onExplanationModalClose,
    onOpen: onExplanationModalOpen,
  } = useDisclosure();
  const { isOpen: isHelpModalOpen, onClose: onHelpModalClose, onOpen: onHelpModalOpen } = useDisclosure();

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
      if (problem.checkpointSids.length > 0) {
        alert('不正解です。チェックポイントごとに回答してください');
        const nextCheckpointTraceItemIndex = problem.traceItems.findIndex(
          (traceItem) => traceItem.sid === problem.checkpointSids.at(0)
        );
        setCurrentTraceItemIndex(nextCheckpointTraceItemIndex);
        setProblemType('checkpoint');
      } else {
        alert('不正解です。ステップごとに回答してください');
        setCurrentTraceItemIndex(1);
        setProblemType('step');
      }
    }
  };

  return (
    <Flex gap="6" w="100%">
      <VStack spacing="4">
        <Box>プログラムの実行後の結果を解答してください。</Box>
        <VStack align="start">
          <HStack>
            <Button onClick={() => handleClickAnswerButton()}>解答</Button>
            <Button onClick={() => handleClickResetButton()}>リセット</Button>
          </HStack>
          <Box>
            <TurtleGraphics
              ref={turtleGraphicsRef}
              beforeTraceItem={problem.traceItems.at(0)}
              currentTraceItem={problem.traceItems.at(-1)}
              isEnableOperation={true}
              problem={problem}
            />
          </Box>
        </VStack>
      </VStack>
      <VStack align="end" minW="50%" overflow="hidden">
        <HStack>
          <Button colorScheme="gray" onClick={onHelpModalOpen}>
            解答方法
          </Button>
          <CustomModal
            body="実行結果問題の解答方法の説明"
            isOpen={isHelpModalOpen}
            title="実行結果問題について"
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
        {/* 画面に収まる高さに設定 */}
        <Box h="calc(100vh - 370px)" w="100%">
          <SyntaxHighlighter code={problem.displayProgram} programmingLanguageId={selectedLanguageId} />
        </Box>
      </VStack>
    </Flex>
  );
};
