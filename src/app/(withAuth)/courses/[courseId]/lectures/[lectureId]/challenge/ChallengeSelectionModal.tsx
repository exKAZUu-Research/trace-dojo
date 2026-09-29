'use client';

import { useRef } from 'react';
import { ChallengeSelection, type ChallengeProblemFormat } from './ChallengeSelection';
import {
  Modal,
  ModalBody,
  ModalCloseButton,
  ModalContent,
  ModalHeader,
  ModalOverlay,
  Text,
} from '@/infrastructures/useClient/chakra';

interface ChallengeSelectionModalProps {
  isOpen: boolean;
  isPending: boolean;
  message?: string;
  messageRole?: 'alert' | 'status';
  onClose: () => void;
  onSelect: (format: ChallengeProblemFormat) => void | Promise<void>;
}

export const ChallengeSelectionModal: React.FC<ChallengeSelectionModalProps> = ({
  isOpen,
  isPending,
  message,
  messageRole = 'alert',
  onClose,
  onSelect,
}) => {
  const initialFocusRef = useRef<HTMLButtonElement>(null);

  return (
    <Modal initialFocusRef={initialFocusRef} isOpen={isOpen} onClose={onClose} size="xl">
      <ModalOverlay />
      <ModalContent>
        <ModalHeader>チャレンジ形式を選択</ModalHeader>
        <ModalCloseButton aria-label="閉じる" />
        <ModalBody pb={6}>
          {message && (
            <Text color={messageRole === 'alert' ? 'red.600' : undefined} mb={4} role={messageRole}>
              {message}
            </Text>
          )}
          <ChallengeSelection isPending={isPending} onSelect={onSelect} regularButtonRef={initialFocusRef} />
        </ModalBody>
      </ModalContent>
    </Modal>
  );
};
