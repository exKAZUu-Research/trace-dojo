'use client';

import { useMemo, useRef, useState } from 'react';
import { ResultAlertDialog } from '../problems/[problemId]/FillInBlankBody';
import { BoardEditor, type TurtleGraphicsHandle } from '../problems/[problemId]/BoardEditor';
import { SyntaxHighlighter } from '../problems/[problemId]/SyntaxHighlighter';
import { TraceViewer } from '../problems/[problemId]/TraceViewer';
import {
  AlertDialog,
  AlertDialogBody,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogOverlay,
  Button,
  Card,
  Flex,
  Heading,
  HStack,
  Tag,
  Text,
  VStack,
} from '@/infrastructures/useClient/chakra';
import { instantiateProblem } from '@/problems/instantiateProblem';
import type { TraceItem, TraceItemVariable } from '@/problems/traceProgram';

export interface RegularChallengeDisplay {
  problemFormat: 'regular';
  sessionId: number;
  problemId: string;
  seed: string;
  problemType: 'executionResult' | 'step';
  traceItemIndex: number;
  completed: boolean;
}
interface SubmitInput {
  courseId: string;
  lectureId: string;
  sessionId: number;
  requestId: string;
  context: { problemType: 'executionResult' | 'step'; traceItemIndex: number };
  isCorrect: boolean;
}
export interface RegularChallengeTransport {
  submit: (input: SubmitInput) => Promise<{ exercise: RegularChallengeDisplay; status: string }>;
  switchToStep: (input: { sessionId: number }) => Promise<RegularChallengeDisplay>;
  next: (input: { sessionId: number; problemFormat: 'regular' }) => Promise<RegularChallengeDisplay>;
}
interface Props {
  courseId: string;
  lectureId: string;
  display: RegularChallengeDisplay;
  transport: RegularChallengeTransport;
  back: () => void;
}

export const RegularChallengeBody: React.FC<Props> = ({
  courseId,
  lectureId,
  display: initialDisplay,
  transport,
  back,
}) => {
  const [display, setDisplay] = useState(initialDisplay);
  const [alert, setAlert] = useState<{ title: string; message: string; after?: () => void }>();
  const [switchOpen, setSwitchOpen] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<{ context: string; id: string } | undefined>(undefined);
  const editor = useRef<TurtleGraphicsHandle>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const problem = useMemo(() => {
    const value = instantiateProblem(display.problemId, 'java', display.seed);
    if (!value) throw new Error(`Unknown regular problem: ${display.problemId}`);
    return value;
  }, [display.problemId, display.seed]);
  const currentIndex =
    display.problemType === 'executionResult'
      ? problem.traceItems.length - 1
      : Math.min(display.traceItemIndex, problem.traceItems.length - 1);
  const previousIndex = display.problemType === 'executionResult' ? 0 : currentIndex - 1;
  const currentVariables =
    display.problemType === 'executionResult' ? problem.finalVars : problem.traceItems[currentIndex].vars;
  const initialVariables = useMemo(
    () => getInitialVariables(display.problemType, problem.traceItems, previousIndex, currentIndex, currentVariables),
    [display.problemType, problem.traceItems, previousIndex, currentIndex, currentVariables]
  );
  const [viewingIndex, setViewingIndex] = useState(previousIndex);
  const contextKey = `${display.sessionId}:${display.problemType}:${display.traceItemIndex}`;

  const submit = async (): Promise<void> => {
    if (!editor.current) return;
    const [locations, hint] = editor.current.findIncorrectLocationsAndHintText();
    const isCorrect = locations.length === 0;
    const requestKey = `${contextKey}:${isCorrect}`;
    if (request.current?.context !== requestKey) request.current = { context: requestKey, id: crypto.randomUUID() };
    try {
      const result = await transport.submit({
        courseId,
        lectureId,
        sessionId: display.sessionId,
        requestId: request.current.id,
        context: { problemType: display.problemType, traceItemIndex: display.traceItemIndex },
        isCorrect,
      });
      request.current = undefined;
      if (!isCorrect) {
        setAlert({
          title: '不正解',
          message: `${locations.join('、')}に誤りがあります。もう一度解答してみましょう。${hint}`,
        });
        return;
      }
      setViewingIndex(result.exercise.problemType === 'executionResult' ? 0 : result.exercise.traceItemIndex - 1);
      setDisplay(result.exercise);
      if (!result.exercise.completed) setAlert({ title: '正解', message: '正解です。次のステップに進みます。' });
    } catch {
      setAlert({ title: '提出できませんでした', message: '通信に失敗しました。もう一度提出してください。' });
    }
  };
  const switchMode = async (): Promise<void> => {
    try {
      const next = await transport.switchToStep({ sessionId: display.sessionId });
      setViewingIndex(0);
      setDisplay(next);
      setSwitchOpen(false);
      setError('');
    } catch {
      setSwitchOpen(false);
      setError('切り替えに失敗しました。下書きは保持されています。');
    }
  };
  const nextProblem = async (): Promise<void> => {
    const next = await transport.next({ sessionId: display.sessionId, problemFormat: 'regular' });
    setDisplay(next);
  };

  if (display.completed)
    return (
      <ResultAlertDialog
        isOpen={true}
        title="正解"
        message="正解です！次の問題へ進めます。"
        actions={[
          { label: '次の問題へ', colorScheme: 'brand', onClick: nextProblem },
          { label: '戻る', onClick: back },
        ]}
      />
    );
  return (
    <>
      {error && (
        <Text role="alert" color="red.600">
          {error}
        </Text>
      )}
      <Flex alignItems="stretch" gap={6}>
        <VStack align="stretch" flexBasis={0} flexGrow={1} minW={0} spacing={4}>
          <VStack align="stretch" as={Card} p={5}>
            <HStack justifyContent="space-between">
              <Heading size="md">問題</Heading>
              {display.problemType === 'step' && <Tag colorScheme="brand">ステップ実行モード</Tag>}
            </HStack>
            <Text>
              {display.problemType === 'executionResult' ? 'プログラムを実行した後' : '現在の行を実行した後'}
              の盤面と変数を作成してください。
            </Text>
            {display.problemType === 'executionResult' && (
              <Button alignSelf="start" onClick={() => setSwitchOpen(true)}>
                ステップ実行モードへ切り替える
              </Button>
            )}
          </VStack>
          <SyntaxHighlighter
            code={problem.displayProgram}
            programmingLanguageId="java"
            currentFocusLine={
              display.problemType === 'step'
                ? problem.sidToLineIndex.get(problem.traceItems[currentIndex].sid)
                : undefined
            }
            previousFocusLine={
              display.problemType === 'step'
                ? problem.sidToLineIndex.get(problem.traceItems[viewingIndex].sid)
                : undefined
            }
            callerLines={
              display.problemType === 'step'
                ? problem.traceItems[currentIndex].callStack.map((id) => problem.callerIdToLineIndex.get(id))
                : undefined
            }
          />
        </VStack>
        <VStack align="stretch" bgColor="gray.50" flexBasis={0} flexGrow={1}>
          <BoardEditor
            key={contextKey}
            ref={editor}
            currentTraceItemIndex={currentIndex}
            currentVariables={currentVariables}
            initialVariables={initialVariables}
            previousTraceItemIndex={previousIndex}
            problem={problem}
            problemType={display.problemType}
            handleSubmit={submit}
          />
        </VStack>
      </Flex>
      {display.problemType === 'step' && previousIndex >= 1 && (
        <TraceViewer
          currentTraceItemIndex={currentIndex}
          previousTraceItemIndex={previousIndex}
          problem={problem}
          setViewingTraceItemIndex={setViewingIndex}
          viewingTraceItemIndex={viewingIndex}
        />
      )}
      <AlertDialog
        isOpen={Boolean(alert)}
        leastDestructiveRef={cancelRef}
        onClose={() => {
          alert?.after?.();
          setAlert(undefined);
        }}
      >
        <AlertDialogOverlay>
          <AlertDialogContent>
            <AlertDialogHeader>{alert?.title}</AlertDialogHeader>
            <AlertDialogBody whiteSpace="pre-wrap">{alert?.message}</AlertDialogBody>
            <AlertDialogFooter>
              <Button
                ref={cancelRef}
                onClick={() => {
                  alert?.after?.();
                  setAlert(undefined);
                }}
              >
                閉じる
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialogOverlay>
      </AlertDialog>
      <AlertDialog isOpen={switchOpen} leastDestructiveRef={cancelRef} onClose={() => setSwitchOpen(false)}>
        <AlertDialogOverlay>
          <AlertDialogContent>
            <AlertDialogHeader>ステップ実行モードへ切り替えますか？</AlertDialogHeader>
            <AlertDialogBody>現在の下書きはリセットされます。</AlertDialogBody>
            <AlertDialogFooter>
              <Button ref={cancelRef} onClick={() => setSwitchOpen(false)}>
                キャンセル
              </Button>
              <Button colorScheme="brand" onClick={() => void switchMode()}>
                切り替える
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialogOverlay>
      </AlertDialog>
    </>
  );
};
const getInitialVariables = (
  problemType: 'executionResult' | 'step',
  traceItems: TraceItem[],
  previousIndex: number,
  currentIndex: number,
  current: TraceItemVariable
): Record<string, string> => {
  let adjustedPreviousIndex = previousIndex;
  let emptyNonGlobals = false;
  if (problemType === 'step') {
    const depth = traceItems[currentIndex].depth;
    while (adjustedPreviousIndex > 0 && depth !== traceItems[adjustedPreviousIndex].depth) {
      if (depth > traceItems[adjustedPreviousIndex].depth) {
        emptyNonGlobals = true;
        break;
      }
      adjustedPreviousIndex -= 1;
    }
    emptyNonGlobals ||=
      traceItems[currentIndex].callStack.at(-1) !== traceItems[adjustedPreviousIndex].callStack.at(-1);
  }
  return Object.fromEntries(
    Object.entries(current)
      .filter(([, value]) => typeof value === 'number' || typeof value === 'string')
      .map(([key]) => {
        const isGlobal =
          key.slice(0, 1) === key.slice(0, 1).toUpperCase() && key.slice(0, 1) !== key.slice(0, 1).toLowerCase();
        if (isGlobal) return [key, String(traceItems[previousIndex].vars[key] ?? '')];
        if (emptyNonGlobals) return [key, ''];
        return [key, String(traceItems[adjustedPreviousIndex].vars[key] ?? '')];
      })
  );
};
