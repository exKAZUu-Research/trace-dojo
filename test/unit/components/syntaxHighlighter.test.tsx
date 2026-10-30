// @vitest-environment jsdom

import { ChakraProvider } from '@chakra-ui/react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { expect, test } from 'vitest';

import { SyntaxHighlighter } from '../../../src/app/(withAuth)/courses/[courseId]/lectures/[lectureId]/problems/[problemId]/SyntaxHighlighter';

type Props = ComponentProps<typeof SyntaxHighlighter> & { enableSyntaxHints?: boolean };

const lexicalCode = String.raw`int 個数 = 17;
  個数 %= 5; 個数 = 個数 % 3;
  boolean 同じ = 個数 == 2 && 個数 != 0;
  個数 >>>= 1; 個数++;
  // %= % = == int
  /* %= % = */
  String 文 = "escaped \" %= % = int";
  char 記号 = '%';
  String 複数行 = """
    %= % = int
    """;
  java.util.List<String> 一覧;`;

test('renders hinted code without a usage helper or an instruction description', () => {
  renderHighlighter({ code: 'int 個数 = 17;' });
  expect.soft(screen.queryByText(/下線のある記号や語/)).not.toBeInTheDocument();
  const group = screen.getByRole('group', { name: 'Java の構文ヒント' });
  expect.soft(group).not.toHaveAttribute('aria-describedby');
  expect(group).not.toHaveAccessibleDescription();
});

test('keeps punctuation, literals, String, class names, and arbitrary names noninteractive', () => {
  const source = `int 個数 = 17;
個数 += 2;
String 文;
Widget 道具;
{ 道具.accept(17, 1.5, "text", 'x', true, false, null); }
一覧[0].accept(文);`;
  const { container } = renderHighlighter({ code: source });
  const code = getCode(container);
  expectSource(code, source);
  expect(within(code).getByRole('button', { name: 'int の説明' })).toBeVisible();
  expect(within(code).getByRole('button', { name: '+= の説明' })).toBeVisible();
  for (const line of [...code.children].slice(2)) {
    if (!(line instanceof HTMLElement)) throw new Error('Source line must be rendered');
    expect.soft(within(line).queryAllByRole('button')).toHaveLength(0);
  }
  expect(within(code).queryByRole('button', { name: '個数 の説明' })).not.toBeInTheDocument();
});

test('shows labeled static snippets, preserves multiline examples, and describes the active hint', async () => {
  const user = userEvent.setup();
  const { container } = renderHighlighter({ code: 'if (課題の個数 > 937) { 課題の個数 %= 937; }' });
  const query = within(getCode(container));
  const keyword = query.getByRole('button', { name: 'if の説明' });
  await user.hover(keyword);
  const keywordTooltip = await screen.findByRole('tooltip');
  expect(within(keywordTooltip).getByText(/^書き方[：:]?$/)).toBeVisible();
  expect(within(keywordTooltip).getByText(/^例[：:]?$/)).toBeVisible();
  const keywordSnippets = keywordTooltip.querySelectorAll('pre > code');
  expect(keywordSnippets).toHaveLength(2);
  expect(keywordSnippets[0]).toHaveTextContent(/^if\s*\(/);
  expect(keywordSnippets[1]?.textContent).toMatch(/if[^\n]*\{\n[ \t]+System\.out\.println\("合格"\);\n\}/);
  const explanation = within(keywordTooltip).getByText(/合格.*(?:表示|出力)/);
  expect(explanation).toBeVisible();
  expect(explanation.closest('pre, code')).toBeNull();
  const keywordDescription = keywordTooltip.textContent ?? '';
  expect(keyword).toHaveAttribute('aria-describedby', keywordTooltip.id);
  expect(keyword).toHaveAccessibleDescription(
    /条件[\s\S]*書き方\s*if[\s\S]*例[\s\S]*if[\s\S]*合格[\s\S]*(?:表示|出力)/
  );
  expect(keywordTooltip).not.toHaveTextContent(/課題の個数|937/);
  await user.unhover(keyword);
  const operator = query.getByRole('button', { name: '%= の説明' });
  await user.hover(operator);
  await waitFor(() => {
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip.textContent).not.toBe(keywordDescription);
    expect(operator).toHaveAttribute('aria-describedby', tooltip.id);
    expect(operator).toHaveAccessibleDescription(/余り[\s\S]*書き方[\s\S]*%=[\s\S]*例[\s\S]*%=\s*3\s*;[\s\S]*1/);
  });
  const operatorTooltip = screen.getByRole('tooltip');
  expect(within(operatorTooltip).getByText(/^書き方[：:]?$/)).toBeVisible();
  expect(within(operatorTooltip).getByText(/^例[：:]?$/)).toBeVisible();
  const operatorSnippets = operatorTooltip.querySelectorAll('pre > code');
  expect(operatorSnippets).toHaveLength(2);
  expect(operatorSnippets[1]).toHaveTextContent(/%=\s*3\s*;/);
  expect(operatorTooltip).not.toHaveTextContent(/課題の個数|937/);
  expect(keyword).not.toHaveAccessibleDescription();
});

test('preserves exact Java source and lexical boundaries around compound operators and literals', async () => {
  const user = userEvent.setup();
  const { container } = renderHighlighter({ code: lexicalCode });
  const code = getCode(container);
  expectSource(code, lexicalCode);
  const query = within(code);
  expect(query.getAllByRole('button', { name: '%= の説明' })).toHaveLength(1);
  expect(query.getAllByRole('button', { name: '% の説明' })).toHaveLength(1);
  expect(query.getAllByRole('button', { name: '= の説明' })).toHaveLength(6);
  expect(query.getAllByRole('button', { name: '== の説明' })).toHaveLength(1);
  expect(query.getAllByRole('button', { name: '!= の説明' })).toHaveLength(1);
  expect(query.getAllByRole('button', { name: '++ の説明' })).toHaveLength(1);
  expect(query.queryByRole('button', { name: '+ の説明' })).not.toBeInTheDocument();
  const shiftLine = code.children[3];
  if (!(shiftLine instanceof HTMLElement)) throw new Error('Shift line must be rendered');
  expect(within(shiftLine).queryByRole('button', { name: '> の説明' })).not.toBeInTheDocument();
  expect(query.queryByRole('button', { name: '>> の説明' })).not.toBeInTheDocument();
  expect(query.queryByRole('button', { name: '>= の説明' })).not.toBeInTheDocument();
  await user.hover(query.getByRole('button', { name: '%= の説明' }));
  expect(await screen.findByRole('tooltip')).toHaveTextContent(/余り|あまり/);
  expectSource(code, lexicalCode);
});

test('distinguishes import wildcards and generic bounds from arithmetic and bitwise operators', () => {
  const source = `import java.util.*;
class Example<T extends Number & Runnable> {
  int product = 3 * 4;
  int bits = 3 & 4;
}`;
  const { container } = renderHighlighter({ code: source });
  const code = getCode(container);
  expectSource(code, source);
  const productLine = code.children[2];
  const bitsLine = code.children[3];
  if (!(productLine instanceof HTMLElement) || !(bitsLine instanceof HTMLElement)) {
    throw new Error('Operator source lines must be rendered');
  }
  expect(within(productLine).getByRole('button', { name: '* の説明' })).toBeVisible();
  expect(within(bitsLine).getByRole('button', { name: '& の説明' })).toBeVisible();
  expect.soft(within(code).getAllByRole('button', { name: '* の説明' })).toHaveLength(1);
  expect.soft(within(code).getAllByRole('button', { name: '& の説明' })).toHaveLength(1);
});

test('uses one keyboard stop, navigates hints, dismisses without moving focus, and leaves with Tab', async () => {
  const user = userEvent.setup();
  const { container } = renderHighlighter({ code: 'int 個数 = 17; 個数 %= 5;' });
  const code = getCode(container);
  const hints = within(code).getAllByRole('button');
  expect(hints.filter((hint) => hint.tabIndex === 0)).toHaveLength(1);
  expect(hints.filter((hint) => hint.tabIndex === -1)).toHaveLength(hints.length - 1);
  await user.click(screen.getByRole('button', { name: 'Before code' }));
  await user.tab();
  await user.tab();
  await user.tab();
  expect(hints[0]).toHaveFocus();
  const tooltip = await screen.findByRole('tooltip');
  expect(hints[0]).toHaveAttribute('aria-describedby', tooltip.id);
  expect(hints[0]).toHaveAccessibleDescription(/整数[\s\S]*書き方\s*int[\s\S]*例\s*int\s+個数\s*=\s*3\s*;[\s\S]*個数/);
  await user.keyboard('{ArrowRight}');
  expect(hints[1]).toHaveFocus();
  await user.keyboard('{ArrowLeft}');
  expect(hints[0]).toHaveFocus();
  await user.keyboard('{End}');
  expect(hints.at(-1)).toHaveFocus();
  await user.keyboard('{Home}');
  expect(hints[0]).toHaveFocus();
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
  expect(hints[0]).toHaveFocus();
  await user.keyboard('{Enter}');
  expect(await screen.findByRole('tooltip')).toBeVisible();
  await user.keyboard('{Enter}');
  await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
  await user.keyboard(' ');
  expect(await screen.findByRole('tooltip')).toBeVisible();
  await user.tab();
  expect(screen.getByRole('textbox', { name: 'Answer' })).toHaveFocus();
  await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
});

test('pins a hovered hint, keeps it while hovering another, switches on tap, and dismisses outside', async () => {
  const user = userEvent.setup();
  const { container } = renderHighlighter({ code: '個数 %= 5; 個数 = 個数 % 3;' });
  const query = within(getCode(container));
  const compound = query.getByRole('button', { name: '%= の説明' });
  const remainder = query.getByRole('button', { name: '% の説明' });
  await user.hover(compound);
  const tooltip = await screen.findByRole('tooltip');
  const explanation = tooltip.textContent;
  await user.hover(tooltip);
  expect(screen.getByRole('tooltip')).toBeVisible();
  await user.click(compound);
  await user.hover(remainder);
  expect(screen.getAllByRole('tooltip')).toHaveLength(1);
  expect(screen.getByRole('tooltip').textContent).toBe(explanation);
  await user.click(remainder);
  await waitFor(() => expect(screen.getByRole('tooltip').textContent).not.toBe(explanation));
  await user.click(remainder);
  await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
  await user.click(compound);
  expect(await screen.findByRole('tooltip')).toBeVisible();
  await user.click(screen.getByRole('textbox', { name: 'Answer' }));
  await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
});

test('clears stale hints on replacement or disabling without taking focus from the answer', async () => {
  const user = userEvent.setup();
  const rendered = renderHighlighter({ code: '個数 %= 5;' });
  await user.click(within(getCode(rendered.container)).getByRole('button', { name: '%= の説明' }));
  expect(await screen.findByRole('tooltip')).toBeVisible();
  rendered.rerender(highlighter({ code: '識別子' }));
  await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
  expect(within(getCode(rendered.container)).queryByRole('button')).not.toBeInTheDocument();
  expect(getCode(rendered.container).querySelector('[tabindex="0"]')).not.toBeInTheDocument();
  const answer = screen.getByRole('textbox', { name: 'Answer' });
  await user.click(answer);
  rendered.rerender(highlighter({ code: '個数 %= 5;' }));
  expect(answer).toHaveFocus();
  await user.click(within(getCode(rendered.container)).getByRole('button', { name: '%= の説明' }));
  expect(await screen.findByRole('tooltip')).toBeVisible();
  rendered.rerender(highlighter({ code: '個数 %= 5;', enableSyntaxHints: false }));
  await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
  expect(within(getCode(rendered.container)).queryByRole('button')).not.toBeInTheDocument();
});

test('preserves zoom, line numbers, and execution styles through hint interaction and trace updates', async () => {
  const user = userEvent.setup();
  const source = 'int 個数 = 17;\n個数 %= 5;\n個数++;';
  const rendered = renderHighlighter({ code: source, callerLines: [1], previousFocusLine: 2, currentFocusLine: 3 });
  const code = getCode(rendered.container);
  expect(code.children[0]).toHaveStyle({ border: '2px dotted #f56565' });
  expect(code.children[1]).toHaveStyle({ backgroundColor: '#feebc8' });
  expect(code.children[2]).toHaveStyle({ border: '4px solid #f56565' });
  await user.click(screen.getByRole('button', { name: 'Zoom in' }));
  expect(getCode(rendered.container).style.fontSize).toBe('1.1rem');
  await user.click(within(code).getByRole('button', { name: '%= の説明' }));
  expect(await screen.findByRole('tooltip')).toBeVisible();
  rendered.rerender(highlighter({ code: source, callerLines: [1], previousFocusLine: 3, currentFocusLine: 2 }));
  expect(screen.getByRole('tooltip')).toBeVisible();
  expect(code.children[0]).toHaveStyle({ border: '2px dotted #f56565' });
  expect(code.children[1]).toHaveStyle({ border: '4px solid #f56565' });
  expect(code.children[2]).toHaveStyle({ backgroundColor: '#feebc8' });
  expectSource(code, source);
  expect(getCode(rendered.container).style.fontSize).toBe('1.1rem');
  await user.click(screen.getByRole('button', { name: 'Zoom out' }));
  expect(getCode(rendered.container).style.fontSize).toBe('1rem');
});

test.each([
  { programmingLanguageId: 'java', enableSyntaxHints: undefined },
  { programmingLanguageId: 'java', enableSyntaxHints: false },
  { programmingLanguageId: 'javascript', enableSyntaxHints: true },
])('stays inert for $programmingLanguageId with enableSyntaxHints=$enableSyntaxHints', async (options) => {
  const user = userEvent.setup();
  const source = 'int 個数 = 17; 個数 %= 5;';
  const { container } = renderHighlighter({ code: source, ...options });
  const code = getCode(container);
  expect(within(code).queryByRole('button')).not.toBeInTheDocument();
  await user.hover(code);
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  expectSource(code, source);
});

const renderHighlighter = (props: Partial<Props>): ReturnType<typeof render> => render(highlighter(props));

const highlighter = (overrides: Partial<Props>): React.ReactNode => {
  const props: Props = { code: '', programmingLanguageId: 'java', enableSyntaxHints: true, ...overrides };
  return (
    <ChakraProvider>
      <button type="button">Before code</button>
      <SyntaxHighlighter {...props} />
      <input aria-label="Answer" />
    </ChakraProvider>
  );
};

const getCode = (container: HTMLElement): HTMLElement => {
  const code = container.querySelector('code');
  if (!code) throw new Error('Highlighted code must be rendered');
  return code;
};

const expectSource = (code: HTMLElement, source: string): void => {
  expect([...code.querySelectorAll('.linenumber')].map((line) => line.textContent)).toEqual(
    source.split('\n').map((_, index) => String(index + 1))
  );
  const copy = code.cloneNode(true);
  if (!(copy instanceof HTMLElement)) throw new Error('Code clone must be an element');
  for (const line of copy.querySelectorAll('.linenumber')) line.remove();
  expect(copy.textContent).toBe(source);
};
