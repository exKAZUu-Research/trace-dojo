'use client';

import type { ProblemSession } from '@prisma/client';
import { useParams, useRouter } from 'next/navigation';
import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { TurtleGraphicsHandle } from './BoardEditor';
import { BoardEditor } from './BoardEditor';
import { SyntaxHighlighter } from './SyntaxHighlighter';
import { TraceViewer } from './TraceViewer';

import { MAX_CHALLENGE_COUNT } from '@/constants';
import { useAuthContextSelector } from '@/contexts/AuthContext';
import { backendTrpcReact } from '@/infrastructures/trpcBackend/client';
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
  useDisclosure,
  VStack,
} from '@/infrastructures/useClient/chakra';
import type { InstantiatedProblem } from '@/problems/instantiateProblem';
import type { CourseId, ProblemId } from '@/problems/problemData';
import type { TraceItem, TraceItemVariable } from '@/problems/traceProgram';
import type { ProblemType } from '@/types';

type Props = {
  problem: InstantiatedProblem;
  problemSession: ProblemSession;
  createSubmissionUpdatingProblemSession: (isCorrect: boolean, isCompleted: boolean) => Promise<void>;
  updateProblemSession: (problemType: string, traceItemIndex: number) => Promise<void>;
};

export const ProblemBody: React.FC<Props> = (props) => {
  const params = useParams<{ courseId: CourseId; lectureId: string; problemId: ProblemId }>();
  const isAdmin = useAuthContextSelector((c) => c.isAdmin);

  const problemType = props.problemSession.problemType as ProblemType;
  const currentTraceItemIndex =
    problemType === 'executionResult'
      ? props.problem.traceItems.length - 1
      : // ProblemSession作成後の問題の改変に対応するため。
        Math.min(props.problemSession.traceItemIndex, props.problem.traceItems.length - 1);
  const previousTraceItemIndex =
    problemType === 'executionResult'
      ? 0
      : isAdmin
        ? // 管理者は最後の盤面の状態も確認できるようにするため。
          Math.min(props.problemSession.traceItemIndex - 1, props.problem.traceItems.length - 1)
        : currentTraceItemIndex - 1;
  const currentVariables =
    problemType === 'executionResult' ? props.problem.finalVars : props.problem.traceItems[currentTraceItemIndex].vars;
  const initialVariables = useMemo(
    () =>
      getInitialVariables(
        problemType,
        props.problem.traceItems,
        previousTraceItemIndex,
        currentTraceItemIndex,
        currentVariables
      ),
    [problemType, props.problem.traceItems, previousTraceItemIndex, currentTraceItemIndex, currentVariables]
  );

  const [viewingTraceItemIndex, setViewingTraceItemIndex] = useState(previousTraceItemIndex);
  useEffect(() => {
    setViewingTraceItemIndex(previousTraceItemIndex);
  }, [previousTraceItemIndex]);

  const { isOpen: isAlertOpen, onClose: onAlertClose, onOpen: onAlertOpen } = useDisclosure();
  const cancelRef = useRef<HTMLButtonElement>(null);

  const turtleGraphicsRef = useRef<TurtleGraphicsHandle>(null);

  const router = useRouter();

  const [alertTitle, setAlertTitle] = useState('');
  const [alertMessage, setAlertMessage] = useState('');
  const [postAlertAction, setPostAlertAction] = useState<() => void>();

  const openAlertDialog = useCallback(
    (title: string, message: string, action?: () => void): void => {
      setAlertTitle(title);
      setAlertMessage(message);
      setPostAlertAction(() => action);
      onAlertOpen();
    },
    [onAlertOpen]
  );

  const { refetch: fetchIncorrectSubmissionsCount } = backendTrpcReact.countIncorrectSubmissions.useQuery(
    { sessionId: props.problemSession.id },
    { enabled: false }
  );

  const handleSubmit = useCallback(async (): Promise<void> => {
    if (isAlertOpen || !turtleGraphicsRef.current) return;

    const [incorrectLocations, hintText] = turtleGraphicsRef.current.findIncorrectLocationsAndHintText();
    const incorrectLocationText = incorrectLocations.join('、');

    switch (problemType) {
      case 'executionResult': {
        if (incorrectLocationText) {
          const response = await fetchIncorrectSubmissionsCount();
          const incorrectCount = (response.data ?? 0) + 1;
          await props.createSubmissionUpdatingProblemSession(false, false);
          if (incorrectCount < MAX_CHALLENGE_COUNT) {
            openAlertDialog(
              '不正解',
              `${incorrectLocationText}に誤りがあります。あと${MAX_CHALLENGE_COUNT - incorrectCount}回間違えたら、ステップ実行モードに移ります。一発正解を目指しましょう！`
            );
          } else {
            await props.updateProblemSession('step', 1);
            openAlertDialog(
              '不正解',
              `${incorrectLocationText}に誤りがあります。${MAX_CHALLENGE_COUNT}回間違えたので、ステップ実行モードに移ります。ステップごとに問題を解いてください。`
            );
          }
        } else {
          await props.createSubmissionUpdatingProblemSession(true, true);
          openAlertDialog(
            '正解',
            '一発正解です！この問題は完了です。問題一覧ページに戻りますので、次の問題に挑戦してください。',
            () => {
              router.push(`/courses/${params.courseId}/lectures/${params.lectureId}`);
            }
          );
        }
        break;
      }
      case 'step': {
        await props.createSubmissionUpdatingProblemSession(
          !incorrectLocationText,
          !incorrectLocationText && currentTraceItemIndex === props.problem.traceItems.length - 1
        );
        if (incorrectLocationText) {
          openAlertDialog(
            '不正解',
            `${incorrectLocationText}に誤りがあります。もう一度解答してみましょう。${hintText}`
          );
          setViewingTraceItemIndex(previousTraceItemIndex);
        } else {
          if (currentTraceItemIndex === props.problem.traceItems.length - 1) {
            openAlertDialog(
              '正解',
              '正解です。この問題は完了です。問題一覧ページに戻りますので、次の問題に挑戦してください。',
              () => {
                router.push(`/courses/${params.courseId}/lectures/${params.lectureId}`);
              }
            );
          } else {
            await props.updateProblemSession('step', currentTraceItemIndex + 1);
            openAlertDialog('正解', '正解です。次のステップに進みます。');
          }
        }
        break;
      }
    }
  }, [
    currentTraceItemIndex,
    fetchIncorrectSubmissionsCount,
    isAlertOpen,
    openAlertDialog,
    previousTraceItemIndex,
    problemType,
    props,
    router,
  ]);

  return (
    <>
      <Flex alignItems="stretch" gap={6}>
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
                {problemType === 'step' && previousTraceItemIndex >= 1 && (
                  <>
                    画面下部にある
                    <Box as="span" bgColor="orange.100" px={0.5} rounded="sm">
                      {props.problem.sidToLineIndex.get(props.problem.traceItems[previousTraceItemIndex].sid)}行目
                    </Box>
                    を実行した後の盤面と変数の一覧表を参考に、
                  </>
                )}
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
                の盤面{Object.keys(initialVariables).length > 0 ? 'と、変数に記録されている値の一覧表' : ''}
                を作成し、提出ボタンを押してください。
              </Box>
            </VStack>
          </VStack>

          <SyntaxHighlighter
            callerLines={
              problemType === 'executionResult'
                ? undefined
                : props.problem.traceItems[currentTraceItemIndex].callStack.map((id) =>
                    props.problem.callerIdToLineIndex.get(id)
                  )
            }
            code={props.problem.displayProgram}
            currentFocusLine={
              problemType === 'executionResult'
                ? undefined
                : props.problem.sidToLineIndex.get(props.problem.traceItems[currentTraceItemIndex].sid)
            }
            previousFocusLine={
              problemType === 'executionResult'
                ? undefined
                : props.problem.sidToLineIndex.get(props.problem.traceItems[viewingTraceItemIndex].sid)
            }
            programmingLanguageId="java"
          />
        </VStack>

        <VStack align="stretch" bgColor="gray.50" flexBasis={0} flexGrow={1} spacing="4">
          <BoardEditor
            ref={turtleGraphicsRef}
            currentTraceItemIndex={currentTraceItemIndex}
            currentVariables={currentVariables}
            handleSubmit={handleSubmit}
            initialVariables={initialVariables}
            previousTraceItemIndex={previousTraceItemIndex}
            problem={props.problem}
            problemType={problemType}
          />
        </VStack>
      </Flex>

      {problemType === 'step' && previousTraceItemIndex >= 1 && (
        <TraceViewer
          currentTraceItemIndex={currentTraceItemIndex}
          previousTraceItemIndex={previousTraceItemIndex}
          problem={props.problem}
          setViewingTraceItemIndex={setViewingTraceItemIndex}
          viewingTraceItemIndex={viewingTraceItemIndex}
        />
      )}

      <AlertDialog
        closeOnEsc={true}
        closeOnOverlayClick={false}
        isOpen={isAlertOpen}
        leastDestructiveRef={cancelRef as React.RefObject<HTMLElement>}
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
            <AlertDialogBody whiteSpace="pre-wrap">{alertMessage}</AlertDialogBody>
            <AlertDialogFooter>
              <Button
                ref={cancelRef}
                rightIcon={
                  <Box as="span" fontSize="sm" fontWeight="bold">
                    (Esc)
                  </Box>
                }
                onClick={() => {
                  postAlertAction?.();
                  onAlertClose();
                }}
              >
                閉じる
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialogOverlay>
      </AlertDialog>
    </>
  );
};

function getInitialVariables(
  problemType: 'executionResult' | 'step',
  traceItems: TraceItem[],
  previousTraceItemIndex: number,
  currentTraceItemIndex: number,
  currentVariables: TraceItemVariable
): Record<string, string> {
  let adjustedPreviousTraceItemIndex = previousTraceItemIndex;

  let nonGlobalVariableShouldBeEmpty = false;
  if (problemType === 'step') {
    const currentDepth = traceItems[currentTraceItemIndex].depth;
    while (adjustedPreviousTraceItemIndex > 0 && currentDepth !== traceItems[adjustedPreviousTraceItemIndex].depth) {
      if (currentDepth > traceItems[adjustedPreviousTraceItemIndex].depth) {
        // 過去のトレースの方が現在のトレースよりも深いため。
        nonGlobalVariableShouldBeEmpty = true;
        break;
      }
      adjustedPreviousTraceItemIndex--;
    }
    // 過去のトレースと現在のトレースのスタックトレースが別であるかどうか。
    nonGlobalVariableShouldBeEmpty ||=
      traceItems[currentTraceItemIndex].callStack.at(-1) !==
      traceItems[adjustedPreviousTraceItemIndex].callStack.at(-1);
  }

  return Object.fromEntries(
    Object.entries(currentVariables)
      .filter(([_, value]) => typeof value === 'number' || typeof value === 'string')
      .map(([key]) => {
        const isGlobalVariable = isUpperCase(key.slice(0, 1));
        console.log(key, isGlobalVariable);
        if (isGlobalVariable) return [key, traceItems[previousTraceItemIndex].vars[key]?.toString() ?? ''];
        if (nonGlobalVariableShouldBeEmpty) return [key, ''];
        return [key, traceItems[adjustedPreviousTraceItemIndex].vars[key]?.toString() ?? ''];
      })
  );
}

function isUpperCase(str: string): boolean {
  return str === str.toUpperCase() && str !== str.toLowerCase();
}
