'use client';

import { useParams, useRouter } from 'next/navigation';
import type React from 'react';
import { useState } from 'react';

import { BoardViewer } from './BoardViewer';
import { JavaCodeEditor } from './JavaCodeEditor';
import { ResultAlertDialog, type CompletionAction } from './ResultAlertDialog';

import { Box, Button, Card, Center, Flex, Heading, HStack, Text, VStack } from '@/infrastructures/useClient/chakra';
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
  const [code, setCode] = useState(props.problem.displayProgram);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [alert, setAlert] = useState<{ title: string; message: string; isCompleted: boolean }>();
  const isIncomplete = code.trim() === '';
  const isCompleted = props.isCompleted || alert?.isCompleted === true;

  const handleSubmit = async (): Promise<void> => {
    if (isSubmitting || alert || isIncomplete || isCompleted) return;
    if (hasIncompleteJavaPlaceholders(code)) {
      setAlert({
        title: 'コードが未完成です',
        message: '【1】などの空欄をJavaのコードに書き換えてから提出してください。',
        isCompleted: false,
      });
      return;
    }
    setIsSubmitting(true);
    try {
      let result: FillInBlankVerdict;
      try {
        result = await props.gradeCode(code);
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
            message:
              props.completionMessage ??
              '正解です！この問題は完了です。問題一覧ページに戻りますので、次の問題に挑戦してください。',
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
                プログラムを実行した後の盤面と亀の位置・向きが右側のようになるように、Javaのコードを編集して提出してください。
                【1】などの空欄を含め、プログラム全体を書き換えられます。
              </Box>
            </VStack>
          </VStack>

          <JavaCodeEditor value={code} disabled={isSubmitting || isCompleted} onChange={setCode} />
          <Text id="java-editor-help" fontSize="sm">
            Tabでインデントできます。エディターから移動するにはEscを押してからTabを押してください。実行は提出時のみ行います。
          </Text>
          <VStack align="stretch" as={Card} p={5} spacing={3}>
            <HStack justify="flex-end" spacing={3}>
              <Button
                type="button"
                variant="outline"
                isDisabled={isSubmitting || isCompleted || Boolean(alert)}
                onClick={() => setCode(props.problem.displayProgram)}
              >
                リセット
              </Button>
              <Button
                colorScheme="brand"
                isDisabled={isIncomplete || isCompleted}
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
          alert?.message ?? (props.isCompleted ? (props.completionMessage ?? '正解です！次の問題へ進めます。') : '')
        }
        title={alert?.title ?? (props.isCompleted ? '正解' : '')}
      />
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
