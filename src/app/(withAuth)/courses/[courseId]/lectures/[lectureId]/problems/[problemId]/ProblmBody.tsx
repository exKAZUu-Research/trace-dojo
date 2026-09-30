'use client';

import type { ProblemSession } from '../../../../../../../../../db/schema';
import { useParams, useRouter } from 'next/navigation';
import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { TurtleGraphicsHandle } from './BoardEditor';
import { BoardEditor } from './BoardEditor';
import { deriveRegularProblemView, RegularProblemPresentation } from './RegularProblemPresentation';
import { ResultAlertDialog } from './ResultAlertDialog';

import { MAX_CHALLENGE_COUNT } from '@/constants';
import { useAuthContextSelector } from '@/contexts/AuthContext';
import { backendTrpcReact } from '@/infrastructures/trpcBackend/client';
import { useDisclosure } from '@/infrastructures/useClient/chakra';
import type { InstantiatedProblem } from '@/problems/instantiateProblem';
import type { CourseId, ProblemId } from '@/problems/problemData';
import type { ProblemType } from '@/types';

interface Props {
  problem: InstantiatedProblem;
  problemSession: ProblemSession;
  createSubmissionUpdatingProblemSession: (isCorrect: boolean, isCompleted: boolean) => Promise<void>;
  updateProblemSession: (problemType: string, traceItemIndex: number) => Promise<void>;
}

export const ProblemBody: React.FC<Props> = (props) => {
  const params = useParams<{ courseId: CourseId; lectureId: string; problemId: ProblemId }>();
  const isAdmin = useAuthContextSelector((c) => c.isAdmin);

  const problemType = props.problemSession.problemType as ProblemType;
  if (problemType === 'fillInBlank') throw new Error('Regular problem body cannot render a fill-in-blank session.');
  const view = useMemo(
    () => deriveRegularProblemView(props.problem, problemType, props.problemSession.traceItemIndex, isAdmin),
    [props.problem, problemType, props.problemSession.traceItemIndex, isAdmin]
  );
  const { currentTraceItemIndex, previousTraceItemIndex, currentVariables, initialVariables } = view;

  const [viewingTraceItemIndex, setViewingTraceItemIndex] = useState(previousTraceItemIndex);
  useEffect(() => {
    setViewingTraceItemIndex(previousTraceItemIndex);
  }, [previousTraceItemIndex]);

  const { isOpen: isAlertOpen, onClose: onAlertClose, onOpen: onAlertOpen } = useDisclosure();
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
    params.courseId,
    params.lectureId,
    previousTraceItemIndex,
    problemType,
    props,
    router,
  ]);

  return (
    <>
      <RegularProblemPresentation
        problem={props.problem}
        view={view}
        viewingTraceItemIndex={viewingTraceItemIndex}
        setViewingTraceItemIndex={setViewingTraceItemIndex}
        editor={
          <BoardEditor
            ref={turtleGraphicsRef}
            currentTraceItemIndex={currentTraceItemIndex}
            currentVariables={currentVariables}
            handleSubmit={async () => {
              try {
                await handleSubmit();
              } catch (error) {
                console.error(error);
                openAlertDialog(
                  '提出できませんでした',
                  '通信に失敗しました。ネットワークの状態を確認して、もう一度提出してください。'
                );
              }
            }}
            initialVariables={initialVariables}
            previousTraceItemIndex={previousTraceItemIndex}
            problem={props.problem}
            problemType={problemType}
          />
        }
      />
      <ResultAlertDialog
        isOpen={isAlertOpen}
        title={alertTitle}
        message={alertMessage}
        onClose={() => {
          postAlertAction?.();
          onAlertClose();
        }}
      />
    </>
  );
};
