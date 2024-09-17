import { useEffect, useRef, useState } from 'react';

import { CustomModal } from '../../../../../../components/molecules/CustomModal';
import { SyntaxHighlighter } from '../../../../../../components/organisms/SyntaxHighlighter';
import type { TurtleGraphicsHandle } from '../../../../../../components/organisms/TurtleGraphics';
import { TurtleGraphics } from '../../../../../../components/organisms/TurtleGraphics';
import {
  AlertDialog,
  AlertDialogBody,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogOverlay,
  Box,
  Button,
  Flex,
  HStack,
  Tooltip,
  useDisclosure,
  VStack,
} from '../../../../../../infrastructures/useClient/chakra';
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
  console.log('ExecutionResultProblem');

  const turtleGraphicsRef = useRef<TurtleGraphicsHandle>(null);
  const {
    isOpen: isExplanationModalOpen,
    onClose: onExplanationModalClose,
    onOpen: onExplanationModalOpen,
  } = useDisclosure();
  const { isOpen: isHelpModalOpen, onClose: onHelpModalClose, onOpen: onHelpModalOpen } = useDisclosure();
  const { isOpen: isAlertOpen, onClose: onAlertClose, onOpen: onAlertOpen } = useDisclosure();
  const cancelRef = useRef(null);
  console.log('isAlertOpen:', isAlertOpen);

  const [alertTitle, setAlertTitle] = useState('');
  const [alertMessage, setAlertMessage] = useState('');

  const handleClickResetButton = (): void => {
    turtleGraphicsRef.current?.init();
  };

  const handleClickAnswerButton = async (): Promise<void> => {
    const isPassed = turtleGraphicsRef.current?.isPassed() || false;

    createAnswerLog(isPassed);

    if (isPassed) {
      setAlertTitle('正解');
      setAlertMessage('正解です。この問題は終了です');
      onAlertOpen();
      handleComplete();
    } else {
      if (problem.checkpointSids.length > 0) {
        setAlertTitle('不正解');
        setAlertMessage('不正解です。チェックポイントごとに回答してください');
        onAlertOpen();
        const nextCheckpointTraceItemIndex = problem.traceItems.findIndex(
          (traceItem) => traceItem.sid === problem.checkpointSids.at(0)
        );
        setCurrentTraceItemIndex(nextCheckpointTraceItemIndex);
        setProblemType('checkpoint');
      } else {
        setAlertTitle('不正解');
        setAlertMessage('不正解です。ステップごとに回答してください');
        onAlertOpen();
        setCurrentTraceItemIndex(1);
        setProblemType('step');
      }
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
      <VStack align="start" spacing="4" w="100%">
        <Box>
          <Box>プログラムの実行後の結果を解答してください。</Box>
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
        </Box>
        <VStack align="center" w="100%">
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
      <AlertDialog
        closeOnEsc={false}
        closeOnOverlayClick={false}
        isOpen={isAlertOpen}
        leastDestructiveRef={cancelRef}
        onClose={onAlertClose}
      >
        <AlertDialogOverlay>
          <AlertDialogContent>
            <AlertDialogHeader fontSize="lg" fontWeight="bold">
              {alertTitle}
            </AlertDialogHeader>
            <AlertDialogBody>{alertMessage}</AlertDialogBody>
            <AlertDialogFooter>
              <Button ref={cancelRef} onClick={onAlertClose}>
                閉じる
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialogOverlay>
      </AlertDialog>
    </Flex>
  );
};
