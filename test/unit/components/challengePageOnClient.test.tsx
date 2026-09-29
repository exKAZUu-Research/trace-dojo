// @vitest-environment jsdom

import { ChakraProvider } from '@chakra-ui/react';
import { StrictMode } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';

const transport = vi.hoisted(() => ({
  start: vi.fn(),
  next: vi.fn(),
  submitBlank: vi.fn(),
  submitRegular: vi.fn(),
  switchRegular: vi.fn(),
}));
const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useParams: () => ({ courseId: 'test', lectureId: 'lecture-1' }),
  useRouter: () => navigation,
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
const regularDisplay = {
  problemFormat: 'regular' as const,
  sessionId: 17,
  problemId: 'test3',
  seed: 'component',
  problemType: 'executionResult' as const,
  traceItemIndex: 0,
  completed: false,
};
const page = (initialFormat?: 'regular' | 'fillInBlank', strict = false): React.ReactNode => (
  <ChakraProvider>
    {strict ? (
      <StrictMode>
        <ChallengePageOnClient initialFormat={initialFormat} />
      </StrictMode>
    ) : (
      <ChallengePageOnClient initialFormat={initialFormat} />
    )}
  </ChakraProvider>
);
const renderPage = (initialFormat?: 'regular' | 'fillInBlank', strict = false): ReturnType<typeof render> =>
  render(page(initialFormat, strict));

beforeEach(() => vi.clearAllMocks());

test('a valid URL format starts exactly once under StrictMode and renders the exercise', async () => {
  transport.start.mockResolvedValue(blankDisplay);
  renderPage('fillInBlank', true);
  expect(await screen.findByRole('textbox', { name: '空欄【1】' })).toBeVisible();
  expect(transport.start).toHaveBeenCalledTimes(1);
  expect(transport.start).toHaveBeenCalledWith({
    courseId: 'test',
    lectureId: 'lecture-1',
    problemFormat: 'fillInBlank',
  });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('a regular URL format starts once and renders the regular exercise', async () => {
  transport.start.mockResolvedValue(regularDisplay);
  renderPage('regular');
  const inputs = await screen.findAllByRole('textbox');
  expect(inputs.length).toBeGreaterThan(0);
  expect(transport.start).toHaveBeenCalledTimes(1);
  expect(transport.start).toHaveBeenCalledWith({
    courseId: 'test',
    lectureId: 'lecture-1',
    problemFormat: 'regular',
  });
});

test('a browser format change starts the new format and ignores the stale previous response', async () => {
  let resolveRegular!: (display: typeof regularDisplay) => void;
  transport.start
    .mockReturnValueOnce(new Promise((resolve) => (resolveRegular = resolve)))
    .mockResolvedValueOnce(blankDisplay);
  const rendered = renderPage('regular');
  await waitFor(() => expect(transport.start).toHaveBeenCalledTimes(1));

  rendered.rerender(page('fillInBlank'));

  expect(await screen.findByRole('textbox', { name: '空欄【1】' })).toBeVisible();
  expect(transport.start).toHaveBeenNthCalledWith(2, {
    courseId: 'test',
    lectureId: 'lecture-1',
    problemFormat: 'fillInBlank',
  });
  await act(async () => resolveRegular(regularDisplay));
  expect(screen.getByRole('textbox', { name: '空欄【1】' })).toBeVisible();
});

test('returning to the same valid format after a missing format starts a fresh request', async () => {
  transport.start.mockResolvedValueOnce(regularDisplay).mockResolvedValueOnce({ ...regularDisplay, sessionId: 18 });
  const rendered = renderPage('regular');
  const inputs = await screen.findAllByRole('textbox');
  expect(inputs.length).toBeGreaterThan(0);

  rendered.rerender(page());
  const dialog = await screen.findByRole('dialog', { name: 'チャレンジ形式を選択' });
  await waitFor(() => expect(dialog).toBeVisible());
  rendered.rerender(page('regular'));

  await waitFor(() => expect(transport.start).toHaveBeenCalledTimes(2));
  expect(transport.start).toHaveBeenNthCalledWith(2, {
    courseId: 'test',
    lectureId: 'lecture-1',
    problemFormat: 'regular',
  });
});

test('removing the URL format clears the exercise and opens the selector without another start', async () => {
  transport.start.mockResolvedValue(regularDisplay);
  const rendered = renderPage('regular');
  const inputs = await screen.findAllByRole('textbox');
  expect(inputs.length).toBeGreaterThan(0);

  rendered.rerender(page());

  const dialog = await screen.findByRole('dialog', { name: 'チャレンジ形式を選択' });
  await waitFor(() => expect(dialog).toBeVisible());
  expect(screen.queryAllByRole('textbox')).toHaveLength(0);
  expect(transport.start).toHaveBeenCalledTimes(1);
});

test('a URL prop update after selecting a format does not duplicate the start request', async () => {
  let resolveBlank!: (display: typeof blankDisplay) => void;
  transport.start.mockReturnValue(new Promise((resolve) => (resolveBlank = resolve)));
  const user = userEvent.setup();
  const rendered = renderPage();
  await user.click(screen.getByRole('button', { name: /穴埋め問題/ }));
  await waitFor(() => expect(transport.start).toHaveBeenCalledTimes(1));

  rendered.rerender(page('fillInBlank'));
  await act(async () => resolveBlank(blankDisplay));

  expect(transport.start).toHaveBeenCalledTimes(1);
  expect(await screen.findByRole('textbox', { name: '空欄【1】' })).toBeVisible();
});

test('a missing format opens the selector without starting and close returns to the lecture', async () => {
  const user = userEvent.setup();
  renderPage();
  const dialog = await screen.findByRole('dialog', { name: 'チャレンジ形式を選択' });
  await waitFor(() => expect(dialog).toBeVisible());
  expect(transport.start).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: /閉じる/ }));
  expect(navigation.push).toHaveBeenCalledWith('/courses/test/lectures/lecture-1');
});

test('no-problems feedback stays inside the modal and the same format can be retried', async () => {
  transport.start.mockResolvedValueOnce({ status: 'noProblems' }).mockResolvedValueOnce(blankDisplay);
  const user = userEvent.setup();
  renderPage('fillInBlank');
  const status = await screen.findByRole('status');
  expect(screen.getByRole('dialog')).toContainElement(status);
  expect(status).toHaveTextContent(/穴埋め問題.*出題できません/);
  await user.click(screen.getByRole('button', { name: /穴埋め問題/ }));
  expect(await screen.findByRole('textbox', { name: '空欄【1】' })).toBeVisible();
  expect(transport.start).toHaveBeenCalledTimes(2);
});

test('an empty regular format can recover by choosing fill-in-blank', async () => {
  transport.start.mockResolvedValueOnce({ status: 'noProblems' }).mockResolvedValueOnce(blankDisplay);
  const user = userEvent.setup();
  renderPage('regular');
  expect(await screen.findByRole('status')).toHaveTextContent(/実行結果・ステップ実行.*出題できません/);
  await user.click(screen.getByRole('button', { name: /穴埋め問題/ }));
  expect(await screen.findByRole('textbox', { name: '空欄【1】' })).toBeVisible();
  expect(transport.start).toHaveBeenNthCalledWith(2, {
    courseId: 'test',
    lectureId: 'lecture-1',
    problemFormat: 'fillInBlank',
  });
});

test('completed fill-in-blank next keeps the active format and renders the returned exercise', async () => {
  transport.start.mockResolvedValue({ ...blankDisplay, completed: true });
  transport.next.mockResolvedValue({ ...blankDisplay, sessionId: 24 });
  const user = userEvent.setup();
  renderPage('fillInBlank');
  await user.click(await screen.findByRole('button', { name: '次の問題へ' }));
  expect(transport.next).toHaveBeenCalledWith({
    courseId: 'test',
    lectureId: 'lecture-1',
    sessionId: 23,
    problemFormat: 'fillInBlank',
  });
  expect(await screen.findByRole('textbox', { name: '空欄【1】' })).toBeVisible();
});

test('completed fill-in-blank back returns to the lecture', async () => {
  transport.start.mockResolvedValue({ ...blankDisplay, completed: true });
  const user = userEvent.setup();
  renderPage('fillInBlank');
  await user.click(await screen.findByRole('button', { name: '戻る' }));
  expect(navigation.push).toHaveBeenCalledWith('/courses/test/lectures/lecture-1');
});

test('an error stays inside the modal and choosing the other format updates the URL and retries', async () => {
  transport.start.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(blankDisplay);
  const user = userEvent.setup();
  renderPage('regular');
  const alert = await screen.findByRole('alert');
  expect(screen.getByRole('dialog')).toContainElement(alert);
  expect(alert).toHaveTextContent('問題を取得できませんでした。');
  await user.click(screen.getByRole('button', { name: /穴埋め問題/ }));
  expect(navigation.push).toHaveBeenCalledWith('/courses/test/lectures/lecture-1/challenge?format=fillInBlank');
  expect(await screen.findByRole('textbox', { name: '空欄【1】' })).toBeVisible();
  expect(transport.start).toHaveBeenNthCalledWith(2, {
    courseId: 'test',
    lectureId: 'lecture-1',
    problemFormat: 'fillInBlank',
  });
});

test('suppresses rapid competing selections while a start is pending', async () => {
  let resolve!: (display: typeof blankDisplay) => void;
  transport.start.mockReturnValue(new Promise((_resolve) => (resolve = _resolve)));
  const user = userEvent.setup();
  renderPage();
  await user.click(screen.getByRole('button', { name: /実行結果・ステップ実行/ }));
  await user.click(screen.getByRole('button', { name: /穴埋め問題/ }));
  expect(transport.start).toHaveBeenCalledTimes(1);
  expect(navigation.push).toHaveBeenCalledTimes(1);
  resolve(blankDisplay);
});

test('ignores a deferred result after close', async () => {
  let resolve!: (display: typeof blankDisplay) => void;
  transport.start.mockReturnValue(new Promise((_resolve) => (resolve = _resolve)));
  const user = userEvent.setup();
  renderPage();
  await user.click(screen.getByRole('button', { name: /穴埋め問題/ }));
  await user.click(screen.getByRole('button', { name: /閉じる/ }));
  await act(async () => resolve(blankDisplay));
  await waitFor(() => expect(navigation.push).toHaveBeenCalledWith('/courses/test/lectures/lecture-1'));
  expect(screen.queryByRole('textbox', { name: '空欄【1】' })).not.toBeInTheDocument();
});

test('ignores a deferred result after unmount without a state-update warning', async () => {
  let resolve!: (display: typeof blankDisplay) => void;
  transport.start.mockReturnValue(new Promise((_resolve) => (resolve = _resolve)));
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  const rendered = renderPage('fillInBlank');
  await waitFor(() => expect(transport.start).toHaveBeenCalledTimes(1));
  rendered.unmount();
  await act(async () => resolve(blankDisplay));
  expect(consoleError).not.toHaveBeenCalled();
  consoleError.mockRestore();
});
