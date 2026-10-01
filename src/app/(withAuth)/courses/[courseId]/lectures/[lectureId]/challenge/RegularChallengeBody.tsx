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
import type { RegularExerciseDisplay } from '@/problems/regular/exerciseProblem';

interface SubmitInput {
  courseId: string;
  lectureId: string;
  sessionId: number;
  requestId: string;
  context: { problemType: 'executionResult' | 'step'; traceItemIndex: number };
  isCorrect: boolean;
}
export interface RegularChallengeTransport {
  submit: (input: SubmitInput) => Promise<RegularExerciseDisplay>;
  switchToStep: (input: { sessionId: number }) => Promise<RegularExerciseDisplay>;
  next: (input: { sessionId: number; problemFormat: 'regular' }) => Promise<RegularExerciseDisplay>;
}
interface Props {
  courseId: string;
  lectureId: string;
  display: RegularExerciseDisplay;
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
  const [alert, setAlert] = useState<{ title: string; message: string }>();
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
  const contextKey = `${display.sessionId}:${display.problemId}:${display.seed}:${display.problemType}:${currentIndex}`;
  // A viewing position chosen for an earlier step or problem falls back to the current step's previous trace item.
  const [viewing, setViewing] = useState({ contextKey, index: previousIndex });
  const viewingIndex = viewing.contextKey === contextKey ? viewing.index : previousIndex;
  const setViewingIndex: React.Dispatch<React.SetStateAction<number>> = (action) =>
    setViewing((prev) => {
      const index = prev.contextKey === contextKey ? prev.index : previousIndex;
      return { contextKey, index: typeof action === 'function' ? action(index) : action };
    });

  const submit = async (): Promise<void> => {
    if (display.completed || alert || switchOpen || !editor.current) return;
    const grading = editor.current.gradeAnswers();
    const isCorrect = grading.status === 'correct';
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
          message: `${grading.incorrectLocations.join('、')}に誤りがあります。もう一度解答してみましょう。${grading.hintText}`,
        });
        return;
      }
      setDisplay(result);
      if (!result.completed) setAlert({ title: '正解', message: '正解です。次のステップに進みます。' });
    } catch {
      setAlert({ title: '提出できませんでした', message: '通信に失敗しました。もう一度提出してください。' });
    }
  };
  const switchMode = async (): Promise<void> => {
    if (display.completed) return;
    try {
      const next = await transport.switchToStep({ sessionId: display.sessionId });
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
          setAlert(undefined);
        }}
      />
      <ResultAlertDialog
        key={display.sessionId}
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
