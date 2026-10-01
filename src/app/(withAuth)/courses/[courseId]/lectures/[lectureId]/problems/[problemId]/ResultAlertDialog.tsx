'use client';

import { useEffect, useRef, useState } from 'react';
import {
  AlertDialog,
  AlertDialogBody,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogOverlay,
  Box,
  Button,
  Text,
} from '@/infrastructures/useClient/chakra';

export interface CompletionAction {
  label: string;
  onClick: () => void | Promise<void>;
  colorScheme?: string;
}
type Props = { isOpen: boolean; title: string; message: string } & (
  | { onClose: () => void; actions?: never }
  | { actions: CompletionAction[]; onClose?: never }
);

export const ResultAlertDialog: React.FC<Props> = (props) => {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const closeHandledRef = useRef(false);
  const actionPendingRef = useRef(false);
  const lifecycleRef = useRef(0);
  const [pendingActionLabel, setPendingActionLabel] = useState('');
  const [actionError, setActionError] = useState('');
  const canDismiss = props.actions === undefined;

  /* oxlint-disable react/set-state-in-effect -- A reused dialog must clear action state when a new open lifecycle starts. */
  useEffect(() => {
    closeHandledRef.current = false;
    actionPendingRef.current = false;
    lifecycleRef.current += 1;
    setPendingActionLabel('');
    setActionError('');
  }, [props.isOpen]);
  /* oxlint-enable react/set-state-in-effect */

  const close = (): void => {
    if (!props.isOpen || !canDismiss || closeHandledRef.current) return;
    closeHandledRef.current = true;
    props.onClose();
  };
  const handleAction = async (action: CompletionAction): Promise<void> => {
    if (actionPendingRef.current) return;
    actionPendingRef.current = true;
    const lifecycle = lifecycleRef.current;
    setPendingActionLabel(action.label);
    setActionError('');
    try {
      await action.onClick();
    } catch (error) {
      if (lifecycleRef.current !== lifecycle) return;
      actionPendingRef.current = false;
      setPendingActionLabel('');
      setActionError(error instanceof Error ? error.message : '操作に失敗しました。もう一度お試しください。');
    }
  };

  return (
    <AlertDialog
      closeOnEsc={canDismiss}
      closeOnOverlayClick={false}
      isOpen={props.isOpen}
      leastDestructiveRef={cancelRef as React.RefObject<HTMLElement>}
      onClose={close}
    >
      <AlertDialogOverlay>
        <AlertDialogContent>
          <AlertDialogHeader fontSize="lg" fontWeight="bold">
            {props.title}
          </AlertDialogHeader>
          <AlertDialogBody whiteSpace="pre-wrap">
            {props.message}
            {actionError && (
              <Text color="red.600" mt={3} role="alert">
                {actionError}
              </Text>
            )}
          </AlertDialogBody>
          <AlertDialogFooter gap={3}>
            {props.actions ? (
              props.actions.map((action, index) => (
                <Button
                  key={action.label}
                  ref={index === 0 ? cancelRef : undefined}
                  colorScheme={action.colorScheme}
                  isDisabled={Boolean(pendingActionLabel)}
                  isLoading={pendingActionLabel === action.label}
                  onClick={() => void handleAction(action)}
                >
                  {action.label}
                </Button>
              ))
            ) : (
              <Button
                ref={cancelRef}
                rightIcon={
                  <Box as="span" fontSize="sm" fontWeight="bold">
                    (Esc)
                  </Box>
                }
                onClick={close}
              >
                閉じる
              </Button>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialogOverlay>
    </AlertDialog>
  );
};
