'use client';

import { Box, Button, Flex, HStack, VStack, useDisclosure } from '@chakra-ui/react';
import { useRef } from 'react';

import { CustomModal } from '../../../../../../components/molecules/CustomModal';
import { SyntaxHighlighter } from '../../../../../../components/organisms/SyntaxHighlighter';
import type { TurtleGraphicsHandle } from '../../../../../../components/organisms/TurtleGraphics';
import { TurtleGraphics } from '../../../../../../components/organisms/TurtleGraphics';
import type { GeneratedProgram, ProblemType } from '../../../../../../types';

interface ExecutionResultProblemProps {
  problemProgram: GeneratedProgram;
  explanation?: Record<'title' | 'body', string>;
  handleComplete: () => void;
  selectedLanguageId: string;
  setStep: (step: ProblemType) => void;
}

export const ExecutionResultProblem: React.FC<ExecutionResultProblemProps> = ({
  explanation,
  handleComplete,
  problemProgram,
  selectedLanguageId,
  setStep,
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

  const handleClickAnswerButton = (): void => {
    const isCorrect = turtleGraphicsRef.current?.isCorrect();

    // TODO: 一旦アラートで表示
    if (isCorrect) {
      alert('正解です。この問題は終了です');
      handleComplete();
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
          <TurtleGraphics
            ref={turtleGraphicsRef}
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
          <SyntaxHighlighter code={problemProgram.displayProgram} programmingLanguageId={selectedLanguageId} />
        </Box>
        <HStack>
          <Button onClick={() => handleClickResetButton()}>リセット</Button>
          <Button onClick={() => handleClickAnswerButton()}>解答</Button>
        </HStack>
      </VStack>
    </Flex>
  );
};
