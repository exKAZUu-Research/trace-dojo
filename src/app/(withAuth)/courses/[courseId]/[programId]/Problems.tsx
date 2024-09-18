'use client';

import { useEffect, useRef, useState } from 'react';

import { CustomModal } from '../../../../../components/molecules/CustomModal';
import { SyntaxHighlighter } from '../../../../../components/organisms/SyntaxHighlighter';
import type { TurtleGraphicsHandle } from '../../../../../components/organisms/TurtleGraphics';
import { TurtleGraphics } from '../../../../../components/organisms/TurtleGraphics';
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
} from '../../../../../infrastructures/useClient/chakra';
import type { Problem } from '../../../../../problems/generateProblem';
import type { ProblemType } from '../../../../../types';
import { isMacOS } from '../../../../../utils/platform';

import { Variables } from './Variables';

interface ExecutionResultProblemProps {
  problem: Problem;
  createAnswerLog: (isPassed: boolean) => void;
  explanation?: Record<'title' | 'body', string>;
  handleComplete: () => void;
  selectedLanguageId: string;
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
  explanation?: Record<'title' | 'body', string>;
  selectedLanguageId: string;
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
  explanation?: Record<'title' | 'body', string>;
  handleComplete: () => void;
  selectedLanguageId: string;
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
  explanation?: Record<'title' | 'body', string>;
  selectedLanguageId: string;
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
  explanation,
  handleComplete,
  problem,
  selectedLanguageId,
  setBeforeTraceItemIndex,
  setCurrentTraceItemIndex,
  setProblemType,
  type,
}) => {
  const turtleGraphicsRef = useRef<TurtleGraphicsHandle>(null);
  const {
    isOpen: isExplanationModalOpen,
    onClose: onExplanationModalClose,
    onOpen: onExplanationModalOpen,
  } = useDisclosure();
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
  }, []);

  return (
    <Flex gap="6" w="100%">
      <VStack align="start" spacing="4" w="100%">
        <Box>
          <Box>
            {type === 'executionResult'
              ? 'プログラムの実行後の結果を解答してください。'
              : type === 'checkpoint'
                ? '赤色でハイライトされている行を初めて実行した後の盤面を作成してください。'
                : '赤色でハイライトされている行を実行した後の盤面を作成してください。'}
            マスを右クリックすると白色に戻せます。
          </Box>
          <HStack>
            <Tooltip
              hasArrow
              fontSize="xs"
              label={`ショートカットキーは ${isMacOS() ? 'Cmd+Enter' : 'Ctrl+Enter'}`}
              placement="bottom"
            >
              <Button onClick={() => handleClickAnswerButton()}>解答</Button>
            </Tooltip>
            <Button onClick={() => handleClickResetButton()}>リセット</Button>
          </HStack>
        </Box>
        <VStack align="center" w="100%">
          {type !== 'executionResult' && (
            <Box textAlign="center" w="100%">
              赤線の行の<strong>実行後</strong>の結果（注意：実行前ではなく<strong>実行後</strong>！）
            </Box>
          )}
          <TurtleGraphics
            ref={turtleGraphicsRef}
            beforeTraceItem={problem.traceItems[beforeTraceItemIndex]}
            currentTraceItem={problem.traceItems[currentTraceItemIndex]}
            isEditable={true}
            problem={problem}
          />
          {type !== 'executionResult' && problem.sidToLineIndex.get(problem.traceItems[beforeTraceItemIndex].sid) && (
            <>
              <Box>
                青色の行の<strong>実行後</strong>の結果（注意：実行前ではなく<strong>実行後</strong>！）
              </Box>
              <TurtleGraphics
                ref={turtleGraphicsRef}
                beforeTraceItem={problem.traceItems[beforeTraceItemIndex]}
                currentTraceItem={problem.traceItems[currentTraceItemIndex]}
                isEditable={false}
                problem={problem}
              />
            </>
          )}
        </VStack>
      </VStack>

      <VStack align="end" minW="50%" overflow="hidden">
        <HStack>
          <Button colorScheme="gray" onClick={onHelpModalOpen}>
            解答方法
          </Button>
          <CustomModal
            body={`${type === 'executionResult' ? '実行結果問題' : type === 'checkpoint' ? 'チェックポイント問題' : 'ステップ問題'}の解答方法の説明`}
            isOpen={isHelpModalOpen}
            title={`${type === 'executionResult' ? '実行結果問題' : type === 'checkpoint' ? 'チェックポイント問題' : 'ステップ問題'}について`}
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
        <Box h={type === 'executionResult' ? 'calc(100vh - 370px)' : '640px'} w="100%">
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
            programmingLanguageId={selectedLanguageId}
          />
        </Box>
        {type !== 'executionResult' && <Variables traceItemVars={problem.traceItems[beforeTraceItemIndex]?.vars} />}
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
  );
};
