// @vitest-environment jsdom

import { ChakraProvider } from '@chakra-ui/react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';

import { composeWithoutSubmitting, expectJavaSource, replaceJavaSource } from '../../helpers/javaEditor';

const infrastructure = vi.hoisted(() => ({ isAdmin: false, problemId: 'test3', grade: vi.fn(), update: vi.fn() }));
vi.mock('next/navigation', () => ({
  notFound: vi.fn(),
  useParams: () => ({
    courseId: 'test',
    lectureId: '8d692b48-8c19-4679-8d8f-3f27a051d44d',
    problemId: infrastructure.problemId,
  }),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('react-idle-timer', () => ({ useIdleTimer: vi.fn() }));
vi.mock('../../../src/contexts/AuthContext', () => ({
  useAuthContextSelector: (selector: (context: { isAdmin: boolean }) => unknown) =>
    selector({ isAdmin: infrastructure.isAdmin }),
}));
vi.mock('../../../src/infrastructures/trpcBackend/client', () => ({
  backendTrpcReact: {
    countIncorrectSubmissions: { useQuery: () => ({ refetch: vi.fn() }) },
    createProblemSubmission: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    gradeFillInBlankAnswers: { useMutation: () => ({ mutateAsync: infrastructure.grade }) },
    updateProblemSession: { useMutation: () => ({ mutate: vi.fn(), mutateAsync: infrastructure.update }) },
  },
}));

import { ProblemPageOnClient } from '../../../src/app/(withAuth)/courses/[courseId]/lectures/[lectureId]/problems/[problemId]/pageOnClient';

beforeEach(() => {
  infrastructure.isAdmin = false;
  infrastructure.problemId = 'test3';
  infrastructure.grade.mockReset();
  infrastructure.update.mockReset().mockResolvedValue({ elapsedMilliseconds: 123 });
});

test.each([
  ['executionResult', '諦めてステップ実行モードに移る'],
  ['step', 'ステップ実行モードで最初からやり直す'],
] as const)('keeps the normal header and %s control', async (problemType, controlName) => {
  renderPage(problemType);
  expect(screen.getByRole('link', { name: '動作確認用' })).toBeVisible();
  expect(screen.getByRole('link', { name: '第1回' })).toBeVisible();
  expect(screen.getByRole('heading', { level: 1, name: 'ステップ実行のテスト用問題(3)' })).toBeVisible();
  const control = screen.getByRole('button', { name: controlName });
  expect(control).toBeVisible();
  if (problemType === 'executionResult') {
    await userEvent.setup().hover(control);
    expect(await screen.findByText('減点になりますが、確実に問題を解けます。')).toBeInTheDocument();
  }
});

test('hides regular controls for fill-in-blank and retains the admin next-step action', () => {
  const rendered = renderPage('fillInBlank');
  expect(screen.queryByRole('button', { name: /ステップ実行モード/ })).not.toBeInTheDocument();

  rendered.unmount();
  infrastructure.isAdmin = true;
  renderPage('step');
  expect(screen.getByRole('button', { name: '次のステップに進む（管理者のみ）' })).toBeVisible();
});

const renderPage = (problemType: 'executionResult' | 'step' | 'fillInBlank'): ReturnType<typeof render> =>
  render(
    <ChakraProvider>
      <ProblemPageOnClient
        initialProblemSession={
          {
            id: 10,
            problemType,
            problemVariablesSeed: 'normal-component',
            traceItemIndex: problemType === 'step' ? 1 : 0,
          } as never
        }
        userId="user-1"
      />
    </ChakraProvider>
  );

test('ordinary full-source editing submits exact multiline code only on explicit Submit and hides expected variables', async () => {
  infrastructure.problemId = 'fillInBlank2';
  infrastructure.grade.mockResolvedValue({
    status: 'incorrect',
    detail: 'The final state differs from the expected one.',
  });
  const user = userEvent.setup();
  renderPage('fillInBlank');
  const editor = screen.getByRole('textbox', { name: /Java/ });
  expect(editor).toHaveAttribute('aria-multiline', 'true');
  expect(editor.textContent).toContain('【1】');
  expect(screen.queryByText('実行後の変数の値')).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '実行後の盤面' })).toBeVisible();
  const code = '  class Edited {\n  public static void main(String[] args) { int renamed = 3; }\n}\n';
  await replaceJavaSource(editor, code);
  await user.keyboard('{End}{Enter}');
  composeWithoutSubmitting(editor);
  expect(infrastructure.grade).not.toHaveBeenCalled();
  await replaceJavaSource(editor, code);
  await user.click(screen.getByRole('button', { name: '提出' }));
  await waitFor(() =>
    expect(infrastructure.grade).toHaveBeenCalledWith({ sessionId: 10, code, elapsedMilliseconds: 123 })
  );
  expectJavaSource(editor, code);
});

test('unfinished code-context placeholders show local feedback only when Submit is pressed', async () => {
  infrastructure.problemId = 'fillInBlank2';
  const user = userEvent.setup();
  renderPage('fillInBlank');
  screen.getByRole('textbox', { name: /Java/ });
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '提出' }));
  expect(await screen.findByText(/未入力|未完成|空欄.*(?:残|入力)/)).toBeVisible();
  expect(infrastructure.grade).not.toHaveBeenCalled();
  expect(infrastructure.update).not.toHaveBeenCalled();
});

test('marker-looking comments, strings, character literals, and text blocks are submitted as ordinary source', async () => {
  infrastructure.problemId = 'fillInBlank2';
  infrastructure.grade.mockResolvedValue({ status: 'ungradable', detail: 'provider offline' });
  const user = userEvent.setup();
  renderPage('fillInBlank');
  const editor = screen.getByRole('textbox', { name: /Java/ });
  const code = `class Literals {
  public static void main(String[] args) {
    // 【1】
    /* 【2】 */
    String text = "【3】";
    char start = '【';
    String block = """
      【4】
      """;
  }
}`;
  await replaceJavaSource(editor, code);
  await user.click(screen.getByRole('button', { name: '提出' }));
  await waitFor(() =>
    expect(infrastructure.grade).toHaveBeenCalledWith({ sessionId: 10, code, elapsedMilliseconds: 123 })
  );
  expect(await screen.findByRole('alertdialog')).toHaveTextContent('採点できませんでした');
  expectJavaSource(editor, code);
});

test('a network failure preserves edited source and releases the pending state', async () => {
  infrastructure.problemId = 'fillInBlank1';
  let reject!: (error: Error) => void;
  infrastructure.grade.mockReturnValue(
    new Promise((_resolve, _reject) => {
      reject = _reject;
    })
  );
  const user = userEvent.setup();
  renderPage('fillInBlank');
  const editor = screen.getByRole('textbox', { name: /Java/ });
  const code = 'class MyProgram { public static void main(String[] args) {} }';
  await replaceJavaSource(editor, code);
  await user.click(screen.getByRole('button', { name: '提出' }));
  await waitFor(() => expect(infrastructure.grade).toHaveBeenCalledTimes(1));
  expect(editor).toHaveAttribute('contenteditable', 'false');
  await act(async () => reject(new Error('controlled offline transport')));
  expect(await screen.findByRole('alertdialog')).toHaveTextContent('提出できませんでした');
  expectJavaSource(editor, code);
  await user.keyboard('{Escape}');
  await waitFor(() => expect(editor).toHaveAttribute('contenteditable', 'true'));
});

test('ordinary session identity changes replace edited code with the new starter', async () => {
  infrastructure.problemId = 'fillInBlank2';
  const rendered = renderPage('fillInBlank');
  const editor = screen.getByRole('textbox', { name: /Java/ });
  await replaceJavaSource(editor, 'class PreviousAttempt {}');
  rendered.rerender(
    <ChakraProvider>
      <ProblemPageOnClient
        initialProblemSession={
          {
            id: 11,
            problemType: 'fillInBlank',
            problemVariablesSeed: 'replacement-session',
            traceItemIndex: 0,
          } as never
        }
        userId="user-1"
      />
    </ChakraProvider>
  );
  await waitFor(() => {
    const fresh = screen.getByRole('textbox', { name: /Java/ });
    expect(fresh.textContent).toContain('【1】');
    expect(fresh.textContent).not.toContain('PreviousAttempt');
  });
});
