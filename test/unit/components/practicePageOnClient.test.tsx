// @vitest-environment jsdom

import { ChakraProvider } from '@chakra-ui/react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { beforeEach, expect, test, vi } from 'vitest';

const transport = vi.hoisted(() => ({
  start: vi.fn(),
  next: vi.fn(),
  submit: vi.fn(),
  switchToStep: vi.fn(),
  submitBlank: vi.fn(),
}));
const navigation = vi.hoisted(() => ({
  push: vi.fn(),
  courseId: 'test',
  lectureId: '8d692b48-8c19-4679-8d8f-3f27a051d44d',
}));
vi.mock('next/navigation', () => ({
  useParams: () => ({ courseId: navigation.courseId, lectureId: navigation.lectureId }),
  useRouter: () => navigation,
}));
vi.mock('../../../src/infrastructures/trpcBackend/client', () => ({
  backendTrpcReact: {
    submitExercise: { useMutation: () => ({ mutateAsync: transport.submitBlank }) },
    startExercise: { useMutation: () => ({ mutateAsync: transport.start }) },
    nextExercise: { useMutation: () => ({ mutateAsync: transport.next }) },
    submitRegularExercise: { useMutation: () => ({ mutateAsync: transport.submit }) },
    switchRegularExerciseToStep: { useMutation: () => ({ mutateAsync: transport.switchToStep }) },
  },
}));

import { ChallengePageOnClient } from '../../../src/app/(withAuth)/courses/[courseId]/lectures/[lectureId]/challenge/pageOnClient';
import { PracticePageOnClient } from '../../../src/app/(withAuth)/courses/[courseId]/lectures/[lectureId]/practice/pageOnClient';
import { courseIdToLectureIds } from '../../../src/problems/problemData';
import type { RegularExerciseDisplay } from '../../../src/problems/regular/exerciseProblem';

const display: RegularExerciseDisplay = {
  problemFormat: 'regular',
  sessionId: 17,
  problemId: 'practiceEasyV1TestL1ScalarUpdateV1',
  seed: 'practice-ui',
  problemType: 'executionResult',
  traceItemIndex: 0,
  completed: false,
};
const page = (): React.ReactNode => (
  <ChakraProvider>
    <StrictMode>
      <PracticePageOnClient />
    </StrictMode>
  </ChakraProvider>
);

beforeEach(() => {
  vi.resetAllMocks();
  navigation.courseId = 'test';
  navigation.lectureId = courseIdToLectureIds.test[0];
});

test('starts regular practice with the shared header first and opens syntax hints by keyboard without submitting', async () => {
  transport.start.mockResolvedValue(display);
  const user = userEvent.setup();
  const { container } = render(page());
  const heading = await screen.findByRole('heading', { level: 1, name: '値を一度更新する 1' });
  expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  expect(screen.queryByText(/課題の成績・進捗には影響しません/)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '授業回に戻る' })).not.toBeInTheDocument();
  const firstPageBlock = container.querySelector(':scope > :not(style) > :not(style)');
  expect(firstPageBlock).toContainElement(heading);
  const courseLink = screen.getByRole('link', { name: '動作確認用' });
  const lectureLink = screen.getByRole('link', { name: '第1回' });
  expect(firstPageBlock).toContainElement(courseLink);
  expect(firstPageBlock).toContainElement(lectureLink);
  expect(courseLink).toHaveAttribute('href', '/courses/test');
  expect(lectureLink).toHaveAttribute('href', `/courses/test/lectures/${navigation.lectureId}`);
  expect(transport.start).toHaveBeenCalledExactlyOnceWith({
    courseId: 'test',
    lectureId: navigation.lectureId,
    learningMode: 'practice',
    problemFormat: 'regular',
  });
  const code = container.querySelector('code');
  if (!code) throw new Error('Practice source must render');
  const hint = within(code).getAllByRole('button')[0];
  hint.focus();
  await user.keyboard('{Enter}');
  expect(await screen.findByRole('tooltip')).toBeVisible();
  expect(transport.submit).not.toHaveBeenCalled();
  await user.keyboard('{Escape}');
});

test('edits a real practice answer and retains the incorrect draft through feedback', async () => {
  transport.start.mockResolvedValue(display);
  transport.submit.mockResolvedValue(display);
  const user = userEvent.setup();
  render(page());
  const inputs = await screen.findAllByRole('textbox');
  const input = inputs[0];
  await user.type(input, '999');
  await user.click(screen.getByRole('button', { name: /提出/ }));
  expect(await screen.findByRole('alertdialog')).toHaveTextContent('不正解');
  expect(transport.submit).toHaveBeenCalledWith(
    expect.objectContaining({
      courseId: 'test',
      lectureId: navigation.lectureId,
      learningMode: 'practice',
      sessionId: 17,
      context: { problemType: 'executionResult', traceItemIndex: 0 },
      isCorrect: false,
    })
  );
  await user.click(screen.getByRole('button', { name: /閉じる|もう一度/ }));
  expect(screen.getAllByRole('textbox')[0]).toHaveValue('999');
});

test('confirms step conversion and submits an independently correct first answer through practice transport', async () => {
  navigation.courseId = 'tuBeginner2';
  navigation.lectureId = courseIdToLectureIds.tuBeginner2[5];
  const initial = { ...display, problemId: 'practiceEasyV1Beginner2L6OverloadDispatchV1' };
  const firstStep: RegularExerciseDisplay = { ...initial, problemType: 'step', traceItemIndex: 1 };
  transport.start.mockResolvedValue(initial);
  transport.submit.mockResolvedValue({ ...firstStep, traceItemIndex: 2 });
  transport.switchToStep.mockResolvedValue(firstStep);
  const user = userEvent.setup();
  render(page());
  await screen.findAllByRole('textbox');
  await user.click(screen.getByRole('button', { name: 'ステップ実行モードに移る' }));
  await user.click(screen.getByRole('button', { name: /切り替/ }));
  expect(await screen.findByText('ステップ実行モード', { exact: true })).toBeVisible();
  expect(transport.switchToStep).toHaveBeenCalledExactlyOnceWith({
    courseId: 'tuBeginner2',
    lectureId: navigation.lectureId,
    learningMode: 'practice',
    sessionId: 17,
  });
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  const stepInput = screen.getByRole('textbox');
  await user.type(stepInput, '2');
  expect(stepInput).toHaveValue('2');
  const submitStep = screen.getByRole('button', { name: /提出/ });
  await waitFor(() => expect(submitStep).toBeEnabled());
  await user.click(submitStep);
  await waitFor(() => expect(transport.submit).toHaveBeenCalledTimes(1));
  expect(transport.submit).toHaveBeenLastCalledWith(
    expect.objectContaining({
      learningMode: 'practice',
      context: { problemType: 'step', traceItemIndex: 1 },
      isCorrect: true,
    })
  );
  expect(await screen.findByRole('alertdialog')).toHaveTextContent('正解');
});

test('returns to the lecture when ending completed practice', async () => {
  transport.start.mockResolvedValue({ ...display, completed: true });
  const user = userEvent.setup();
  render(page());
  await user.click(await screen.findByRole('button', { name: '終わる' }));
  expect(navigation.push).toHaveBeenCalledWith(`/courses/test/lectures/${navigation.lectureId}`);
});

test('resumes completion, requests the next practice source, and resumes that source after remount', async () => {
  const nextDisplay = { ...display, sessionId: 18, problemId: 'practiceEasyV1TestL1ScalarUpdateV2' };
  transport.start.mockResolvedValueOnce({ ...display, completed: true }).mockResolvedValueOnce(nextDisplay);
  transport.next.mockResolvedValue(nextDisplay);
  const user = userEvent.setup();
  const rendered = render(page());
  await user.click(await screen.findByRole('button', { name: '次の問題へ' }));
  expect(transport.next).toHaveBeenCalledExactlyOnceWith({
    courseId: 'test',
    lectureId: navigation.lectureId,
    learningMode: 'practice',
    problemFormat: 'regular',
    sessionId: 17,
  });
  expect(await screen.findByRole('heading', { level: 1, name: '値を一度更新する 2' })).toBeVisible();
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  expect(rendered.container.querySelector('code')).toHaveTextContent('int value = 2;');
  rendered.unmount();
  render(page());
  expect(await screen.findByRole('heading', { level: 1, name: '値を一度更新する 2' })).toBeVisible();
  expect(document.querySelector('code')).toHaveTextContent('int value = 2;');
  expect(transport.start).toHaveBeenCalledTimes(2);
});

test('ignores a deferred previous-location response after navigation', async () => {
  let resolveOld!: (value: RegularExerciseDisplay) => void;
  transport.start
    .mockReturnValueOnce(
      new Promise<RegularExerciseDisplay>((resolve) => {
        resolveOld = resolve;
      })
    )
    .mockResolvedValueOnce({ ...display, sessionId: 18, problemId: 'practiceEasyV1Beginner1L1TerminalTurnV1' });
  const rendered = render(page());
  await waitFor(() => expect(transport.start).toHaveBeenCalledTimes(1));
  navigation.courseId = 'tuBeginner1';
  navigation.lectureId = courseIdToLectureIds.tuBeginner1[0];
  rendered.rerender(page());
  expect(await screen.findByRole('heading', { level: 1, name: '進んで向きを変える 1' })).toBeVisible();
  await act(async () => resolveOld(display));
  expect(screen.getByRole('heading', { level: 1, name: '進んで向きを変える 1' })).toBeVisible();
  expect(screen.queryByRole('heading', { name: '値を一度更新する 1' })).not.toBeInTheDocument();
  expect(transport.start).toHaveBeenLastCalledWith({
    courseId: 'tuBeginner1',
    lectureId: navigation.lectureId,
    learningMode: 'practice',
    problemFormat: 'regular',
  });
});

test('a late practice Next response cannot replace the challenge page or its answer draft after mode navigation', async () => {
  let resolveNext!: (value: RegularExerciseDisplay) => void;
  const challenge: RegularExerciseDisplay = { ...display, problemId: 'test3' };
  transport.start.mockResolvedValueOnce({ ...display, completed: true }).mockResolvedValueOnce(challenge);
  transport.next.mockReturnValue(
    new Promise<RegularExerciseDisplay>((resolve) => {
      resolveNext = resolve;
    })
  );
  const user = userEvent.setup();
  const rendered = render(page());
  await user.click(await screen.findByRole('button', { name: '次の問題へ' }));
  expect(transport.next).toHaveBeenCalledTimes(1);
  rendered.rerender(
    <ChakraProvider>
      <StrictMode>
        <ChallengePageOnClient initialFormat="regular" />
      </StrictMode>
    </ChakraProvider>
  );
  expect(await screen.findByRole('heading', { level: 1, name: 'ステップ実行のテスト用問題(3)' })).toBeVisible();
  const inputs = screen.getAllByRole('textbox');
  await user.type(inputs[0], '9876');
  expect(inputs[0]).toHaveValue('9876');
  await act(async () => resolveNext({ ...display, sessionId: 18, problemId: 'practiceEasyV1TestL1ScalarUpdateV2' }));
  expect(screen.getByRole('heading', { level: 1, name: 'ステップ実行のテスト用問題(3)' })).toBeVisible();
  expect(screen.getAllByRole('textbox')[0]).toHaveValue('9876');
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  expect(transport.start).toHaveBeenLastCalledWith({
    courseId: 'test',
    lectureId: navigation.lectureId,
    problemFormat: 'regular',
  });
  const code = rendered.container.querySelector('code');
  if (!code) throw new Error('Challenge source must render');
  expect(within(code).queryByRole('button')).not.toBeInTheDocument();
});

test('a stale step draft is discarded when reloading the practice route into its replacement session', async () => {
  const oldStep: RegularExerciseDisplay = { ...display, problemType: 'step', traceItemIndex: 2 };
  const replacement: RegularExerciseDisplay = {
    ...display,
    sessionId: 18,
    problemId: 'practiceEasyV1TestL1ScalarUpdateV3',
  };
  transport.start.mockResolvedValueOnce(oldStep).mockResolvedValueOnce(replacement);
  transport.submit.mockRejectedValue({ data: { code: 'CONFLICT' } });
  const user = userEvent.setup();
  const rendered = render(page());
  await user.type(await screen.findByRole('textbox'), '9876');
  await user.click(screen.getByRole('button', { name: /提出/ }));
  expect(await screen.findByRole('alert')).toHaveTextContent('問題の進み具合が画面と一致しません');
  expect(screen.getByRole('button', { name: 'ページを再読み込み' })).toBeVisible();
  expect(transport.submit).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: 17,
      learningMode: 'practice',
      context: { problemType: 'step', traceItemIndex: 2 },
    })
  );
  rendered.unmount();
  const reloaded = render(page());
  expect(await screen.findByRole('heading', { name: '値を一度更新する 3' })).toBeVisible();
  expect(reloaded.container.querySelector('code')).toHaveTextContent('int value = 3;');
  expect(screen.getByRole('textbox')).not.toHaveValue('9876');
  expect(screen.queryByText('ステップ実行モード', { exact: true })).not.toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(transport.start).toHaveBeenCalledTimes(2);
});
