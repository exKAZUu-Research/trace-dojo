'use client';

import { useParams, useRouter } from 'next/navigation';
import type React from 'react';
import { useEffect, useId, useRef, useState } from 'react';
import { MdRedo, MdUndo } from 'react-icons/md';
import { useImmer } from 'use-immer';

import { BoardViewer } from './BoardViewer';
import { JavaDiagnosticList } from './JavaDiagnosticList';
import { JavaCodeEditor, type EditorHistoryAvailability, type JavaCodeEditorHandle } from './JavaCodeEditor';
import { ResultAlertDialog, type CompletionAction } from './ResultAlertDialog';

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
  Center,
  Flex,
  Heading,
  HStack,
  IconButton,
  VStack,
} from '@/infrastructures/useClient/chakra';
import { javaFeedbackSummary, readJavaDiagnostics, type JavaDiagnostic } from '@/problems/fillInBlank/javaDiagnostics';
import { hasIncompleteJavaPlaceholders } from '@/problems/fillInBlank/javaSource';
import type { FillInBlankVerdict } from '@/problems/fillInBlank/grade';
import type { TurtleTrace } from '@/problems/traceProgram';
import type { CourseId, ProblemId } from '@/problems/problemData';

interface Props {
  problem: {
    displayProgram: string;
    finalBoard: string;
    finalTurtles: TurtleTrace[];
  };
  gradeCode: (code: string) => Promise<FillInBlankVerdict>;
  completionActions?: CompletionAction[];
  completionMessage?: string;
  isCompleted?: boolean;
}

export const FillInBlankBody: React.FC<Props> = (props) => {
  const params = useParams<{ courseId: CourseId; lectureId: string; problemId: ProblemId }>();
  const router = useRouter();
  const [code, setCode] = useState(props.problem.displayProgram.replaceAll(/\r\n?/g, '\n'));
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [alert, setAlert] = useImmer<
    { title: string; message: string; isCompleted: boolean; diagnostics?: JavaDiagnostic[] } | undefined
  >(undefined);
  const [isResetOpen, setIsResetOpen] = useState(false);
  const [history, setHistory] = useImmer<EditorHistoryAvailability>({ canUndo: false, canRedo: false });
  const [feedback, setFeedback] = useImmer<{ diagnostics: JavaDiagnostic[]; isStale: boolean } | undefined>(undefined);
  const feedbackHeadingId = useId();
  const revision = useRef(0);
  const request = useRef(0);
  useEffect(
    () => () => {
      request.current += 1;
    },
    []
  );
  const invalidate = (): void => {
    revision.current += 1;
    request.current += 1;
    setIsSubmitting(false);
    setFeedback((draft) => {
      if (draft) draft.isStale = true;
    });
  };
  const editor = useRef<JavaCodeEditorHandle>(null);
  const cancelReset = useRef<HTMLButtonElement>(null);
  const resetButton = useRef<HTMLButtonElement>(null);
  const isIncomplete = code.trim() === '';
  const isCompleted = props.isCompleted || alert?.isCompleted === true;

  const isLocked = isSubmitting || isCompleted || Boolean(alert);
  const isEditorLocked = isLocked || isResetOpen;

  const handleSubmit = async (): Promise<void> => {
    if (isEditorLocked || isIncomplete) return;
    if (hasIncompleteJavaPlaceholders(code)) {
      setAlert({
        title: 'コードが未完成です',
        message: '【1】などの空欄をJavaのコードに書き換えてから提出してください。',
        isCompleted: false,
      });
      return;
    }
    setFeedback(undefined);
    const token = ++request.current;
    const submittedRevision = revision.current;
    const isCurrent = (): boolean => token === request.current && submittedRevision === revision.current;
    setIsSubmitting(true);
    try {
      let result: FillInBlankVerdict;
      try {
        result = await props.gradeCode(code);
      } catch (error) {
        if (!isCurrent()) return;
        console.error(error);
        setAlert({
          title: '提出できませんでした',
          message: '通信に失敗しました。ネットワークの状態を確認して、もう一度提出してください。',
          isCompleted: false,
        });
        return;
      }
      if (!isCurrent()) return;
      switch (result.status) {
        case 'correct': {
          setAlert({
            title: '正解',
            message:
              props.completionMessage ??
              '正解です！この問題は完了です。問題一覧ページに戻りますので、次の問題に挑戦してください。',
            isCompleted: true,
          });
          break;
        }
        case 'incorrect': {
          const diagnostics = result.detail.startsWith('Compile error')
            ? readJavaDiagnostics(result.diagnostics, code.split('\n').length)
            : undefined;
          if (diagnostics) setFeedback({ diagnostics, isStale: false });
          setAlert({
            title: '不正解',
            message: toIncorrectMessage(result.detail),
            diagnostics,
            isCompleted: false,
          });
          break;
        }
        case 'ungradable': {
          setAlert({
            title: '採点できませんでした',
            message: '採点サービスが混み合っています。しばらく待ってから、もう一度提出してください。',
            isCompleted: false,
          });
          break;
        }
      }
    } finally {
      if (isCurrent()) setIsSubmitting(false);
    }
  };

  return (
    <>
      <Flex alignItems="stretch" gap={6}>
        <VStack align="stretch" flexBasis={0} flexGrow={1} minW={0} spacing={4}>
          <VStack align="stretch" as={Card} overflow="hidden" spacing={0}>
            <VStack align="stretch" borderBottomWidth="1px" p={5}>
              <Heading size="md">問題</Heading>
              <Box>
                プログラムを実行した後の盤面と亀の位置・向きが右側のようになるように、Javaのコードを編集して提出してください。
                【1】などの空欄を含め、プログラム全体を書き換えられます。
              </Box>
            </VStack>
          </VStack>

          <JavaCodeEditor
            ref={editor}
            value={code}
            disabled={isEditorLocked}
            onChange={(value) => {
              invalidate();
              setCode(value);
            }}
            onInvalidate={invalidate}
            diagnostics={feedback?.isStale ? undefined : feedback?.diagnostics}
            onHistoryChange={(availability) =>
              setHistory((draft) => {
                draft.canUndo = availability.canUndo;
                draft.canRedo = availability.canRedo;
              })
            }
          />
          {feedback && (
            <Box as="section" aria-labelledby={feedbackHeadingId}>
              <Heading id={feedbackHeadingId} size="sm" mb={3}>
                {feedback.isStale ? '前回提出したコードの確認結果' : '提出したコードの確認結果'}
              </Heading>
              <Box role="status" aria-live="polite" mb={feedback.isStale ? 3 : 0}>
                {feedback.isStale &&
                  'これは前回提出したコードの確認結果です。修正を確認するには、もう一度提出してください。'}
              </Box>
              <JavaDiagnosticList diagnostics={feedback.diagnostics} />
            </Box>
          )}
          <VStack align="stretch" as={Card} p={5} spacing={3}>
            <HStack justify="flex-end" spacing={3}>
              <IconButton
                type="button"
                variant="outline"
                aria-label="元に戻す"
                title="元に戻す"
                icon={<MdUndo size={24} />}
                isDisabled={isEditorLocked || !history.canUndo}
                onClick={() => {
                  if (!isEditorLocked) editor.current?.undo();
                }}
              />
              <IconButton
                type="button"
                variant="outline"
                aria-label="やり直す"
                title="やり直す"
                icon={<MdRedo size={24} />}
                isDisabled={isEditorLocked || !history.canRedo}
                onClick={() => {
                  if (!isEditorLocked) editor.current?.redo();
                }}
              />
              <Button
                type="button"
                variant="outline"
                ref={resetButton}
                isDisabled={isEditorLocked}
                onClick={() => {
                  if (!isEditorLocked) setIsResetOpen(true);
                }}
              >
                リセット
              </Button>
              <Button
                colorScheme="brand"
                isDisabled={isIncomplete || isEditorLocked}
                isLoading={isSubmitting}
                onClick={() => void handleSubmit()}
              >
                提出
              </Button>
            </HStack>
          </VStack>
        </VStack>

        <VStack align="stretch" bgColor="gray.50" flexBasis={0} flexGrow={1} p={5} rounded="md" spacing={4}>
          <Heading size="md">実行後の盤面</Heading>
          <Center>
            <BoardViewer board={props.problem.finalBoard} turtles={props.problem.finalTurtles} />
          </Center>
        </VStack>
      </Flex>

      <AlertDialog
        isOpen={isResetOpen}
        leastDestructiveRef={cancelReset}
        finalFocusRef={resetButton}
        onClose={() => setIsResetOpen(false)}
      >
        <AlertDialogOverlay>
          <AlertDialogContent>
            <AlertDialogHeader>コードをリセットしますか？</AlertDialogHeader>
            <AlertDialogBody>編集内容を問題の初期コードに戻します。</AlertDialogBody>
            <AlertDialogFooter>
              <Button ref={cancelReset} type="button" onClick={() => setIsResetOpen(false)}>
                キャンセル
              </Button>
              <Button
                type="button"
                colorScheme="red"
                ml={3}
                isDisabled={isLocked}
                onClick={() => {
                  if (isLocked) return;
                  invalidate();
                  setCode(props.problem.displayProgram.replaceAll(/\r\n?/g, '\n'));
                  setIsResetOpen(false);
                }}
              >
                リセットする
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialogOverlay>
      </AlertDialog>

      <ResultAlertDialog
        {...(isCompleted && props.completionActions
          ? { actions: props.completionActions }
          : {
              onClose: () => {
                if (isCompleted) router.push(`/courses/${params.courseId}/lectures/${params.lectureId}`);
                setAlert(undefined);
              },
            })}
        isOpen={Boolean(alert) || Boolean(props.isCompleted)}
        message={
          alert?.diagnostics ? (
            <Box whiteSpace="normal" maxH="60dvh" overflowY="auto">
              <Box as="p" mb={4}>
                {javaFeedbackSummary}
              </Box>
              <JavaDiagnosticList diagnostics={alert.diagnostics} />
              <Box as="p" mt={4}>
                閉じてコードを修正し、もう一度提出してください。
              </Box>
            </Box>
          ) : (
            (alert?.message ?? (props.isCompleted ? (props.completionMessage ?? '正解です！次の問題へ進めます。') : ''))
          )
        }
        title={alert?.title ?? (props.isCompleted ? '正解' : '')}
      />
    </>
  );
};

function toIncorrectMessage(detail: string): string {
  if (detail.startsWith('Compile error')) return `${javaFeedbackSummary}入力したコードを見直してください。`;
  if (detail.startsWith('Time limit'))
    return 'プログラムが終了しませんでした。無限ループになっていないか確認してください。';
  if (detail.includes('forbidden')) return '使用できない機能が含まれています。';
  if (detail.startsWith('The program threw an exception') || detail.startsWith('The program failed')) {
    return 'プログラムが実行中にエラーで停止しました。亀が盤面の外に出ていないか確認してください。';
  }
  if (detail.includes('too much output') || detail.includes('too long') || detail.includes('did not finish')) {
    return 'プログラムを最後まで実行できませんでした。出力や入力の量を減らしてください。';
  }
  return '実行結果が期待した盤面と異なります。もう一度考えてみましょう。';
}
