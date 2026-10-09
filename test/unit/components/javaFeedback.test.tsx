// @vitest-environment jsdom

import { ChakraProvider } from '@chakra-ui/react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

import { readRenderedJavaSource } from '../../helpers/javaEditor';
import { FillInBlankBody } from '../../../src/app/(withAuth)/courses/[courseId]/lectures/[lectureId]/problems/[problemId]/FillInBlankBody';

vi.mock('next/navigation', () => ({
  useParams: () => ({ courseId: 'test', lectureId: 'test', problemId: 'fillInBlank1' }),
  useRouter: () => ({ push: vi.fn() }),
}));

const source = 'class Main {\n public static void main(String[] args) {\n  missing();\n }\n}';
const message = '変数やメソッドの名前と宣言を確認してください。';
const verdict = { status: 'incorrect' as const, detail: 'Compile error.', diagnostics: [{ line: 3, message }] };
const problem = {
  displayProgram: source,
  finalBoard: '.......\n.......\n.......\n.......\n.......\n.......\n.......',
  finalTurtles: [],
};

const body = (grade: () => Promise<typeof verdict>, key = 'first'): React.ReactNode => (
  <ChakraProvider>
    <FillInBlankBody key={key} problem={problem} gradeCode={grade} />
  </ChakraProvider>
);

test.each(['reset', 'composition'] as const)(
  'compiler annotations disappear immediately on same-document %s',
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
    expect(screen.queryByText(message)).not.toBeInTheDocument();
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
      <FillInBlankBody problem={{ ...problem, displayProgram: crlfSource }} gradeCode={grade} />
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
