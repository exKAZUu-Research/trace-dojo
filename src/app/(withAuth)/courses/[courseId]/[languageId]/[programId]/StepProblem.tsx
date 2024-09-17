'use client';

import { useEffect, useRef } from 'react';

import { CustomModal } from '../../../../../../components/molecules/CustomModal';
import { SyntaxHighlighter } from '../../../../../../components/organisms/SyntaxHighlighter';
import type { TurtleGraphicsHandle } from '../../../../../../components/organisms/TurtleGraphics';
import { TurtleGraphics } from '../../../../../../components/organisms/TurtleGraphics';
import {
  Box,
  Button,
  Flex,
  HStack,
  Tooltip,
  useDisclosure,
  VStack,
} from '../../../../../../infrastructures/useClient/chakra';
import type { Problem } from '../../../../../../problems/generateProblem';

import { Variables } from './Variables';

interface StepProblemProps {
  beforeTraceItemIndex: number;
  createAnswerLog: (isPassed: boolean) => void;
  currentTraceItemIndex: number;
  problem: Problem;
  explanation?: Record<'title' | 'body', string>;
  handleComplete: () => void;
  selectedLanguageId: string;
  setBeforeTraceItemIndex: (line: number) => void;
  setCurrentTraceItemIndex: (line: number) => void;
}

export const StepProblem: React.FC<StepProblemProps> = ({
  beforeTraceItemIndex,
  createAnswerLog,
  currentTraceItemIndex,
  explanation,
  handleComplete,
  problem,
  selectedLanguageId,
  setBeforeTraceItemIndex,
  setCurrentTraceItemIndex,
}) => {
  const turtleGraphicsRef = useRef<TurtleGraphicsHandle>(null);
  const {
    isOpen: isExplanationModalOpen,
    onClose: onExplanationModalClose,
    onOpen: onExplanationModalOpen,
  } = useDisclosure();
  const { isOpen: isHelpModalOpen, onClose: onHelpModalClose, onOpen: onHelpModalOpen } = useDisclosure();

  const beforeCheckpointTraceItem = problem.traceItems[beforeTraceItemIndex];
  const currentCheckpointTraceItem = problem.traceItems[currentTraceItemIndex];

  const handleClickResetButton = (): void => {
    turtleGraphicsRef.current?.init();
  };

  const handleClickAnswerButton = (): void => {
    const isPassed = turtleGraphicsRef.current?.isPassed() || false;

    createAnswerLog(isPassed);

    // TODO: 一旦アラートで表示
    if (isPassed) {
      if (currentCheckpointTraceItem === problem.traceItems.at(-1)) {
        alert('正解です。この問題は終了です');
        handleComplete();
      } else {
        alert('正解です。次の行に進みます');
        setBeforeTraceItemIndex(currentTraceItemIndex);
        setCurrentTraceItemIndex(currentTraceItemIndex + 1);
      }
    } else {
      alert('不正解です。もう一度回答してください');
    }
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        handleClickAnswerButton();
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  return (
    <Flex gap="6" w="100%">
      <VStack spacing="4">
        <VStack align="start">
          <Box>赤色にハイライトされている行における盤面を作成してください。</Box>
          <HStack>
            <Tooltip
              hasArrow
              fontSize="xs"
              label={`${navigator.platform.toLowerCase().includes('mac') ? 'Cmd+Enter' : 'Ctrl+Enter'}`}
              placement="bottom"
            >
              <Button onClick={() => handleClickAnswerButton()}>解答</Button>
            </Tooltip>
            <Button onClick={() => handleClickResetButton()}>リセット</Button>
          </HStack>
        </VStack>
        <VStack align="center">
          <Box textAlign="center" w="100%">
            赤線で囲われた行の実行後の結果（注意：実行前ではなく実行後！）
          </Box>
          <Box>
            <TurtleGraphics
              ref={turtleGraphicsRef}
              beforeTraceItem={beforeCheckpointTraceItem}
              currentTraceItem={currentCheckpointTraceItem}
              isEnableOperation={true}
              problem={problem}
            />
          </Box>
        </VStack>
        {problem.sidToLineIndex.get(beforeCheckpointTraceItem.sid) && (
          <VStack>
            <Box>青色のハイライト行の実行後の結果（注意：実行前ではなく実行後！）</Box>
            <Box>
              <TurtleGraphics
                ref={turtleGraphicsRef}
                beforeTraceItem={beforeCheckpointTraceItem}
                currentTraceItem={currentCheckpointTraceItem}
                isEnableOperation={false}
                problem={problem}
              />
            </Box>
          </VStack>
        )}
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
            beforeCheckpointLine={problem.sidToLineIndex.get(beforeCheckpointTraceItem.sid)}
            code={problem.displayProgram}
            currentCheckpointLine={problem.sidToLineIndex.get(currentCheckpointTraceItem.sid)}
            programmingLanguageId={selectedLanguageId}
          />
        </Box>
        <Variables traceItemVars={beforeCheckpointTraceItem?.vars} />
      </VStack>
    </Flex>
  );
};
