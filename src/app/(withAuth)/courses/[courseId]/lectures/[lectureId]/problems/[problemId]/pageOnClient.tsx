'use client';

import type { ProblemSession } from '@prisma/client';
import NextLink from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { MdOutlineInfo } from 'react-icons/md';
import { useIdleTimer } from 'react-idle-timer';

import { CustomModal } from '../../../../../../../../components/molecules/CustomModal';
import {
  MAX_ACTIVE_DURATION_MS_AFTER_LAST_EVENT,
  MIN_INTERVAL_MS_OF_ACTIVE_EVENTS,
} from '../../../../../../../../constants';
import { backendTrpcReact } from '../../../../../../../../infrastructures/trpcBackend/client';
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
  Link,
  Text,
  Tooltip,
  useDisclosure,
  VStack,
} from '../../../../../../../../infrastructures/useClient/chakra';
import type { Problem } from '../../../../../../../../problems/generateProblem';
import type { CourseId, ProblemId } from '../../../../../../../../problems/problemData';
import { courseIdToLectureIds, courseIdToName, problemIdToName } from '../../../../../../../../problems/problemData';
import { isMacOS } from '../../../../../../../../utils/platform';

import type { TurtleGraphicsHandle } from './BoardEditor';
import { BoardEditor } from './BoardEditor';
import { BoardViewer } from './BoardViewer';
import { SyntaxHighlighter } from './SyntaxHighlighter';
import { Variables } from './Variables';

type Props = {
  params: { courseId: CourseId; lectureId: string; problemId: ProblemId };
  problem: Problem;
  userId: string;
  initialProblemSession: ProblemSession;
};

export const ProblemPageOnClient: React.FC<Props> = (props) => {
  const [problemSession, setProblemSession] = useState(props.initialProblemSession);

  const lectureIndex = courseIdToLectureIds[props.params.courseId].indexOf(props.params.lectureId);

  const updateProblemSessionMutation = backendTrpcReact.updateProblemSession.useMutation();
  const createProblemSubmissionMutation = backendTrpcReact.createProblemSubmission.useMutation();

  const lastActionTimeRef = useRef(Date.now());
  useIdleTimer({
    async onAction() {
      await updateProblemSessionMutation.mutateAsync({
        id: props.initialProblemSession.id,
        incrementalElapsedMilliseconds: getIncrementalElapsedMilliseconds(lastActionTimeRef),
      });
    },
    // Events within the throttle period are ignored.
    throttle: MIN_INTERVAL_MS_OF_ACTIVE_EVENTS,
  });

  const createSubmissionUpdatingSession = async (isCorrect: boolean, isCompleted: boolean): Promise<void> => {
    const newProblemSession = await updateProblemSessionMutation.mutateAsync({
      id: problemSession.id,
      incrementalElapsedMilliseconds: getIncrementalElapsedMilliseconds(lastActionTimeRef),
      completedAt: isCompleted ? new Date() : undefined,
    });
    await createProblemSubmissionMutation.mutateAsync({
      sessionId: problemSession.id,
      problemType: problemSession.problemType,
      traceItemIndex: problemSession.traceItemIndex,
      elapsedMilliseconds: newProblemSession.elapsedMilliseconds,
      isCorrect,
    });
  };

  const problemType = problemSession.problemType;
  const currentTraceItemIndex =
    problemType === 'executionResult' ? props.problem.traceItems.length - 1 : problemSession.traceItemIndex;
  const previousTraceItemIndex = problemType === 'executionResult' ? 0 : currentTraceItemIndex - 1;

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

    switch (problemType) {
      case 'executionResult': {
        void createSubmissionUpdatingSession(isCorrect, isCorrect);
        if (isCorrect) {
          openAlertDialog('正解', '正解です。この問題は終了です');
        } else {
          (async () => {
            const newProblemSession = await updateProblemSessionMutation.mutateAsync({
              id: problemSession.id,
              problemType: 'step',
              traceItemIndex: 1,
            });
            setProblemSession(newProblemSession);
          })();
          openAlertDialog('不正解', '不正解です。ステップごとに回答してください');
        }
        break;
      }
      case 'step': {
        void createSubmissionUpdatingSession(
          isCorrect,
          isCorrect && currentTraceItemIndex === props.problem.traceItems.length - 1
        );
        if (isCorrect) {
          if (currentTraceItemIndex === props.problem.traceItems.length - 1) {
            openAlertDialog('正解', '正解です。この問題は終了です');
          } else {
            (async () => {
              const newProblemSession = await updateProblemSessionMutation.mutateAsync({
                id: problemSession.id,
                traceItemIndex: currentTraceItemIndex + 1,
              });
              setProblemSession(newProblemSession);
            })();
            openAlertDialog('正解', '正解です。次の行に進みます');
          }
        } else {
          openAlertDialog('不正解', '不正解です。もう一度回答してください');
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
    <VStack align="stretch" spacing={8}>
      <VStack align="stretch" spacing={1}>
        <HStack spacing={2}>
          <Link as={NextLink} color="gray.600" fontWeight="bold" href={`/courses/${props.params.courseId}`}>
            {courseIdToName[props.params.courseId]}
          </Link>
          <Text color="gray.600">{'>'}</Text>
          <Link
            as={NextLink}
            color="gray.600"
            fontWeight="bold"
            href={`/courses/${props.params.courseId}/lectures/${props.params.lectureId}`}
          >
            第{lectureIndex + 1}回
          </Link>
        </HStack>
        <Heading as="h1">{problemIdToName[props.params.problemId]}</Heading>
      </VStack>

      <Flex gap={6}>
        <VStack align="stretch" flexBasis={0} flexGrow={1} minW={0} spacing={4}>
          <VStack align="stretch" as={Card} overflow="hidden" spacing={0}>
            <VStack align="stretch" borderBottomWidth="1px" p={5}>
              <Heading size="md">問題</Heading>

              <div>
                <Box as="span" fontWeight="bold">
                  {problemType === 'executionResult' ? (
                    'プログラムを実行した後'
                  ) : (
                    <>
                      <Box as="span" bgColor="red.100" px={0.5} rounded="sm">
                        {props.problem.sidToLineIndex.get(props.problem.traceItems[currentTraceItemIndex].sid)}行目
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
                  body={`${problemType === 'executionResult' ? '実行結果問題' : 'ステップ問題'}の解答方法の説明`}
                  isOpen={isHelpModalOpen}
                  title={`${problemType === 'executionResult' ? '実行結果問題' : 'ステップ問題'}について`}
                  onClose={onHelpModalClose}
                />
              </HStack>
            </VStack>

            <SyntaxHighlighter
              code={props.problem.displayProgram}
              currentFocusLine={
                problemType === 'executionResult'
                  ? undefined
                  : props.problem.sidToLineIndex.get(props.problem.traceItems[currentTraceItemIndex].sid)
              }
              previousFocusLine={
                problemType === 'executionResult'
                  ? undefined
                  : props.problem.sidToLineIndex.get(props.problem.traceItems[previousTraceItemIndex].sid)
              }
              programmingLanguageId="java"
            />
          </VStack>

          {problemType !== 'executionResult' &&
            props.problem.sidToLineIndex.get(props.problem.traceItems[previousTraceItemIndex]?.sid) && (
              <VStack align="stretch" as={Card} bg="gray.50" p={5} spacing={6}>
                <VStack align="stretch">
                  <Heading size="md">
                    参考：
                    <Box as="span" bgColor="orange.100" px={0.5} rounded="sm">
                      {props.problem.sidToLineIndex.get(props.problem.traceItems[previousTraceItemIndex]?.sid)}行目
                    </Box>
                    を実行した後（
                    <Box as="span" bgColor="red.100" px={0.5} rounded="sm">
                      {props.problem.sidToLineIndex.get(props.problem.traceItems[currentTraceItemIndex]?.sid)}行目
                    </Box>
                    を実行する前）の盤面
                  </Heading>
                </VStack>

                <BoardViewer
                  alignSelf="center"
                  board={props.problem.traceItems[previousTraceItemIndex]?.board}
                  vars={props.problem.traceItems[previousTraceItemIndex]?.vars}
                />

                <Variables traceItemVars={props.problem.traceItems[previousTraceItemIndex]?.vars} />
              </VStack>
            )}
        </VStack>

        <VStack align="stretch" flexBasis={0} flexGrow={1} spacing="4">
          <BoardEditor
            ref={turtleGraphicsRef}
            currentTraceItem={props.problem.traceItems[currentTraceItemIndex]}
            isEditable={true}
            previousTraceItem={props.problem.traceItems[previousTraceItemIndex]}
            problem={props.problem}
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
    </VStack>
  );
};

function getIncrementalElapsedMilliseconds(lastActionTimeRef: React.MutableRefObject<number>): number {
  const nowTime = Date.now();
  const incrementalElapsedMilliseconds = Math.min(
    nowTime - lastActionTimeRef.current,
    MAX_ACTIVE_DURATION_MS_AFTER_LAST_EVENT
  );
  lastActionTimeRef.current = nowTime;
  return incrementalElapsedMilliseconds;
}
