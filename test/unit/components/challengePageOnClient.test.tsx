// @vitest-environment jsdom

import { ChakraProvider } from '@chakra-ui/react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

const transport = vi.hoisted(() => ({
  start: vi.fn(),
  next: vi.fn(),
  submitBlank: vi.fn(),
  submitRegular: vi.fn(),
  switchRegular: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useParams: () => ({ courseId: 'test', lectureId: 'test' }),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('../../../src/infrastructures/trpcBackend/client', () => ({
  backendTrpcReact: {
    startExercise: { useMutation: () => ({ mutateAsync: transport.start, isPending: false }) },
    nextExercise: { useMutation: () => ({ mutateAsync: transport.next }) },
    submitExercise: { useMutation: () => ({ mutateAsync: transport.submitBlank }) },
    submitRegularExercise: { useMutation: () => ({ mutateAsync: transport.submitRegular }) },
    switchRegularExerciseToStep: { useMutation: () => ({ mutateAsync: transport.switchRegular }) },
  },
}));

import { ChallengePageOnClient } from '../../../src/app/(withAuth)/courses/[courseId]/lectures/[lectureId]/challenge/pageOnClient';

test('keeps both format choices after one is empty and starts the other format', async () => {
  const blankDisplay = {
    sessionId: 23,
    problemId: 'fillInBlank2',
    displayProgram: 'class Main { int x = 【1】; }',
    blankCount: 1,
    expectedBoard: '.......\n.......\n.......\n.......\n.......\n.......\n.......',
    expectedTurtles: [],
    finalVars: {},
    completed: false,
  };
  transport.start.mockReset().mockResolvedValueOnce({ status: 'noProblems' }).mockResolvedValueOnce(blankDisplay);
  const user = userEvent.setup();
  render(
    <ChakraProvider>
      <ChallengePageOnClient />
    </ChakraProvider>
  );

  await user.click(screen.getByRole('button', { name: /実行結果/ }));
  expect(await screen.findByRole('status')).toHaveTextContent(/実行結果・ステップ実行.*出題できません/);
  expect(screen.getByRole('button', { name: /実行結果/ })).toBeVisible();
  expect(screen.getByRole('button', { name: /穴埋め/ })).toBeVisible();

  await user.click(screen.getByRole('button', { name: /穴埋め/ }));
  expect(transport.start).toHaveBeenNthCalledWith(1, {
    courseId: 'test',
    lectureId: 'test',
    problemFormat: 'regular',
  });
  expect(transport.start).toHaveBeenNthCalledWith(2, {
    courseId: 'test',
    lectureId: 'test',
    problemFormat: 'fillInBlank',
  });
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  expect(await screen.findByRole('textbox', { name: '空欄【1】' })).toBeVisible();
});
