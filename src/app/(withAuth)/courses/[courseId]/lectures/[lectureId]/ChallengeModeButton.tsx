'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { ChallengeSelectionModal } from './challenge/ChallengeSelectionModal';
import type { ChallengeProblemFormat } from './challenge/ChallengeSelection';
import { Button } from '@/infrastructures/useClient/chakra';

interface ChallengeModeButtonProps {
  courseId: string;
  lectureId: string;
}

export const ChallengeModeButton: React.FC<ChallengeModeButtonProps> = ({ courseId, lectureId }) => {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [isPending, setIsPending] = useState(false);
  const pendingRef = useRef(false);

  const select = (format: ChallengeProblemFormat): void => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setIsPending(true);
    router.push(`/courses/${courseId}/lectures/${lectureId}/challenge?format=${format}`);
  };

  return (
    <>
      <Button alignSelf="start" colorScheme="brand" onClick={() => setIsOpen(true)}>
        チャレンジモード
      </Button>
      <ChallengeSelectionModal
        isOpen={isOpen}
        isPending={isPending}
        onClose={() => {
          pendingRef.current = false;
          setIsOpen(false);
          setIsPending(false);
        }}
        onSelect={select}
      />
    </>
  );
};
