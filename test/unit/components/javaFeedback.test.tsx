// @vitest-environment jsdom

import { ChakraProvider } from '@chakra-ui/react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';

import { readRenderedJavaSource, replaceJavaSource } from '../../helpers/javaEditor';
import type { FillInBlankVerdict } from '../../../src/problems/fillInBlank/grade';
import { FillInBlankBody } from '../../../src/app/(withAuth)/courses/[courseId]/lectures/[lectureId]/problems/[problemId]/FillInBlankBody';

vi.mock('next/navigation', () => ({
  useParams: () => ({ courseId: 'test', lectureId: 'test', problemId: 'fillInBlank1' }),
  useRouter: () => ({ push: vi.fn() }),
}));

beforeEach(() => localStorage.clear());

const source = 'class Main {\n public static void main(String[] args) {\n  missing();\n }\n}';
const message = '変数やメソッドの名前と宣言を確認してください。';
const originalMessage = 'cannot find symbol\nsymbol: method missing()';
const verdict = {
  status: 'incorrect' as const,
  detail: 'Compile error.',
  diagnostics: [{ line: 3, message, originalMessage }],
};
const problem = {
  displayProgram: source,
  finalBoard: '.......\n.......\n.......\n.......\n.......\n.......\n.......',
  finalTurtles: [],
};

const body = (grade: () => Promise<FillInBlankVerdict>, key = 'first', displayProgram = source): React.ReactNode => (
  <ChakraProvider>
    <FillInBlankBody
      draftContext={{
        userId: 'feedback-user',
        mode: 'ordinary',
        courseId: 'test',
        lectureId: '1',
        problemId: 'feedback',
        sessionId: key === 'first' ? 1 : 2,
      }}
      key={key}
      problem={{ ...problem, displayProgram }}
      gradeCode={grade}
    />
  </ChakraProvider>
);

test.each(['reset', 'composition'] as const)(
  'same-document %s makes feedback historical and clears compiler annotations',
  async (action) => {
    const user = userEvent.setup();
    const grade = vi.fn().mockResolvedValue(verdict);
    render(body(grade));
    const editor = screen.getByRole('textbox', { name: /Java/ });
    await user.click(screen.getByRole('button', { name: '提出' }));
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeVisible());
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    await waitFor(() => expect(document.querySelector('.cm-lintRange-error')).toBeInTheDocument());
    expect(screen.getByText(message)).toBeVisible();
    if (action === 'reset') {
      await user.click(screen.getByRole('button', { name: 'リセット' }));
      await waitFor(() => expect(screen.getByRole('alertdialog')).toBeVisible());
      await user.click(screen.getByRole('button', { name: 'リセットする' }));
    } else {
      fireEvent.compositionStart(editor);
    }
    expect(document.querySelector('.cm-lintRange-error')).not.toBeInTheDocument();
    const report = screen.getByRole('region', { name: '前回提出したコードの確認結果' });
    expect(within(report).getByText(message)).toBeVisible();
    expect(within(report).getByText(/symbol: method missing/)).toBeVisible();
    expect(within(report).getByRole('status')).toHaveTextContent(/前回提出.*もう一度提出/);
    expect(within(report).getByRole('status')).not.toHaveTextContent('編集しました');
    expect(readRenderedJavaSource(editor)).toBe(source);
    if (action === 'composition') fireEvent.compositionEnd(editor, { data: '亀' });
    expect(grade).toHaveBeenCalledTimes(1);
  }
);

test('an obsolete pending submission cannot alert or unlock the next session', async () => {
  const user = userEvent.setup();
  let resolveOld!: (value: typeof verdict) => void;
  let resolveNew!: (value: typeof verdict) => void;
  const oldGrade = vi.fn(
    () =>
      new Promise<typeof verdict>((resolve) => {
        resolveOld = resolve;
      })
  );
  const newGrade = vi.fn(
    () =>
      new Promise<typeof verdict>((resolve) => {
        resolveNew = resolve;
      })
  );
  const rendered = render(body(oldGrade));
  await user.click(screen.getByRole('button', { name: '提出' }));
  await waitFor(() => expect(oldGrade).toHaveBeenCalledOnce());
  rendered.rerender(body(newGrade, 'next'));
  await user.click(screen.getByRole('button', { name: '提出' }));
  await waitFor(() => expect(newGrade).toHaveBeenCalledOnce());
  await act(async () => {
    resolveOld(verdict);
  });
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: /Java/ })).toHaveAttribute('contenteditable', 'false');
  expect(document.querySelector('.cm-lintRange-error')).not.toBeInTheDocument();
  await act(async () => {
    resolveNew(verdict);
  });
  await waitFor(() => expect(screen.getByRole('alertdialog')).toBeVisible());
  expect(screen.getAllByText(message).length).toBeGreaterThan(0);
});

test.each(
  [
    [{ line: 999, message: 'INVALID_DIAGNOSTIC_LINE' }],
    [{ line: -1, message: 'INVALID_DIAGNOSTIC_LINE' }],
    [{ line: '3', message: 'INVALID_DIAGNOSTIC_LINE' }],
    [{ line: 3, message: 'INVALID_DIAGNOSTIC_MESSAGE'.repeat(30) }],
    [{ line: 3, message: 'INVALID_DIAGNOSTIC_MESSAGE', originalMessage: 42 }],
    [{ line: 3, message: 'INVALID_DIAGNOSTIC_MESSAGE', originalMessage: '' }],
    [{ line: 3, message: 'INVALID_DIAGNOSTIC_MESSAGE', originalMessage: 'X'.repeat(241) }],
  ].map((diagnostics) => ({ diagnostics }))
)(
  'invalid optional compiler payload falls back without rendering an invalid annotation: %j',
  async ({ diagnostics }) => {
    const grade = vi.fn().mockResolvedValue({ status: 'incorrect', detail: 'Compile error.', diagnostics });
    const user = userEvent.setup();
    render(body(grade));
    await user.click(screen.getByRole('button', { name: '提出' }));
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeVisible());
    expect(screen.getByRole('alertdialog')).not.toHaveTextContent('INVALID_DIAGNOSTIC');
    expect(document.querySelector('.cm-lintRange-error')).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: '提出' })).toBeEnabled();
  }
);

test('compiler diagnostic on the empty final CRLF learner line stays on that line', async () => {
  const finalLineMessage = '構文を確認してください。閉じ括弧が不足している可能性があります。';
  const crlfSource = 'class Main {\r\n public static void main(String[] args) {}\r\n}\r\n';
  const grade = vi.fn().mockResolvedValue({
    status: 'incorrect',
    detail: 'Compile error.',
    diagnostics: [{ line: 4, message: finalLineMessage }],
  });
  const user = userEvent.setup();
  render(
    <ChakraProvider>
      <FillInBlankBody
        draftContext={{
          userId: 'feedback-user',
          mode: 'ordinary',
          courseId: 'test',
          lectureId: '1',
          problemId: 'feedback',
          sessionId: 1,
        }}
        problem={{ ...problem, displayProgram: crlfSource }}
        gradeCode={grade}
      />
    </ChakraProvider>
  );
  const editor = screen.getByRole('textbox', { name: /Java/ });
  expect(readRenderedJavaSource(editor)).toBe(crlfSource.replaceAll('\r\n', '\n'));
  await user.click(screen.getByRole('button', { name: '提出' }));
  await waitFor(() => expect(screen.getByRole('alertdialog')).toBeVisible());
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  await waitFor(() => expect(editor.querySelector('.cm-lintPoint-error')).toBeInTheDocument());
  const lines = editor.querySelectorAll('.cm-line');
  expect(lines).toHaveLength(4);
  expect(lines[3].querySelector('.cm-lintPoint-error')).toBeInTheDocument();
  expect(lines[2].querySelector('.cm-lintPoint-error, .cm-lintRange-error')).not.toBeInTheDocument();
  expect(screen.getByText(finalLineMessage)).toBeVisible();
  expect(grade).toHaveBeenCalledOnce();
});

test('Japanese explanation precedes the optional plain-text compiler reference in dialog and inline feedback', async () => {
  const user = userEvent.setup();
  const secondary = 'cannot find symbol <img src=x onerror=alert(1)>\nsymbol: method missing()';
  const generalMessage = 'コード全体の宣言を確認してください。';
  const grade = vi.fn().mockResolvedValue({
    ...verdict,
    diagnostics: [{ line: 3, message, originalMessage: secondary }, { message: generalMessage }],
  });
  render(body(grade));
  await user.click(screen.getByRole('button', { name: '提出' }));
  const dialog = await screen.findByRole('alertdialog');
  expect(dialog.textContent).toMatch(/コード.*確認/);
  const items = within(dialog).getAllByRole('listitem');
  expect(items).toHaveLength(2);
  expect(items[0]).toHaveTextContent('3行目付近');
  expect(within(items[0]).getByText(message)).toBeVisible();
  expect(within(items[0]).getByText(/参考（Java のメッセージ）/)).toBeVisible();
  expect(items[0]).not.toHaveTextContent(generalMessage);
  expect(items[1]).not.toHaveTextContent(message);
  expect(items[1]).toHaveTextContent('コード全体');
  expect(within(items[1]).getByText(generalMessage)).toBeVisible();
  expect(within(items[1]).queryByText(/参考（Java のメッセージ）/)).not.toBeInTheDocument();
  expect(within(dialog).getByText('閉じてコードを修正し、もう一度提出してください。')).toBeVisible();
  expect(dialog.textContent?.indexOf(message)).toBeLessThan(dialog.textContent?.indexOf(secondary) ?? -1);
  expect(dialog.textContent).toContain(secondary);
  expect(dialog.querySelector('img')).not.toBeInTheDocument();
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  const region = screen.getByRole('region', { name: '提出したコードの確認結果' });
  expect(within(region).getByText(message)).toBeVisible();
  expect(within(region).getByText(/参考（Java のメッセージ）/)).toBeVisible();
  expect(region.textContent?.indexOf(message)).toBeLessThan(region.textContent?.indexOf(secondary) ?? -1);
  expect(region.textContent).toContain(secondary);
  expect(region.querySelector('img')).not.toBeInTheDocument();
  expect(within(region).getAllByRole('listitem')).toHaveLength(2);
});

test('historical feedback survives a blocked submit, is replaced by a new report, and clears for a noncompiler result', async () => {
  const user = userEvent.setup();
  let resolveNext!: (value: FillInBlankVerdict) => void;
  const grade = vi
    .fn<() => Promise<FillInBlankVerdict>>()
    .mockResolvedValueOnce(verdict)
    .mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveNext = resolve;
        })
    );
  render(body(grade));
  const editor = screen.getByRole('textbox', { name: /Java/ });
  await user.click(screen.getByRole('button', { name: '提出' }));
  await screen.findByRole('alertdialog');
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  await user.click(screen.getByRole('button', { name: 'リセット' }));
  await screen.findByRole('alertdialog');
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  expect(screen.getByRole('region', { name: '提出したコードの確認結果' })).toHaveTextContent(message);
  await replaceJavaSource(editor, 'class Main { int x = 【1】; }');
  expect(screen.getByRole('region', { name: '前回提出したコードの確認結果' })).toHaveTextContent(message);
  await user.click(screen.getByRole('button', { name: '提出' }));
  await screen.findByRole('alertdialog');
  expect(grade).toHaveBeenCalledOnce();
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  expect(screen.getByRole('region', { name: '前回提出したコードの確認結果' })).toHaveTextContent(message);
  await replaceJavaSource(editor, 'class Main { int x = true; }');
  await user.click(screen.getByRole('button', { name: '提出' }));
  await waitFor(() => expect(grade).toHaveBeenCalledTimes(2));
  expect(screen.queryByText(message)).not.toBeInTheDocument();
  expect(screen.queryByRole('region', { name: /提出したコードの確認結果/ })).not.toBeInTheDocument();
  const nextMessage = '代入する値の種類を確認してください。';
  await act(async () => {
    resolveNext({ status: 'incorrect', detail: 'Compile error.', diagnostics: [{ line: 1, message: nextMessage }] });
  });
  await screen.findByRole('alertdialog');
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  expect(screen.getByRole('region', { name: '提出したコードの確認結果' })).toHaveTextContent(nextMessage);
  expect(screen.queryByText(message)).not.toBeInTheDocument();
  await waitFor(() => expect(document.querySelector('.cm-lintRange-error')).toBeInTheDocument());
  await replaceJavaSource(editor, 'class Main { int x = 1; }');
  expect(screen.getByRole('region', { name: '前回提出したコードの確認結果' })).toHaveTextContent(nextMessage);
  await user.click(screen.getByRole('button', { name: '提出' }));
  await waitFor(() => expect(grade).toHaveBeenCalledTimes(3));
  expect(screen.queryByText(nextMessage)).not.toBeInTheDocument();
  await act(async () => {
    resolveNext({ status: 'incorrect', detail: 'Final board differs.' });
  });
  await screen.findByRole('alertdialog');
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  expect(screen.queryByRole('region', { name: /提出したコードの確認結果/ })).not.toBeInTheDocument();
  expect(document.querySelector('.cm-lintRange-error')).not.toBeInTheDocument();
});

test('a new keyed session discards its predecessor’s visible compiler report', async () => {
  const user = userEvent.setup();
  const grade = vi.fn().mockResolvedValue(verdict);
  const rendered = render(body(grade));
  await user.click(screen.getByRole('button', { name: '提出' }));
  await screen.findByRole('alertdialog');
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  expect(screen.getByRole('region', { name: '提出したコードの確認結果' })).toHaveTextContent(message);
  rendered.rerender(body(grade, 'next'));
  expect(screen.queryByText(message)).not.toBeInTheDocument();
  expect(screen.queryByText(/symbol: method missing/)).not.toBeInTheDocument();
  expect(screen.queryByRole('region', { name: /提出したコードの確認結果/ })).not.toBeInTheDocument();
  expect(document.querySelector('.cm-lintRange-error')).not.toBeInTheDocument();
  expect(grade).toHaveBeenCalledOnce();
});

test('an in-place starter change restores only its matching draft and starts fresh history', async () => {
  const grade = vi.fn().mockResolvedValue(verdict);
  const rendered = render(body(grade));
  await replaceJavaSource(screen.getByRole('textbox', { name: /Java/ }), 'class Learner {}');
  const revised = 'class RevisedStarter {}';
  rendered.rerender(body(grade, 'first', revised));
  expect(readRenderedJavaSource(screen.getByRole('textbox', { name: /Java/ }))).toBe(revised);
  expect(screen.getByRole('button', { name: '元に戻す' })).toBeDisabled();
  await replaceJavaSource(screen.getByRole('textbox', { name: /Java/ }), 'class RevisedLearner {}');
  rendered.unmount();
  render(body(grade, 'first', revised));
  expect(readRenderedJavaSource(screen.getByRole('textbox', { name: /Java/ }))).toBe('class RevisedLearner {}');
  expect(grade).not.toHaveBeenCalled();
});

test('a successful obsolete submission cannot clear either attempt draft', async () => {
  const user = userEvent.setup();
  let finish!: (value: FillInBlankVerdict) => void;
  const grade = vi.fn(
    () =>
      new Promise<FillInBlankVerdict>((resolve) => {
        finish = resolve;
      })
  );
  const rendered = render(body(grade));
  await replaceJavaSource(screen.getByRole('textbox', { name: /Java/ }), 'class FirstDraft {}');
  await user.click(screen.getByRole('button', { name: '提出' }));
  await waitFor(() => expect(grade).toHaveBeenCalledOnce());
  rendered.rerender(body(grade, 'next'));
  await replaceJavaSource(screen.getByRole('textbox', { name: /Java/ }), 'class NextDraft {}');
  await act(async () => {
    finish({ status: 'correct' });
  });
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  rendered.unmount();
  const next = render(body(grade, 'next'));
  expect(readRenderedJavaSource(screen.getByRole('textbox', { name: /Java/ }))).toBe('class NextDraft {}');
  next.unmount();
  render(body(grade));
  expect(readRenderedJavaSource(screen.getByRole('textbox', { name: /Java/ }))).toBe('class FirstDraft {}');
});
