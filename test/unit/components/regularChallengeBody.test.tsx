// @vitest-environment jsdom

import { ChakraProvider } from '@chakra-ui/react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

import {
  RegularChallengeBody,
  type RegularChallengeDisplay,
  type RegularChallengeTransport,
} from '../../../src/app/(withAuth)/courses/[courseId]/lectures/[lectureId]/challenge/RegularChallengeBody';

const executionDisplay: RegularChallengeDisplay = {
  problemFormat: 'regular',
  sessionId: 17,
  problemId: 'test3',
  seed: 'component',
  problemType: 'executionResult',
  traceItemIndex: 0,
  completed: false,
};

test('uses the real editor local grader and sends only verdict with stored context', async () => {
  const user = userEvent.setup();
  const submit = vi.fn<RegularChallengeTransport['submit']>().mockImplementation(async (input) => ({
    exercise: executionDisplay,
    status: input.isCorrect ? 'correct' : 'incorrect',
  }));
  renderBody({ submit });

  const inputs = screen.getAllByRole('textbox');
  for (const [input, value] of inputs.map((input, index) => [input, ['2', '2', '4'][index]] as const)) {
    await user.type(input, value);
  }
  await user.click(screen.getByRole('button', { name: /提出/ }));

  await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  const payload = submit.mock.calls[0][0];
  expect(payload).toMatchObject({
    sessionId: 17,
    context: { problemType: 'executionResult', traceItemIndex: 0 },
    requestId: expect.any(String),
    isCorrect: true,
  });
  expect(payload).not.toHaveProperty('answers');
  expect(payload).not.toHaveProperty('board');
  expect(payload).not.toHaveProperty('turtles');
  expect(payload).not.toHaveProperty('variables');
});

test('keeps an incorrect draft mounted across repeated attempts and never switches automatically', async () => {
  const user = userEvent.setup();
  const submit = vi
    .fn<RegularChallengeTransport['submit']>()
    .mockResolvedValue({ exercise: executionDisplay, status: 'incorrect' });
  const switchToStep = vi.fn();
  renderBody({ submit, switchToStep });
  const inputs = screen.getAllByRole('textbox');
  await user.type(inputs[0], '999');
  await user.type(inputs[1], '2');
  await user.type(inputs[2], '4');
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await user.click(screen.getByRole('button', { name: /提出/ }));
    await screen.findByRole('alertdialog');
    await user.click(screen.getByRole('button', { name: /閉じる|もう一度/ }));
  }
  expect(inputs[0]).toHaveValue('999');
  expect(inputs[1]).toHaveValue('2');
  expect(inputs[2]).toHaveValue('4');
  expect(submit).toHaveBeenCalledTimes(4);
  expect(switchToStep).not.toHaveBeenCalled();
  expect(submit.mock.calls.every(([input]) => input.isCorrect === false)).toBe(true);
});

test('preserves the draft on switch cancel or failure and resets only after success', async () => {
  const user = userEvent.setup();
  const stepDisplay = { ...executionDisplay, problemType: 'step' as const, traceItemIndex: 1 };
  const switchToStep = vi
    .fn<RegularChallengeTransport['switchToStep']>()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(stepDisplay);
  renderBody({ switchToStep });
  const input = screen.getAllByRole('textbox')[0];
  await user.type(input, 'draft');

  await user.click(screen.getByRole('button', { name: /ステップ実行/ }));
  expect(screen.getByRole('alertdialog')).toHaveTextContent(/下書き.*リセット|リセット.*下書き/);
  await user.click(screen.getByRole('button', { name: /キャンセル/ }));
  expect(input).toHaveValue('draft');

  await user.click(screen.getByRole('button', { name: /ステップ実行/ }));
  await user.click(screen.getByRole('button', { name: /切り替/ }));
  await screen.findByRole('alert');
  expect(input).toHaveValue('draft');

  await user.click(screen.getByRole('button', { name: /ステップ実行/ }));
  await user.click(screen.getByRole('button', { name: /切り替/ }));
  expect(await screen.findByText(/ステップ実行モード/)).toBeVisible();
  expect(screen.getAllByRole('textbox')[0]).not.toHaveValue('draft');
});

test('shows completion actions and delegates Next and lecture Back', async () => {
  const user = userEvent.setup();
  const next = vi.fn(async () => executionDisplay);
  const back = vi.fn();
  const { unmount } = renderBody({ display: { ...executionDisplay, completed: true }, next, back });
  await user.click(screen.getByRole('button', { name: /次の問題/ }));
  expect(next).toHaveBeenCalledWith({ sessionId: 17, problemFormat: 'regular' });
  await waitFor(() => expect(screen.queryByRole('button', { name: /次の問題/ })).not.toBeInTheDocument());
  expect(screen.getByRole('button', { name: /提出/ })).toBeVisible();

  unmount();
  renderBody({ display: { ...executionDisplay, completed: true }, next, back });
  await user.click(screen.getByRole('button', { name: /戻る/ }));
  expect(back).toHaveBeenCalledTimes(1);
});

test('locally grades a correct non-final step and resets to the authoritative next step', async () => {
  const user = userEvent.setup();
  const stepOne = { ...executionDisplay, problemType: 'step' as const, traceItemIndex: 1 };
  const stepTwo = { ...stepOne, traceItemIndex: 2 };
  const submit = vi
    .fn<RegularChallengeTransport['submit']>()
    .mockResolvedValue({ exercise: stepTwo, status: 'correct' });
  renderBody({ display: stepOne, submit });
  await user.type(screen.getByRole('textbox'), '1');
  await user.click(screen.getByRole('button', { name: /提出/ }));
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  expect(submit.mock.calls[0][0]).toMatchObject({
    context: { problemType: 'step', traceItemIndex: 1 },
    isCorrect: true,
  });
  await user.click(await screen.findByRole('button', { name: /閉じる|次/ }));
  expect(await screen.findByText(/ステップ実行モード/)).toBeVisible();
  expect(screen.getAllByRole('textbox')).toHaveLength(2);
});

test('locally grades the final step and exposes completion actions', async () => {
  const user = userEvent.setup();
  const finalStep = { ...executionDisplay, problemType: 'step' as const, traceItemIndex: 5 };
  const completed = { ...finalStep, completed: true };
  const submit = vi
    .fn<RegularChallengeTransport['submit']>()
    .mockResolvedValue({ exercise: completed, status: 'correct' });
  renderBody({ display: finalStep, submit });
  const inputs = screen.getAllByRole('textbox');
  expect(inputs).toHaveLength(3);
  await user.type(inputs[2], '4');
  await user.click(screen.getByRole('button', { name: /提出/ }));
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  expect(submit.mock.calls[0][0]).toMatchObject({
    context: { problemType: 'step', traceItemIndex: 5 },
    isCorrect: true,
  });
  await waitFor(() => expect(screen.getByRole('button', { name: /次の問題/ })).toBeVisible());
  expect(screen.getByRole('button', { name: /戻る/ })).toBeVisible();
});

const renderBody = (
  overrides: Partial<RegularChallengeTransport> & { display?: RegularChallengeDisplay; back?: () => void }
): ReturnType<typeof render> => {
  const transport: RegularChallengeTransport = {
    submit: async () => ({ exercise: executionDisplay, status: 'incorrect' }),
    switchToStep: async () => ({ ...executionDisplay, problemType: 'step', traceItemIndex: 1 }),
    next: async () => executionDisplay,
    ...overrides,
  };
  return render(
    <ChakraProvider>
      <RegularChallengeBody
        courseId="test"
        lectureId="test"
        display={overrides.display ?? executionDisplay}
        transport={transport}
        back={overrides.back ?? (() => {})}
      />
    </ChakraProvider>
  );
};
