'use client';

import { useEffect, useRef, useState } from 'react';
import { MdOutlineInfo } from 'react-icons/md';

import { CustomModal } from '../../../../../../../../components/molecules/CustomModal';
import {
  AlertDialog,
  AlertDialogBody,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogOverlay,
  Box,
  Button,
  Card,
  Flex,
  Heading,
  HStack,
  Icon,
  Tooltip,
  useDisclosure,
  VStack,
} from '../../../../../../../../infrastructures/useClient/chakra';
import type { Problem } from '../../../../../../../../problems/generateProblem';
import type { ProblemType } from '../../../../../../../../types';
import { isMacOS } from '../../../../../../../../utils/platform';

import type { TurtleGraphicsHandle } from './BoardEditor';
import { BoardEditor } from './BoardEditor';
import { BoardViewer } from './BoardViewer';
import { SyntaxHighlighter } from './SyntaxHighlighter';
import { Variables } from './Variables';

interface ExecutionResultProblemProps {
  problem: Problem;
  createSubmission: (isCorrect: boolean) => void;
  handleComplete: () => void;
  setCurrentTraceItemIndex: (line: number) => void;
  setProblemType: (step: ProblemType) => void;
}

export const ExecutionResultProblem: React.FC<ExecutionResultProblemProps> = (props) => {
  console.log('ExecutionResultProblem');
  return (
    <ProblemComponent
      {...props}
      currentTraceItemIndex={props.problem.traceItems.length - 1}
      previousTraceItemIndex={0}
      type="executionResult"
    />
  );
};

interface StepProblemProps {
  previousTraceItemIndex: number;
  createSubmission: (isCorrect: boolean) => void;
  currentTraceItemIndex: number;
  problem: Problem;
  handleComplete: () => void;
  setPreviousTraceItemIndex: (line: number) => void;
  setCurrentTraceItemIndex: (line: number) => void;
}

export const StepProblem: React.FC<StepProblemProps> = (props) => {
  console.log('StepProblem');
  return <ProblemComponent {...props} type="step" />;
};

interface ProblemProps {
  problem: Problem;
  createSubmission: (isCorrect: boolean) => void;
  setCurrentTraceItemIndex: (line: number) => void;
  setProblemType?: (step: ProblemType) => void;
  handleComplete?: () => void;
  previousTraceItemIndex: number;
  currentTraceItemIndex: number;
  setPreviousTraceItemIndex?: (line: number) => void;
}

const ProblemComponent: React.FC<ProblemProps & { type: 'executionResult' | 'step' }> = ({
  createSubmission,
  currentTraceItemIndex,
  handleComplete,
  previousTraceItemIndex,
  problem,
  setCurrentTraceItemIndex,
  setPreviousTraceItemIndex,
  setProblemType,
  type,
}) => {
  const turtleGraphicsRef = useRef<TurtleGraphicsHandle>(null);
  const { isOpen: isHelpModalOpen, onClose: onHelpModalClose, onOpen: onHelpModalOpen } = useDisclosure();
  const { isOpen: isAlertOpen, onClose: onAlertClose, onOpen: onAlertOpen } = useDisclosure();
  const cancelRef = useRef(null);

  const [alertTitle, setAlertTitle] = useState('');
  const [alertMessage, setAlertMessage] = useState('');
  const [postAlertAction, setPostAlertAction] = useState<() => void>();

  const handleClickResetButton = (): void => {
    turtleGraphicsRef.current?.initialize();
  };

  const openAlertDialog = (title: string, message: string, action?: () => void): void => {
    setAlertTitle(title);
    setAlertMessage(message);
    setPostAlertAction(() => action);
    onAlertOpen();
  };

  const handleClickAnswerButton = async (): Promise<void> => {
    const isCorrect = turtleGraphicsRef.current?.isCorrect() || false;
    createSubmission(isCorrect);

    switch (type) {
      case 'executionResult': {
        if (!isCorrect) {
          openAlertDialog('不正解', '不正解です。ステップごとに回答してください', () => {
            setCurrentTraceItemIndex(1);
            setProblemType?.('step');
          });
          break;
        }

        handleComplete?.();
        openAlertDialog('正解', '正解です。この問題は終了です');
        break;
      }
      case 'step': {
        if (!isCorrect) {
          openAlertDialog('不正解', '不正解です。もう一度回答してください');
          break;
        }

        if (currentTraceItemIndex === problem.traceItems.length - 1) {
          handleComplete?.();
          openAlertDialog('正解', '正解です。この問題は終了です');
        } else {
          openAlertDialog('正解', '正解です。次の行に進みます', () => {
            setPreviousTraceItemIndex?.(currentTraceItemIndex);
            setCurrentTraceItemIndex(currentTraceItemIndex + 1);
          });
        }
        break;
      }
    }
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        void handleClickAnswerButton();
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <Flex gap={6}>
        <VStack align="stretch" flexBasis={0} flexGrow={1} minW={0} spacing={4}>
          <VStack align="stretch" as={Card} overflow="hidden" spacing={0}>
            <VStack align="stretch" borderBottomWidth="1px" p={5}>
              <Heading size="md">問題</Heading>

              <div>
                <Box as="span" fontWeight="bold">
                  {type === 'executionResult' ? (
                    'プログラムを実行した後'
                  ) : (
                    <>
                      <Box as="span" bgColor="red.100" px={0.5} rounded="sm">
                        {problem.sidToLineIndex.get(problem.traceItems[currentTraceItemIndex].sid)}行目
                      </Box>
                      を実行した後
                    </>
                  )}
                </Box>
                の盤面を作成してください。
              </div>

              <HStack spacing={4}>
                <Button leftIcon={<Icon as={MdOutlineInfo} />} size="sm" variant="outline" onClick={onHelpModalOpen}>
                  解答方法
                </Button>
                <CustomModal
                  body={`${type === 'executionResult' ? '実行結果問題' : 'ステップ問題'}の解答方法の説明`}
                  isOpen={isHelpModalOpen}
                  title={`${type === 'executionResult' ? '実行結果問題' : 'ステップ問題'}について`}
                  onClose={onHelpModalClose}
                />
              </HStack>
            </VStack>

            <SyntaxHighlighter
              code={problem.displayProgram}
              currentFocusLine={
                type === 'executionResult'
                  ? undefined
                  : problem.sidToLineIndex.get(problem.traceItems[currentTraceItemIndex].sid)
              }
              previousFocusLine={
                type === 'executionResult'
                  ? undefined
                  : problem.sidToLineIndex.get(problem.traceItems[previousTraceItemIndex].sid)
              }
              programmingLanguageId="java"
            />
          </VStack>

          {type !== 'executionResult' &&
            problem.sidToLineIndex.get(problem.traceItems[previousTraceItemIndex]?.sid) && (
              <VStack align="stretch" as={Card} bg="gray.50" p={5} spacing={6}>
                <VStack align="stretch">
                  <Heading size="md">
                    参考：
                    <Box as="span" bgColor="orange.100" px={0.5} rounded="sm">
                      {problem.sidToLineIndex.get(problem.traceItems[previousTraceItemIndex]?.sid)}行目
                    </Box>
                    を実行した後（
                    <Box as="span" bgColor="red.100" px={0.5} rounded="sm">
                      {problem.sidToLineIndex.get(problem.traceItems[currentTraceItemIndex]?.sid)}行目
                    </Box>
                    を実行する前）の盤面
                  </Heading>
                </VStack>

                <BoardViewer
                  alignSelf="center"
                  board={problem.traceItems[previousTraceItemIndex]?.board}
                  vars={problem.traceItems[previousTraceItemIndex]?.vars}
                />

                <Variables traceItemVars={problem.traceItems[previousTraceItemIndex]?.vars} />
              </VStack>
            )}
        </VStack>

        <VStack align="stretch" flexBasis={0} flexGrow={1} spacing="4">
          <BoardEditor
            ref={turtleGraphicsRef}
            currentTraceItem={problem.traceItems[currentTraceItemIndex]}
            isEditable={true}
            previousTraceItem={problem.traceItems[previousTraceItemIndex]}
            problem={problem}
          />

          <HStack justify="space-between">
            <Button colorScheme="brand" variant="outline" onClick={() => handleClickResetButton()}>
              盤面をリセット
            </Button>

            <Button
              colorScheme="brand"
              rightIcon={
                <Box as="span" color="whiteAlpha.800" fontSize="sm" fontWeight="bold">
                  {isMacOS() ? 'Cmd + Enter' : 'Ctrl + Enter'}
                </Box>
              }
              onClick={() => handleClickAnswerButton()}
            >
              提出
            </Button>
          </HStack>
        </VStack>

        <AlertDialog
          closeOnEsc={true}
          closeOnOverlayClick={false}
          isOpen={isAlertOpen}
          leastDestructiveRef={cancelRef}
          onClose={() => {
            postAlertAction?.();
            onAlertClose();
          }}
        >
          <AlertDialogOverlay>
            <AlertDialogContent>
              <AlertDialogHeader fontSize="lg" fontWeight="bold">
                {alertTitle}
              </AlertDialogHeader>
              <AlertDialogBody>{alertMessage}</AlertDialogBody>
              <AlertDialogFooter>
                <Tooltip hasArrow fontSize="xs" label={`ショートカットキーは Esc`} placement="bottom">
                  <Button
                    ref={cancelRef}
                    onClick={() => {
                      postAlertAction?.();
                      onAlertClose();
                    }}
                  >
                    閉じる
                  </Button>
                </Tooltip>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialogOverlay>
        </AlertDialog>
      </Flex>
    </>
  );
};
