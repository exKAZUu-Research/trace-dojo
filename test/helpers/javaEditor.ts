import { fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

export async function replaceJavaSource(editor: HTMLElement, code: string): Promise<void> {
  const user = userEvent.setup();
  await user.click(editor);
  await user.keyboard('{Control>}a{/Control}');
  await user.paste(code);
  await waitFor(() => expectJavaSource(editor, code));
}

export function expectJavaSource(editor: HTMLElement, code: string): void {
  const text = editor.textContent?.replaceAll('\r\n', '\n');
  // Contenteditable line elements do not expose line separators through textContent in jsdom.
  if (text !== code.replaceAll('\n', '')) throw new Error(`Editor source differs: ${JSON.stringify(text)}`);
}

export function composeWithoutSubmitting(editor: HTMLElement): void {
  fireEvent.compositionStart(editor);
  fireEvent.keyDown(editor, { key: 'Enter', code: 'Enter', isComposing: true, keyCode: 229 });
  fireEvent.compositionEnd(editor, { data: '亀' });
}

export function readRenderedJavaSource(editor: HTMLElement): string {
  return [...editor.querySelectorAll('.cm-line')].map((line) => line.textContent).join('\n');
}
