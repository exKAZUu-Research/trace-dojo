'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { type ChallengeProblemFormat } from './ChallengeSelection';
import { ChallengeSelectionModal } from './ChallengeSelectionModal';
import { RegularChallengeBody } from './RegularChallengeBody';
import { FillInBlankBody } from '../problems/[problemId]/FillInBlankBody';
import { ProblemPageHeader } from '../problems/[problemId]/ProblemPageHeader';
import { ReloadNotice } from '../problems/[problemId]/ReloadNotice';
import type { CompletionAction } from '../problems/[problemId]/ResultAlertDialog';
import { backendTrpcReact } from '@/infrastructures/trpcBackend/client';
import { Center, Spinner, VStack } from '@/infrastructures/useClient/chakra';
import type { ExerciseDisplay } from '@/problems/fillInBlank/exerciseProblem';
import type { FillInBlankVerdict } from '@/problems/fillInBlank/grade';
import type { CourseId, ProblemId } from '@/problems/problemData';
import type { RegularExerciseDisplay } from '@/problems/regular/exerciseProblem';
import { isChallengeSessionStale } from '@/utils/problemSessionError';

type Display = ExerciseDisplay | RegularExerciseDisplay;
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
  const [isSessionStale, setIsSessionStale] = useState(false);
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
        promise: start({ courseId, lectureId, problemFormat: format }),
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
  const detectStaleSession = async <T,>(request: Promise<T>): Promise<T> => {
    try {
      return await request;
    } catch (error) {
      if (isChallengeSessionStale(error)) setIsSessionStale(true);
      throw error;
    }
  };
  const fetchNext = async (sessionId: number, problemFormat: ChallengeProblemFormat): Promise<Display> => {
    let display: Display | { status: 'noProblems' };
    try {
      display = await detectStaleSession(next.mutateAsync({ courseId, lectureId, sessionId, problemFormat }));
    } catch {
      throw new Error('次の問題を取得できませんでした。');
    }
    if ('status' in display) throw new Error('この授業回には現在出題できる問題がありません。');
    return display;
  };
  const nextBlank = async (): Promise<void> => {
    if (!exercise) throw new Error('次の問題を取得できませんでした。');
    setExercise(await fetchNext(exercise.sessionId, 'fillInBlank'));
  };
  const actions: CompletionAction[] = [
    { label: '終わる', onClick: back },
    { label: '次の問題へ', colorScheme: 'brand', onClick: nextBlank },
  ];
  const gradeBlank = async (code: string): Promise<FillInBlankVerdict> => {
    if (!exercise) throw new Error('No active exercise');
    return await detectStaleSession(
      submitBlank.mutateAsync({ courseId, lectureId, sessionId: exercise.sessionId, code })
    );
  };

  if (isSessionStale) {
    return (
      <ReloadNotice
        message="学習期間が切り替わったか、別の画面で問題が進みました。ページを再読み込みして続きから解いてください。"
        title="問題の進み具合が画面と一致しません"
      />
    );
  }

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
      {!isModalOpen && !exercise && isPending && (
        <Center py={10}>
          <Spinner label="問題を準備しています" />
        </Center>
      )}
      {exercise?.problemFormat === 'regular' && format === 'regular' && (
        <RegularChallengeBody
          key={exercise.sessionId}
          courseId={courseId}
          lectureId={lectureId}
          display={exercise}
          back={back}
          transport={{
            submit: async (input) => await detectStaleSession(submitRegular.mutateAsync(input)),
            switchToStep: async ({ sessionId }) =>
              await detectStaleSession(switchRegular.mutateAsync({ courseId, lectureId, sessionId })),
            next: async ({ sessionId, problemFormat }) => {
              const value = await fetchNext(sessionId, problemFormat);
              if (value.problemFormat !== 'regular') throw new Error('次の問題を取得できませんでした。');
              return value;
            },
          }}
        />
      )}
      {exercise?.problemFormat === 'fillInBlank' && format === 'fillInBlank' && (
        <VStack key={exercise.sessionId} align="stretch" spacing={4}>
          <ProblemPageHeader courseId={courseId} lectureId={lectureId} problemId={exercise.problemId as ProblemId} />
          <FillInBlankBody
            problem={exercise}
            gradeCode={gradeBlank}
            completionActions={actions}
            completionMessage="正解です！次の問題へ進めます。"
            isCompleted={exercise.completed}
          />
        </VStack>
      )}
    </VStack>
  );
};
