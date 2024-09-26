import type { ProblemSession } from '@prisma/client';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { MAX_CHALLENGE_COUNT } from '../../../../../../../../constants';
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
  Tag,
  Tooltip,
  useDisclosure,
  VStack,
} from '../../../../../../../../infrastructures/useClient/chakra';
import type { Problem } from '../../../../../../../../problems/generateProblem';
import type { CourseId, ProblemId } from '../../../../../../../../problems/problemData';
import { isTurtleTrace } from '../../../../../../../../problems/traceProgram';

import type { TurtleGraphicsHandle } from './BoardEditor';
import { BoardEditor } from './BoardEditor';
import { BoardViewer } from './BoardViewer';
import { SyntaxHighlighter } from './SyntaxHighlighter';
import { Variables } from './Variables';

type Props = {
  params: { courseId: CourseId; lectureId: string; problemId: ProblemId };
  problem: Problem;
  problemSession: ProblemSession;
  createSubmissionUpdatingProblemSession: (isCorrect: boolean, isCompleted: boolean) => Promise<void>;
  updateProblemSession: (problemType: string, traceItemIndex: number) => Promise<void>;
};

export const ProblemBody: React.FC<Props> = (props) => {
  const problemType = props.problemSession.problemType;
  const currentTraceItemIndex =
    problemType === 'executionResult' ? props.problem.traceItems.length - 1 : props.problemSession.traceItemIndex;
  const previousTraceItemIndex = problemType === 'executionResult' ? 0 : currentTraceItemIndex - 1;

  const { isOpen: isAlertOpen, onClose: onAlertClose, onOpen: onAlertOpen } = useDisclosure();
  const cancelRef = useRef(null);

  const turtleGraphicsRef = useRef<TurtleGraphicsHandle>(null);

  const router = useRouter();

  const [alertTitle, setAlertTitle] = useState('');
  const [alertMessage, setAlertMessage] = useState('');
  const [postAlertAction, setPostAlertAction] = useState<() => void>();

  const openAlertDialog = (title: string, message: string, action?: () => void): void => {
    setAlertTitle(title);
    setAlertMessage(message);
    setPostAlertAction(() => action);
    onAlertOpen();
  };

  const { refetch: fetchIncorrectSubmissionsCount } = backendTrpcReact.countIncorrectSubmissions.useQuery(
    { sessionId: props.problemSession.id },
    { enabled: false }
  );

  const handleClickSubmitButton = async (): Promise<void> => {
    const isCorrect = turtleGraphicsRef.current?.isCorrect() || false;

    switch (problemType) {
      case 'executionResult': {
        if (isCorrect) {
          void props.createSubmissionUpdatingProblemSession(true, true);
          openAlertDialog(
            '正解',
            '一発正解です！この問題は完了です。問題一覧ページに戻りますので、次の問題に挑戦してください。',
            () => {
              router.push(`/courses/${props.params.courseId}/lectures/${props.params.lectureId}`);
            }
          );
        } else {
          const response = await fetchIncorrectSubmissionsCount();
          const incorrectCount = (response.data ?? 0) + 1;
          void props.createSubmissionUpdatingProblemSession(false, false);
          if (incorrectCount < MAX_CHALLENGE_COUNT) {
            openAlertDialog(
              '不正解',
              `不正解です。あと${MAX_CHALLENGE_COUNT - incorrectCount}回間違えたら、ステップ実行モードに移ります。一発正解を目指しましょう！`
            );
          } else {
            void props.updateProblemSession('step', 1);
            openAlertDialog(
              '不正解',
              `不正解です。${MAX_CHALLENGE_COUNT}回間違えたので、ステップ実行モードに移ります。ステップごとに問題を解いてください。`
            );
          }
        }
        break;
      }
      case 'step': {
        void props.createSubmissionUpdatingProblemSession(
          isCorrect,
          isCorrect && currentTraceItemIndex === props.problem.traceItems.length - 1
        );
        if (isCorrect) {
          if (currentTraceItemIndex === props.problem.traceItems.length - 1) {
            openAlertDialog(
              '正解',
              '正解です。この問題は完了です。問題一覧ページに戻りますので、次の問題に挑戦してください。',
              () => {
                router.push(`/courses/${props.params.courseId}/lectures/${props.params.lectureId}`);
              }
            );
          } else {
            void props.updateProblemSession('step', currentTraceItemIndex + 1);
            openAlertDialog('正解', '正解です。次のステップに進みます。');
          }
        } else {
          openAlertDialog('不正解', '不正解です。もう一度解答してください。');
        }
        break;
      }
    }
  };

  useShortcutKeys(handleClickSubmitButton);

  return (
    <>
      <Flex gap={6}>
        <VStack align="stretch" flexBasis={0} flexGrow={1} minW={0} spacing={4}>
          <VStack align="stretch" as={Card} overflow="hidden" spacing={0}>
            <VStack align="stretch" borderBottomWidth="1px" p={5}>
              <HStack justifyContent="space-between">
                <Heading size="md">問題</Heading>
                {problemType === 'step' && (
                  <Tag colorScheme="brand" fontWeight="bold" size="sm" variant="solid">
                    ステップ実行モード
                  </Tag>
                )}
              </HStack>

              <Box>
                <Box as="span" fontWeight="bold">
                  {problemType === 'executionResult' ? (
                    'プログラムを実行した後'
                  ) : (
                    <>
                      <Box as="span" border="2px solid #f56565" px={0.5} rounded="sm">
                        {props.problem.sidToLineIndex.get(props.problem.traceItems[currentTraceItemIndex].sid)}行目
                      </Box>
                      を実行した後
                    </>
                  )}
                </Box>
                の盤面を作成し、提出ボタンを押してください。
              </Box>
            </VStack>
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

        <VStack align="stretch" flexBasis={0} flexGrow={1} spacing="4">
          <BoardEditor
            ref={turtleGraphicsRef}
            currentTraceItemIndex={currentTraceItemIndex}
            handleClickSubmitButton={handleClickSubmitButton}
            previousTraceItemIndex={previousTraceItemIndex}
            problem={props.problem}
          />
        </VStack>
      </Flex>

      {problemType !== 'executionResult' &&
        props.problem.sidToLineIndex.get(props.problem.traceItems[previousTraceItemIndex].sid) && (
          <HStack alignItems="flex-start" as={Card} bg="gray.50" p={5}>
            <VStack align="stretch" flexBasis={0} flexGrow={2} spacing={6}>
              <VStack align="stretch">
                <Heading size="md">
                  <Box as="span" bgColor="orange.100" px={0.5} rounded="sm">
                    {props.problem.sidToLineIndex.get(props.problem.traceItems[previousTraceItemIndex].sid)}行目
                  </Box>
                  を実行した後（
                  <Box as="span" border="2px solid #f56565" px={0.5} rounded="sm">
                    {props.problem.sidToLineIndex.get(props.problem.traceItems[currentTraceItemIndex].sid)}行目
                  </Box>
                  を実行する前）の盤面
                </Heading>
              </VStack>

              <BoardViewer
                alignSelf="center"
                board={props.problem.traceItems[previousTraceItemIndex]?.board}
                turtles={Object.values(props.problem.traceItems[previousTraceItemIndex].vars ?? {}).filter(
                  isTurtleTrace
                )}
              />
            </VStack>
            <Box flexBasis={0} flexGrow={3}>
              <Variables traceItemVars={props.problem.traceItems[currentTraceItemIndex].vars} />
            </Box>
          </HStack>
        )}

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
    </>
  );
};

function useShortcutKeys(handleClickAnswerButton: () => Promise<void>): void {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void handleClickAnswerButton();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
