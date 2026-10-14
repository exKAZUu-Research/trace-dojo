// @vitest-environment jsdom

import { ChakraProvider } from '@chakra-ui/react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { readRenderedJavaSource, replaceJavaSource } from '../../helpers/javaEditor';
import { courseIdToLectureIds } from '../../../src/problems/problemData';
import { Lecture } from '../../../src/app/(withAuth)/courses/[courseId]/lectures/[lectureId]/pageOnClient';
import { ProblemPageOnClient } from '../../../src/app/(withAuth)/courses/[courseId]/lectures/[lectureId]/problems/[problemId]/pageOnClient';
import { ChallengePageOnClient } from '../../../src/app/(withAuth)/courses/[courseId]/lectures/[lectureId]/challenge/pageOnClient';

const transport = vi.hoisted(() => ({
  problemId: 'testTurnBug',
  lectureId: '',
  grade: vi.fn(),
  update: vi.fn(),
  start: vi.fn(),
  push: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('Problem page was not found');
  },
  useParams: () => ({ courseId: 'test', lectureId: transport.lectureId, problemId: transport.problemId }),
  useRouter: () => ({ push: transport.push }),
}));
vi.mock('react-idle-timer', () => ({ useIdleTimer: vi.fn() }));
vi.mock('../../../src/contexts/AuthContext', () => ({
  useAuthContextSelector: (selector: (context: { isAdmin: boolean; currentUserId: string }) => unknown) =>
    selector({ isAdmin: true, currentUserId: 'demo-ui-user' }),
}));
vi.mock('../../../src/infrastructures/trpcBackend/client', () => ({
  backendTrpcReact: {
    startExercise: { useMutation: () => ({ mutateAsync: transport.start }) },
    nextExercise: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    submitExercise: { useMutation: () => ({ mutateAsync: transport.grade }) },
    submitRegularExercise: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    switchRegularExerciseToStep: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    countIncorrectSubmissions: { useQuery: () => ({ refetch: vi.fn() }) },
    createProblemSubmission: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    gradeFillInBlankAnswers: { useMutation: () => ({ mutateAsync: transport.grade }) },
    updateProblemSession: { useMutation: () => ({ mutate: vi.fn(), mutateAsync: transport.update }) },
  },
}));

const turn = {
  problemFormat: 'bugFix' as const,
  problemId: 'testTurnBug',
  displayProgram: `public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(3, 3);
        亀.前に進む();
        亀.左を向く();
        亀.前に進む();
    }
}`,
  finalBoard: '.......\n.......\n.......\n...#...\n...##..\n.......\n.......',
  finalTurtles: [{ x: 4, y: 4, color: '#', dir: 'E' }],
};
const loop = {
  problemFormat: 'bugFix' as const,
  problemId: 'testForConditionBug',
  displayProgram: `public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(2, 1);
        for (int i = 0; i + 3; i++) {
            亀.前に進む();
        }
    }
}`,
  finalBoard: '.......\n..#....\n..#....\n..#....\n..#....\n.......\n.......',
  finalTurtles: [{ x: 2, y: 4, color: '#', dir: 'N' }],
};

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  transport.lectureId = courseIdToLectureIds.test[0];
  transport.grade.mockReset();
  transport.start.mockReset();
  transport.update.mockReset().mockResolvedValue({ elapsedMilliseconds: 123 });
});

test.each([turn, loop])('checking list offers an individual ordinary link for $problemId', (problem) => {
  render(
    <ChakraProvider>
      <Lecture lectureIndex={0} problemSessions={[]} />
    </ChakraProvider>
  );
  const link = screen
    .getAllByRole('link')
    .find((item) => item.getAttribute('href') === `${transport.lectureId}/problems/${problem.problemId}`);
  expect(link, 'The real checking-course membership must render a direct problem link').toBeDefined();
  expect(link).toBeVisible();
  expect(link).toHaveAccessibleName(/\S/);
  expect(
    screen.getAllByRole('link').some((item) => item.getAttribute('href')?.endsWith('/problems/fillInBlank1'))
  ).toBe(true);
});

test.each([turn, loop])(
  'ordinary demo $problemId displays its editable starter and bug instructions without trace controls',
  async (problem) => {
    renderDemo(problem);
    const editor = await screen.findByRole('textbox', { name: /Java/ });
    expect(readRenderedJavaSource(editor)).toBe(problem.displayProgram);
    expect(editor).toHaveAttribute('contenteditable', 'true');
    expect(screen.getByText(/誤りが1か所/)).toBeVisible();
    expect(screen.getByRole('heading', { name: '実行後の盤面' })).toBeVisible();
    expect(screen.queryByRole('button', { name: /ステップ|次のステップ/ })).not.toBeInTheDocument();
    expect(screen.queryByText('実行後の変数の値')).not.toBeInTheDocument();
    expect(transport.grade).not.toHaveBeenCalled();
  }
);

test('ordinary syntax demo submits exact source, shows compiler diagnostics, and completes only after repair', async () => {
  const user = userEvent.setup();
  const diagnostic = 'for文の条件にはboolean型の式が必要です。';
  transport.grade
    .mockResolvedValueOnce({
      status: 'incorrect',
      detail: 'Compile error.',
      diagnostics: [
        { line: 4, message: diagnostic, originalMessage: 'incompatible types: int cannot be converted to boolean' },
      ],
    })
    .mockResolvedValueOnce({ status: 'correct' });
  renderDemo(loop);
  const editor = await screen.findByRole('textbox', { name: /Java/ });
  await user.click(screen.getByRole('button', { name: '提出' }));
  await waitFor(() =>
    expect(transport.grade).toHaveBeenNthCalledWith(1, {
      sessionId: 31,
      code: loop.displayProgram,
      elapsedMilliseconds: 123,
    })
  );
  const failure = await screen.findByRole('alertdialog');
  expect(within(failure).getByText(diagnostic)).toBeVisible();
  expect(failure).toHaveTextContent('不正解');
  expect(transport.push).not.toHaveBeenCalled();
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  const repaired = loop.displayProgram.replace('i + 3', 'i < 3');
  await replaceJavaSource(editor, repaired);
  await user.click(screen.getByRole('button', { name: '提出' }));
  await waitFor(() =>
    expect(transport.grade).toHaveBeenNthCalledWith(2, {
      sessionId: 31,
      code: repaired,
      elapsedMilliseconds: 123,
    })
  );
  expect(await screen.findByRole('alertdialog')).toHaveTextContent('この問題は完了');
  expect(editor).toHaveAttribute('contenteditable', 'false');
  await user.keyboard('{Escape}');
  await waitFor(() => expect(transport.push).toHaveBeenCalledWith(`/courses/test/lectures/${transport.lectureId}`));
});

test('ordinary demo reset restores the buggy starter without submission and remains undoable', async () => {
  const user = userEvent.setup();
  renderDemo(turn);
  const editor = await screen.findByRole('textbox', { name: /Java/ });
  const repaired = turn.displayProgram.replace('左を向く', '右を向く');
  await replaceJavaSource(editor, repaired);
  await user.click(screen.getByRole('button', { name: 'リセット' }));
  await user.click(await screen.findByRole('button', { name: 'リセットする' }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  expect(readRenderedJavaSource(editor)).toBe(turn.displayProgram);
  await user.click(screen.getByRole('button', { name: '元に戻す' }));
  expect(readRenderedJavaSource(editor)).toBe(repaired);
  expect(transport.grade).not.toHaveBeenCalled();
  expect(transport.update).not.toHaveBeenCalled();
});

test('demo drafts resume per problem and stay separate from challenge drafts with the same session', async () => {
  let page = renderDemo(turn);
  const ordinaryDraft = turn.displayProgram.replace('左を向く', '右を向く');
  await replaceJavaSource(await screen.findByRole('textbox', { name: /Java/ }), ordinaryDraft);
  page.unmount();
  page = renderDemo(loop);
  let editor = await screen.findByRole('textbox', { name: /Java/ });
  expect(readRenderedJavaSource(editor)).toBe(loop.displayProgram);
  const loopDraft = loop.displayProgram.replace('i + 3', 'i < 3');
  await replaceJavaSource(editor, loopDraft);
  page.unmount();
  transport.problemId = turn.problemId;
  transport.start.mockResolvedValue({ ...turn, sessionId: 31, completed: false });
  page = render(
    <ChakraProvider>
      <ChallengePageOnClient initialFormat="bugFix" />
    </ChakraProvider>
  );
  editor = await screen.findByRole('textbox', { name: /Java/ });
  expect(readRenderedJavaSource(editor)).toBe(turn.displayProgram);
  await replaceJavaSource(editor, `${ordinaryDraft}\n// Challenge draft`);
  page.unmount();
  page = renderDemo(turn);
  expect(readRenderedJavaSource(await screen.findByRole('textbox', { name: /Java/ }))).toBe(ordinaryDraft);
  page.unmount();
  renderDemo(loop);
  expect(readRenderedJavaSource(await screen.findByRole('textbox', { name: /Java/ }))).toBe(loopDraft);
  expect(transport.grade).not.toHaveBeenCalled();
});

function renderDemo(javaProblem: typeof turn): ReturnType<typeof render> {
  transport.problemId = javaProblem.problemId;
  const props = {
    javaProblem,
    userId: 'demo-ui-user',
    initialProblemSession: {
      id: 31,
      problemId: javaProblem.problemId,
      problemType: 'bugFix',
      problemVariablesSeed: 'demo-ui',
      traceItemIndex: 0,
    } as never,
  };
  return render(
    <ChakraProvider>
      <ProblemPageOnClient {...props} />
    </ChakraProvider>
  );
}
