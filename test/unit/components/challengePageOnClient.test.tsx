// @vitest-environment jsdom

import { ChakraProvider } from '@chakra-ui/react';
import { StrictMode } from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
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
  useParams: () => ({ courseId: 'test', lectureId: '8d692b48-8c19-4679-8d8f-3f27a051d44d' }),
  useRouter: () => navigation,
}));
vi.mock('../../../src/infrastructures/trpcBackend/client', () => ({
  backendTrpcReact: {
    startExercise: { useMutation: () => ({ mutateAsync: transport.start }) },
    nextExercise: { useMutation: () => ({ mutateAsync: transport.next }) },
    submitExercise: { useMutation: () => ({ mutateAsync: transport.submitBlank }) },
    submitRegularExercise: { useMutation: () => ({ mutateAsync: transport.submitRegular }) },
    switchRegularExerciseToStep: { useMutation: () => ({ mutateAsync: transport.switchRegular }) },
  },
}));

import { ChallengePageOnClient } from '../../../src/app/(withAuth)/courses/[courseId]/lectures/[lectureId]/challenge/pageOnClient';

const blankDisplay = {
  problemFormat: 'fillInBlank' as const,
  sessionId: 23,
  problemId: 'fillInBlank2',
  displayProgram: 'class Main { int x = 【1】; }',
  blankCount: 1,
  finalBoard: '.......\n.......\n.......\n.......\n.......\n.......\n.......',
  finalTurtles: [],
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
    lectureId: '8d692b48-8c19-4679-8d8f-3f27a051d44d',
    problemFormat: 'fillInBlank',
  });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('a URL format shows a loading indicator until the first exercise arrives', async () => {
  let resolve!: (display: typeof blankDisplay) => void;
  transport.start.mockReturnValue(new Promise((_resolve) => (resolve = _resolve)));
  renderPage('fillInBlank');
  expect(await screen.findByText('問題を準備しています')).toBeInTheDocument();
  await act(async () => resolve(blankDisplay));
  expect(await screen.findByRole('textbox', { name: '空欄【1】' })).toBeVisible();
  expect(screen.queryByText('問題を準備しています')).not.toBeInTheDocument();
});

test('a regular URL format starts once and renders the regular exercise', async () => {
  transport.start.mockResolvedValue(regularDisplay);
  renderPage('regular');
  await screen.findAllByRole('textbox');
  expect(transport.start).toHaveBeenCalledTimes(1);
  expect(transport.start).toHaveBeenCalledWith({
    courseId: 'test',
    lectureId: '8d692b48-8c19-4679-8d8f-3f27a051d44d',
    problemFormat: 'regular',
  });
  expect(screen.getByRole('link', { name: '動作確認用' })).toBeVisible();
  expect(screen.getByRole('link', { name: '第1回' })).toBeVisible();
  expect(screen.getByRole('heading', { level: 1, name: 'ステップ実行のテスト用問題(3)' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'ステップ実行モードに移る' })).toBeVisible();
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
    lectureId: '8d692b48-8c19-4679-8d8f-3f27a051d44d',
    problemFormat: 'fillInBlank',
  });
  await act(async () => resolveRegular(regularDisplay));
  expect(screen.getByRole('textbox', { name: '空欄【1】' })).toBeVisible();
});

test('returning to the same valid format after a missing format drops the old exercise and starts a fresh request', async () => {
  let resolveSecond!: (display: typeof regularDisplay) => void;
  transport.start
    .mockResolvedValueOnce(regularDisplay)
    .mockReturnValueOnce(new Promise((resolve) => (resolveSecond = resolve)));
  const rendered = renderPage('regular');
  await screen.findAllByRole('textbox');

  rendered.rerender(page());
  const dialog = await screen.findByRole('dialog', { name: 'チャレンジ形式を選択' });
  await waitFor(() => expect(dialog).toBeVisible());
  rendered.rerender(page('regular'));

  await waitFor(() => expect(transport.start).toHaveBeenCalledTimes(2));
  expect(rendered.container.querySelectorAll('input')).toHaveLength(0);
  await act(async () => resolveSecond({ ...regularDisplay, sessionId: 18 }));
  expect(rendered.container.querySelectorAll('input').length).toBeGreaterThan(0);
  expect(transport.start).toHaveBeenNthCalledWith(2, {
    courseId: 'test',
    lectureId: '8d692b48-8c19-4679-8d8f-3f27a051d44d',
    problemFormat: 'regular',
  });
});

test('removing the URL format hides the exercise and opens the selector without another start', async () => {
  transport.start.mockResolvedValue(regularDisplay);
  const rendered = renderPage('regular');
  await screen.findAllByRole('textbox');

  rendered.rerender(page());

  const dialog = await screen.findByRole('dialog', { name: 'チャレンジ形式を選択' });
  await waitFor(() => expect(dialog).toBeVisible());
  expect(rendered.container.querySelectorAll('input')).toHaveLength(0);
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
  expect(navigation.push).toHaveBeenCalledWith('/courses/test/lectures/8d692b48-8c19-4679-8d8f-3f27a051d44d');
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
  expect(await screen.findByRole('status')).toHaveTextContent(/通常問題.*出題できません/);
  await user.click(screen.getByRole('button', { name: /穴埋め問題/ }));
  expect(await screen.findByRole('textbox', { name: '空欄【1】' })).toBeVisible();
  expect(transport.start).toHaveBeenNthCalledWith(2, {
    courseId: 'test',
    lectureId: '8d692b48-8c19-4679-8d8f-3f27a051d44d',
    problemFormat: 'fillInBlank',
  });
});

test('a regular submission refused on a stale session state replaces the exercise with a reload notice', async () => {
  transport.start.mockResolvedValue(regularDisplay);
  transport.submitRegular.mockRejectedValue({ data: { code: 'CONFLICT' } });
  const user = userEvent.setup();
  renderPage('regular');
  const inputs = await screen.findAllByRole('textbox');
  for (const [input, value] of inputs.map((input, index) => [input, ['2', '2', '4'][index]] as const)) {
    await user.type(input, value);
  }
  await user.click(screen.getByRole('button', { name: /提出/ }));
  expect(await screen.findByRole('button', { name: 'ページを再読み込み' })).toBeVisible();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
}, 15_000);

test('a fill-in-blank submission in an expired learning period shows a reload notice instead of a retry', async () => {
  transport.start.mockResolvedValue(blankDisplay);
  transport.submitBlank.mockRejectedValue({ data: { code: 'NOT_FOUND' } });
  const user = userEvent.setup();
  renderPage('fillInBlank');
  await user.type(await screen.findByRole('textbox', { name: '空欄【1】' }), 'x + 1');
  await user.click(screen.getByRole('button', { name: /提出/ }));
  expect(await screen.findByRole('button', { name: 'ページを再読み込み' })).toBeVisible();
  expect(screen.queryByText(/もう一度提出してください/)).not.toBeInTheDocument();
});

test('completed fill-in-blank next keeps the active format and renders the returned exercise', async () => {
  transport.start.mockResolvedValue({ ...blankDisplay, completed: true });
  transport.next.mockResolvedValue({ ...blankDisplay, sessionId: 24 });
  const user = userEvent.setup();
  renderPage('fillInBlank');
  const input = await screen.findByRole('textbox', { hidden: true, name: '空欄【1】' });
  expect(input).toBeDisabled();
  expect(screen.getByText(/プログラムを実行した後の盤面/)).toBeVisible();
  await user.keyboard('{Escape}');
  expect(screen.getByRole('alertdialog')).toBeVisible();
  await user.click(screen.getByRole('button', { name: '次の問題へ' }));
  expect(transport.next).toHaveBeenCalledWith({
    courseId: 'test',
    lectureId: '8d692b48-8c19-4679-8d8f-3f27a051d44d',
    sessionId: 23,
    problemFormat: 'fillInBlank',
  });
  expect(await screen.findByRole('textbox', { name: '空欄【1】' })).toBeEnabled();
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
});

test('a just-completed fill-in-blank keeps its answer, deduplicates Next, and resets for the fresh session', async () => {
  let resolveNext!: (display: typeof blankDisplay) => void;
  transport.start.mockResolvedValue(blankDisplay);
  transport.submitBlank.mockResolvedValue({ status: 'correct' });
  transport.next.mockReturnValue(new Promise((resolve) => (resolveNext = resolve)));
  const user = userEvent.setup();
  renderPage('fillInBlank');
  const input = await screen.findByRole('textbox', { name: '空欄【1】' });
  await user.type(input, 'x + 1');
  await user.click(screen.getByRole('button', { name: '提出' }));
  const dialog = await screen.findByRole('alertdialog');
  expect(input).toHaveValue('x + 1');
  expect(screen.getByRole('button', { hidden: true, name: '提出' })).toBeDisabled();
  await user.keyboard('{Escape}');
  expect(dialog).toBeInTheDocument();

  await user.dblClick(screen.getByRole('button', { name: '次の問題へ' }));
  expect(transport.next).toHaveBeenCalledTimes(1);
  expect(transport.next).toHaveBeenCalledWith({
    courseId: 'test',
    lectureId: '8d692b48-8c19-4679-8d8f-3f27a051d44d',
    sessionId: 23,
    problemFormat: 'fillInBlank',
  });
  await act(async () => resolveNext({ ...blankDisplay, sessionId: 24 }));
  const freshInput = await screen.findByRole('textbox', { name: '空欄【1】' });
  expect(freshInput).toBeEnabled();
  expect(freshInput).toHaveValue('');
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
});

test('completed fill-in-blank orders Back before Next and reports a failed action without dismissing', async () => {
  transport.start.mockResolvedValue({ ...blankDisplay, completed: true });
  transport.next.mockRejectedValue(new Error('Invalid challenge problem: fillInBlank2'));
  const user = userEvent.setup();
  renderPage('fillInBlank');
  const dialog = await screen.findByRole('alertdialog');
  expect(
    within(dialog)
      .getAllByRole('button')
      .map((button) => button.textContent)
  ).toEqual(['終わる', '次の問題へ']);
  await user.click(screen.getByRole('button', { name: '次の問題へ' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('次の問題を取得できませんでした。');
  expect(dialog).not.toHaveTextContent('Invalid challenge problem');
  expect(dialog).toBeVisible();
});

test('completed fill-in-blank back returns to the lecture', async () => {
  transport.start.mockResolvedValue({ ...blankDisplay, completed: true });
  const user = userEvent.setup();
  renderPage('fillInBlank');
  await user.click(await screen.findByRole('button', { name: '終わる' }));
  expect(navigation.push).toHaveBeenCalledWith('/courses/test/lectures/8d692b48-8c19-4679-8d8f-3f27a051d44d');
});

test('an error stays inside the modal and choosing the other format updates the URL and retries', async () => {
  transport.start.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(blankDisplay);
  const user = userEvent.setup();
  renderPage('regular');
  const alert = await screen.findByRole('alert');
  expect(screen.getByRole('dialog')).toContainElement(alert);
  expect(alert).toHaveTextContent('問題を取得できませんでした。');
  await user.click(screen.getByRole('button', { name: /穴埋め問題/ }));
  expect(navigation.push).toHaveBeenCalledWith(
    '/courses/test/lectures/8d692b48-8c19-4679-8d8f-3f27a051d44d/challenge?format=fillInBlank'
  );
  expect(await screen.findByRole('textbox', { name: '空欄【1】' })).toBeVisible();
  expect(transport.start).toHaveBeenNthCalledWith(2, {
    courseId: 'test',
    lectureId: '8d692b48-8c19-4679-8d8f-3f27a051d44d',
    problemFormat: 'fillInBlank',
  });
});

test('disables the format choices while a start is pending so a second selection cannot fire', async () => {
  let resolve!: (display: typeof blankDisplay) => void;
  transport.start.mockReturnValue(new Promise((_resolve) => (resolve = _resolve)));
  const user = userEvent.setup();
  renderPage();
  await user.click(screen.getByRole('button', { name: /通常問題/ }));
  expect(screen.getByRole('button', { name: /通常問題/ })).toBeDisabled();
  expect(screen.getByRole('button', { name: /穴埋め問題/ })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: /穴埋め問題/ }));
  expect(transport.start).toHaveBeenCalledTimes(1);
  expect(navigation.push).toHaveBeenCalledTimes(1);
  await act(async () => resolve(blankDisplay));
});

test('a deferred result from before close does not replace the exercise started afterwards', async () => {
  let resolve!: (display: typeof blankDisplay) => void;
  transport.start
    .mockReturnValueOnce(new Promise((_resolve) => (resolve = _resolve)))
    .mockResolvedValueOnce({ ...blankDisplay, sessionId: 99, problemId: 'fillInBlank3' });
  const user = userEvent.setup();
  const rendered = renderPage();
  await user.click(screen.getByRole('button', { name: /穴埋め問題/ }));
  await user.click(screen.getByRole('button', { name: /閉じる/ }));
  expect(navigation.push).toHaveBeenCalledWith('/courses/test/lectures/8d692b48-8c19-4679-8d8f-3f27a051d44d');
  rendered.rerender(page('fillInBlank'));
  expect(await screen.findByRole('heading', { level: 1, name: '穴埋めのテスト用問題(3)' })).toBeVisible();
  await act(async () => resolve(blankDisplay));
  expect(screen.getByRole('heading', { level: 1, name: '穴埋めのテスト用問題(3)' })).toBeVisible();
  expect(transport.start).toHaveBeenCalledTimes(2);
});
