// @vitest-environment jsdom

import { ChakraProvider } from '@chakra-ui/react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
const startExercise = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useParams: () => ({ courseId: 'test', lectureId: 'lecture-1' }),
  useRouter: () => navigation,
}));
vi.mock('@willbooster/shared-lib-react', () => ({ useLocalStorage: () => [false, vi.fn()] }));
vi.mock('../../../src/contexts/AuthContext', () => ({ useAuthContextSelector: () => 'user-1' }));
vi.mock('../../../src/infrastructures/trpcBackend/client', () => ({
  backendTrpcReact: { startExercise: { useMutation: () => ({ mutateAsync: startExercise }) } },
}));

import { ChallengeModeButton } from '../../../src/app/(withAuth)/courses/[courseId]/lectures/[lectureId]/ChallengeModeButton';
import { ChallengeSelectionModal } from '../../../src/app/(withAuth)/courses/[courseId]/lectures/[lectureId]/challenge/ChallengeSelectionModal';
import { Lecture } from '../../../src/app/(withAuth)/courses/[courseId]/lectures/[lectureId]/pageOnClient';

const renderInChakra = (node: React.ReactNode): ReturnType<typeof render> =>
  render(<ChakraProvider>{node}</ChakraProvider>);

test('the lecture trigger opens a labelled dialog, focuses the regular native card, and Enter navigates', async () => {
  navigation.push.mockReset();
  const user = userEvent.setup();
  renderInChakra(<Lecture lectureIndex={0} problemSessions={[]} />);
  await user.click(screen.getByRole('button', { name: 'チャレンジモード' }));
  const dialog = await screen.findByRole('dialog', { name: 'チャレンジ形式を選択' });
  await waitFor(() => expect(dialog).toBeVisible());
  const regular = screen.getByRole('button', { name: /通常問題/ });
  const blank = screen.getByRole('button', { name: /穴埋め問題/ });
  await waitFor(() => expect(regular).toHaveFocus());
  expect(regular.querySelector('button')).toBeNull();
  expect(blank.querySelector('button')).toBeNull();
  await user.keyboard('{Enter}');
  expect(navigation.push).toHaveBeenCalledWith('/courses/test/lectures/lecture-1/challenge?format=regular');
});

test.each([
  [
    'close button',
    async (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole('button', { name: /閉じる/ })),
  ],
  ['Escape', async (user: ReturnType<typeof userEvent.setup>) => user.keyboard('{Escape}')],
])('%s cancels without navigation and returns focus to the lecture trigger', async (_label, close) => {
  navigation.push.mockReset();
  const user = userEvent.setup();
  renderInChakra(<ChallengeModeButton courseId="test-course" lectureId="lecture-1" />);
  const trigger = screen.getByRole('button', { name: 'チャレンジモード' });
  await user.click(trigger);
  await close(user);
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(navigation.push).not.toHaveBeenCalled();
  expect(startExercise).not.toHaveBeenCalled();
  expect(trigger).toHaveFocus();
});

test('fill-in-blank card navigates with its format', async () => {
  navigation.push.mockReset();
  const user = userEvent.setup();
  renderInChakra(<ChallengeModeButton courseId="test-course" lectureId="lecture-1" />);
  await user.click(screen.getByRole('button', { name: 'チャレンジモード' }));
  await user.click(screen.getByRole('button', { name: /穴埋め問題/ }));
  expect(navigation.push).toHaveBeenCalledWith('/courses/test-course/lectures/lecture-1/challenge?format=fillInBlank');
});

test('suppresses two format activations in the same event turn', async () => {
  navigation.push.mockReset();
  const user = userEvent.setup();
  renderInChakra(<ChallengeModeButton courseId="test-course" lectureId="lecture-1" />);
  await user.click(screen.getByRole('button', { name: 'チャレンジモード' }));
  const regular = await screen.findByRole('button', { name: /通常問題/ });
  const blank = screen.getByRole('button', { name: /穴埋め問題/ });

  fireEvent.click(regular);
  fireEvent.click(blank);

  expect(navigation.push).toHaveBeenCalledTimes(1);
  expect(navigation.push).toHaveBeenCalledWith('/courses/test-course/lectures/lecture-1/challenge?format=regular');
});

test('shows recovery feedback inside the modal while preserving both choices', async () => {
  renderInChakra(
    <ChallengeSelectionModal
      isOpen={true}
      isPending={false}
      message="問題を取得できませんでした。"
      onClose={vi.fn()}
      onSelect={vi.fn()}
    />
  );
  const dialog = await screen.findByRole('dialog');
  expect(dialog).toContainElement(screen.getByRole('alert'));
  expect(screen.getByRole('button', { name: /通常問題/ })).toBeEnabled();
  expect(screen.getByRole('button', { name: /穴埋め問題/ })).toBeEnabled();
});
