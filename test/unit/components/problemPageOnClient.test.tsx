// @vitest-environment jsdom

import { ChakraProvider } from '@chakra-ui/react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';

import {
  composeWithoutSubmitting,
  expectJavaSource,
  readRenderedJavaSource,
  replaceJavaSource,
} from '../../helpers/javaEditor';

const infrastructure = vi.hoisted(() => ({
  isAdmin: false,
  problemId: 'test3',
  grade: vi.fn(),
  update: vi.fn(),
  start: vi.fn(),
}));
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
  useAuthContextSelector: (selector: (context: { isAdmin: boolean; currentUserId: string }) => unknown) =>
    selector({ isAdmin: infrastructure.isAdmin, currentUserId: 'user-1' }),
}));
vi.mock('../../../src/infrastructures/trpcBackend/client', () => ({
  backendTrpcReact: {
    startExercise: { useMutation: () => ({ mutateAsync: infrastructure.start }) },
    nextExercise: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    submitExercise: { useMutation: () => ({ mutateAsync: infrastructure.grade }) },
    submitRegularExercise: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    switchRegularExerciseToStep: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    countIncorrectSubmissions: { useQuery: () => ({ refetch: vi.fn() }) },
    createProblemSubmission: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    gradeFillInBlankAnswers: { useMutation: () => ({ mutateAsync: infrastructure.grade }) },
    updateProblemSession: { useMutation: () => ({ mutate: vi.fn(), mutateAsync: infrastructure.update }) },
  },
}));

import { ChallengePageOnClient } from '../../../src/app/(withAuth)/courses/[courseId]/lectures/[lectureId]/challenge/pageOnClient';

import { ProblemPageOnClient } from '../../../src/app/(withAuth)/courses/[courseId]/lectures/[lectureId]/problems/[problemId]/pageOnClient';

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  infrastructure.isAdmin = false;
  infrastructure.problemId = 'test3';
  infrastructure.grade.mockReset();
  infrastructure.start.mockReset();
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

const renderPage = (
  problemType: 'executionResult' | 'step' | 'fillInBlank',
  userId = 'user-1',
  sessionId = 10,
  seed = 'normal-component'
): ReturnType<typeof render> =>
  render(
    <ChakraProvider>
      <ProblemPageOnClient
        initialProblemSession={
          {
            id: sessionId,
            problemType,
            problemVariablesSeed: seed,
            traceItemIndex: problemType === 'step' ? 1 : 0,
          } as never
        }
        userId={userId}
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
  expect(editor).not.toHaveAttribute('aria-describedby');
  expect(screen.queryByText(/Tab.*(?:Escape|Esc|インデント)/)).not.toBeInTheDocument();
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
  const header = await screen.findByText(/未入力|未完成|空欄.*(?:残|入力)/);
  await waitFor(() => expect(header).toBeVisible());
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
  expect(readRenderedJavaSource(editor)).toBe(code);
  expect(editor).toHaveAttribute('contenteditable', 'false');
  expect(screen.getByRole('button', { hidden: true, name: '元に戻す' })).toBeDisabled();
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  await user.click(screen.getByRole('button', { name: '元に戻す' }));
  expect(readRenderedJavaSource(editor)).not.toBe(code);
  await user.click(screen.getByRole('button', { name: 'やり直す' }));
  expect(readRenderedJavaSource(editor)).toBe(code);
  expect(infrastructure.grade).toHaveBeenCalledTimes(1);
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
  const starter = readRenderedJavaSource(editor);
  await replaceJavaSource(editor, code);
  await user.click(screen.getByRole('button', { name: '提出' }));
  await waitFor(() => expect(infrastructure.grade).toHaveBeenCalledTimes(1));
  expect(screen.getByRole('button', { name: '元に戻す' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'やり直す' })).toBeDisabled();
  expect(editor).toHaveAttribute('contenteditable', 'false');
  await act(async () => reject(new Error('controlled offline transport')));
  expect(await screen.findByRole('alertdialog')).toHaveTextContent('提出できませんでした');
  expectJavaSource(editor, code);
  await user.keyboard('{Escape}');
  await waitFor(() => expect(editor).toHaveAttribute('contenteditable', 'true'));
  await user.click(screen.getByRole('button', { name: '元に戻す' }));
  expect(readRenderedJavaSource(editor)).toBe(starter);
  await user.click(screen.getByRole('button', { name: 'やり直す' }));
  expect(readRenderedJavaSource(editor)).toBe(code);
  expect(infrastructure.grade).toHaveBeenCalledTimes(1);
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
    expect(screen.getByRole('button', { name: '元に戻す' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'やり直す' })).toBeDisabled();
  });
});

test.each(['edited', 'empty'] as const)(
  'ordinary Reset restores the exact starter from %s source without submitting',
  async (source) => {
    infrastructure.problemId = 'fillInBlank2';
    const user = userEvent.setup();
    renderPage('fillInBlank');
    const editor = screen.getByRole('textbox', { name: /Java/ });
    const starter = readRenderedJavaSource(editor);
    expect(starter).toContain('【1】');
    expect(starter).toContain('\n');
    const edited = 'class Edited {\n  int value = 42;\n}\n';
    await replaceJavaSource(editor, edited);
    expect(readRenderedJavaSource(editor)).toBe(edited);
    if (source === 'empty') {
      await user.click(editor);
      await user.keyboard('{Control>}a{/Control}{Backspace}');
      await waitFor(() => expect(readRenderedJavaSource(editor)).toBe(''));
    }
    expect(readRenderedJavaSource(editor)).not.toBe(starter);
    const draft = readRenderedJavaSource(editor);
    await user.click(screen.getByRole('button', { name: 'リセット' }));
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeVisible());
    expect(readRenderedJavaSource(editor)).toBe(draft);
    await user.click(screen.getByRole('button', { name: 'リセットする' }));
    await waitFor(() => expect(readRenderedJavaSource(editor)).toBe(starter));
    expect(infrastructure.grade).not.toHaveBeenCalled();
    expect(infrastructure.update).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  }
);

test('ordinary editor zoom preserves source and both undo and redo history without grading', async () => {
  infrastructure.problemId = 'fillInBlank2';
  const user = userEvent.setup();
  renderPage('fillInBlank');
  const editor = screen.getByRole('textbox', { name: /Java/ });
  const starter = readRenderedJavaSource(editor);
  const draft = 'class Draft {\n  // 日本語のコメント\n  int value = 42;\n}\n';
  await replaceJavaSource(editor, draft);
  const zoomOut = screen.getByRole('button', { name: 'コードを縮小' });
  const zoomIn = screen.getByRole('button', { name: 'コードを拡大' });
  const undo = screen.getByRole('button', { name: '元に戻す' });
  const redo = screen.getByRole('button', { name: 'やり直す' });
  for (const control of [zoomOut, zoomIn]) expect(control).toHaveAttribute('type', 'button');

  await user.click(zoomIn);
  await user.click(zoomOut);
  expect(readRenderedJavaSource(editor)).toBe(draft);
  expect(undo).toBeEnabled();
  expect(redo).toBeDisabled();
  await user.click(undo);
  expect(readRenderedJavaSource(editor)).toBe(starter);
  expect(undo).toBeDisabled();
  expect(redo).toBeEnabled();

  await user.click(zoomOut);
  await user.click(zoomIn);
  expect(readRenderedJavaSource(editor)).toBe(starter);
  expect(undo).toBeDisabled();
  expect(redo).toBeEnabled();
  await user.click(redo);
  expect(readRenderedJavaSource(editor)).toBe(draft);
  expect(infrastructure.grade).not.toHaveBeenCalled();
  expect(infrastructure.update).not.toHaveBeenCalled();
});

test('ordinary editor zoom reaches each bound and permits reversing direction', async () => {
  infrastructure.problemId = 'fillInBlank2';
  const user = userEvent.setup();
  renderPage('fillInBlank');
  const editor = screen.getByRole('textbox', { name: /Java/ });
  const starter = readRenderedJavaSource(editor);
  const zoomOut = screen.getByRole<HTMLButtonElement>('button', { name: 'コードを縮小' });
  const zoomIn = screen.getByRole<HTMLButtonElement>('button', { name: 'コードを拡大' });
  expect(zoomOut).toBeEnabled();
  expect(zoomIn).toBeEnabled();
  for (const [towardBound, reverse] of [
    [zoomIn, zoomOut],
    [zoomOut, zoomIn],
  ] as const) {
    for (let attempts = 0; attempts < 32 && !towardBound.disabled; attempts++) await user.click(towardBound);
    expect(towardBound).toBeDisabled();
    expect(reverse).toBeEnabled();
    await user.click(towardBound);
    expect(towardBound).toBeDisabled();
    await user.click(reverse);
    expect(towardBound).toBeEnabled();
    expect(readRenderedJavaSource(editor)).toBe(starter);
  }
  expect(screen.getByRole('button', { name: '元に戻す' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'やり直す' })).toBeDisabled();
  expect(infrastructure.grade).not.toHaveBeenCalled();
  expect(infrastructure.update).not.toHaveBeenCalled();
});

test('ordinary editor shares keyboard and toolbar history and confirms an isolated undoable reset', async () => {
  infrastructure.problemId = 'fillInBlank2';
  const user = userEvent.setup();
  renderPage('fillInBlank');
  const editor = screen.getByRole('textbox', { name: /Java/ });
  const starter = readRenderedJavaSource(editor);
  const undo = screen.getByRole('button', { name: '元に戻す' });
  const redo = screen.getByRole('button', { name: 'やり直す' });
  const reset = screen.getByRole('button', { name: 'リセット' });
  const submit = screen.getByRole('button', { name: '提出' });
  const controls = screen.getAllByRole('button');
  expect(controls.slice(controls.indexOf(undo), controls.indexOf(submit) + 1)).toEqual([undo, redo, reset, submit]);
  expect(undo).toBeDisabled();
  expect(redo).toBeDisabled();
  await user.click(reset);
  await user.click(await screen.findByRole('button', { name: 'リセットする' }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  expect(undo).toBeDisabled();
  expect(redo).toBeDisabled();

  const draft = 'class Draft {\n  int value = 42;\n}\n';
  await replaceJavaSource(editor, draft);
  expect(undo).toBeEnabled();
  await user.click(undo);
  expect(readRenderedJavaSource(editor)).toBe(starter);
  expect(redo).toBeEnabled();
  await user.click(reset);
  const cancel = await screen.findByRole('button', { name: 'キャンセル' });
  await waitFor(() => expect(cancel).toHaveFocus());
  expect(editor).toHaveAttribute('contenteditable', 'false');
  for (const control of [undo, redo, reset, submit]) expect(control).toBeDisabled();
  fireEvent.keyDown(editor, { key: 'y', code: 'KeyY', keyCode: 89, ctrlKey: true });
  expect(readRenderedJavaSource(editor)).toBe(starter);
  await user.click(cancel);
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  await waitFor(() => expect(reset).toHaveFocus());
  expect(redo).toBeEnabled();
  await user.click(redo);
  expect(readRenderedJavaSource(editor)).toBe(draft);

  await user.click(editor);
  fireEvent.keyDown(editor, { key: 'z', code: 'KeyZ', keyCode: 90, ctrlKey: true });
  expect(readRenderedJavaSource(editor)).toBe(starter);
  expect(undo).toBeDisabled();
  expect(redo).toBeEnabled();
  await user.click(reset);
  await screen.findByRole('alertdialog');
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  expect(readRenderedJavaSource(editor)).toBe(starter);
  expect(redo).toBeEnabled();
  await user.click(editor);
  fireEvent.keyDown(editor, { key: 'y', code: 'KeyY', keyCode: 89, ctrlKey: true });
  expect(readRenderedJavaSource(editor)).toBe(draft);
  expect(undo).toBeEnabled();
  expect(redo).toBeDisabled();

  await user.click(reset);
  await screen.findByRole('alertdialog');
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  expect(readRenderedJavaSource(editor)).toBe(draft);
  await user.click(reset);
  await user.click(await screen.findByRole('button', { name: 'リセットする' }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  expect(readRenderedJavaSource(editor)).toBe(starter);
  await user.click(undo);
  expect(readRenderedJavaSource(editor)).toBe(draft);
  await user.click(redo);
  expect(readRenderedJavaSource(editor)).toBe(starter);
  await user.click(undo);
  await user.click(undo);
  expect(readRenderedJavaSource(editor)).toBe(starter);
  expect(undo).toBeDisabled();
  const replacement = 'class Replacement {\n  int other = 7;\n}\n';
  await replaceJavaSource(editor, replacement);
  expect(readRenderedJavaSource(editor)).toBe(replacement);
  expect(redo).toBeDisabled();
  expect(infrastructure.grade).not.toHaveBeenCalled();
  expect(infrastructure.update).not.toHaveBeenCalled();
});

test('local hints identify a missing operand and disappear after a repair without grading', async () => {
  infrastructure.problemId = 'fillInBlank2';
  renderPage('fillInBlank');
  const editor = screen.getByRole('textbox', { name: /Java/ });
  await replaceJavaSource(editor, 'class Main { void draw() { int x = ; } }');
  await waitFor(() => expect(document.querySelector('.cm-lintRange-error')).toBeInTheDocument());
  fireEvent.keyDown(editor, { key: 'M', code: 'KeyM', keyCode: 77, ctrlKey: true, shiftKey: true });
  const panel = await screen.findByRole('listbox', { name: 'Diagnostics' });
  expect(await within(panel).findByText(/「=」.*代入する値/)).toBeVisible();
  expect(panel.querySelector('.cm-diagnosticSource')).not.toBeInTheDocument();
  await replaceJavaSource(editor, 'class Main { void draw() { int x = 1 + ; } }');
  expect(await within(panel).findByText(/「\+」.*計算する値/)).toBeVisible();
  expect(within(panel).queryByText(/「=」.*代入する値/)).not.toBeInTheDocument();
  await replaceJavaSource(editor, 'class Main { void draw() { int x = 1 + 2; } }');
  await waitFor(() => expect(document.querySelector('.cm-lintRange-error')).not.toBeInTheDocument());
  expect(within(panel).queryByText(/右側/)).not.toBeInTheDocument();
  await replaceJavaSource(editor, 'class Main { void draw() { int x = true; missing(); } }');
  await waitFor(() => expect(document.querySelector('.cm-lintRange-error')).not.toBeInTheDocument());
  await replaceJavaSource(editor, 'class Main { void draw() { int x = 【1】; } }');
  expect(document.querySelector('.cm-lintRange-error')).not.toBeInTheDocument();
  expect(infrastructure.grade).not.toHaveBeenCalled();
});

test('local hints keep uncertain recovery generic without flagging valid literal and empty-expression forms', async () => {
  infrastructure.problemId = 'fillInBlank2';
  renderPage('fillInBlank');
  const editor = screen.getByRole('textbox', { name: /Java/ });
  const user = userEvent.setup();
  await user.click(editor);
  fireEvent.keyDown(editor, { key: 'M', code: 'KeyM', keyCode: 77, ctrlKey: true, shiftKey: true });
  const panel = await screen.findByRole('listbox', { name: 'Diagnostics' });
  const uncertainSources = [
    'class Main { void f() { String s = "broken;\n int x = ; } }',
    'class Main { void f() { /* broken\n int x = ; } }',
    'class Main { void f() { int x = 1; x += ; } }',
    'class Main { void f() { boolean x = true && ; } }',
    'class Main { void f() { int x = -; } }',
    'class Main { void f() { move(1; int x = ; } }',
    String.raw`class Main { void f() { int x = ; } } // \u000a`,
  ];
  for (const code of uncertainSources) {
    await replaceJavaSource(editor, code);
    await waitFor(() => expect(panel, code).toHaveTextContent(/コード全体で/));
    expect(panel).not.toHaveTextContent(/代入する値|計算する値/);
  }
  await replaceJavaSource(
    editor,
    `class Main {
    void f() {
      String 文字 = "= ; + ; /*";
      char 記号 = '+';
      String block = """
        = ; + ; // /*
        """;
      /* = ; + ; */
      for (;;) { break; }
      return;
    }
  }
  class Probe { void f() { move(1; } }`
  );
  expect(await within(panel).findAllByText(/コード全体で/)).toHaveLength(1);
  expect(panel).not.toHaveTextContent(/代入する値|計算する値/);
  const lines = [...editor.querySelectorAll('.cm-line')];
  const probeLine = lines.at(-1);
  expect(probeLine).toHaveTextContent('class Probe');
  expect(probeLine?.querySelector('.cm-lintRange-error')).toBeInTheDocument();
  for (const line of lines.slice(0, -1)) {
    expect(line.querySelector('.cm-lintRange-error, .cm-lintPoint-error')).not.toBeInTheDocument();
  }
  expect(infrastructure.grade).not.toHaveBeenCalled();
});

test('compiler feedback becomes historical on edit and undo never restores compiler annotations', async () => {
  infrastructure.problemId = 'fillInBlank2';
  const message = 'この呼び出し方に合う名前が見つかりません。';
  const originalMessage = 'cannot find symbol\nsymbol: method missing()';
  infrastructure.grade.mockResolvedValue({
    status: 'incorrect',
    detail: 'Compile error.',
    diagnostics: [{ line: 3, message, originalMessage }],
  });
  const user = userEvent.setup();
  renderPage('fillInBlank');
  const editor = screen.getByRole('textbox', { name: /Java/ });
  await replaceJavaSource(editor, 'class Main {\n public static void main(String[] args) {\n  missing();\n }\n}');
  await user.click(screen.getByRole('button', { name: '提出' }));
  await waitFor(() => expect(screen.getByRole('alertdialog')).toBeVisible());
  expect(screen.getAllByText(message, { exact: true, normalizer: (text) => text }).length).toBeGreaterThan(0);
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  expect(screen.getByText(message, { exact: true, normalizer: (text) => text })).toBeVisible();
  expect(screen.getByText(/symbol: method missing/)).toBeVisible();
  await waitFor(() => expect(document.querySelector('.cm-lintRange-error')).toBeInTheDocument());
  await user.click(editor);
  await user.keyboard('{Control>}{End}{/Control} ');
  expect(document.querySelector('.cm-lintRange-error')).not.toBeInTheDocument();
  const report = screen.getByRole('region', { name: '前回提出したコードの確認結果' });
  expect(within(report).getByText(message)).toBeVisible();
  expect(within(report).getByText(/symbol: method missing/)).toBeVisible();
  const notice = within(report).getByRole('status');
  expect(notice).toHaveTextContent(/前回提出.*もう一度提出/);
  expect(notice).not.toHaveAttribute('aria-live', 'assertive');
  expect(notice).not.toHaveAttribute('aria-live', 'off');
  expect(within(report).getByRole('heading', { name: '前回提出したコードの確認結果' })).toBeVisible();
  expect(notice).not.toHaveTextContent(message);
  await user.click(screen.getByRole('button', { name: '元に戻す' }));
  expect(readRenderedJavaSource(editor)).toBe(
    'class Main {\n public static void main(String[] args) {\n  missing();\n }\n}'
  );
  expect(screen.getByRole('region', { name: '前回提出したコードの確認結果' })).toHaveTextContent(message);
  expect(document.querySelector('.cm-lintRange-error')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'やり直す' }));
  expect(screen.getByRole('region', { name: '前回提出したコードの確認結果' })).toHaveTextContent(message);
  expect(document.querySelector('.cm-lintRange-error')).not.toBeInTheDocument();
  expect(infrastructure.grade).toHaveBeenCalledTimes(1);
});

test('Japanese Turtle completion inserts literal source, supports undo, and never grades', async () => {
  infrastructure.problemId = 'fillInBlank2';
  const user = userEvent.setup();
  renderPage('fillInBlank');
  const editor = screen.getByRole('textbox', { name: /Java/ });
  const prefix = 'class Main { void draw() { Turtle 亀 = new Turtle(); 亀.前';
  await replaceJavaSource(editor, prefix);
  await user.keyboard('{Control>} {/Control}');
  const option = await screen.findByRole('option', { name: /前に進む/ });
  await user.click(option);
  expect(readRenderedJavaSource(editor)).toContain('亀.前に進む(');
  expect(readRenderedJavaSource(editor)).not.toMatch(/&|<span/);
  await user.click(screen.getByRole('button', { name: '元に戻す' }));
  expect(readRenderedJavaSource(editor)).toBe(prefix);
  expect(infrastructure.grade).not.toHaveBeenCalled();
});

test.each([
  { option: /^Turtle亀を作る$/, suffix: 'Turtle learner = new Turtle();', inputs: ['learner'] },
  { option: /Turtle\(x, y\)/, suffix: 'Turtle learner = new Turtle(2, 3);', inputs: ['learner', '2', '3'] },
])('Turtle creation completion inserts editable taught arguments: $suffix', async ({ option, suffix, inputs }) => {
  infrastructure.problemId = 'fillInBlank2';
  const user = userEvent.setup();
  renderPage('fillInBlank');
  const editor = screen.getByRole('textbox', { name: /Java/ });
  const prefix = 'class Main { void draw() { ';
  await replaceJavaSource(editor, `${prefix}Tur`);
  await user.keyboard('{Control>} {/Control}');
  await user.click(await screen.findByRole('option', { name: option }));
  for (const [index, input] of inputs.entries()) {
    if (index > 0) await user.keyboard('{Tab}');
    await user.paste(input);
  }
  expect(readRenderedJavaSource(editor)).toBe(prefix + suffix);
  expect(editor).toHaveFocus();
  expect(infrastructure.grade).not.toHaveBeenCalled();
});

test.each([
  'class Main { void draw() { String text = "前',
  'class Main { void draw() { // Turtle 亀 = new Turtle(); 亀.前',
  'class Main { void draw() { int 亀 = 1; 亀.前',
  'class Main { void draw() { { Turtle 亀 = new Turtle(); } 亀.前',
  'class Main { void draw() { Turtle 亀 = new Turtle(); { int 亀 = 1; 亀.前',
])('does not suggest Turtle members outside a visible explicit Turtle local: %s', async (source) => {
  infrastructure.problemId = 'fillInBlank2';
  const user = userEvent.setup();
  renderPage('fillInBlank');
  const editor = screen.getByRole('textbox', { name: /Java/ });
  await replaceJavaSource(editor, 'class Main { void draw(Turtle 亀) { 亀.前');
  await user.keyboard('{Control>} {/Control}');
  await screen.findByRole('option', { name: /前に進む/ });
  await user.keyboard('{Escape}');
  await replaceJavaSource(editor, source);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  try {
    await act(async () => {
      fireEvent.keyDown(editor, { key: ' ', code: 'Space', ctrlKey: true });
      fireEvent.keyUp(editor, { key: ' ', code: 'Space', ctrlKey: true });
      await vi.runAllTimersAsync();
    });
    expect(vi.getTimerCount()).toBe(0);
    expect(screen.queryByRole('option', { name: /前に進む/ })).not.toBeInTheDocument();
    expect(infrastructure.grade).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

test('Java snippet completion accepts with Enter and Tab navigates source placeholders without grading', async () => {
  infrastructure.problemId = 'fillInBlank2';
  const user = userEvent.setup();
  renderPage('fillInBlank');
  const editor = screen.getByRole('textbox', { name: /Java/ });
  await replaceJavaSource(editor, 'class Main { void draw() { fo');
  await user.keyboard('{Control>} {/Control}');
  await screen.findByRole('option', { name: /for/ });
  // CodeMirror ignores acceptance immediately after opening; model elapsed user time without a wall-clock wait.
  const readyTime = Date.now() + 1000;
  const clock = vi.spyOn(Date, 'now').mockReturnValue(readyTime);
  try {
    await user.keyboard('{Enter}');
  } finally {
    clock.mockRestore();
  }
  expect(readRenderedJavaSource(editor)).toMatch(/for\s*\(/);
  expect(readRenderedJavaSource(editor)).not.toMatch(/\$\{|<span/);
  await user.paste('cursor');
  await user.keyboard('{Tab}');
  await user.paste('7');
  const inserted = readRenderedJavaSource(editor);
  expect(inserted).toMatch(/for\s*\(\s*int\s+cursor\s*=\s*0\s*;\s*cursor\s*<\s*7\s*;\s*cursor\+\+/);
  expect(inserted).not.toContain('\t');
  expect(editor).toHaveFocus();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  expect(infrastructure.grade).not.toHaveBeenCalled();
});

test('local draft restores exact multiline source and empty edits before explicit submission', async () => {
  infrastructure.problemId = 'fillInBlank2';
  infrastructure.grade.mockResolvedValue({ status: 'incorrect', detail: 'Different final state.' });
  const user = userEvent.setup();
  const code = 'class Draft {\n  // 日本語\n  int count = 42;\n}\n';
  let rendered = renderPage('fillInBlank');
  await replaceJavaSource(await screen.findByRole('textbox', { name: /Java/ }), code);
  rendered.unmount();
  rendered = renderPage('fillInBlank');
  let editor = await screen.findByRole('textbox', { name: /Java/ });
  expect(readRenderedJavaSource(editor)).toBe(code);
  expect(screen.getByRole('button', { name: '元に戻す' })).toBeDisabled();
  expect(infrastructure.grade).not.toHaveBeenCalled();
  expect(infrastructure.update).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '提出' }));
  await waitFor(() =>
    expect(infrastructure.grade).toHaveBeenCalledWith({ sessionId: 10, code, elapsedMilliseconds: 123 })
  );
  await screen.findByRole('alertdialog');
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  await user.click(editor);
  await user.keyboard('{Control>}a{/Control}{Backspace}');
  expect(readRenderedJavaSource(editor)).toBe('');
  rendered.unmount();
  renderPage('fillInBlank');
  editor = await screen.findByRole('textbox', { name: /Java/ });
  expect(readRenderedJavaSource(editor)).toBe('');
  expect(screen.getByRole('button', { name: '提出' })).toBeDisabled();
  expect(infrastructure.grade).toHaveBeenCalledTimes(1);
});

test('local drafts isolate accounts and attempts while retaining the original attempt', async () => {
  infrastructure.problemId = 'fillInBlank2';
  const original = 'class FirstAccount {}';
  let rendered = renderPage('fillInBlank');
  await replaceJavaSource(await screen.findByRole('textbox', { name: /Java/ }), original);
  rendered.unmount();
  rendered = renderPage('fillInBlank', 'user-2');
  let editor = await screen.findByRole('textbox', { name: /Java/ });
  expect(readRenderedJavaSource(editor)).not.toBe(original);
  await replaceJavaSource(editor, 'class SecondAccount {}');
  rendered.unmount();
  rendered = renderPage('fillInBlank', 'user-1', 11, 'next-attempt');
  editor = await screen.findByRole('textbox', { name: /Java/ });
  expect(readRenderedJavaSource(editor)).not.toBe(original);
  await replaceJavaSource(editor, 'class NextAttempt {}');
  rendered.unmount();
  renderPage('fillInBlank');
  expect(readRenderedJavaSource(await screen.findByRole('textbox', { name: /Java/ }))).toBe(original);
  expect(infrastructure.grade).not.toHaveBeenCalled();
});

test('local draft reset cancellation survives remount and undo of confirmed reset saves again', async () => {
  infrastructure.problemId = 'fillInBlank2';
  const user = userEvent.setup();
  let rendered = renderPage('fillInBlank');
  let editor = await screen.findByRole('textbox', { name: /Java/ });
  const starter = readRenderedJavaSource(editor);
  const code = 'class ResetDraft {}';
  await replaceJavaSource(editor, code);
  await user.click(screen.getByRole('button', { name: 'リセット' }));
  await user.click(await screen.findByRole('button', { name: 'キャンセル' }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  rendered.unmount();
  rendered = renderPage('fillInBlank');
  editor = await screen.findByRole('textbox', { name: /Java/ });
  expect(readRenderedJavaSource(editor)).toBe(code);
  await user.click(screen.getByRole('button', { name: 'リセット' }));
  await user.click(await screen.findByRole('button', { name: 'リセットする' }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  expect(readRenderedJavaSource(editor)).toBe(starter);
  await user.click(screen.getByRole('button', { name: '元に戻す' }));
  expect(readRenderedJavaSource(editor)).toBe(code);
  rendered.unmount();
  rendered = renderPage('fillInBlank');
  expect(readRenderedJavaSource(await screen.findByRole('textbox', { name: /Java/ }))).toBe(code);
  await user.click(screen.getByRole('button', { name: 'リセット' }));
  await user.click(await screen.findByRole('button', { name: 'リセットする' }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  rendered.unmount();
  renderPage('fillInBlank');
  expect(readRenderedJavaSource(await screen.findByRole('textbox', { name: /Java/ }))).toBe(starter);
});

test('local draft quota failure keeps current code usable and both previously saved attempts recoverable', async () => {
  infrastructure.problemId = 'fillInBlank2';
  const first = 'class RecoverableFirst {}';
  const second = 'class RecoverableSecond {}';
  let rendered = renderPage('fillInBlank');
  await replaceJavaSource(await screen.findByRole('textbox', { name: /Java/ }), first);
  expectStoredDraft(first);
  rendered.unmount();
  rendered = renderPage('fillInBlank', 'user-1', 11);
  await replaceJavaSource(await screen.findByRole('textbox', { name: /Java/ }), second);
  rendered.unmount();
  rendered = renderPage('fillInBlank');
  const editor = await screen.findByRole('textbox', { name: /Java/ });
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Storage full', 'QuotaExceededError');
  });
  await replaceJavaSource(editor, 'class UnsavedButEditable {}');
  expect(readRenderedJavaSource(editor)).toBe('class UnsavedButEditable {}');
  expect(editor).toHaveAttribute('contenteditable', 'true');
  expect(screen.getByText(/一時保存の処理に失敗/)).toBeVisible();
  expect(screen.queryByText(/保存しました|保存済み/)).not.toBeInTheDocument();
  write.mockRestore();
  rendered.unmount();
  rendered = renderPage('fillInBlank');
  expect(readRenderedJavaSource(await screen.findByRole('textbox', { name: /Java/ }))).toBe(first);
  rendered.unmount();
  renderPage('fillInBlank', 'user-1', 11);
  expect(readRenderedJavaSource(await screen.findByRole('textbox', { name: /Java/ }))).toBe(second);
});

test.each(['invalid JSON', 'unsupported version'] as const)(
  'local draft with %s falls back to starter without preventing edits',
  async (damage) => {
    infrastructure.problemId = 'fillInBlank2';
    const rendered = renderPage('fillInBlank');
    const editor = await screen.findByRole('textbox', { name: /Java/ });
    const starter = readRenderedJavaSource(editor);
    await replaceJavaSource(editor, 'class DamagedDraft {}');
    const { key, raw } = expectStoredDraft('class DamagedDraft {}');
    rendered.unmount();
    localStorage.setItem(key, damage === 'invalid JSON' ? '{' : JSON.stringify({ ...JSON.parse(raw), version: -1 }));
    renderPage('fillInBlank');
    const restored = await screen.findByRole('textbox', { name: /Java/ });
    expect(readRenderedJavaSource(restored)).toBe(starter);
    await replaceJavaSource(restored, 'class RepairedDraft {}');
    expect(readRenderedJavaSource(restored)).toBe('class RepairedDraft {}');
  }
);

test.each([
  { prefix: 'a', name: 'a' },
  { prefix: 'm', name: 'main' },
])(
  'source-word completion accepts $name literally despite an unfinished method and never grades',
  async ({ prefix, name }) => {
    infrastructure.problemId = 'fillInBlank2';
    const user = userEvent.setup();
    renderPage('fillInBlank');
    const editor = await screen.findByRole('textbox', { name: /Java/ });
    const before = `class Main { public static int a(){return 1} public static void main(String[] args) { Turtle turtle = new Turtle(); turtle.前に進む(); ${prefix}`;
    const after = '; } }';
    await replaceJavaSource(editor, before + after);
    await user.keyboard(`{ArrowLeft>${after.length}}`);
    await user.keyboard('{Control>} {/Control}');
    const option = await screen.findByRole('option', { name: `${name}コード内の単語` });
    if (prefix === 'a') {
      expect(screen.getAllByRole('option', { name: /^args/ })).toHaveLength(1);
      expect(screen.getByRole('option', { name: 'args' })).toBeVisible();
    }
    await user.click(option);
    expect(readRenderedJavaSource(editor)).toBe(before.slice(0, -prefix.length) + name + after);
    if (name !== prefix) {
      await user.click(screen.getByRole('button', { name: '元に戻す' }));
      expect(readRenderedJavaSource(editor)).toBe(before + after);
    }
    expect(infrastructure.grade).not.toHaveBeenCalled();
  }
);

test('source-word completion refreshes edited code and excludes comments, literals and the caret occurrence', async () => {
  infrastructure.problemId = 'fillInBlank2';
  const user = userEvent.setup();
  renderPage('fillInBlank');
  const editor = await screen.findByRole('textbox', { name: /Java/ });
  const before = `class Main { void wordOld() {} void draw() {
    // wordComment
    /* wordBlock */
    String text = "wordString";
    String block = """
    wordTextBlock
    """;
    char letter = 'w';
    word`;
  const after = 'CaretOnly; } }';
  await replaceJavaSource(editor, before + after);
  await user.keyboard(`{ArrowLeft>${after.length}}`);
  await user.keyboard('{Control>} {/Control}');
  await screen.findByRole('option', { name: 'wordOldコード内の単語' });
  for (const name of ['wordComment', 'wordBlock', 'wordString', 'wordTextBlock', 'wordCaretOnly']) {
    expect(screen.queryByRole('option', { name: new RegExp(`^${name}`) })).not.toBeInTheDocument();
  }
  await user.keyboard('{Escape}');
  const edited = before.replace('wordOld', 'word新$名');
  await replaceJavaSource(editor, edited + after);
  await user.keyboard(`{ArrowLeft>${after.length}}`);
  await user.keyboard('{Control>} {/Control}');
  const renamed = await screen.findByRole('option', { name: 'word新$名コード内の単語' });
  expect(screen.queryByRole('option', { name: /^wordOld/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('option', { name: /^wordCaretOnly/ })).not.toBeInTheDocument();
  await user.click(renamed);
  expect(readRenderedJavaSource(editor)).toBe(edited.slice(0, -4) + 'word新$名' + after);
  expect(infrastructure.grade).not.toHaveBeenCalled();
});

test('variable completion inserts a Unicode parameter literally and undo restores the prefix without grading', async () => {
  infrastructure.problemId = 'fillInBlank2';
  const user = userEvent.setup();
  renderPage('fillInBlank');
  const editor = await screen.findByRole('textbox', { name: /Java/ });
  const prefix = 'class Main { void draw(int 歩数) { int counter = 2; 歩';
  await replaceJavaSource(editor, prefix);
  await user.keyboard('{Control>} {/Control}');
  await user.click(await screen.findByRole('option', { name: /^歩数/ }));
  expect(readRenderedJavaSource(editor)).toBe(`${prefix}数`);
  await user.click(screen.getByRole('button', { name: '元に戻す' }));
  expect(readRenderedJavaSource(editor)).toBe(prefix);
  expect(infrastructure.grade).not.toHaveBeenCalled();
});

test('variable completion updates its own visible locals after typing and backspacing', async () => {
  infrastructure.problemId = 'fillInBlank2';
  const user = userEvent.setup();
  renderPage('fillInBlank');
  const editor = await screen.findByRole('textbox', { name: /Java/ });
  await replaceJavaSource(editor, 'class Main { void draw() { int counter = 1, countDown = 2; ');
  await user.keyboard('count');
  await screen.findByRole('option', { name: /^counter/ });
  await screen.findByRole('option', { name: /^countDown/ });
  await user.keyboard('D');
  await waitFor(() => expect(screen.queryByRole('option', { name: /^counter/ })).not.toBeInTheDocument());
  await screen.findByRole('option', { name: /^countDown/ });
  await user.keyboard('{Backspace}');
  await screen.findByRole('option', { name: /^counter/ });
  await user.click(await screen.findByRole('option', { name: /^countDown/ }));
  expect(readRenderedJavaSource(editor)).toMatch(/; countDown$/);
  expect(infrastructure.grade).not.toHaveBeenCalled();
});

test('variable completion preserves richer scoped candidates alongside neutral source words', async () => {
  infrastructure.problemId = 'fillInBlank2';
  const user = userEvent.setup();
  renderPage('fillInBlank');
  const editor = await screen.findByRole('textbox', { name: /Java/ });
  const before =
    'class ScopeClass { void scopeMethod(int scopeParameter) { int scopeLocal = 1; { int scopeSibling = 2; } for (int scopeIndex = 0; scopeIndex < 3; scopeIndex++) { sco';
  const after = '; int scopeLater = 4; } } }';
  await replaceJavaSource(editor, before + after);
  await user.keyboard(`{ArrowLeft>${after.length}}`);
  await user.keyboard('{Control>} {/Control}');
  await screen.findByRole('option', { name: 'scopeLocal' });
  for (const name of ['scopeLocal', 'scopeParameter', 'scopeIndex']) {
    expect(screen.getByRole('option', { name })).toBeVisible();
    expect(screen.getAllByRole('option', { name: new RegExp(`^${name}`) })).toHaveLength(1);
  }
  for (const name of ['scopeSibling', 'scopeLater', 'scopeMethod', 'ScopeClass']) {
    expect(screen.getByRole('option', { name: `${name}コード内の単語` })).toBeVisible();
    expect(screen.queryByRole('option', { name })).not.toBeInTheDocument();
  }
  await user.click(screen.getByRole('option', { name: 'scopeSiblingコード内の単語' }));
  expect(readRenderedJavaSource(editor)).toBe(before.slice(0, -3) + 'scopeSibling' + after);
});

test('variable completion includes later fields and constructor locals while respecting static context', async () => {
  infrastructure.problemId = 'fillInBlank2';
  const user = userEvent.setup();
  renderPage('fillInBlank');
  const editor = await screen.findByRole('textbox', { name: /Java/ });
  const before = 'class Main { Main(int speedParameter) { int speedLocal = 1; spe';
  const after = '; } int speedField; static int speedShared; }';
  await replaceJavaSource(editor, before + after);
  await user.keyboard(`{ArrowLeft>${after.length}}`);
  await user.keyboard('{Control>} {/Control}');
  await screen.findByRole('option', { name: 'speedLocal' });
  await screen.findByRole('option', { name: 'speedParameter' });
  await screen.findByRole('option', { name: 'speedShared' });
  await user.click(await screen.findByRole('option', { name: 'speedField' }));
  expect(readRenderedJavaSource(editor)).toBe(before.slice(0, -3) + 'speedField' + after);
  await user.click(screen.getByRole('button', { name: '元に戻す' }));
  expect(readRenderedJavaSource(editor)).toBe(before + after);
  const staticBefore = 'class Main { static void draw() { spe';
  const staticAfter = '; } int speedField; static int speedShared; }';
  await replaceJavaSource(editor, staticBefore + staticAfter);
  await user.keyboard(`{ArrowLeft>${staticAfter.length}}`);
  await user.keyboard('{Control>} {/Control}');
  await screen.findByRole('option', { name: 'speedShared' });
  expect(screen.getByRole('option', { name: 'speedFieldコード内の単語' })).toBeVisible();
  expect(screen.queryByRole('option', { name: 'speedField' })).not.toBeInTheDocument();
});

test('variable completion distinguishes enhanced-loop scope from neutral source words', async () => {
  infrastructure.problemId = 'fillInBlank2';
  const user = userEvent.setup();
  renderPage('fillInBlank');
  const editor = await screen.findByRole('textbox', { name: /Java/ });
  const before = 'class Main { void draw(int[] itemValues) { for (int itemValue : item';
  const after = ') {} } }';
  await replaceJavaSource(editor, before + after);
  await user.keyboard(`{ArrowLeft>${after.length}}`);
  await user.keyboard('{Control>} {/Control}');
  await screen.findByRole('option', { name: /^itemValues/ });
  expect(screen.getByRole('option', { name: 'itemValueコード内の単語' })).toBeVisible();
  expect(screen.queryByRole('option', { name: 'itemValue' })).not.toBeInTheDocument();
  await user.keyboard('{Escape}');
  await replaceJavaSource(editor, 'class Main { void draw(int[] itemValues) { for (int itemValue : itemValues) { item');
  await user.keyboard('{Control>} {/Control}');
  await user.click(await screen.findByRole('option', { name: 'itemValue' }));
  expect(readRenderedJavaSource(editor)).toMatch(/\{ itemValue$/);
});

test('local draft storage read failures warn but do not block editing or explicit submission', async () => {
  infrastructure.problemId = 'fillInBlank2';
  infrastructure.grade.mockResolvedValue({ status: 'ungradable', detail: 'Offline' });
  const read = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new DOMException('Storage denied', 'SecurityError');
  });
  try {
    const user = userEvent.setup();
    renderPage('fillInBlank');
    const editor = await screen.findByRole('textbox', { name: /Java/ });
    expect(screen.getByText(/一時保存の処理に失敗/)).toBeVisible();
    const code = 'class AvailableEditor {}';
    await replaceJavaSource(editor, code);
    await user.click(screen.getByRole('button', { name: '提出' }));
    await waitFor(() =>
      expect(infrastructure.grade).toHaveBeenCalledWith({ sessionId: 10, code, elapsedMilliseconds: 123 })
    );
    expect(readRenderedJavaSource(editor)).toBe(code);
  } finally {
    read.mockRestore();
  }
});

test('local draft reset removal failures warn and preserve the visible reset source', async () => {
  infrastructure.problemId = 'fillInBlank2';
  const user = userEvent.setup();
  renderPage('fillInBlank');
  const editor = await screen.findByRole('textbox', { name: /Java/ });
  const starter = readRenderedJavaSource(editor);
  await replaceJavaSource(editor, 'class ResetFailure {}');
  expectStoredDraft('class ResetFailure {}');
  const removal = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
    throw new DOMException('Storage denied', 'SecurityError');
  });
  try {
    await user.click(screen.getByRole('button', { name: 'リセット' }));
    await user.click(await screen.findByRole('button', { name: 'リセットする' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(readRenderedJavaSource(editor)).toBe(starter);
    expect(editor).toHaveAttribute('contenteditable', 'true');
    expect(screen.getByText(/一時保存の処理に失敗/)).toBeVisible();
  } finally {
    removal.mockRestore();
  }
});

test('variable completion offers catch and lambda parameters without leaking completed scopes', async () => {
  infrastructure.problemId = 'fillInBlank2';
  const user = userEvent.setup();
  renderPage('fillInBlank');
  const editor = await screen.findByRole('textbox', { name: /Java/ });
  await replaceJavaSource(
    editor,
    'class Main { void draw() { int visibleOuter = 1; try {} catch (Exception visibleError) { use(visibleArgument -> { vis'
  );
  await user.keyboard('{Control>} {/Control}');
  await screen.findByRole('option', { name: 'visibleOuter' });
  await screen.findByRole('option', { name: 'visibleError' });
  await user.click(await screen.findByRole('option', { name: 'visibleArgument' }));
  expect(readRenderedJavaSource(editor)).toMatch(/\{ visibleArgument$/);
  await replaceJavaSource(
    editor,
    'class Main { void draw() { int visibleOuter = 1; try {} catch (Exception visibleError) { use(visibleArgument -> {}); } vis'
  );
  await user.keyboard('{Control>} {/Control}');
  await screen.findByRole('option', { name: 'visibleOuter' });
  for (const name of ['visibleError', 'visibleArgument']) {
    expect(screen.getByRole('option', { name: `${name}コード内の単語` })).toBeVisible();
    expect(screen.queryByRole('option', { name })).not.toBeInTheDocument();
  }
});

test('variable completion respects local field shadowing before offering Turtle members', async () => {
  infrastructure.problemId = 'fillInBlank2';
  const user = userEvent.setup();
  renderPage('fillInBlank');
  const editor = await screen.findByRole('textbox', { name: /Java/ });
  const before = 'class Main { void draw() { 亀.前';
  const after = '; } Turtle 亀 = new Turtle(); }';
  await replaceJavaSource(editor, before + after);
  await user.keyboard(`{ArrowLeft>${after.length}}`);
  await user.keyboard('{Control>} {/Control}');
  await screen.findByRole('option', { name: /前に進む/ });
  await user.keyboard('{Escape}');
  const shadowed = 'class Main { void draw() { int 亀 = 1; 亀.前';
  await replaceJavaSource(editor, shadowed + after);
  await user.keyboard(`{ArrowLeft>${after.length}}`);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  try {
    await act(async () => {
      fireEvent.keyDown(editor, { key: ' ', code: 'Space', ctrlKey: true });
      fireEvent.keyUp(editor, { key: ' ', code: 'Space', ctrlKey: true });
      await vi.runAllTimersAsync();
    });
    expect(vi.getTimerCount()).toBe(0);
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});

function expectStoredDraft(code: string): { key: string; raw: string } {
  const entries = Array.from({ length: localStorage.length }, (_, index) => {
    const key = localStorage.key(index)!;
    return { key, raw: localStorage.getItem(key)! };
  });
  const entry = entries.find(({ raw }) => raw.includes(code));
  expect(entry, 'The editor must persist its source before the storage failure is introduced').toBeDefined();
  return entry!;
}

test('variable completion never offers source declarations in literals, comments or arbitrary members', async () => {
  infrastructure.problemId = 'fillInBlank2';
  const user = userEvent.setup();
  renderPage('fillInBlank');
  const editor = await screen.findByRole('textbox', { name: /Java/ });
  const prefix = 'class Main { void draw() { int visibleValue = 1; ';
  await replaceJavaSource(editor, `${prefix}vis`);
  await user.keyboard('{Control>} {/Control}');
  await screen.findByRole('option', { name: /^visibleValue/ });
  await user.keyboard('{Escape}');
  for (const suffix of ['// vis', 'String text = "vis', 'String text = """\nvis', 'object.vis']) {
    await replaceJavaSource(editor, prefix + suffix);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      await act(async () => {
        fireEvent.keyDown(editor, { key: ' ', code: 'Space', ctrlKey: true });
        fireEvent.keyUp(editor, { key: ' ', code: 'Space', ctrlKey: true });
        await vi.runAllTimersAsync();
      });
      expect(vi.getTimerCount()).toBe(0);
      expect(screen.queryByRole('option', { name: /^visibleValue/ })).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  }
});

test('local draft identities separate ordinary and challenge modes with the same session and starter', async () => {
  infrastructure.problemId = 'fillInBlank2';
  let rendered = renderPage('fillInBlank');
  let editor = await screen.findByRole('textbox', { name: /Java/ });
  const starter = readRenderedJavaSource(editor);
  const ordinary = 'class OrdinaryDraft {}';
  await replaceJavaSource(editor, ordinary);
  rendered.unmount();
  infrastructure.start.mockResolvedValue({
    problemFormat: 'fillInBlank',
    sessionId: 10,
    problemId: 'fillInBlank2',
    displayProgram: starter,
    finalBoard: '.......\n.......\n.......\n.......\n.......\n.......\n.......',
    finalTurtles: [],
    blankCount: 1,
    completed: false,
  });
  rendered = render(
    <ChakraProvider>
      <ChallengePageOnClient initialFormat="fillInBlank" />
    </ChakraProvider>
  );
  editor = await screen.findByRole('textbox', { name: /Java/ });
  expect(readRenderedJavaSource(editor)).toBe(starter);
  await replaceJavaSource(editor, 'class ChallengeDraft {}');
  rendered.unmount();
  renderPage('fillInBlank');
  expect(readRenderedJavaSource(await screen.findByRole('textbox', { name: /Java/ }))).toBe(ordinary);
  expect(infrastructure.grade).not.toHaveBeenCalled();
});
