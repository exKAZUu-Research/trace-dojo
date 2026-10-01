'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { ChallengeSelectionModal } from './challenge/ChallengeSelectionModal';
import type { ChallengeProblemFormat } from './challenge/ChallengeSelection';
import { Button, Text, VStack } from '@/infrastructures/useClient/chakra';

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
      <VStack align="start" pt={4} spacing={1}>
        <Button colorScheme="brand" onClick={() => setIsOpen(true)}>
          チャレンジモード（任意）
        </Button>
        <Text color="gray.600" fontSize="sm">
          チャレンジモードの取り組みは成績に反映されません。
        </Text>
      </VStack>
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
