'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { type ChallengeProblemFormat } from './ChallengeSelection';
import { ChallengeSelectionModal } from './ChallengeSelectionModal';
import { RegularChallengeBody, type RegularChallengeDisplay } from './RegularChallengeBody';
import { FillInBlankBody } from '../problems/[problemId]/FillInBlankBody';
import { ProblemPageHeader } from '../problems/[problemId]/ProblemPageHeader';
import type { CompletionAction } from '../problems/[problemId]/ResultAlertDialog';
import { backendTrpcReact } from '@/infrastructures/trpcBackend/client';
import { VStack } from '@/infrastructures/useClient/chakra';
import type { ExerciseDisplay } from '@/problems/fillInBlank/exerciseProblem';
import type { FillInBlankVerdict } from '@/problems/fillInBlank/grade';
import type { CourseId, ProblemId } from '@/problems/problemData';

type Display = ExerciseDisplay | RegularChallengeDisplay;
interface Props {
  initialFormat?: ChallengeProblemFormat;
}

export const ChallengePageOnClient: React.FC<Props> = ({ initialFormat }) => {
  const { courseId, lectureId } = useParams<{ courseId: CourseId; lectureId: string }>();
  const router = useRouter();
  const [exercise, setExercise] = useState<Display>();
  const [format, setFormat] = useState<ChallengeProblemFormat | undefined>(initialFormat);
  const [retryGeneration, setRetryGeneration] = useState(0);
  const [message, setMessage] = useState<{ text: string; role: 'alert' | 'status' }>();
  const [isModalOpen, setIsModalOpen] = useState(!initialFormat);
  const [isPending, setIsPending] = useState(false);
  const pendingRef = useRef(false);
  const requestRef = useRef<{ key: string; promise: Promise<Display | { status: 'noProblems' }> } | undefined>(
    undefined
  );
  const activeRequestRef = useRef(0);
  const previousInitialFormatRef = useRef(initialFormat);
  const { mutateAsync: start } = backendTrpcReact.startExercise.useMutation();
  const next = backendTrpcReact.nextExercise.useMutation();
  const submitBlank = backendTrpcReact.submitExercise.useMutation();
  const submitRegular = backendTrpcReact.submitRegularExercise.useMutation();
  const switchRegular = backendTrpcReact.switchRegularExerciseToStep.useMutation();
  const back = (): void => router.push(`/courses/${courseId}/lectures/${lectureId}`);

  useEffect(() => {
    if (initialFormat === previousInitialFormatRef.current) return;
    previousInitialFormatRef.current = initialFormat;
    if (initialFormat === format) return;
    activeRequestRef.current += 1;
    requestRef.current = undefined;
    pendingRef.current = false;
    // URL changes are external input and must reset the active challenge view.
    // oxlint-disable-next-line react/set-state-in-effect -- synchronize client state with server search params
    setIsPending(false);
    setMessage(undefined);
    setExercise(undefined);
    setFormat(initialFormat);
    setIsModalOpen(!initialFormat);
  }, [format, initialFormat]);

  useEffect(() => {
    if (!format) return;
    let cancelled = false;
    const requestId = ++activeRequestRef.current;
    const key = `${courseId}:${lectureId}:${format}:${retryGeneration}`;
    if (requestRef.current?.key !== key) {
      requestRef.current = {
        key,
        promise: start({ courseId, lectureId, problemFormat: format }) as Promise<Display | { status: 'noProblems' }>,
      };
    }
    pendingRef.current = true;
    // Starting is an external request whose pending state is reflected in the modal.
    // oxlint-disable-next-line react/set-state-in-effect -- synchronize UI with the active request
    setIsPending(true);
    const promise = requestRef.current.promise;
    void promise
      .then((display) => {
        if (cancelled || activeRequestRef.current !== requestId) return display;
        if ('status' in display) {
          setMessage({
            text: `${format === 'regular' ? '通常問題' : '穴埋め問題'}は現在出題できません。別の形式を選んでください。`,
            role: 'status',
          });
          setIsModalOpen(true);
          return display;
        }
        setExercise(display);
        setIsModalOpen(false);
        return display;
      })
      .catch(() => {
        if (cancelled || activeRequestRef.current !== requestId) return;
        setMessage({ text: '問題を取得できませんでした。', role: 'alert' });
        setIsModalOpen(true);
      })
      .finally(() => {
        if (cancelled || activeRequestRef.current !== requestId) return;
        pendingRef.current = false;
        setIsPending(false);
      });
    return () => {
      cancelled = true;
    };
  }, [courseId, format, lectureId, retryGeneration, start]);

  const select = (selected: ChallengeProblemFormat): void => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setIsPending(true);
    setMessage(undefined);
    setExercise(undefined);
    if (selected !== format) {
      setFormat(selected);
      router.push(`/courses/${courseId}/lectures/${lectureId}/challenge?format=${selected}`);
    } else setRetryGeneration((generation) => generation + 1);
  };
  const closeSelection = (): void => {
    activeRequestRef.current += 1;
    requestRef.current = undefined;
    pendingRef.current = false;
    setIsPending(false);
    setIsModalOpen(false);
    setFormat(undefined);
    back();
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
    { label: '終わる', onClick: back },
    { label: '次の問題へ', colorScheme: 'brand', onClick: nextBlank },
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
      <ChallengeSelectionModal
        isOpen={isModalOpen}
        isPending={isPending}
        message={message?.text}
        messageRole={message?.role}
        onClose={closeSelection}
        onSelect={select}
      />
      {exercise && format === 'regular' && (
        <RegularChallengeBody
          key={exercise.sessionId}
          courseId={courseId}
          lectureId={lectureId}
          display={exercise as RegularChallengeDisplay}
          back={back}
          transport={{
            submit: async (input) => await submitRegular.mutateAsync(input),
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
      {exercise && format === 'fillInBlank' && (
        <VStack key={exercise.sessionId} align="stretch" spacing={4}>
          <ProblemPageHeader courseId={courseId} lectureId={lectureId} problemId={exercise.problemId as ProblemId} />
          <FillInBlankBody
            problem={exercise as ExerciseDisplay}
            gradeAnswers={gradeBlank}
            completionActions={actions}
            completionMessage="正解です！次の問題へ進めます。"
            isCompleted={exercise.completed}
          />
        </VStack>
      )}
    </VStack>
  );
};
