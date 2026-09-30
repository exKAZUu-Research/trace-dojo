// @vitest-environment jsdom

import { ChakraProvider } from '@chakra-ui/react';
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

import { ChallengeSelection } from '../../../src/app/(withAuth)/courses/[courseId]/lectures/[lectureId]/challenge/ChallengeSelection';

test('mounts without starting, uses native buttons, and suppresses activation while pending', async () => {
  const user = userEvent.setup();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const onSelect = vi.fn<(format: 'regular' | 'fillInBlank') => Promise<void>>(async () => pending);
  const Harness: React.FC = () => {
    const [isPending, setIsPending] = useState(false);
    return (
      <ChallengeSelection
        isPending={isPending}
        onSelect={async (format) => {
          setIsPending(true);
          try {
            await onSelect(format);
          } finally {
            setIsPending(false);
          }
        }}
      />
    );
  };
  const { container } = render(
    <ChakraProvider>
      <Harness />
    </ChakraProvider>
  );

  expect(onSelect).not.toHaveBeenCalled();
  const regular = screen.getByRole('button', { name: /通常問題/ });
  const blank = screen.getByRole('button', { name: /穴埋め問題/ });
  expect(regular.querySelector('button')).toBeNull();
  expect(blank.querySelector('button')).toBeNull();
  expect(container.querySelectorAll('button')).toHaveLength(2);

  regular.focus();
  await user.keyboard('{Enter}');
  expect(onSelect).toHaveBeenCalledWith('regular');
  await user.click(screen.getByRole('button', { name: /穴埋め/ }));
  expect(onSelect).toHaveBeenCalledTimes(1);
  release();
});
