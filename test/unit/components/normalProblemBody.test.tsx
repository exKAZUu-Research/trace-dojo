// @vitest-environment jsdom

import { ChakraProvider } from '@chakra-ui/react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

const count = vi.hoisted(() => ({ value: 0 }));
const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useParams: () => ({ courseId: 'test', lectureId: 'test', problemId: 'test3' }),
  useRouter: () => navigation,
}));
vi.mock('../../../src/contexts/AuthContext', () => ({ useAuthContextSelector: () => false }));
vi.mock('../../../src/infrastructures/trpcBackend/client', () => ({
  backendTrpcReact: {
    countIncorrectSubmissions: {
      useQuery: () => ({ refetch: async () => ({ data: count.value++ }) }),
    },
  },
}));

import { ProblemBody } from '../../../src/app/(withAuth)/courses/[courseId]/lectures/[lectureId]/problems/[problemId]/ProblmBody';
import { instantiateProblem } from '../../../src/problems/instantiateProblem';

test('keeps the normal three-wrong automatic fallback through the real editor', async () => {
  count.value = 0;
  const problem = instantiateProblem('test3', 'java', 'normal-component');
  if (!problem) throw new Error('test3 must instantiate');
  const createSubmission = vi.fn(async () => {});
  const updateSession = vi.fn(async () => {});
  const user = userEvent.setup();
  render(
    <ChakraProvider>
      <ProblemBody
        problem={problem}
        problemSession={
          {
            id: 1,
            problemType: 'executionResult',
            traceItemIndex: 0,
          } as never
        }
        createSubmissionUpdatingProblemSession={createSubmission}
        updateProblemSession={updateSession}
      />
    </ChakraProvider>
  );
  for (const input of screen.getAllByRole('textbox')) await user.type(input, '999');

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await user.click(screen.getByRole('button', { name: /提出/ }));
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('不正解');
    await user.click(screen.getByRole('button', { name: /閉じる/ }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  }
  expect(createSubmission).toHaveBeenCalledTimes(3);
  expect(createSubmission).toHaveBeenLastCalledWith(false, false);
  expect(updateSession).toHaveBeenCalledTimes(1);
  expect(updateSession).toHaveBeenCalledWith('step', 1);
}, 15_000);

test.each([
  { traceItemIndex: 1, typedValue: '1', isCompleted: false, nextIndex: 2 },
  { traceItemIndex: 5, typedValue: '4', isCompleted: true, nextIndex: undefined },
])(
  'keeps normal correct step $traceItemIndex advance/completion through the real editor',
  async ({ traceItemIndex, typedValue, isCompleted, nextIndex }) => {
    const problem = instantiateProblem('test3', 'java', 'normal-component');
    if (!problem) throw new Error('test3 must instantiate');
    const createSubmission = vi.fn(async () => {});
    const updateSession = vi.fn(async () => {});
    const user = userEvent.setup();
    render(
      <ChakraProvider>
        <ProblemBody
          problem={problem}
          problemSession={{ id: 2, problemType: 'step', traceItemIndex } as never}
          createSubmissionUpdatingProblemSession={createSubmission}
          updateProblemSession={updateSession}
        />
      </ChakraProvider>
    );
    const inputs = screen.getAllByRole('textbox');
    await user.type(inputs.at(-1)!, typedValue);
    await user.click(screen.getByRole('button', { name: /提出/ }));
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('正解です');
    expect(createSubmission).toHaveBeenCalledWith(true, isCompleted);
    if (nextIndex === undefined) expect(updateSession).not.toHaveBeenCalled();
    else expect(updateSession).toHaveBeenCalledWith('step', nextIndex);
    await user.click(screen.getByRole('button', { name: /閉じる/ }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  }
);

test('renders the normal step instruction with concrete current and previous line references', () => {
  const problem = instantiateProblem('test3', 'java', 'normal-component');
  if (!problem) throw new Error('test3 must instantiate');
  render(
    <ChakraProvider>
      <ProblemBody
        problem={problem}
        problemSession={{ id: 3, problemType: 'step', traceItemIndex: 2 } as never}
        createSubmissionUpdatingProblemSession={vi.fn()}
        updateProblemSession={vi.fn()}
      />
    </ChakraProvider>
  );
  expect(screen.getByText('ステップ実行モード')).toBeVisible();
  expect(screen.getByText(/画面下部にある/)).toHaveTextContent(
    '画面下部にある3行目を実行した後の盤面と変数の一覧表を参考に、5行目を実行した後の盤面と、変数に記録されている値の一覧表を作成し、提出ボタンを押してください。'
  );
});

test.each([
  { traceItemIndex: 1, isVisible: false },
  { traceItemIndex: 2, isVisible: true },
])(
  'shows trace history only after a previous executable step at index $traceItemIndex',
  ({ traceItemIndex, isVisible }) => {
    const problem = instantiateProblem('test3', 'java', 'normal-component');
    if (!problem) throw new Error('test3 must instantiate');
    render(
      <ChakraProvider>
        <ProblemBody
          problem={problem}
          problemSession={{ id: 5, problemType: 'step', traceItemIndex } as never}
          createSubmissionUpdatingProblemSession={vi.fn()}
          updateProblemSession={vi.fn()}
        />
      </ChakraProvider>
    );
    const tracePrevious = screen.queryByRole('button', { name: '1ステップ前を表示' });
    if (isVisible) expect(tracePrevious).toBeVisible();
    else expect(tracePrevious).not.toBeInTheDocument();
  }
);

test('resets the close guard so Escape and a later close each finish one intermediate alert', async () => {
  navigation.push.mockClear();
  const problem = instantiateProblem('test3', 'java', 'normal-component');
  if (!problem) throw new Error('test3 must instantiate');
  const createSubmission = vi.fn(async () => {});
  const updateSession = vi.fn(async () => {});
  const user = userEvent.setup();
  const rendered = render(
    <ChakraProvider>
      <ProblemBody
        problem={problem}
        problemSession={{ id: 6, problemType: 'step', traceItemIndex: 1 } as never}
        createSubmissionUpdatingProblemSession={createSubmission}
        updateProblemSession={updateSession}
      />
    </ChakraProvider>
  );
  await user.type(screen.getByRole('textbox'), '1');
  await user.click(screen.getByRole('button', { name: /提出/ }));
  await screen.findByRole('alertdialog');
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  expect(updateSession).toHaveBeenCalledTimes(1);
  expect(navigation.push).not.toHaveBeenCalled();

  rendered.rerender(
    <ChakraProvider>
      <ProblemBody
        problem={problem}
        problemSession={{ id: 6, problemType: 'step', traceItemIndex: 2 } as never}
        createSubmissionUpdatingProblemSession={createSubmission}
        updateProblemSession={updateSession}
      />
    </ChakraProvider>
  );
  for (const input of screen.getAllByRole('textbox')) await user.type(input, '999');
  await user.click(screen.getByRole('button', { name: /提出/ }));
  await screen.findByRole('alertdialog');
  await user.click(screen.getByRole('button', { name: /閉じる/ }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  expect(createSubmission).toHaveBeenCalledTimes(2);
}, 15_000);

test('runs a completed normal post-alert action only once when close and Escape race', async () => {
  navigation.push.mockClear();
  const problem = instantiateProblem('test3', 'java', 'normal-component');
  if (!problem) throw new Error('test3 must instantiate');
  const user = userEvent.setup();
  render(
    <ChakraProvider>
      <ProblemBody
        problem={problem}
        problemSession={{ id: 4, problemType: 'step', traceItemIndex: 5 } as never}
        createSubmissionUpdatingProblemSession={vi.fn()}
        updateProblemSession={vi.fn()}
      />
    </ChakraProvider>
  );
  await user.type(screen.getAllByRole('textbox').at(-1)!, '4');
  await user.click(screen.getByRole('button', { name: /提出/ }));
  const close = await screen.findByRole('button', { name: /閉じる/ });
  const dialog = screen.getByRole('alertdialog');
  // One act batch keeps the dialog open for both closers, so only the dialog's close guard can stop the second one.
  act(() => {
    fireEvent.keyDown(dialog, { key: 'Escape' });
    fireEvent.click(close);
  });
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  expect(navigation.push).toHaveBeenCalledTimes(1);
});
