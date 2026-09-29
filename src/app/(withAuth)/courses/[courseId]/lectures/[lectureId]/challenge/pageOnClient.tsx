'use client';

import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { ChallengeSelection, type ChallengeProblemFormat } from './ChallengeSelection';
import { RegularChallengeBody, type RegularChallengeDisplay } from './RegularChallengeBody';
import { FillInBlankBody, ResultAlertDialog, type CompletionAction } from '../problems/[problemId]/FillInBlankBody';
import { NextLinkWithoutPrefetch } from '@/components/atoms/NextLinkWithoutPrefetch';
import { backendTrpcReact } from '@/infrastructures/trpcBackend/client';
import { Heading, Link, Text, VStack } from '@/infrastructures/useClient/chakra';
import type { ExerciseDisplay } from '@/problems/fillInBlank/exerciseProblem';
import type { FillInBlankVerdict } from '@/problems/fillInBlank/grade';
import type { CourseId } from '@/problems/problemData';

type Display = ExerciseDisplay | RegularChallengeDisplay;
export const ChallengePageOnClient: React.FC = () => {
  const { courseId, lectureId } = useParams<{ courseId: CourseId; lectureId: string }>();
  const router = useRouter();
  const [exercise, setExercise] = useState<Display>();
  const [format, setFormat] = useState<ChallengeProblemFormat>();
  const [emptyFormat, setEmptyFormat] = useState<ChallengeProblemFormat>();
  const [error, setError] = useState('');
  const start = backendTrpcReact.startExercise.useMutation();
  const next = backendTrpcReact.nextExercise.useMutation();
  const submitBlank = backendTrpcReact.submitExercise.useMutation();
  const submitRegular = backendTrpcReact.submitRegularExercise.useMutation();
  const switchRegular = backendTrpcReact.switchRegularExerciseToStep.useMutation();
  const back = (): void => router.push(`/courses/${courseId}/lectures/${lectureId}`);

  const select = async (selected: ChallengeProblemFormat): Promise<void> => {
    setError('');
    setEmptyFormat(undefined);
    try {
      const display = await start.mutateAsync({ courseId, lectureId, problemFormat: selected });
      if ('status' in display) setEmptyFormat(selected);
      else {
        setFormat(selected);
        setExercise(display as Display);
      }
    } catch {
      setError('問題を取得できませんでした。');
    }
  };
  const nextBlank = async (): Promise<void> => {
    if (!exercise) throw new Error('問題を取得できませんでした。');
    const display = await next.mutateAsync({
      courseId,
      lectureId,
      sessionId: exercise.sessionId,
      problemFormat: 'fillInBlank',
    });
    if ('status' in display) throw new Error('この授業回には現在出題できる問題がありません。');
    setExercise(display as ExerciseDisplay);
  };
  const actions: CompletionAction[] = [
    { label: '次の問題へ', colorScheme: 'brand', onClick: nextBlank },
    { label: '戻る', onClick: back },
  ];
  const gradeBlank = async (answers: string[]): Promise<FillInBlankVerdict> => {
    if (!exercise) throw new Error('No active exercise');
    const result = await submitBlank.mutateAsync({ courseId, lectureId, sessionId: exercise.sessionId, answers });
    return result.status === 'incorrect'
      ? { status: 'incorrect', detail: result.detail }
      : result.status === 'ungradable'
        ? { status: 'ungradable', detail: '' }
        : { status: 'correct' };
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
      {emptyFormat && (
        <Text as="output">
          {emptyFormat === 'regular' ? '実行結果・ステップ実行' : '穴埋め問題'}
          は現在出題できません。別の形式を選んでください。
        </Text>
      )}
      {!exercise && (
        <ChallengeSelection courseId={courseId} lectureId={lectureId} isPending={start.isPending} onSelect={select} />
      )}
      {exercise && format === 'regular' && (
        <RegularChallengeBody
          courseId={courseId}
          lectureId={lectureId}
          display={exercise as RegularChallengeDisplay}
          back={back}
          transport={{
            submit: async (input) => {
              const value = await submitRegular.mutateAsync(input);
              return { exercise: value, status: input.isCorrect ? 'correct' : 'incorrect' };
            },
            switchToStep: async ({ sessionId }) => await switchRegular.mutateAsync({ courseId, lectureId, sessionId }),
            next: async ({ sessionId, problemFormat }) => {
              const value = await next.mutateAsync({ courseId, lectureId, sessionId, problemFormat });
              if ('status' in value || !('problemFormat' in value))
                throw new Error('この授業回には現在出題できる問題がありません。');
              return value;
            },
          }}
        />
      )}
      {exercise && format === 'fillInBlank' && exercise.completed && (
        <ResultAlertDialog actions={actions} isOpen={true} message="正解です！次の問題へ進めます。" title="正解" />
      )}
      {exercise && format === 'fillInBlank' && !exercise.completed && (
        <FillInBlankBody
          key={exercise.sessionId}
          problem={{
            displayProgram: (exercise as ExerciseDisplay).displayProgram,
            blankCount: (exercise as ExerciseDisplay).blankCount,
            finalBoard: (exercise as ExerciseDisplay).expectedBoard,
            finalTurtles: (exercise as ExerciseDisplay).expectedTurtles,
            finalVars: (exercise as ExerciseDisplay).finalVars,
          }}
          gradeAnswers={gradeBlank}
          completionActions={actions}
          completionMessage="正解です！次の問題へ進めます。"
        />
      )}
    </VStack>
  );
};
