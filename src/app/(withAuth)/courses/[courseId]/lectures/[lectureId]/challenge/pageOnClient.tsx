'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useImmer } from 'use-immer';

import { FillInBlankBody, ResultAlertDialog, type CompletionAction } from '../problems/[problemId]/FillInBlankBody';

import { NextLinkWithoutPrefetch } from '@/components/atoms/NextLinkWithoutPrefetch';
import { backendTrpcReact } from '@/infrastructures/trpcBackend/client';
import { Button, Heading, Link, Text, VStack } from '@/infrastructures/useClient/chakra';
import type { ExerciseDisplay } from '@/problems/fillInBlank/exerciseProblem';
import type { FillInBlankVerdict } from '@/problems/fillInBlank/grade';
import type { CourseId } from '@/problems/problemData';

export const ChallengePageOnClient: React.FC = () => {
  const { courseId, lectureId } = useParams<{ courseId: CourseId; lectureId: string }>();
  const router = useRouter();
  const [exercise, setExercise] = useImmer<ExerciseDisplay | undefined>(undefined);
  const [noCandidates, setNoCandidates] = useState(false);
  const [error, setError] = useState('');
  const { mutateAsync: startExercise, isPending: isStarting } = backendTrpcReact.startExercise.useMutation();
  const next = backendTrpcReact.nextExercise.useMutation();
  const submit = backendTrpcReact.submitExercise.useMutation();

  useEffect(() => {
    let active = true;
    void startExercise({ courseId, lectureId })
      .then((display) => {
        if (active) {
          if ('status' in display) setNoCandidates(true);
          else setExercise(display);
        }
        return display;
      })
      .catch(() => {
        if (active) setError('問題を取得できませんでした。');
      });
    return () => {
      active = false;
    };
  }, [courseId, lectureId, startExercise, setExercise]);

  const handleNext = async (): Promise<void> => {
    if (!exercise) throw new Error('問題を取得できませんでした。もう一度お試しください。');
    let display: ExerciseDisplay | { status: 'noProblems' };
    try {
      display = await next.mutateAsync({ courseId, lectureId, sessionId: exercise.sessionId });
    } catch {
      throw new Error('次の問題を取得できませんでした。もう一度お試しください。');
    }
    if ('status' in display) throw new Error('この授業回には現在出題できる問題がありません。');
    setExercise(display);
  };

  const completionActions: CompletionAction[] = [
    { label: '次の問題へ', colorScheme: 'brand', onClick: handleNext },
    {
      label: '戻る',
      onClick: () => router.push(`/courses/${courseId}/lectures/${lectureId}`),
    },
  ];

  const gradeAnswers = async (answers: string[]): Promise<FillInBlankVerdict> => {
    if (!exercise) throw new Error('No active exercise');
    const result = await submit.mutateAsync({ courseId, lectureId, sessionId: exercise.sessionId, answers });
    switch (result.status) {
      case 'correct': {
        return { status: 'correct' };
      }
      case 'incorrect': {
        return { status: 'incorrect', detail: result.detail };
      }
      case 'ungradable': {
        return { status: 'ungradable', detail: '' };
      }
    }
  };

  return (
    <VStack align="stretch" spacing={5}>
      <Link as={NextLinkWithoutPrefetch} href={`/courses/${courseId}/lectures/${lectureId}`} alignSelf="start">
        授業回へ戻る
      </Link>
      <Heading as="h1">チャレンジモード</Heading>
      <Text color="gray.600">チャレンジの履歴は成績や通常課題の進捗には反映されません。</Text>
      {error && (
        <Text color="red.600" role="alert">
          {error}
        </Text>
      )}
      {noCandidates && !exercise && <Text>この授業回には現在出題できる問題がありません。授業回に戻ってください。</Text>}
      {!exercise && !noCandidates && (
        <Button
          alignSelf="start"
          isLoading={isStarting}
          onClick={() => {
            setError('');
            void startExercise({ courseId, lectureId })
              .then((display) => {
                if ('status' in display) setNoCandidates(true);
                else setExercise(display);
                return display;
              })
              .catch(() => setError('問題を取得できませんでした。'));
          }}
        >
          問題を取得
        </Button>
      )}
      {exercise?.completed && (
        <ResultAlertDialog
          actions={completionActions}
          isOpen={true}
          message="正解です！次の問題へ進めます。"
          title="正解"
        />
      )}
      {exercise && !exercise.completed && (
        <FillInBlankBody
          key={exercise.sessionId}
          problem={{
            displayProgram: exercise.displayProgram,
            blankCount: exercise.blankCount,
            finalBoard: exercise.expectedBoard,
            finalTurtles: exercise.expectedTurtles,
            finalVars: exercise.finalVars,
          }}
          gradeAnswers={gradeAnswers}
          completionActions={completionActions}
          completionMessage="正解です！次の問題へ進めます。"
        />
      )}
    </VStack>
  );
};
