'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { backendTrpcReact } from '@/infrastructures/trpcBackend/client';
import { Button, Spinner, Text, VStack } from '@/infrastructures/useClient/chakra';
import type { CourseId } from '@/problems/problemData';
import type { RegularExerciseDisplay } from '@/problems/regular/exerciseProblem';
import { isChallengeSessionStale } from '@/utils/problemSessionError';

import { ReloadNotice } from '../problems/[problemId]/ReloadNotice';
import { RegularExerciseBody } from '../RegularExerciseBody';

export const PracticePageOnClient: React.FC = () => {
  const { courseId, lectureId } = useParams<{ courseId: CourseId; lectureId: string }>();
  return <PracticeSession key={`practice:${courseId}:${lectureId}`} courseId={courseId} lectureId={lectureId} />;
};

const PracticeSession: React.FC<{ courseId: CourseId; lectureId: string }> = ({ courseId, lectureId }) => {
  const router = useRouter();
  const [display, setDisplay] = useState<RegularExerciseDisplay>();
  const [message, setMessage] = useState('');
  const [generation, setGeneration] = useState(0);
  const [stale, setStale] = useState(false);
  const { mutateAsync: start } = backendTrpcReact.startExercise.useMutation();
  const next = backendTrpcReact.nextExercise.useMutation();
  const submit = backendTrpcReact.submitRegularExercise.useMutation();
  const switchToStep = backendTrpcReact.switchRegularExerciseToStep.useMutation();
  const request = useRef<{ generation: number; promise: ReturnType<typeof start> } | undefined>(undefined);
  const location = { courseId, lectureId, learningMode: 'practice' as const };
  const back = (): void => router.push(`/courses/${courseId}/lectures/${lectureId}`);

  useEffect(() => {
    let cancelled = false;
    if (request.current?.generation !== generation) {
      request.current = {
        generation,
        promise: start({ courseId, lectureId, learningMode: 'practice', problemFormat: 'regular' }),
      };
    }
    void request.current.promise
      .then((value) => {
        if (cancelled) return value;
        if ('status' in value) setMessage('この授業回には現在練習できる問題がありません。');
        else if (value.problemFormat === 'regular') setDisplay(value);
        return value;
      })
      .catch(() => {
        if (!cancelled) setMessage('問題を取得できませんでした。');
      });
    return () => {
      cancelled = true;
    };
  }, [courseId, lectureId, generation, start]);

  const detectStale = async <T,>(promise: Promise<T>): Promise<T> => {
    try {
      return await promise;
    } catch (error) {
      if (isChallengeSessionStale(error)) setStale(true);
      throw error;
    }
  };

  if (stale)
    return (
      <ReloadNotice
        title="問題の進み具合が画面と一致しません"
        message="学習期間が切り替わったか、別の画面で問題が進みました。ページを再読み込みして続きから解いてください。"
      />
    );
  return (
    <VStack align="stretch" spacing={4}>
      {display ? (
        <RegularExerciseBody
          mode="practice"
          courseId={courseId}
          lectureId={lectureId}
          display={display}
          back={back}
          transport={{
            submit: async (input) => await detectStale(submit.mutateAsync({ ...input, ...location })),
            switchToStep: async ({ sessionId }) =>
              await detectStale(switchToStep.mutateAsync({ ...location, sessionId })),
            next: async ({ sessionId }) => {
              const value = await detectStale(next.mutateAsync({ ...location, sessionId, problemFormat: 'regular' }));
              if ('status' in value || value.problemFormat !== 'regular')
                throw new Error('次の問題を取得できませんでした。');
              return value;
            },
          }}
        />
      ) : message ? (
        <>
          <Text role="alert">{message}</Text>
          <Button alignSelf="start" onClick={back}>
            授業回に戻る
          </Button>
          <Button
            onClick={() => {
              setMessage('');
              setGeneration((value) => value + 1);
            }}
          >
            再試行
          </Button>
        </>
      ) : (
        <Spinner label="問題を準備しています" />
      )}
    </VStack>
  );
};
