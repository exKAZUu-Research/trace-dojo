'use client';

import { useParams, useRouter } from 'next/navigation';
import type React from 'react';
import { useRef, useState } from 'react';
import { useImmer } from 'use-immer';

import { BoardViewer } from './BoardViewer';
import { SyntaxHighlighter } from './SyntaxHighlighter';
import { Variables } from './Variables';

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
  Input,
  Text,
  VStack,
} from '@/infrastructures/useClient/chakra';
import { toBlankPlaceholder } from '@/problems/fillInBlank/blanks';
import type { FillInBlankGradingResult } from '@/problems/fillInBlank/grade';
import type { InstantiatedProblem } from '@/problems/instantiateProblem';
import type { CourseId, ProblemId } from '@/problems/problemData';

interface Props {
  problem: InstantiatedProblem;
  gradeAnswers: (answers: string[]) => Promise<FillInBlankGradingResult>;
}

export const FillInBlankBody: React.FC<Props> = (props) => {
  const params = useParams<{ courseId: CourseId; lectureId: string; problemId: ProblemId }>();
  const router = useRouter();
  const [answers, updateAnswers] = useImmer<string[]>(props.problem.blankAnswers.map(() => ''));
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [alert, setAlert] = useState<{ title: string; message: string; isCompleted: boolean }>();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const hasVariables = Object.keys(props.problem.finalVars).length > 0;
  const isIncomplete = answers.some((answer) => answer.trim() === '');

  const handleSubmit = async (): Promise<void> => {
    if (isSubmitting || alert || isIncomplete) return;
    setIsSubmitting(true);
    try {
      let result: FillInBlankGradingResult;
      try {
        result = await props.gradeAnswers(answers);
      } catch (error) {
        console.error(error);
        setAlert({
          title: '提出できませんでした',
          message: '通信に失敗しました。ネットワークの状態を確認して、もう一度提出してください。',
          isCompleted: false,
        });
        return;
      }
      switch (result.status) {
        case 'correct': {
          setAlert({
            title: '正解',
            message: '正解です！この問題は完了です。問題一覧ページに戻りますので、次の問題に挑戦してください。',
            isCompleted: true,
          });
          break;
        }
        case 'incorrect': {
          setAlert({ title: '不正解', message: toIncorrectMessage(result.detail), isCompleted: false });
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
      setIsSubmitting(false);
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
                プログラムを実行した後の盤面{hasVariables ? 'と変数の値' : ''}が右側のようになるように、
                <Box as="span" fontWeight="bold">
                  空欄{props.problem.blankAnswers.map((_, index) => toBlankPlaceholder(index + 1)).join('、')}
                </Box>
                に入るJavaのコードを入力し、提出ボタンを押してください。
              </Box>
            </VStack>
          </VStack>

          <SyntaxHighlighter code={props.problem.displayProgram} programmingLanguageId="java" />

          <VStack align="stretch" as={Card} p={5} spacing={3}>
            {answers.map((answer, index) => (
              <HStack key={index} spacing={3}>
                <Text flexShrink={0} fontWeight="bold">
                  {toBlankPlaceholder(index + 1)}
                </Text>
                <Input
                  aria-label={`空欄${toBlankPlaceholder(index + 1)}`}
                  // oxlint-disable-next-line jsx-a11y/no-autofocus -- 空欄の入力がこのページの主目的のため。
                  autoFocus={index === 0}
                  bg="white"
                  fontFamily="mono"
                  spellCheck={false}
                  value={answer}
                  onChange={(event) => {
                    updateAnswers((draft) => {
                      draft[index] = event.target.value;
                    });
                  }}
                  onKeyDown={(event) => {
                    // Enter also confirms a Japanese IME conversion, which must not submit.
                    if (event.key === 'Enter' && !event.nativeEvent.isComposing) void handleSubmit();
                  }}
                />
              </HStack>
            ))}
            <Button
              alignSelf="flex-end"
              colorScheme="brand"
              isDisabled={isIncomplete}
              isLoading={isSubmitting}
              onClick={() => void handleSubmit()}
            >
              提出
            </Button>
          </VStack>
        </VStack>

        <VStack align="stretch" bgColor="gray.50" flexBasis={0} flexGrow={1} p={5} rounded="md" spacing={4}>
          <Heading size="md">実行後の盤面</Heading>
          <Center>
            <BoardViewer board={props.problem.finalBoard} turtles={props.problem.finalTurtles} />
          </Center>
          {hasVariables && (
            <>
              <Heading size="md">実行後の変数の値</Heading>
              <Variables traceItemVars={props.problem.finalVars} />
            </>
          )}
        </VStack>
      </Flex>

      <AlertDialog
        closeOnEsc={true}
        closeOnOverlayClick={false}
        isOpen={alert !== undefined}
        leastDestructiveRef={cancelRef as React.RefObject<HTMLElement>}
        onClose={() => {
          if (alert?.isCompleted) router.push(`/courses/${params.courseId}/lectures/${params.lectureId}`);
          setAlert(undefined);
        }}
      >
        <AlertDialogOverlay>
          <AlertDialogContent>
            <AlertDialogHeader fontSize="lg" fontWeight="bold">
              {alert?.title}
            </AlertDialogHeader>
            <AlertDialogBody whiteSpace="pre-wrap">{alert?.message}</AlertDialogBody>
            <AlertDialogFooter>
              <Button
                ref={cancelRef}
                rightIcon={
                  <Box as="span" fontSize="sm" fontWeight="bold">
                    (Esc)
                  </Box>
                }
                onClick={() => {
                  if (alert?.isCompleted) router.push(`/courses/${params.courseId}/lectures/${params.lectureId}`);
                  setAlert(undefined);
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

function toIncorrectMessage(detail: string): string {
  if (detail.startsWith('Compile error')) return 'コンパイルエラーになりました。入力したコードを見直してください。';
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
