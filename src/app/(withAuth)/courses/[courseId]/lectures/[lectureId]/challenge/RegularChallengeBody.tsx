'use client';

import { useMemo, useRef, useState } from 'react';
import { ProblemPageHeader } from '../problems/[problemId]/ProblemPageHeader';
import {
  deriveRegularProblemView,
  RegularProblemPresentation,
} from '../problems/[problemId]/RegularProblemPresentation';
import { ResultAlertDialog } from '../problems/[problemId]/ResultAlertDialog';
import { BoardEditor, type TurtleGraphicsHandle } from '../problems/[problemId]/BoardEditor';
import {
  AlertDialog,
  AlertDialogBody,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogOverlay,
  Button,
  Text,
} from '@/infrastructures/useClient/chakra';
import { instantiateProblem } from '@/problems/instantiateProblem';
import type { CourseId, ProblemId } from '@/problems/problemData';

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
  const view = useMemo(
    () => deriveRegularProblemView(problem, display.problemType, display.traceItemIndex),
    [problem, display.problemType, display.traceItemIndex]
  );
  const { currentTraceItemIndex: currentIndex, previousTraceItemIndex: previousIndex } = view;
  const [viewingIndex, setViewingIndex] = useState(previousIndex);
  const contextKey = `${display.sessionId}:${display.problemId}:${display.seed}:${display.problemType}:${currentIndex}`;

  const submit = async (): Promise<void> => {
    if (display.completed || !editor.current) return;
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
    if (display.completed) return;
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
    const nextProblemValue = instantiateProblem(next.problemId as ProblemId, 'java', next.seed);
    if (!nextProblemValue) throw new Error('問題を取得できませんでした。');
    const nextView = deriveRegularProblemView(nextProblemValue, next.problemType, next.traceItemIndex);
    setViewingIndex(nextView.previousTraceItemIndex);
    setAlert(undefined);
    setSwitchOpen(false);
    setError('');
    request.current = undefined;
    setDisplay(next);
  };
  return (
    <>
      <ProblemPageHeader
        courseId={courseId as CourseId}
        lectureId={lectureId}
        problemId={display.problemId as ProblemId}
        actions={
          display.problemType === 'executionResult' && !display.completed ? (
            <Button colorScheme="blue" variant="outline" onClick={() => setSwitchOpen(true)}>
              ステップ実行モードに移る
            </Button>
          ) : undefined
        }
      />
      {error && (
        <Text role="alert" color="red.600">
          {error}
        </Text>
      )}
      <RegularProblemPresentation
        problem={problem}
        view={view}
        viewingTraceItemIndex={viewingIndex}
        setViewingTraceItemIndex={setViewingIndex}
        editor={
          <BoardEditor
            key={contextKey}
            ref={editor}
            currentTraceItemIndex={currentIndex}
            currentVariables={view.currentVariables}
            initialVariables={view.initialVariables}
            previousTraceItemIndex={previousIndex}
            problem={problem}
            problemType={display.problemType}
            isDisabled={display.completed}
            handleSubmit={submit}
          />
        }
      />
      <ResultAlertDialog
        isOpen={Boolean(alert)}
        message={alert?.message ?? ''}
        title={alert?.title ?? ''}
        onClose={() => {
          alert?.after?.();
          setAlert(undefined);
        }}
      />
      <ResultAlertDialog
        isOpen={display.completed}
        message="正解です！次の問題へ進めます。"
        title="正解"
        actions={[
          { label: '終わる', onClick: back },
          { label: '次の問題へ', colorScheme: 'brand', onClick: nextProblem },
        ]}
      />
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
