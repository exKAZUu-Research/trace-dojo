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

import { Variables } from './Variables';

interface CheckpointProblemProps {
  setProblemType: (step: ProblemType) => void;
  problem: Problem;
  beforeTraceItemIndex: number;
  createAnswerLog: (isPassed: boolean) => void;
  currentTraceItemIndex: number;
  explanation?: Record<'title' | 'body', string>;
  selectedLanguageId: string;
  setBeforeTraceItemIndex: (line: number) => void;
  setCurrentTraceItemIndex: (line: number) => void;
}

export const CheckpointProblem: React.FC<CheckpointProblemProps> = ({
  beforeTraceItemIndex,
  createAnswerLog,
  currentTraceItemIndex,
  explanation,
  problem,
  selectedLanguageId,
  setBeforeTraceItemIndex,
  setCurrentTraceItemIndex,
  setProblemType,
}) => {
  console.log('CheckpointProblem');

  const turtleGraphicsRef = useRef<TurtleGraphicsHandle>(null);
  const {
    isOpen: isExplanationModalOpen,
    onClose: onExplanationModalClose,
    onOpen: onExplanationModalOpen,
  } = useDisclosure();
  const { isOpen: isHelpModalOpen, onClose: onHelpModalClose, onOpen: onHelpModalOpen } = useDisclosure();
  const { isOpen: isAlertOpen, onClose: onAlertClose, onOpen: onAlertOpen } = useDisclosure();
  const cancelRef = useRef(null);

  const beforeCheckpointTraceItem = problem.traceItems[beforeTraceItemIndex];
  const currentCheckpointTraceItem = problem.traceItems[currentTraceItemIndex];

  const [alertTitle, setAlertTitle] = useState('');
  const [alertMessage, setAlertMessage] = useState('');

  const handleClickResetButton = (): void => {
    turtleGraphicsRef.current?.init();
  };

  const handleClickAnswerButton = (): void => {
    const isPassed = turtleGraphicsRef.current?.isPassed() || false;

    createAnswerLog(isPassed);

    if (isPassed) {
      setBeforeTraceItemIndex(currentTraceItemIndex);

      if (currentCheckpointTraceItem.sid === problem.checkpointSids.at(-1)) {
        setAlertTitle('正解');
        setAlertMessage('正解です。このチェックポイントから1行ずつ回答してください');
        onAlertOpen();
        setCurrentTraceItemIndex(currentTraceItemIndex + 1);
        setProblemType('step');
      } else {
        setAlertTitle('正解');
        setAlertMessage('正解です。次のチェックポイントに進みます');
        onAlertOpen();
        const nextCheckpointTraceItemIndex = problem.traceItems.findIndex(
          (traceItem) =>
            traceItem.sid ===
            problem.checkpointSids.at(problem.checkpointSids.indexOf(currentCheckpointTraceItem.sid) + 1)
        );
        setCurrentTraceItemIndex(nextCheckpointTraceItemIndex);
      }
    } else {
      setAlertTitle('不正解');
      setAlertMessage('不正解です。最後に正解したチェックポイントから1行ずつ回答してください');
      onAlertOpen();
      setCurrentTraceItemIndex(beforeTraceItemIndex + 1);
      setProblemType('step');
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
            body="チェックポイント問題の解答方法の説明"
            isOpen={isHelpModalOpen}
            title="チェックポイント問題について"
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
