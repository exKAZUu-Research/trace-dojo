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

import { BoardEditor } from './BoardEditor';
import type { TurtleGraphicsHandle } from './BoardEditor';
import { BoardViewer } from './BoardViewer';
import { SyntaxHighlighter } from './SyntaxHighlighter';
import { Variables } from './Variables';

interface ExecutionResultProblemProps {
  problem: Problem;
  createAnswerLog: (isPassed: boolean) => void;
  handleComplete: () => void;
  setCurrentTraceItemIndex: (line: number) => void;
  setProblemType: (step: ProblemType) => void;
}

export const ExecutionResultProblem: React.FC<ExecutionResultProblemProps> = (props) => {
  console.log('ExecutionResultProblem');
  return (
    <ProblemComponent
      {...props}
      beforeTraceItemIndex={0}
      currentTraceItemIndex={props.problem.traceItems.length - 1}
      type="executionResult"
    />
  );
};

interface CheckpointProblemProps {
  setProblemType: (step: ProblemType) => void;
  problem: Problem;
  beforeTraceItemIndex: number;
  createAnswerLog: (isPassed: boolean) => void;
  currentTraceItemIndex: number;
  setBeforeTraceItemIndex: (line: number) => void;
  setCurrentTraceItemIndex: (line: number) => void;
}

export const CheckpointProblem: React.FC<CheckpointProblemProps> = (props) => {
  console.log('CheckpointProblem');
  return <ProblemComponent {...props} type="checkpoint" />;
};

interface StepProblemProps {
  beforeTraceItemIndex: number;
  createAnswerLog: (isPassed: boolean) => void;
  currentTraceItemIndex: number;
  problem: Problem;
  handleComplete: () => void;
  setBeforeTraceItemIndex: (line: number) => void;
  setCurrentTraceItemIndex: (line: number) => void;
}

export const StepProblem: React.FC<StepProblemProps> = (props) => {
  console.log('StepProblem');
  return <ProblemComponent {...props} type="step" />;
};

interface ProblemProps {
  problem: Problem;
  createAnswerLog: (isPassed: boolean) => void;
  setCurrentTraceItemIndex: (line: number) => void;
  setProblemType?: (step: ProblemType) => void;
  handleComplete?: () => void;
  beforeTraceItemIndex: number;
  currentTraceItemIndex: number;
  setBeforeTraceItemIndex?: (line: number) => void;
}

const ProblemComponent: React.FC<ProblemProps & { type: 'executionResult' | 'checkpoint' | 'step' }> = ({
  beforeTraceItemIndex,
  createAnswerLog,
  currentTraceItemIndex,
  handleComplete,
  problem,
  setBeforeTraceItemIndex,
  setCurrentTraceItemIndex,
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
    const isPassed = turtleGraphicsRef.current?.isPassed() || false;
    createAnswerLog(isPassed);

    switch (type) {
      case 'executionResult': {
        if (isPassed) {
          handleComplete?.();
          openAlertDialog('正解', '正解です。この問題は終了です');
          break;
        }

        // チェックポイント機能は理解しにくいので、一時的に無効化する。（ステップ実行機能だけを使う。）
        openAlertDialog('不正解', '不正解です。ステップごとに回答してください', () => {
          setCurrentTraceItemIndex(1);
          setProblemType?.('step');
        });
        // if (problem.checkpointSids.length > 0) {
        //   openAlertDialog('不正解', '不正解です。チェックポイントごとに回答してください', () => {
        //     const nextCheckpointTraceItemIndex = problem.traceItems.findIndex(
        //       (traceItem) => traceItem.sid === problem.checkpointSids[0]
        //     );
        //     setCurrentTraceItemIndex(nextCheckpointTraceItemIndex);
        //     setProblemType?.('checkpoint');
        //   });
        // } else {
        //   openAlertDialog('不正解', '不正解です。ステップごとに回答してください', () => {
        //     setCurrentTraceItemIndex(1);
        //     setProblemType?.('step');
        //   });
        // }
        break;
      }
      case 'checkpoint': {
        if (isPassed) {
          setBeforeTraceItemIndex?.(currentTraceItemIndex);
          if (problem.traceItems[currentTraceItemIndex].sid === problem.checkpointSids.at(-1)) {
            openAlertDialog('正解', '正解です。このチェックポイントから1行ずつ回答してください', () => {
              setCurrentTraceItemIndex(currentTraceItemIndex + 1);
              setProblemType?.('step');
            });
          } else {
            openAlertDialog('正解', '正解です。次のチェックポイントに進みます', () => {
              const nextCheckpointIndex =
                problem.checkpointSids.indexOf(problem.traceItems[currentTraceItemIndex].sid) + 1;
              const nextCheckpointTraceItemIndex = problem.traceItems.findIndex(
                (traceItem) => traceItem.sid === problem.checkpointSids[nextCheckpointIndex]
              );
              setCurrentTraceItemIndex(nextCheckpointTraceItemIndex);
            });
          }
          break;
        }

        openAlertDialog('不正解', '不正解です。最後に正解したチェックポイントから1行ずつ回答してください', () => {
          setCurrentTraceItemIndex(beforeTraceItemIndex + 1);
          setProblemType?.('step');
        });
        break;
      }
      case 'step': {
        if (isPassed) {
          if (currentTraceItemIndex === problem.traceItems.length - 1) {
            handleComplete?.();
            openAlertDialog('正解', '正解です。この問題は終了です');
          } else {
            openAlertDialog('正解', '正解です。次の行に進みます', () => {
              setBeforeTraceItemIndex?.(currentTraceItemIndex);
              setCurrentTraceItemIndex(currentTraceItemIndex + 1);
            });
          }
          break;
        }

        openAlertDialog('不正解', '不正解です。もう一度回答してください');
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
                      を{type === 'checkpoint' ? '初めて' : ''}実行した後
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
                  body={`${type === 'executionResult' ? '実行結果問題' : type === 'checkpoint' ? 'チェックポイント問題' : 'ステップ問題'}の解答方法の説明`}
                  isOpen={isHelpModalOpen}
                  title={`${type === 'executionResult' ? '実行結果問題' : type === 'checkpoint' ? 'チェックポイント問題' : 'ステップ問題'}について`}
                  onClose={onHelpModalClose}
                />
              </HStack>
            </VStack>

            <SyntaxHighlighter
              beforeCheckpointLine={
                type === 'executionResult'
                  ? undefined
                  : problem.sidToLineIndex.get(problem.traceItems[beforeTraceItemIndex].sid)
              }
              code={problem.displayProgram}
              currentCheckpointLine={
                type === 'executionResult'
                  ? undefined
                  : problem.sidToLineIndex.get(problem.traceItems[currentTraceItemIndex].sid)
              }
              programmingLanguageId="java"
            />
          </VStack>

          {type !== 'executionResult' && problem.sidToLineIndex.get(problem.traceItems[beforeTraceItemIndex]?.sid) && (
            <VStack align="stretch" as={Card} bg="gray.50" p={5} spacing={6}>
              <VStack align="stretch">
                <Heading size="md">
                  <Box as="span" bgColor="orange.100" px={0.5} rounded="sm">
                    {problem.sidToLineIndex.get(problem.traceItems[beforeTraceItemIndex]?.sid)}行目
                  </Box>
                  を実行した後の盤面
                </Heading>
                <Box color="gray.600" fontSize="sm">
                  実行前ではなく<strong>実行後</strong>！
                </Box>
              </VStack>

              <BoardViewer
                alignSelf="center"
                board={problem.traceItems[beforeTraceItemIndex]?.board}
                vars={problem.traceItems[beforeTraceItemIndex]?.vars}
              />

              <Variables traceItemVars={problem.traceItems[beforeTraceItemIndex]?.vars} />
            </VStack>
          )}
        </VStack>

        <VStack align="stretch" flexBasis={0} flexGrow={1} spacing="4">
          <BoardEditor
            ref={turtleGraphicsRef}
            beforeTraceItem={problem.traceItems[beforeTraceItemIndex]}
            currentTraceItem={problem.traceItems[currentTraceItemIndex]}
            isEditable={true}
            problem={problem}
          />

          <HStack justify="space-between">
            <Button colorScheme="brand" variant="outline" onClick={() => handleClickResetButton()}>
              リセット
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
              解答
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
